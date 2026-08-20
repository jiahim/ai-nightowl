import type { Message, ModelSpec, ProviderConfig, TaskKind } from '../types.js';

/** 模型调用结果 */
export interface ChatResult {
  content: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
}

/**
 * 平台适配器接口。
 *
 * 所有国内平台（DeepSeek / Kimi / MiniMax / ...）都实现这个接口。
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

  /** 调用模型（OpenAI 兼容 chat/completions） */
  chat(model: string, messages: Message[], opts?: { maxTokens?: number }): Promise<ChatResult>;
}
