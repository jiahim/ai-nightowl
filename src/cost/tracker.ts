import type { ModelSpec } from '../types.js';

/**
 * 成本追踪（m5-cost）。
 *
 * 记录每次模型调用的 token 用量，按 ModelSpec 定价 + 当前时段折扣算出
 * 实付成本，累计成汇总，验证「低谷时段确实省钱」。
 *
 * 分层职责：
 *   - computeCallCost 是纯函数（定价 + 折扣运算，可测试、无 IO）
 *   - CostTracker 是纯累加器（record / summary / toJSON / fromJSON，无 IO）
 *   - 落盘由外层（runtime / interfaces）用 toJSON/fromJSON 自行持久化
 *
 * 定价模型（人民币 / 百万 tokens）：
 *   - 输入未命中缓存：inputPrice
 *   - 输入命中缓存：cacheHitPrice（缺省退回 inputPrice）
 *   - 输出：outputPrice
 *   - 实付 = 原价 × discount（低谷 5 折 = 0.5）
 *
 * 已知边界：
 *   - cacheHitTokens 默认 0：当前 ChatResult.usage 只带 prompt/completion，
 *     DeepSeek 返回的 prompt_cache_hit_tokens 尚未提取（见 providers/deepseek.ts）；
 *     但 computeCallCost 已支持命中缓存按 cacheHitPrice 计价，为 Kimi/MiniMax
 *     （缓存命中 80-90% off 是其主要省钱维度）留好口子。
 */

const TOKENS_PER_MILLION = 1_000_000;

/** 单次调用成本记录 */
export interface CostEntry {
  /** ISO 时间戳 */
  at: string;
  model: string;
  /** 调用用途（execute / judge / plan / summarize） */
  kind: string;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  /** 是否在低谷（空闲）时段 */
  offPeak: boolean;
  /** 生效折扣（1 = 原价，0.5 = 5 折） */
  discount: number;
  /** 未折扣成本（元） */
  listCost: number;
  /** 折扣后实付成本（元） */
  actualCost: number;
}

/** 累计成本汇总 */
export interface CostSummary {
  calls: number;
  offPeakCalls: number;
  peakCalls: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  /** 累计原价（元） */
  listCost: number;
  /** 累计实付（元） */
  actualCost: number;
  /** 累计节省（元）= listCost - actualCost */
  saved: number;
}

/** 单次调用成本计算入参 */
export interface CallCostInput {
  model: ModelSpec;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens?: number;
  discount?: number;
}

/** 纯函数：算一次调用的原价与折后价（人民币，元） */
export function computeCallCost(input: CallCostInput): {
  listCost: number;
  actualCost: number;
} {
  const prompt = Math.max(0, input.promptTokens);
  const completion = Math.max(0, input.completionTokens);
  const cacheHit = Math.min(Math.max(0, input.cacheHitTokens ?? 0), prompt);
  const miss = prompt - cacheHit;
  const hitPrice = input.model.cacheHitPrice ?? input.model.inputPrice;

  const missCost = (miss / TOKENS_PER_MILLION) * input.model.inputPrice;
  const hitCost = (cacheHit / TOKENS_PER_MILLION) * hitPrice;
  const outCost = (completion / TOKENS_PER_MILLION) * input.model.outputPrice;
  const listCost = missCost + hitCost + outCost;

  const discount = input.discount ?? 1;
  return { listCost, actualCost: listCost * discount };
}

/** 单条成本记录入参 */
export interface RecordInput {
  model: ModelSpec;
  kind: string;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens?: number;
  offPeak: boolean;
  discount: number;
  at?: Date;
}

/** 成本累加器（无 IO，可序列化持久化） */
export class CostTracker {
  private entries: CostEntry[] = [];

  /** 记录一次调用，返回本次成本（元） */
  record(input: RecordInput): number {
    const { listCost, actualCost } = computeCallCost({
      model: input.model,
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      cacheHitTokens: input.cacheHitTokens,
      discount: input.discount,
    });
    this.entries.push({
      at: (input.at ?? new Date()).toISOString(),
      model: input.model.name,
      kind: input.kind,
      promptTokens: Math.max(0, input.promptTokens),
      completionTokens: Math.max(0, input.completionTokens),
      cacheHitTokens: Math.max(0, input.cacheHitTokens ?? 0),
      offPeak: input.offPeak,
      discount: input.discount,
      listCost,
      actualCost,
    });
    return actualCost;
  }

  /** 累计汇总 */
  summary(): CostSummary {
    const s: CostSummary = {
      calls: 0,
      offPeakCalls: 0,
      peakCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      cacheHitTokens: 0,
      listCost: 0,
      actualCost: 0,
      saved: 0,
    };
    for (const e of this.entries) {
      s.calls += 1;
      if (e.offPeak) s.offPeakCalls += 1;
      else s.peakCalls += 1;
      s.promptTokens += e.promptTokens;
      s.completionTokens += e.completionTokens;
      s.cacheHitTokens += e.cacheHitTokens;
      s.listCost += e.listCost;
      s.actualCost += e.actualCost;
    }
    s.saved = s.listCost - s.actualCost;
    return s;
  }

  /** 清空（重新计一轮） */
  reset(): void {
    this.entries = [];
  }

  toJSON(): { entries: CostEntry[] } {
    return { entries: this.entries };
  }

  static fromJSON(data: { entries: CostEntry[] }): CostTracker {
    const t = new CostTracker();
    t.entries = data.entries;
    return t;
  }
}
