import type { Blueprint, Checkpoint, Message, RollingSummary } from '../types.js';
import type { StoreState } from './store.js';

/**
 * 稳定前缀构造（m3-prefix）。
 *
 * 无限 loop 的模型上下文分成「稳定前缀 + 可变后缀」两段：
 *   稳定前缀 = system 提示词 + 蓝图骨架 + checkpoint 历史
 *   可变后缀 = 滚动摘要（会被 keepSummaries 截断，内容会变）+ 当前工作集
 *
 * 为什么这么分？—— 吃 DeepSeek 的上下文缓存（context caching）。
 * 前缀缓存命中的前提是：prompt 开头的 token 序列逐字节稳定、且顺序确定。
 * 因此：
 *   - 蓝图骨架只渲染「静态结构」（title/constraints/里程碑目标/子任务详情/
 *     依赖/判定标准），**不含 status / evidence / 时间戳**——这些会随 tick 变化；
 *   - checkpoint 是 append-only 的（Store 从不截断 checkpoint），按插入顺序渲染，
 *     新 checkpoint 只追加在末尾，已写部分保持逐字节不变 → 前缀缓存持续命中；
 *   - 滚动摘要会被 keepSummaries 截断（旧摘要被 slice 掉），内容随 tick 变化，
 *     故归入**可变后缀**，绝不放进稳定前缀。
 *
 * 分层职责：本模块全是纯函数（无 IO），只产出 Message[] 供 executor /
 * provider 直接拼接；不触碰状态机、不做持久化。fingerprint 供调用方判断
 * 「前缀何时变化」（新增 checkpoint 时），据此可重置缓存 key。
 */

export interface PrefixOptions {
  /** 系统提示词（角色设定）。缺省用通用文案 */
  systemPrompt?: string;
  /** 是否渲染蓝图骨架（默认 true） */
  includeBlueprint?: boolean;
  /** 是否渲染 checkpoint 历史（默认 true） */
  includeCheckpoints?: boolean;
  /** 是否渲染滚动摘要（归入可变后缀，默认 true） */
  includeRollingSummaries?: boolean;
}

/** 完整上下文分段：稳定前缀 + 可变后缀 + 指纹 */
export interface PrefixContext {
  /** 稳定前缀（system + blueprint + checkpoints），字节级稳定，可吃缓存 */
  prefix: Message[];
  /** 可变后缀（滚动摘要），拼接在前缀之后、当前工作集之前 */
  variable: Message[];
  /** 前缀指纹（djb2 十六进制），变化 = 前缀失效需重算缓存 */
  fingerprint: string;
}

const DEFAULT_SYSTEM_PROMPT =
  '你是 nightowl（夜猫子）—— 自驱动的夜间任务编排引擎。你按蓝图逐项推进子任务、' +
  '判定完成、刷新里程碑，直至整体目标完成。你只负责当前这一项子任务，不越界。';

export class PrefixBuilder {
  private readonly options: Required<PrefixOptions>;

  constructor(options: PrefixOptions = {}) {
    this.options = {
      systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      includeBlueprint: options.includeBlueprint ?? true,
      includeCheckpoints: options.includeCheckpoints ?? true,
      includeRollingSummaries: options.includeRollingSummaries ?? true,
    };
  }

  /**
   * 渲染蓝图骨架（纯函数）：只含静态结构，不含 status / evidence / 时间戳。
   * 里程碑、子任务均按数组顺序遍历（作者定的顺序即稳定顺序）。
   */
  renderBlueprintSkeleton(bp: Blueprint): string {
    const lines: string[] = [];
    lines.push(`# ${bp.title}`);
    if (bp.description) lines.push(`目标：${bp.description}`);
    if (bp.constraints.length > 0) {
      lines.push('硬约束：');
      for (const c of bp.constraints) lines.push(`- ${c}`);
    }
    if (bp.definitionOfDone) lines.push(`完成定义：${bp.definitionOfDone}`);
    lines.push('');
    lines.push('## 里程碑与子任务');
    for (const m of bp.milestones) {
      lines.push(`### ${m.name}（${m.id}）`);
      lines.push(`目标：${m.goal}`);
      if (m.acceptance.length > 0) {
        lines.push('验收标准：');
        m.acceptance.forEach((a, i) => lines.push(`  ${i + 1}. ${a}`));
      }
      for (const st of m.subtasks) {
        const deps = st.dependencies.length > 0 ? `（依赖：${st.dependencies.join('、')}）` : '';
        lines.push(`- [${st.id}] ${st.name}${deps}`);
        if (st.detail) lines.push(`    说明：${st.detail}`);
        if (st.verdict.criteria.length > 0) {
          lines.push(`    判定标准：${st.verdict.criteria.join('；')}`);
        }
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  /** 渲染 checkpoint 历史（纯函数）：按插入顺序，不含时间戳（保持逐字节稳定） */
  renderCheckpoints(checkpoints: Checkpoint[]): string {
    if (checkpoints.length === 0) return '';
    const lines: string[] = ['# 已达成里程碑（checkpoint）'];
    for (const c of checkpoints) {
      lines.push(`- 里程碑「${c.milestoneId}」达成：${c.summary}`);
    }
    return lines.join('\n');
  }

  /** 渲染滚动摘要（纯函数）：归入可变后缀，按 seq 顺序 */
  renderRollingSummaries(summaries: RollingSummary[]): string {
    if (summaries.length === 0) return '';
    const lines: string[] = ['# 滚动进度摘要'];
    summaries.forEach((s) => lines.push(`- [seq ${s.seq}] ${s.content}`));
    return lines.join('\n');
  }

  /** 组装稳定前缀：system + 蓝图骨架 + checkpoint，单条 system 消息（吃前缀缓存） */
  buildStablePrefix(state: StoreState): Message[] {
    const parts: string[] = [this.options.systemPrompt];
    if (this.options.includeBlueprint) {
      const skeleton = this.renderBlueprintSkeleton(state.blueprint);
      if (skeleton) parts.push(skeleton);
    }
    if (this.options.includeCheckpoints) {
      const cps = this.renderCheckpoints(state.checkpoints);
      if (cps) parts.push(cps);
    }
    return [{ role: 'system', content: parts.join('\n\n') }];
  }

  /** 组装可变后缀：滚动摘要（内容会变 / 会被截断），单条 user 消息 */
  buildVariableContext(state: StoreState): Message[] {
    if (!this.options.includeRollingSummaries) return [];
    const summaries = this.renderRollingSummaries(state.rollingSummaries);
    if (!summaries) return [];
    return [{ role: 'user', content: summaries }];
  }

  /** 组装完整上下文：稳定前缀 + 可变后缀 + 指纹（供调用方拼接当前工作集） */
  buildContext(state: StoreState): PrefixContext {
    const prefix = this.buildStablePrefix(state);
    const variable = this.buildVariableContext(state);
    return {
      prefix,
      variable,
      fingerprint: fingerprint(prefix.map((m) => m.content).join('\n\n')),
    };
  }
}

/** djb2 哈希：返回 8 位十六进制指纹（用于判断前缀是否变化） */
export function fingerprint(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
