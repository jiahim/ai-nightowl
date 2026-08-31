import type { ModelSpec, ProviderConfig, TaskKind } from '../types.js';
import { ProviderRequestError, type ProviderRemoteUsage, type ProviderUsageWindow } from './adapter.js';
import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from './openai-compatible.js';

const PAYG_MODELS: ModelSpec[] = [
  {
    name: 'MiniMax-M2.7',
    kind: 'chat',
    inputPrice: 2.1,
    outputPrice: 8.4,
    cacheHitPrice: 0.42,
    contextWindow: 204_800,
  },
  {
    name: 'MiniMax-M2.7-highspeed',
    // 官方定义为同能力的高速档，不应被“质量优先”误判为更强推理模型。
    kind: 'chat',
    inputPrice: 4.2,
    outputPrice: 16.8,
    cacheHitPrice: 0.42,
    contextWindow: 204_800,
  },
];

const PLAN_MODELS: ModelSpec[] = PAYG_MODELS.map((model) => ({
  ...model,
  // 已付订阅费视为沉没成本；路由比较的是额度内下一次调用的边际成本。
  inputPrice: 0,
  outputPrice: 0,
  cacheHitPrice: 0,
}));

abstract class MiniMaxBaseAdapter extends OpenAICompatibleAdapter {
  override routeModel(kind: TaskKind): ModelSpec {
    const models = this.config.models;
    // highspeed 是否包含在套餐中取决于订阅档位，默认不自动选择，避免无权限报错。
    return models.find((model) => model.name === 'MiniMax-M2.7') ?? super.routeModel(kind);
  }
}

/** MiniMax 开放平台普通 Key：按实际 token 计费。 */
export class MiniMaxAdapter extends MiniMaxBaseAdapter {
  constructor(config: Partial<ProviderConfig> = {}, options: OpenAICompatibleAdapterOptions = {}) {
    super({
      id: 'minimax',
      name: 'MiniMax 按量',
      baseUrl: process.env.MINIMAX_BASE_URL?.trim() || 'https://api.minimaxi.com/v1',
      apiKeyEnv: 'MINIMAX_API_KEY',
      models: structuredClone(PAYG_MODELS),
      costStrategy: { timezone: 'Asia/Shanghai', preferCache: true },
      ...config,
    }, { ...options, maxTokensField: 'max_completion_tokens' });
  }
}

/**
 * MiniMax Plan / Token Plan：使用独立 Plan Key，不与普通按量 Key 混用。
 * 额度优先从官方 token_plan/remains 查询；查询不可用时可在控制台人工配置。
 */
export class MiniMaxPlanAdapter extends MiniMaxBaseAdapter {
  constructor(config: Partial<ProviderConfig> = {}, options: OpenAICompatibleAdapterOptions = {}) {
    super({
      id: 'minimax-plan',
      name: 'MiniMax Plan',
      baseUrl: process.env.MINIMAX_PLAN_BASE_URL?.trim() || 'https://api.minimaxi.com/v1',
      apiKeyEnv: 'MINIMAX_PLAN_API_KEY',
      models: structuredClone(PLAN_MODELS),
      costStrategy: {
        timezone: 'Asia/Shanghai',
        preferCache: true,
      },
      ...config,
    }, { ...options, maxTokensField: 'max_completion_tokens' });
  }

  async queryUsage(
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<ProviderRemoteUsage> {
    const apiKey = this.resolveApiKey();
    if (!apiKey) throw new Error(`Missing API key: env ${this.config.apiKeyEnv} not set`);
    const response = await this.fetchImpl(miniMaxQuotaUrl(this.config.baseUrl), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 5_000),
    });
    if (!response.ok) {
      throw new ProviderRequestError(this.id, response.status, response.status === 429 || response.status >= 500);
    }
    const payload = await response.json() as Record<string, unknown>;
    return parseMiniMaxUsage(payload, new Date());
  }
}

function miniMaxQuotaUrl(baseUrl: string): string {
  const override = process.env.MINIMAX_PLAN_QUOTA_URL?.trim();
  if (override) return override;
  const host = new URL(baseUrl).hostname;
  if (host.endsWith('minimaxi.com')) return 'https://www.minimaxi.com/v1/token_plan/remains';
  if (host.endsWith('minimax.io')) return 'https://www.minimax.io/v1/token_plan/remains';
  return `${new URL(baseUrl).origin}/v1/token_plan/remains`;
}

function parseMiniMaxUsage(payload: Record<string, unknown>, now: Date): ProviderRemoteUsage {
  const nested = objectValue(payload.data);
  const root = (nested ? objectValue(nested.data) : undefined) ?? nested ?? payload;
  const base = objectValue(root.base_resp) ?? objectValue(payload.base_resp);
  const statusCode = Number(base?.status_code);
  if (Number.isFinite(statusCode) && statusCode !== 0) throw new Error('MiniMax Plan 额度接口返回业务错误');
  const rows = Array.isArray(root.model_remains)
    ? root.model_remains.filter((item): item is Record<string, unknown> => Boolean(objectValue(item)))
    : Array.isArray(payload.model_remains)
      ? payload.model_remains.filter((item): item is Record<string, unknown> => Boolean(objectValue(item)))
      : [];
  const selected = rows.find((row) => /^(?:general|MiniMax-M\*?)$/i.test(String(row.model_name ?? '')))
    ?? rows.find((row) => !/video/i.test(String(row.model_name ?? '')))
    ?? (hasQuotaFields(root) ? root : undefined);
  if (!selected) throw new Error('MiniMax Plan 额度响应缺少文本模型窗口');

  const windows: ProviderUsageWindow[] = [];
  const interval = usageWindow(selected, {
    id: 'minimax-plan-5h',
    label: 'Plan 5 小时滚动额度',
    period: 'rolling',
    windowMinutes: 300,
    percentKey: 'current_interval_remaining_percent',
    statusKey: 'current_interval_status',
    endKey: 'end_time',
    remainsKey: 'remains_time',
  }, now);
  if (interval) windows.push(interval);
  const weekly = usageWindow(selected, {
    id: 'minimax-plan-weekly',
    label: 'Plan 每周额度',
    period: 'week',
    percentKey: 'current_weekly_remaining_percent',
    statusKey: 'current_weekly_status',
    endKey: 'weekly_end_time',
    remainsKey: 'weekly_remains_time',
  }, now);
  if (weekly) windows.push(weekly);
  if (windows.length === 0) throw new Error('MiniMax Plan 额度响应无法识别');
  return { source: 'provider-api', fetchedAt: now.toISOString(), windows };
}

function usageWindow(
  row: Record<string, unknown>,
  shape: {
    id: string;
    label: string;
    period: ProviderUsageWindow['period'];
    windowMinutes?: number;
    percentKey: string;
    statusKey: string;
    endKey: string;
    remainsKey: string;
  },
  now: Date,
): ProviderUsageWindow | undefined {
  const percentRaw = Number(row[shape.percentKey]);
  const upstreamStatus = Number(row[shape.statusKey]);
  if (!Number.isFinite(percentRaw) && !Number.isFinite(upstreamStatus)) return undefined;
  const remainingPercent = Number.isFinite(percentRaw) ? Math.max(0, percentRaw) : undefined;
  const status: ProviderUsageWindow['status'] = upstreamStatus === 3
    ? 'unlimited'
    : upstreamStatus === 2 || remainingPercent === 0
      ? 'exhausted'
      : remainingPercent !== undefined
        ? 'available'
        : 'unknown';
  return {
    id: shape.id,
    label: shape.label,
    period: shape.period,
    windowMinutes: shape.windowMinutes,
    remainingPercent,
    status,
    resetAt: resetAt(row[shape.endKey], row[shape.remainsKey], now),
  };
}

function resetAt(end: unknown, remains: unknown, now: Date): string | undefined {
  const endMs = Number(end);
  if (Number.isFinite(endMs) && endMs > 0) return new Date(endMs).toISOString();
  const remainsMs = Number(remains);
  return Number.isFinite(remainsMs) && remainsMs > 0
    ? new Date(now.getTime() + remainsMs).toISOString()
    : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasQuotaFields(value: Record<string, unknown>): boolean {
  return 'current_interval_remaining_percent' in value || 'current_weekly_remaining_percent' in value;
}
