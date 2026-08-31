import type { Message, ModelSpec, ProviderConfig, TaskKind } from '../types.js';

/** 不携带上游响应体的安全 Provider 错误；retryable 供故障转移内部判断。 */
export class ProviderRequestError extends Error {
  constructor(
    readonly providerId: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(`${providerId} 请求失败（HTTP ${status}）`);
    this.name = 'ProviderRequestError';
  }
}

/** 模型调用结果 */
export interface ChatResult {
  content: string;
  model: string;
  /** 实际响应平台；故障转移后可能与调用入口 adapter 不同。 */
  providerId?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
  /** 实际使用的模型规格（failover 切平台后可能与请求模型不同；成本按它算） */
  spec?: ModelSpec;
  /** 实际平台在调用时刻的计价上下文。 */
  pricing?: {
    offPeak: boolean;
    discount: number;
    /** 命中的资费规则，便于成本审计与 UI 解释。 */
    ruleId?: string | null;
    label?: string;
    timezone?: string;
    source?: 'provider' | 'configured';
  };
}

export interface ProviderUsageWindow {
  id: string;
  label: string;
  period: 'rolling' | 'week';
  windowMinutes?: number;
  /** Provider 返回的剩余额度百分比；可能因 boost 大于 100。 */
  remainingPercent?: number;
  status: 'available' | 'exhausted' | 'unlimited' | 'unknown';
  resetAt?: string;
}

export interface ProviderRemoteUsage {
  source: 'provider-api';
  fetchedAt: string;
  windows: ProviderUsageWindow[];
  warning?: string;
}

/**
 * 平台适配器接口。
 *
 * 所有平台（DeepSeek / MiniMax / OpenAI / 自定义兼容接口 / ...）都实现这个接口。
 * 成本策略抽象在这里：不同平台省钱维度不同，统一用
 * isOffPeak / currentDiscount / routeModel 三个方法暴露。
 */
export interface ProviderAdapter {
  readonly id: string;
  readonly config: ProviderConfig;

  /** 当前是否处于该平台的空闲（低价）时段（无 peakWindows 的平台恒 false） */
  isOffPeak(now: Date): boolean;

  /** 当前时刻该平台的有效折扣（1 = 原价，0.5 = 5 折） */
  currentDiscount(now: Date): number;

  /** 按任务类型选模型（简单任务降档省钱） */
  routeModel(kind: TaskKind): ModelSpec;

  /** 可选：从 Provider 官方接口读取套餐额度；不支持的平台省略。 */
  queryUsage?(
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ProviderRemoteUsage>;

  /** 调用模型（OpenAI 兼容 chat/completions） */
  chat(
    model: string,
    messages: Message[],
    opts?: { maxTokens?: number; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ChatResult>;
}
