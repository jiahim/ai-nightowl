import type { ProviderPoliciesStore } from '../config/provider-policies.js';
import type { CustomOpenAISettings, ProviderSettingsStore } from '../config/provider-settings.js';
import type { ProviderUsageLedger } from '../config/provider-usage.js';
import type { Message, ModelSpec, TaskKind } from '../types.js';
import { computeCallCost } from '../cost/tracker.js';
import type { ProviderAdapter, ProviderRemoteUsage } from './adapter.js';
import {
  defaultProviderPolicy,
  estimateFitsLimits,
  estimateQuoteCost,
  evaluatePricing,
  usageLimitStatuses,
  type PricingQuote,
  type ProviderCallEstimate,
  type ProviderCandidate,
  type ProviderPolicy,
  type ProviderPriority,
  type UsageEvent,
} from './policy.js';

export interface ProviderIntent {
  priority: ProviderPriority;
  taskKind: TaskKind;
  expectedPromptTokens: number;
  expectedCompletionTokens: number;
  maxWaitMinutes: number;
  maxCost?: number;
}

export interface ProviderRecommendationCandidate extends ProviderCandidate {
  optionId: string;
  betterAt?: string;
  betterEstimatedCost?: number;
}

export interface ProviderRecommendation {
  recommendationId: string;
  analyzedBy: 'local' | 'ai';
  request: string;
  interpretation: ProviderIntent;
  recommendedOptionId: string | null;
  candidates: ProviderRecommendationCandidate[];
  summary: string;
  warnings: string[];
}

export type ProviderIntentInterpreter = (
  request: string,
  fallback: ProviderIntent,
  catalog: Array<{ providerId: string; models: Array<{ name: string; kind: string }> }>,
) => Promise<Partial<ProviderIntent>>;

export interface ProviderManagementSnapshot {
  preferredProvider: string;
  effectiveProvider: string | null;
  priority: ProviderPriority;
  providers: Array<{
    id: string;
    name: string;
    configured: boolean;
    source: string | null;
    envKey?: string;
    billingMode?: 'payg' | 'plan' | 'custom';
    credentialManaged: boolean;
    configuration?: CustomOpenAISettings;
    policySource: 'provider' | 'configured';
    policy: ProviderPolicy;
    currentPricing: PricingQuote[];
    usageLimits: ReturnType<typeof usageLimitStatuses>;
    remoteUsage?: ProviderRemoteUsage;
  }>;
  persistence: 'local-file';
  restartRequired: false;
  intelligentMatching: true;
}

export interface ProviderCallContext {
  requestedModel?: string;
  taskKind?: TaskKind;
  messages?: Message[];
  maxTokens?: number;
  now?: Date;
}

/**
 * Provider 的统一决策层：目录自发现、人工覆盖、周期额度、智能匹配和实际记账
 * 都在这里收口。LLM 只能解释需求；最终候选仍由确定性价格/额度规则计算。
 */
export class ProviderManagementService {
  private readonly adapters: ProviderAdapter[];
  private readonly byId: Map<string, ProviderAdapter>;
  private readonly remoteUsage = new Map<string, ProviderRemoteUsage>();
  private readonly remoteUsageAttemptedAt = new Map<string, number>();
  private interpreter?: ProviderIntentInterpreter;

  constructor(
    adapters: ProviderAdapter[],
    private readonly settings: ProviderSettingsStore,
    private readonly policies: ProviderPoliciesStore,
    private readonly usage: ProviderUsageLedger,
    private readonly available: (adapter: ProviderAdapter) => boolean,
  ) {
    if (adapters.length === 0) throw new Error('ProviderManagementService: 至少需要一个 Provider');
    this.adapters = [...adapters];
    this.byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  }

  setIntentInterpreter(interpreter: ProviderIntentInterpreter): void {
    this.interpreter = interpreter;
  }

  providerIds(): string[] {
    return [...this.byId.keys()];
  }

  isAvailable(provider: ProviderAdapter | string): boolean {
    const adapter = typeof provider === 'string' ? this.byId.get(provider) : provider;
    return adapter ? this.available(adapter) : false;
  }

  profile(providerId: string): { policy: ProviderPolicy; source: 'provider' | 'configured' } {
    const adapter = this.byId.get(providerId);
    if (!adapter) throw new Error(`未知 Provider：${providerId}`);
    const configured = this.policies.profile(providerId);
    return configured
      ? { policy: configured, source: 'configured' }
      : { policy: defaultProviderPolicy(adapter.config), source: 'provider' };
  }

  quote(providerId: string, modelName: string, now: Date = new Date()): PricingQuote {
    const adapter = this.byId.get(providerId);
    if (!adapter) throw new Error(`未知 Provider：${providerId}`);
    const model = adapter.config.models.find((item) => item.name === modelName);
    if (!model) throw new Error(`Provider ${providerId} 不支持模型 ${modelName}`);
    const profile = this.profile(providerId);
    return evaluatePricing(providerId, model, profile.policy, now, profile.source);
  }

  currentProvider(kind: TaskKind = 'execute', now: Date = new Date()): ProviderAdapter {
    const preferred = this.settings.effectivePreferredProvider();
    const ranked = this.rank({ taskKind: kind, now });
    if (preferred) {
      const selected = ranked.find((item) => item.adapter.id === preferred && item.candidate.eligible);
      if (selected) return selected.adapter;
    }
    return ranked.find((item) => item.candidate.eligible)?.adapter
      ?? this.adapters.find((adapter) => this.available(adapter))
      ?? this.adapters[0];
  }

  routeModel(kind: TaskKind): ModelSpec {
    const adapter = this.currentProvider(kind);
    return this.modelFor(adapter, kind);
  }

  async orderForCall(context: ProviderCallContext): Promise<Array<[ProviderAdapter, string]>> {
    await this.refreshRemoteUsage();
    const kind = this.requestedKind(context.requestedModel, context.taskKind);
    const ranked = this.rank({ ...context, taskKind: kind });
    const preferred = this.settings.effectivePreferredProvider();
    const eligible = ranked.filter((item) => item.candidate.eligible);
    if (preferred) {
      eligible.sort((a, b) => Number(b.adapter.id === preferred) - Number(a.adapter.id === preferred));
    }
    return eligible.map((item) => [item.adapter, item.model.name]);
  }

  /** 查询支持官方额度 API 的 Provider；60 秒内复用缓存，失败不阻塞其他平台。 */
  async refreshRemoteUsage(providerId?: string, force = false): Promise<void> {
    const now = Date.now();
    const targets = this.adapters.filter((adapter) =>
      (!providerId || adapter.id === providerId) &&
      this.available(adapter) &&
      typeof adapter.queryUsage === 'function');
    await Promise.all(targets.map(async (adapter) => {
      const attemptedAt = this.remoteUsageAttemptedAt.get(adapter.id) ?? 0;
      if (!force && now - attemptedAt < 60_000) return;
      this.remoteUsageAttemptedAt.set(adapter.id, now);
      try {
        this.remoteUsage.set(adapter.id, await adapter.queryUsage!({ timeoutMs: 5_000 }));
      } catch {
        this.remoteUsage.set(adapter.id, {
          source: 'provider-api',
          fetchedAt: new Date(now).toISOString(),
          windows: [],
          warning: '官方额度暂时无法查询，路由将使用本地账本与调用失败后的故障转移。',
        });
      }
    }));
  }

  async recordUsage(event: UsageEvent): Promise<void> {
    await this.usage.record(event);
  }

  snapshot(now: Date = new Date()): ProviderManagementSnapshot {
    const credentialSnapshot = this.settings.snapshot();
    const credentials = new Map<string, (typeof credentialSnapshot.providers)[number]>(
      credentialSnapshot.providers.map((provider) => [provider.id, provider]),
    );
    const events = this.usage.events();
    const providers = this.adapters.map((adapter) => {
      const credential = credentials.get(adapter.id);
      const profile = this.profile(adapter.id);
      return {
        id: adapter.id,
        name: adapter.config.name,
        configured: this.available(adapter),
        source: credential?.source ?? (this.available(adapter) ? 'plugin' : null),
        envKey: credential?.envKey,
        billingMode: credential?.billingMode,
        credentialManaged: credential?.credentialManaged ?? false,
        configuration: credential?.configuration,
        policySource: profile.source,
        policy: profile.policy,
        currentPricing: adapter.config.models.map((model) =>
          evaluatePricing(adapter.id, model, profile.policy, now, profile.source)),
        usageLimits: usageLimitStatuses(profile.policy, adapter.id, events, now),
        remoteUsage: this.remoteUsage.get(adapter.id),
      };
    });
    const preferred = this.settings.effectivePreferredProvider();
    return {
      preferredProvider: credentialSnapshot.preferredProvider,
      effectiveProvider: preferred ?? this.currentProvider('execute', now)?.id ?? null,
      priority: this.policies.priority(),
      providers,
      persistence: 'local-file',
      restartRequired: false,
      intelligentMatching: true,
    };
  }

  async recommend(request: string, now: Date = new Date()): Promise<ProviderRecommendation> {
    const clean = request.trim().slice(0, 4000);
    if (!clean) throw new Error('请描述任务对成本、速度或质量的要求');
    await this.refreshRemoteUsage();
    const fallback = inferProviderIntent(clean, this.policies.priority());
    let intent = fallback;
    let analyzedBy: ProviderRecommendation['analyzedBy'] = 'local';
    const warnings: string[] = [];
    if (this.interpreter && this.adapters.some((adapter) => this.available(adapter))) {
      try {
        const inferred = await this.interpreter(clean, fallback, this.adapters.map((adapter) => ({
          providerId: adapter.id,
          models: adapter.config.models.map((model) => ({ name: model.name, kind: model.kind })),
        })));
        intent = validateIntent({ ...fallback, ...inferred });
        analyzedBy = 'ai';
      } catch {
        warnings.push('AI 意图识别暂不可用，已使用本地规则完成匹配。');
      }
    }

    const estimate = {
      promptTokens: intent.expectedPromptTokens,
      completionTokens: intent.expectedCompletionTokens,
    };
    const ranked = this.rank({ taskKind: intent.taskKind, now }, intent.priority, estimate);
    const candidates: ProviderRecommendationCandidate[] = ranked.map(({ adapter, model, candidate }) => {
      const better = intent.maxWaitMinutes > 0
        ? this.findBetterQuote(adapter, model, now, intent.maxWaitMinutes, estimate)
        : undefined;
      const maxCostExceeded = intent.maxCost !== undefined && candidate.estimatedCost > intent.maxCost;
      return {
        ...candidate,
        eligible: candidate.eligible && !maxCostExceeded,
        warnings: [
          ...candidate.warnings,
          ...(maxCostExceeded ? [`预计费用超过单次预算 ¥${intent.maxCost!.toFixed(4)}`] : []),
        ],
        optionId: `${adapter.id}:${model.name}`,
        betterAt: better?.at,
        betterEstimatedCost: better?.cost,
      };
    });
    const eligible = candidates.filter((candidate) => candidate.eligible);
    const recommended = eligible[0] ?? null;
    return {
      recommendationId: `rec-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
      analyzedBy,
      request: clean,
      interpretation: intent,
      recommendedOptionId: recommended?.optionId ?? null,
      candidates,
      summary: recommended
        ? `建议使用 ${recommended.providerName} / ${recommended.model}，当前预计 ¥${recommended.estimatedCost.toFixed(4)}。`
        : '当前没有同时满足密钥、额度和预算要求的 Provider。',
      warnings,
    };
  }

  candidateExists(optionId: string): { providerId: string; model: string } | null {
    const split = optionId.indexOf(':');
    if (split <= 0) return null;
    const providerId = optionId.slice(0, split);
    const model = optionId.slice(split + 1);
    const adapter = this.byId.get(providerId);
    return adapter?.config.models.some((item) => item.name === model) ? { providerId, model } : null;
  }

  private rank(
    context: ProviderCallContext,
    priority: ProviderPriority = this.policies.priority(),
    explicitEstimate?: ProviderCallEstimate,
  ): Array<{ adapter: ProviderAdapter; model: ModelSpec; candidate: ProviderCandidate }> {
    const now = context.now ?? new Date();
    const estimate = explicitEstimate ?? estimateCall(context.messages ?? [], context.maxTokens);
    const events = this.usage.events();
    const kind = context.taskKind ?? this.requestedKind(context.requestedModel, 'execute');
    const ranked = this.adapters.map((adapter, index) => {
      const model = this.modelFor(adapter, kind, context.requestedModel, priority);
      const profile = this.profile(adapter.id);
      const quote = evaluatePricing(adapter.id, model, profile.policy, now, profile.source);
      const estimatedCost = estimateQuoteCost(quote, estimate);
      const limits = usageLimitStatuses(profile.policy, adapter.id, events, now);
      const available = this.available(adapter);
      const remoteUsage = this.remoteUsage.get(adapter.id);
      const remoteExhausted = remoteUsage?.windows.some((window) => window.status === 'exhausted') ?? false;
      const fits = estimateFitsLimits(limits, estimate, estimatedCost) && !remoteExhausted;
      const warnings = limits.filter((limit) => limit.warning).map((limit) =>
        `${limit.label}已使用 ${(limit.ratio * 100).toFixed(0)}%`);
      for (const window of remoteUsage?.windows ?? []) {
        if (window.status === 'exhausted') warnings.push(`${window.label}已耗尽`);
        else if (window.remainingPercent !== undefined && window.remainingPercent <= 20) {
          warnings.push(`${window.label}仅剩 ${window.remainingPercent.toFixed(0)}%`);
        }
      }
      if (remoteUsage?.warning) warnings.push(remoteUsage.warning);
      const reasons = [
        `${quote.label}（${quote.timezone}）`,
        profile.source === 'configured' ? '使用用户确认的资费画像' : '使用 Provider 自报目录',
      ];
      if (remoteUsage?.windows.length) reasons.push('已核验 Provider 官方套餐额度');
      if (!available) warnings.push('尚未配置凭据或 Provider 不可用');
      if (!fits) warnings.push('本次预计用量会超过周期限制');
      const score = candidateScore(priority, model, quote, estimatedCost, index);
      return {
        adapter,
        model,
        candidate: {
          providerId: adapter.id,
          providerName: adapter.config.name,
          model: model.name,
          eligible: available && fits,
          estimatedCost,
          currentRate: quote,
          usageLimits: limits,
          remoteUsage,
          reasons,
          warnings,
          score,
        },
      };
    });
    return ranked.sort((a, b) =>
      Number(b.candidate.eligible) - Number(a.candidate.eligible) ||
      a.candidate.score - b.candidate.score ||
      a.adapter.id.localeCompare(b.adapter.id));
  }

  private modelFor(
    adapter: ProviderAdapter,
    kind: TaskKind,
    requestedModel?: string,
    priority: ProviderPriority = this.policies.priority(),
  ): ModelSpec {
    const exact = requestedModel
      ? adapter.config.models.find((model) => model.name === requestedModel)
      : undefined;
    if (exact) return exact;
    const requested = requestedModel
      ? this.adapters.flatMap((item) => item.config.models)
        .find((model) => model.name === requestedModel)
      : undefined;
    const desiredKind = requested?.kind ?? (priority === 'quality' ? 'reasoner' : undefined);
    if (!requestedModel && priority === 'cost') {
      return [...adapter.config.models].sort((a, b) =>
        (a.inputPrice + a.outputPrice) - (b.inputPrice + b.outputPrice) ||
        a.name.localeCompare(b.name))[0];
    }
    return adapter.config.models.find((model) => desiredKind && model.kind === desiredKind)
      ?? adapter.routeModel(kind)
      ?? adapter.config.models[0];
  }

  private requestedKind(modelName: string | undefined, fallback: TaskKind | undefined): TaskKind {
    if (!modelName) return fallback ?? 'execute';
    const model = this.adapters.flatMap((adapter) => adapter.config.models).find((item) => item.name === modelName);
    return model?.kind === 'reasoner' ? 'execute' : fallback ?? 'execute';
  }

  private findBetterQuote(
    adapter: ProviderAdapter,
    model: ModelSpec,
    now: Date,
    maxWaitMinutes: number,
    estimate: ProviderCallEstimate,
  ): { at: string; cost: number } | undefined {
    const current = estimateQuoteCost(this.quote(adapter.id, model.name, now), estimate);
    const limit = Math.min(maxWaitMinutes, 7 * 24 * 60);
    for (let minutes = 15; minutes <= limit; minutes += 15) {
      const at = new Date(now.getTime() + minutes * 60_000);
      const cost = estimateQuoteCost(this.quote(adapter.id, model.name, at), estimate);
      if (cost < current * 0.99) return { at: at.toISOString(), cost };
    }
    return undefined;
  }
}

export function inferProviderIntent(
  request: string,
  fallbackPriority: ProviderPriority = 'balanced',
): ProviderIntent {
  const text = request.toLowerCase();
  let priority = fallbackPriority;
  if (/省钱|最低价|便宜|成本|预算|economy|cheap/.test(text)) priority = 'cost';
  if (/马上|立即|尽快|紧急|速度|低延迟|asap|urgent/.test(text)) priority = 'speed';
  if (/复杂|深度|推理|质量|准确|高质量|reason|quality/.test(text)) priority = 'quality';
  // “复杂但优先省钱”这类句子以用户明确写出的优先级为准。
  if (/(?:优先|侧重).{0,4}(?:省钱|成本|低价)|(?:省钱|成本|低价).{0,4}(?:优先|第一)/.test(text)) priority = 'cost';
  if (/(?:优先|侧重).{0,4}(?:速度|立即|时效)|(?:速度|时效).{0,4}(?:优先|第一)/.test(text)) priority = 'speed';
  if (/(?:优先|侧重).{0,4}(?:质量|准确|推理)|(?:质量|准确).{0,4}(?:优先|第一)/.test(text)) priority = 'quality';
  const taskKind: TaskKind = /规划|计划|拆解|plan/.test(text) ? 'plan' : 'execute';
  const tokenMatch = text.match(/(\d+(?:\.\d+)?)\s*(万|千|m|k)?\s*(?:tokens?|令牌)/i);
  const expectedPromptTokens = tokenMatch
    ? Math.max(1, Math.round(Number(tokenMatch[1]) * unitMultiplier(tokenMatch[2])))
    : 10_000;
  const outputMatch = text.match(/输出\s*(\d+(?:\.\d+)?)\s*(万|千|m|k)?\s*(?:tokens?|令牌)?/i);
  const expectedCompletionTokens = outputMatch
    ? Math.max(1, Math.round(Number(outputMatch[1]) * unitMultiplier(outputMatch[2])))
    : 2_000;
  const waitMatch = text.match(/(?:可等|等待?|延后)\s*(\d+(?:\.\d+)?)\s*(分钟|小时|天|min|hours?|days?)/i);
  const maxWaitMinutes = waitMatch ? Math.round(Number(waitMatch[1]) * waitUnitMinutes(waitMatch[2])) : 0;
  const costMatch = text.match(/(?:预算|不超过|最多)\s*(?:¥|￥|rmb)?\s*(\d+(?:\.\d+)?)/i);
  return validateIntent({
    priority,
    taskKind,
    expectedPromptTokens,
    expectedCompletionTokens,
    maxWaitMinutes,
    maxCost: costMatch ? Number(costMatch[1]) : undefined,
  });
}

export function validateIntent(value: ProviderIntent): ProviderIntent {
  if (!['cost', 'balanced', 'speed', 'quality'].includes(value.priority)) throw new Error('priority 非法');
  if (!['plan', 'execute', 'judge', 'summarize'].includes(value.taskKind)) throw new Error('taskKind 非法');
  for (const key of ['expectedPromptTokens', 'expectedCompletionTokens', 'maxWaitMinutes'] as const) {
    if (!Number.isFinite(value[key]) || value[key] < 0) throw new Error(`${key} 非法`);
  }
  if (value.maxCost !== undefined && (!Number.isFinite(value.maxCost) || value.maxCost < 0)) {
    throw new Error('maxCost 非法');
  }
  return {
    priority: value.priority,
    taskKind: value.taskKind,
    expectedPromptTokens: Math.floor(value.expectedPromptTokens),
    expectedCompletionTokens: Math.floor(value.expectedCompletionTokens),
    maxWaitMinutes: Math.min(7 * 24 * 60, Math.floor(value.maxWaitMinutes)),
    maxCost: value.maxCost,
  };
}

export function usageEventFromResult(input: {
  providerId: string;
  model: string;
  quote: PricingQuote;
  promptTokens: number;
  completionTokens: number;
  at?: Date;
}): UsageEvent {
  const actualCost = computeCallCost({
    model: input.quote.model,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    discount: input.quote.discount,
  }).actualCost;
  return {
    at: (input.at ?? new Date()).toISOString(),
    providerId: input.providerId,
    model: input.model,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    actualCost,
  };
}

function estimateCall(messages: Message[], maxTokens?: number): ProviderCallEstimate {
  const chars = messages.reduce((sum, message) => sum + message.content.length, 0);
  return {
    promptTokens: Math.max(1, Math.ceil(chars / 2)),
    completionTokens: Math.max(1, Math.min(maxTokens ?? 1024, 2048)),
  };
}

function candidateScore(
  priority: ProviderPriority,
  model: ModelSpec,
  quote: PricingQuote,
  estimatedCost: number,
  index: number,
): number {
  const unitPrice = (quote.model.inputPrice + quote.model.outputPrice) * quote.discount;
  const qualityPenalty = model.kind === 'reasoner' ? 0 : 100;
  if (priority === 'quality') return qualityPenalty + unitPrice / 1000;
  if (priority === 'speed') return index + (quote.offPeak ? 0.01 : 0);
  if (priority === 'cost') return estimatedCost || unitPrice / 1_000_000;
  return unitPrice + qualityPenalty * 0.05;
}

function unitMultiplier(unit: string | undefined): number {
  if (!unit) return 1;
  if (unit === '万') return 10_000;
  if (unit === '千' || unit.toLowerCase() === 'k') return 1_000;
  if (unit.toLowerCase() === 'm') return 1_000_000;
  return 1;
}

function waitUnitMinutes(unit: string): number {
  if (/天|days?/i.test(unit)) return 24 * 60;
  if (/小时|hours?/i.test(unit)) return 60;
  return 1;
}
