import type { Message, ModelSpec, ProviderConfig, TaskKind } from '../types.js';
import type { ChatResult, ProviderAdapter } from './adapter.js';

/**
 * 多平台故障转移适配器（2026-08-21，模型策略落地）。
 *
 * 用户模型策略：
 *   1. 默认 DeepSeek `deepseek-v4-flash`
 *   2. v4-flash 没钱（429 余额不足 / 限流 / 网络 / 5xx）→ 智谱 `glm-5.3` 顶上
 *   3. 困难问题 → `deepseek-v4-pro` 或 `glm-5.3` 尝试（Executor 升级重试配合）
 *   4. 都不行才停止（所有链失败 → 抛错 → loop 标 blocked）
 *
 * 实现：按请求的 model 名路由到"链"（有序平台列表），链内逐个尝试；
 * 可恢复错误（429 / 5xx / 网络）切换到链中下一个平台；
 * 不可恢复错误（400 参数 / 401 403 key / 404 模型不存在）直接抛，不切换
 * （切换也没用，属于调用方 bug）。
 *
 * 成本修正：实际调用可能落在链中非首选平台，返回时补 spec
 * （实际模型的 ModelSpec），上层 CostTracker 按真实价格记账。
 */

/** 请求模型名 → 尝试链（[平台 id, 模型名] 有序对） */
const CHAINS: Record<string, Array<[string, string]>> = {
  // 普通任务：flash 没钱 → glm-5.3 顶上
  'deepseek-v4-flash': [
    ['deepseek', 'deepseek-v4-flash'],
    ['zhipu', 'glm-5.3'],
  ],
  // 困难任务：v4-pro 不行 → glm-5.3 顶上
  'deepseek-v4-pro': [
    ['deepseek', 'deepseek-v4-pro'],
    ['zhipu', 'glm-5.3'],
  ],
  // 兜底模型自身：glm-5.3 挂了就没有更弱兜底，抛错交给上层
  'glm-5.3': [['zhipu', 'glm-5.3']],
};

/** 可恢复错误：切换平台重试有意义 */
export function isRetryableProviderError(err: unknown): boolean {
  const msg = (err as Error).message ?? String(err);
  return (
    /fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN/i.test(msg) || // 网络
    /429|5\d\d|rate limit|too many/i.test(msg) || // 限流 / 服务端
    /余额不足|insufficient|无可用资源包/i.test(msg) // 余额类
  );
}

export class FailoverAdapter implements ProviderAdapter {
  readonly id = 'failover';
  readonly config: ProviderConfig;

  /** 平台 id → adapter */
  private readonly byId = new Map<string, ProviderAdapter>();

  constructor(adapters: ProviderAdapter[]) {
    if (adapters.length === 0) throw new Error('FailoverAdapter: 至少需要一个平台');
    for (const a of adapters) this.byId.set(a.id, a);

    // 合成 config：models 合并所有平台（供 routeModel / 成本查询），
    // 时段策略委托首选平台（通常是 DeepSeek）。
    const primary = adapters[0];
    const models = adapters.flatMap((a) => a.config.models);
    this.config = {
      id: 'failover',
      name: `Failover(${adapters.map((a) => a.id).join('+')})`,
      baseUrl: primary.config.baseUrl,
      apiKeyEnv: primary.config.apiKeyEnv,
      models,
      costStrategy: primary.config.costStrategy,
    };
  }

  /** 空闲/折扣委托首选平台（DeepSeek 时段逻辑） */
  isOffPeak(now: Date): boolean {
    return this.primary().isOffPeak(now);
  }

  currentDiscount(now: Date): number {
    return this.primary().currentDiscount(now);
  }

  /** 首选平台的默认路由（正常时 v4-flash） */
  routeModel(kind: TaskKind): ModelSpec {
    return this.primary().routeModel(kind);
  }

  private primary(): ProviderAdapter {
    return this.byId.values().next().value as ProviderAdapter;
  }

  /** 解析 model 名 → 尝试链；未识别模型回退到"所有含该模型的平台" */
  private chainFor(model: string): Array<[ProviderAdapter, string]> {
    const known = CHAINS[model];
    if (known) {
      const chain: Array<[ProviderAdapter, string]> = [];
      for (const [pid, m] of known) {
        const adapter = this.byId.get(pid);
        if (adapter) chain.push([adapter, m]);
      }
      if (chain.length > 0) return chain;
    }
    // 未配置链：找能提供该模型的平台，按传入顺序
    const chain: Array<[ProviderAdapter, string]> = [];
    for (const adapter of this.byId.values()) {
      if (adapter.config.models.some((m) => m.name === model)) chain.push([adapter, model]);
    }
    return chain;
  }

  async chat(
    model: string,
    messages: Message[],
    opts?: { maxTokens?: number },
  ): Promise<ChatResult> {
    const chain = this.chainFor(model);
    if (chain.length === 0) {
      throw new Error(`FailoverAdapter: 没有任何平台支持模型 ${model}`);
    }

    let lastErr: unknown = null;
    for (const [adapter, m] of chain) {
      try {
        const r = await adapter.chat(m, messages, opts);
        // 成本修正：补上实际模型规格（可能不是请求时的首选模型）
        const spec =
          adapter.config.models.find((x) => x.name === r.model) ??
          adapter.config.models.find((x) => x.name === m);
        return spec ? { ...r, spec } : r;
      } catch (err) {
        lastErr = err;
        if (!isRetryableProviderError(err)) throw err; // 不可恢复：不切换
        // 可恢复：尝试链中下一个平台
      }
    }

    throw lastErr ?? new Error(`所有平台都失败：${model}`);
  }
}
