import type { Blueprint, Evidence, Message, Subtask } from '../types.js';
import type { ChatResult, ProviderAdapter } from '../providers/adapter.js';
import type { CostTracker } from '../cost/tracker.js';

/**
 * LLM 执行器（m2-executor）。
 *
 * 子任务 → 调 provider 模型干活：把蓝图上下文 + 子任务详情组装成
 * prompt，按 TaskKind 路由选模型，调用 provider，把产出落成 evidence。
 *
 * 分层职责：
 *  - buildMessages 是纯函数（组装 prompt，可测试、无 IO）
 *  - execute 是编排逻辑（调 provider，IO 由 adapter 承担）
 *  - 结果（ExecutorResult.evidence）由外层（runtime loop / judge）
 *    回写到 Subtask，executor 自己不改状态机 —— 保持可复用。
 */

/** 一次子任务执行的结果 */
export interface ExecutorResult {
  subtaskId: string;
  /** 模型产出（代码 / 方案 / 结果文本） */
  output: string;
  model: string;
  usage?: ChatResult['usage'];
  /** 执行证据：供 judge 判定时参考 */
  evidence: Evidence[];
}

export interface ExecutorOptions {
  /** 单次调用最大输出 tokens */
  maxTokens?: number;
  /** 成本追踪器（可选，注入后每次执行会记录 token 成本） */
  tracker?: CostTracker;
}

const DEFAULT_MAX_TOKENS = 4096;

export class Executor {
  readonly adapter: ProviderAdapter;
  readonly maxTokens: number;
  private readonly tracker?: CostTracker;

  constructor(adapter: ProviderAdapter, options: ExecutorOptions = {}) {
    this.adapter = adapter;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.tracker = options.tracker;
  }

  /**
   * 构建执行消息（纯函数）。
   * system：蓝图约束 + 里程碑目标；user：子任务详情 + 已有证据。
   */
  buildMessages(bp: Blueprint, subtask: Subtask): Message[] {
    const milestone = bp.milestones.find((m) =>
      m.subtasks.some((s) => s.id === subtask.id),
    );

    const sys: string[] = [];
    sys.push(`你是「${bp.title}」的执行者。`);
    if (bp.description) sys.push(`目标：${bp.description}`);
    if (bp.constraints.length > 0) {
      sys.push('硬约束（必须遵守）：');
      for (const c of bp.constraints) sys.push(`- ${c}`);
    }
    if (milestone) sys.push(`当前里程碑「${milestone.name}」目标：${milestone.goal}`);
    sys.push('你只负责完成当前这一项子任务，不要越界做其他事。');

    const user: string[] = [];
    user.push(`子任务【${subtask.name}】`);
    if (subtask.detail) user.push(`说明：${subtask.detail}`);

    // 上游依赖子任务的产出：作为本任务的参考材料。
    // dogfood 暴露的坑（2026-08-21）：s4-review 依赖 s3-draft，但 executor
    // 只传了本子任务的 evidence，模型永远看不到上游草稿 → 只能答"无法复核"。
    const allSubtasks = bp.milestones.flatMap((m) => m.subtasks);
    const depEvidence: string[] = [];
    for (const depId of subtask.dependencies) {
      const dep = allSubtasks.find((s) => s.id === depId);
      if (!dep) continue;
      for (const e of dep.evidence) {
        if (e.content) depEvidence.push(`[${dep.name} / ${e.kind}] ${e.content}`);
      }
    }
    if (depEvidence.length > 0) {
      user.push('上游子任务产出（完成本任务必需的参考材料）：');
      for (const d of depEvidence) user.push(`- ${d}`);
    }

    if (subtask.evidence.length > 0) {
      user.push('本子任务已积累的证据：');
      for (const e of subtask.evidence) {
        if (e.content) user.push(`- [${e.kind}] ${e.content}`);
      }
    }
    user.push('请给出完成本子任务的具体产出（代码 / 方案 / 结果），并说明它如何满足要求。');

    return [
      { role: 'system', content: sys.join('\n') },
      { role: 'user', content: user.join('\n') },
    ];
  }

  /**
   * 执行单个子任务：选模型 → 调 provider → 收集 evidence。
   * 失败时抛出（由运行时 loop 决定重试 / 标记 blocked）。
   */
  async execute(bp: Blueprint, subtask: Subtask): Promise<ExecutorResult> {
    const spec = this.adapter.routeModel('execute');
    const messages = this.buildMessages(bp, subtask);
    const result = await this.adapter.chat(spec.name, messages, {
      maxTokens: this.maxTokens,
    });
    const at = new Date().toISOString();
    const evidence: Evidence[] = [
      {
        kind: 'log',
        content: `模型 ${result.model} 产出：\n${result.content}`,
        at,
      },
    ];
    if (this.tracker && result.usage) {
      this.tracker.record({
        model: spec,
        kind: 'execute',
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        offPeak: this.adapter.isOffPeak(new Date()),
        discount: this.adapter.currentDiscount(new Date()),
        at: new Date(at),
      });
    }
    return {
      subtaskId: subtask.id,
      output: result.content,
      model: result.model,
      usage: result.usage,
      evidence,
    };
  }
}
