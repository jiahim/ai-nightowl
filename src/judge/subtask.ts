import type { Subtask, Verdict, VerdictKind } from '../types.js';

/**
 * 子任务完成判定（m2-judge）。
 *
 * 每个子任务带一个 verdict（kind: llm / check / manual），本模块按 kind
 * 路由到对应判定手段，产出「是否完成 + 原因」。与 MilestoneJudge（聚合整
 * 个里程碑）不同，这里判定**单个子任务**是否达成其完成标准。
 *
 * 三种 kind 的判定手段各不相同，且都涉及 IO（跑模型 / 跑断言 / 问人），
 * 所以由调用方注入回调，本模块只做「组装 + 路由」的纯编排，保持无 IO 可复用：
 *   - llm    ：把子任务 + 证据 + 标准拼成 prompt，交给 llmJudge 判定
 *   - check  ：把 check 标识 / 命令交给 checkFn 跑，返回布尔
 *   - manual ：把标准交给 manualFn 人工确认，返回布尔
 * （回写 status 由外层 runtime loop 负责，judge 不改状态机。）
 */

/** 子任务判定结果 */
export interface SubtaskJudgment {
  subtaskId: string;
  kind: VerdictKind;
  /** 是否判定为完成 */
  done: boolean;
  /** 未完成 / 无法判定的原因（done 时为空） */
  reasons: string[];
  /** 判定细节：llm 的结论原文 / check 失败输出 */
  detail?: string;
}

/** llm 判定函数：读 subtask + prompt + criteria，返回是否通过 + 结论原文 */
export type LlmJudgeFn = (
  subtask: Subtask,
  prompt: string,
  criteria: string[],
) => Promise<{ passed: boolean; detail: string }>;

/** check 判定函数：跑断言 / 命令，返回是否通过 */
export type CheckFn = (subtask: Subtask, check: string) => boolean | Promise<boolean>;

/** manual 判定函数：人工确认，返回是否通过 */
export type ManualFn = (
  subtask: Subtask,
  criteria: string[],
) => boolean | Promise<boolean>;

export interface SubtaskJudgeOptions {
  llmJudge?: LlmJudgeFn;
  checkFn?: CheckFn;
  manualFn?: ManualFn;
}

export class SubtaskJudge {
  private readonly llmJudge?: LlmJudgeFn;
  private readonly checkFn?: CheckFn;
  private readonly manualFn?: ManualFn;

  constructor(options: SubtaskJudgeOptions = {}) {
    this.llmJudge = options.llmJudge;
    this.checkFn = options.checkFn;
    this.manualFn = options.manualFn;
  }

  /**
   * 组装 llm 判定 prompt（纯函数）。
   * verdict.prompt 若提供则作为核心指令，否则用默认指令；
   * 再拼上子任务详情、完成标准、已积累证据。
   */
  buildJudgePrompt(subtask: Subtask, verdict: Verdict): string {
    const parts: string[] = [];
    parts.push(verdict.prompt ?? '请判定以下子任务是否已经完成。');
    parts.push(`子任务【${subtask.name}】`);
    if (subtask.detail) parts.push(`说明：${subtask.detail}`);
    if (verdict.criteria.length > 0) {
      parts.push('完成标准（必须逐条满足）：');
      verdict.criteria.forEach((c, i) => parts.push(`  ${i + 1}. ${c}`));
    }
    if (subtask.evidence.length > 0) {
      parts.push('已积累的证据：');
      for (const e of subtask.evidence) {
        const body = e.content ? e.content : e.path ?? '(无内容)';
        parts.push(`- [${e.kind}] ${body}`);
      }
    } else {
      parts.push('（暂无证据）');
    }
    parts.push('请只回答：done（已完成）或 not_done（未完成），随后用一句话说明理由。');
    return parts.join('\n');
  }

  /** 判定单个子任务是否完成（按 verdict.kind 路由） */
  async judge(subtask: Subtask): Promise<SubtaskJudgment> {
    const v = subtask.verdict;
    switch (v.kind) {
      case 'llm':
        return this.judgeByLlm(subtask, v);
      case 'check':
        return this.judgeByCheck(subtask, v);
      case 'manual':
        return this.judgeByManual(subtask, v);
    }
  }

  private async judgeByLlm(subtask: Subtask, v: Verdict): Promise<SubtaskJudgment> {
    if (!this.llmJudge) {
      return {
        subtaskId: subtask.id,
        kind: 'llm',
        done: false,
        reasons: ['未注入 llmJudge 判定器'],
      };
    }
    const prompt = this.buildJudgePrompt(subtask, v);
    const { passed, detail } = await this.llmJudge(subtask, prompt, v.criteria);
    return {
      subtaskId: subtask.id,
      kind: 'llm',
      done: passed,
      reasons: passed ? [] : ['llm 判定未通过'],
      detail,
    };
  }

  private async judgeByCheck(subtask: Subtask, v: Verdict): Promise<SubtaskJudgment> {
    if (!this.checkFn) {
      return {
        subtaskId: subtask.id,
        kind: 'check',
        done: false,
        reasons: ['未注入 checkFn 判定器'],
      };
    }
    const check = v.check ?? v.criteria.join(' && ');
    const passed = await this.checkFn(subtask, check);
    return {
      subtaskId: subtask.id,
      kind: 'check',
      done: passed,
      reasons: passed ? [] : [`检查未通过：${check}`],
    };
  }

  private async judgeByManual(subtask: Subtask, v: Verdict): Promise<SubtaskJudgment> {
    if (!this.manualFn) {
      return {
        subtaskId: subtask.id,
        kind: 'manual',
        done: false,
        reasons: ['未注入 manualFn 判定器'],
      };
    }
    const passed = await this.manualFn(subtask, v.criteria);
    return {
      subtaskId: subtask.id,
      kind: 'manual',
      done: passed,
      reasons: passed ? [] : ['人工确认未通过'],
    };
  }
}
