import type { Blueprint, Evidence, Milestone, RollingSummary } from '../types.js';
import type { StoreState } from './store.js';

/**
 * 滚动摘要引擎（m3-memory）。
 *
 * 无限 loop 靠「落盘状态机 + 上下文压缩」存活。checkpoint（里程碑达成摘要）
 * 已由 runtime/loop 在里程碑达成时落一份确定性摘要；本模块补齐另一半——
 * 「滚动摘要」：把不断累积的执行证据（evidence）压缩成 RollingSummary，
 * 旧摘要按 keepSummaries 截断，模型上下文永远只承载「稳定前缀 + 最近摘要」，
 * 历史细节由 checkpoint + 滚动摘要承载，不会无限膨胀。
 *
 * 分层职责（与 m2-judge / m2-milestone 同一套注入模式）：
 *   - collectSince / buildSummaryPrompt / fallbackSummary 是纯函数（无 IO，可测）
 *   - compress 是编排逻辑：收集 → 组装 prompt → 交给 summarizeFn（LLM）产出摘要；
 *     未注入 summarizeFn 时退化为确定性拼接（保证离线 / 无 key 也能跑）
 *   - 本模块只产出 RollingSummary 并回写 StoreState.rollingSummaries，
 *     持久化仍由 Store.save 负责（调用方负责调 store.save 落盘）
 *
 * 水位线语义：RollingSummary.since 表示「本摘要已覆盖到的最后一条证据时间戳」。
 *   - 首次压缩：收集全部证据，since = 最新证据时间戳
 *   - 后续压缩：只收集 at > since 的新证据，避免重复摘要
 *   - 重启后从 since 续跑，不丢进度、不重复压缩
 * 注意：时间戳比较用字符串比较，要求所有 at 为同精度 ISO 8601
 * （内部统一用 new Date().toISOString() 生成，满足此前提）。
 */

/** LLM 摘要函数：读 prompt，返回摘要文本 */
export type SummarizeFn = (prompt: string) => Promise<string>;

export interface SummarizerOptions {
  /** LLM 摘要函数；缺省时用确定性 fallback */
  summarizeFn?: SummarizeFn;
  /** 确定性 fallback 摘要的最大字符数（默认 2000） */
  maxFallbackChars?: number;
  /** 保留的滚动摘要数量（默认 5，与 Store.addCheckpoint 截断一致） */
  keepSummaries?: number;
}

/** 待摘要的单条执行证据（含子任务 / 里程碑上下文） */
export interface SummarizeItem {
  subtaskId: string;
  subtaskName: string;
  milestoneName: string;
  kind: Evidence['kind'];
  content: string;
  at: string;
}

const EPOCH = '1970-01-01T00:00:00.000Z';
const DEFAULT_MAX_FALLBACK_CHARS = 2000;
const DEFAULT_KEEP_SUMMARIES = 5;

export class Summarizer {
  private readonly summarizeFn?: SummarizeFn;
  private readonly maxFallbackChars: number;
  private readonly keepSummaries: number;

  constructor(options: SummarizerOptions = {}) {
    this.summarizeFn = options.summarizeFn;
    this.maxFallbackChars = options.maxFallbackChars ?? DEFAULT_MAX_FALLBACK_CHARS;
    this.keepSummaries = options.keepSummaries ?? DEFAULT_KEEP_SUMMARIES;
  }

  /** 收集时间戳严格晚于 since 的所有执行证据（含上下文），纯函数 */
  collectSince(bp: Blueprint, since: string): SummarizeItem[] {
    const items: SummarizeItem[] = [];
    for (const m of bp.milestones) {
      for (const st of m.subtasks) {
        for (const e of st.evidence) {
          if (e.at > since) {
            items.push({
              subtaskId: st.id,
              subtaskName: st.name,
              milestoneName: m.name,
              kind: e.kind,
              content: e.content ?? e.path ?? '',
              at: e.at,
            });
          }
        }
      }
    }
    return items;
  }

  /** 组装滚动摘要 prompt（纯函数） */
  buildSummaryPrompt(bp: Blueprint, items: SummarizeItem[], since: string): string {
    const lines: string[] = [];
    lines.push(`你是「${bp.title}」的进度记录员。`);
    lines.push(`请把自 ${since} 以来的 ${items.length} 条执行证据压缩成一份简洁的滚动摘要。`);
    lines.push('要求：保留关键产出、结论、失败原因与阻塞点；丢弃冗余与流水账；中文、不超过 400 字。');
    lines.push('');
    lines.push('待摘要的执行证据：');
    for (const it of items) {
      const body = it.content.trim() || '(无内容)';
      lines.push(`- [${it.milestoneName}/${it.subtaskName}][${it.kind}] ${body}`);
    }
    return lines.join('\n');
  }

  /** 确定性 fallback 摘要（无 LLM 时也能产出，纯函数） */
  fallbackSummary(items: SummarizeItem[], maxChars: number = this.maxFallbackChars): string {
    const lines: string[] = [`（确定性摘要，未接入 LLM）共 ${items.length} 条证据：`];
    for (const it of items) {
      const body = (it.content || '').replace(/\s+/g, ' ').trim();
      const snippet = body.length > 120 ? `${body.slice(0, 120)}…` : body || '(无内容)';
      lines.push(`- [${it.subtaskName}] ${snippet}`);
    }
    let out = lines.join('\n');
    if (out.length > maxChars) out = `${out.slice(0, maxChars)}…`;
    return out;
  }

  /** 已摘要水位线：最后一份滚动摘要的 since（无则 EPOCH） */
  lastWatermark(state: StoreState): string {
    const last = state.rollingSummaries[state.rollingSummaries.length - 1];
    return last ? last.since : EPOCH;
  }

  /** 下一个摘要序号（递增） */
  nextSeq(state: StoreState): number {
    const last = state.rollingSummaries[state.rollingSummaries.length - 1];
    return last ? last.seq + 1 : 1;
  }

  /** 新水位线 = 覆盖到的最后一条证据时间戳 */
  private newSince(items: SummarizeItem[], fallback: string): string {
    return items.reduce((max, it) => (it.at > max ? it.at : max), fallback);
  }

  /**
   * 滚动压缩：把 since 之后（缺省 = 已摘要水位线之后）的新证据压缩成一份
   * RollingSummary 并回写 state.rollingSummaries（按 keepSummaries 截断）。
   * 无新证据时返回 null（调用方据此跳过 store.save）。
   */
  async compress(state: StoreState, since?: string): Promise<RollingSummary | null> {
    const watermark = since ?? this.lastWatermark(state);
    const items = this.collectSince(state.blueprint, watermark);
    if (items.length === 0) return null;

    const content = this.summarizeFn
      ? await this.summarizeFn(this.buildSummaryPrompt(state.blueprint, items, watermark))
      : this.fallbackSummary(items);

    const summary: RollingSummary = {
      content,
      since: this.newSince(items, watermark),
      seq: this.nextSeq(state),
    };
    state.rollingSummaries.push(summary);
    state.rollingSummaries = state.rollingSummaries.slice(-this.keepSummaries);
    return summary;
  }

  /**
   * 里程碑达成时的 checkpoint 摘要（LLM 或确定性）。
   * 供 runtime/loop 在落 checkpoint 前调用，替代内联的确定性摘要，
   * 得到更高质量的里程碑归档（读该里程碑所有子任务的证据）。
   */
  async summarizeMilestone(bp: Blueprint, milestone: Milestone): Promise<string> {
    const items: SummarizeItem[] = [];
    for (const st of milestone.subtasks) {
      for (const e of st.evidence) {
        items.push({
          subtaskId: st.id,
          subtaskName: st.name,
          milestoneName: milestone.name,
          kind: e.kind,
          content: e.content ?? e.path ?? '',
          at: e.at,
        });
      }
    }

    if (this.summarizeFn && items.length > 0) {
      const lines: string[] = [];
      lines.push(`里程碑「${milestone.name}」已达成（${milestone.subtasks.length} 个子任务全部完成）。`);
      lines.push(`目标：${milestone.goal}`);
      lines.push('请依据下列各子任务的产出证据，写一段里程碑归档摘要（成果 + 关键产出，中文，不超过 300 字）：');
      for (const it of items) {
        const body = it.content.trim() || '(无内容)';
        lines.push(`- [${it.subtaskName}][${it.kind}] ${body}`);
      }
      return await this.summarizeFn(lines.join('\n'));
    }

    // 确定性 fallback：里程碑目标 + 各子任务产出摘要
    const parts: string[] = [
      `里程碑「${milestone.name}」达成：${milestone.subtasks.length} 个子任务全部完成。${milestone.goal}`,
    ];
    for (const st of milestone.subtasks) {
      const snippet = st.evidence
        .map((e) => (e.content ?? e.path ?? '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 2)
        .join(' | ');
      parts.push(`- ${st.name}${snippet ? `：${snippet.slice(0, 160)}` : ''}`);
    }
    return parts.join('\n');
  }
}
