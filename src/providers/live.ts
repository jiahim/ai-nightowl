import type { Message, ModelSpec, ProviderConfig, TaskKind } from '../types.js';
import type { ChatResult, ProviderAdapter } from './adapter.js';
import { isRetryableProviderError } from './failover.js';
import type { PricingQuote, UsageEvent } from './policy.js';

export interface LiveProviderRouting {
  preferredProvider(): string | undefined;
  isAvailable(adapter: ProviderAdapter): boolean;
  /** 可选的通用策略能力；旧调用方只实现上面两项仍保持原行为。 */
  routeModel?(kind: TaskKind): ModelSpec;
  primaryProvider?(kind: TaskKind): ProviderAdapter;
  orderForCall?(context: {
    requestedModel: string;
    messages: Message[];
    maxTokens?: number;
    now: Date;
  }): Array<[ProviderAdapter, string]> | Promise<Array<[ProviderAdapter, string]>>;
  quote?(providerId: string, model: string, now: Date): PricingQuote;
  recordUsage?(event: UsageEvent): Promise<void>;
  reserveCall?(context: {
    providerId: string;
    model: string;
    messages: Message[];
    maxTokens?: number;
    now: Date;
  }): Promise<string | null>;
  completeReservation?(id: string, event?: UsageEvent): Promise<void>;
}

/**
 * 运行时 Provider 路由器：每次调用都重新读取首选平台与可用密钥，
 * 因而 Web Console 保存设置后无需重启 Node 服务。
 */
export class LiveProviderAdapter implements ProviderAdapter {
  readonly id = 'live-provider';
  readonly config: ProviderConfig;
  private readonly adapters: ProviderAdapter[];
  private readonly byId: Map<string, ProviderAdapter>;

  constructor(adapters: ProviderAdapter[], private readonly routing: LiveProviderRouting) {
    if (adapters.length === 0) throw new Error('LiveProviderAdapter: 至少需要一个平台');
    this.adapters = [...adapters];
    this.byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));
    const models = adapters.flatMap((adapter) => adapter.config.models);
    this.config = {
      id: this.id,
      name: `Live(${adapters.map((adapter) => adapter.id).join('+')})`,
      baseUrl: '',
      apiKeyEnv: '',
      models,
      costStrategy: {},
    };
  }

  isOffPeak(now: Date): boolean {
    const primary = this.primary();
    const model = this.routing.routeModel?.('execute') ?? primary.routeModel('execute');
    return this.routing.quote?.(primary.id, model.name, now).offPeak ?? primary.isOffPeak(now);
  }

  currentDiscount(now: Date): number {
    const primary = this.primary();
    const model = this.routing.routeModel?.('execute') ?? primary.routeModel('execute');
    return this.routing.quote?.(primary.id, model.name, now).discount ?? primary.currentDiscount(now);
  }

  routeModel(kind: TaskKind): ModelSpec {
    return this.routing.routeModel?.(kind) ?? this.primary().routeModel(kind);
  }

  async chat(
    model: string,
    messages: Message[],
    opts?: { maxTokens?: number; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ChatResult> {
    const calledAt = new Date();
    const chain = await (this.routing.orderForCall?.({
      requestedModel: model,
      messages,
      maxTokens: opts?.maxTokens,
      now: calledAt,
    }) ?? this.chainFor(model));
    if (chain.length === 0) {
      throw new Error('没有满足凭据、预算与周期额度约束的 Provider，请在“模型设置”中查看决策说明');
    }

    let lastError: unknown;
    for (const [adapter, targetModel] of chain) {
      const reservationId = this.routing.reserveCall && this.routing.completeReservation
        ? await this.routing.reserveCall({
          providerId: adapter.id,
          model: targetModel,
          messages,
          maxTokens: opts?.maxTokens,
          now: calledAt,
        })
        : undefined;
      if (reservationId === null) continue;
      try {
        const result = await adapter.chat(targetModel, messages, opts);
        const baseSpec = adapter.config.models.find((item) => item.name === result.model)
          ?? adapter.config.models.find((item) => item.name === targetModel);
        const pricedAt = new Date();
        const quote = baseSpec ? this.routing.quote?.(adapter.id, baseSpec.name, pricedAt) : undefined;
        const actual = {
          providerId: adapter.id,
          pricing: quote ? {
            offPeak: quote.offPeak,
            discount: quote.discount,
            ruleId: quote.ruleId,
            label: quote.label,
            timezone: quote.timezone,
            source: quote.source,
          } : result.pricing ?? {
            offPeak: adapter.isOffPeak(pricedAt),
            discount: adapter.currentDiscount(pricedAt),
          },
        };
        const spec = quote?.model ?? baseSpec;
        let usageEvent: UsageEvent | undefined;
        if (spec && (this.routing.recordUsage || reservationId)) {
          // 即使兼容端点没有返回 token usage，也要记录成功请求，才能正确执行
          // requests 类型的滚动/日/周/月额度；未知 token 按 0 记，不猜测费用。
          const promptTokens = Math.max(0, result.usage?.promptTokens ?? 0);
          const completionTokens = Math.max(0, result.usage?.completionTokens ?? 0);
          const discount = actual.pricing.discount;
          const actualCost = (
            (promptTokens / 1_000_000) * spec.inputPrice +
            (completionTokens / 1_000_000) * spec.outputPrice
          ) * discount;
          // 上游调用已经成功，账本写入失败不能触发第二次模型调用。
          usageEvent = {
            at: pricedAt.toISOString(),
            providerId: adapter.id,
            model: result.model,
            promptTokens,
            completionTokens,
            actualCost,
          };
        }
        if (reservationId && this.routing.completeReservation) {
          // 上游已成功，账本失败不能触发重复模型调用。
          await this.routing.completeReservation(reservationId, usageEvent).catch(() => undefined);
        } else if (usageEvent && this.routing.recordUsage) {
          await this.routing.recordUsage(usageEvent).catch(() => undefined);
        }
        return spec ? { ...result, ...actual, spec } : { ...result, ...actual };
      } catch (error) {
        if (reservationId && this.routing.completeReservation) {
          await this.routing.completeReservation(reservationId).catch(() => undefined);
        }
        lastError = error;
        if (!isRetryableProviderError(error)) throw error;
      }
    }
    throw lastError ?? new Error('所有已配置的模型平台都不可用');
  }

  private primary(): ProviderAdapter {
    const managed = this.routing.primaryProvider?.('execute');
    if (managed) return managed;
    const preferred = this.routing.preferredProvider();
    if (preferred && this.byId.has(preferred)) return this.byId.get(preferred)!;
    return this.adapters.find((adapter) => this.routing.isAvailable(adapter)) ?? this.adapters[0];
  }

  private chainFor(model: string): Array<[ProviderAdapter, string]> {
    const primary = this.primary();
    const requestedKind = this.adapters
      .flatMap((adapter) => adapter.config.models)
      .find((item) => item.name === model)?.kind;
    const ordered = [primary, ...this.adapters.filter((adapter) => adapter !== primary)];
    const chain: Array<[ProviderAdapter, string]> = [];
    for (const adapter of ordered) {
      if (!this.routing.isAvailable(adapter)) continue;
      const target = adapter.config.models.find((item) => item.name === model)
        ?? adapter.config.models.find((item) => requestedKind && item.kind === requestedKind)
        ?? adapter.routeModel('execute');
      chain.push([adapter, target.name]);
    }
    return chain;
  }
}
