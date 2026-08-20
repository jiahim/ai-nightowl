import type { Milestone, SubtaskStatus } from '../types.js';

/**
 * 里程碑聚合判定（m2-milestone）。
 *
 * 纯逻辑、无 IO。判定一个里程碑是否达成，靠两层：
 *   1. 子任务聚合 —— 该里程碑下所有子任务都必须 done；
 *   2. 验收标准（acceptance）—— 逐条验证通过。
 * 两层都满足才算 done；任一子任务 blocked 则整体 blocked。
 *
 * acceptance 的"如何验证"由调用方提供（verifyAcceptance 回调）：
 *   - check 型：跑一段断言/命令返回布尔
 *   - manual 型：问用户
 *   - llm 型：让模型判定
 * 这样把"判定逻辑"和"验证手段"解耦，保持本模块无 IO、可复用。
 * （子任务级别的 llm/check/manual 三态判定属于 m2-judge，另行实现。）
 */

/** 子任务状态聚合计数 */
export interface SubtaskTally {
  total: number;
  done: number;
  inProgress: number;
  blocked: number;
  pending: number;
}

/** 验收标准逐条判定结果 */
export interface AcceptanceVerdict {
  criteria: string[];
  /** 与 criteria 一一对应：是否已验证通过 */
  passed: boolean[];
  allPassed: boolean;
  /** 未通过的验收标准（人类可读，便于报给用户/模型） */
  unmet: string[];
}

/** 里程碑聚合判定的完整结果 */
export interface MilestoneEvaluation {
  milestoneId: string;
  tally: SubtaskTally;
  acceptance: AcceptanceVerdict;
  /** 聚合后的里程碑状态 */
  status: SubtaskStatus;
  done: boolean;
  /** 未达成 / 阻塞的原因（空 = 达成） */
  reasons: string[];
}

/** 验收标准验证器：给定某条标准（及下标），返回是否通过 */
export type AcceptanceVerifier = (criterion: string, index: number) => boolean;

export class MilestoneJudge {
  private readonly verifyAcceptance?: AcceptanceVerifier;

  constructor(verifyAcceptance?: AcceptanceVerifier) {
    this.verifyAcceptance = verifyAcceptance;
  }

  /** 聚合子任务状态计数 */
  tally(milestone: Milestone): SubtaskTally {
    const t: SubtaskTally = {
      total: milestone.subtasks.length,
      done: 0,
      inProgress: 0,
      blocked: 0,
      pending: 0,
    };
    for (const s of milestone.subtasks) {
      switch (s.status) {
        case 'done':
          t.done += 1;
          break;
        case 'in-progress':
          t.inProgress += 1;
          break;
        case 'blocked':
          t.blocked += 1;
          break;
        default:
          t.pending += 1;
          break;
      }
    }
    return t;
  }

  /** 逐条验证验收标准（无验证器时视为全部未通过；空标准视为通过） */
  evaluateAcceptance(milestone: Milestone): AcceptanceVerdict {
    const criteria = milestone.acceptance ?? [];
    const passed = criteria.map((c, i) => {
      if (!this.verifyAcceptance) return false;
      return this.verifyAcceptance(c, i);
    });
    const unmet = criteria.filter((_, i) => !passed[i]);
    return {
      criteria,
      passed,
      allPassed: passed.every(Boolean),
      unmet,
    };
  }

  /**
   * 完整判定：子任务聚合 + 验收标准。
   * 状态推导：
   *   - 任一 blocked → blocked
   *   - 全部 done 且验收全部通过 → done
   *   - 有 in-progress 或部分 done（但未全达成）→ in-progress
   *   - 其余 → pending
   */
  evaluate(milestone: Milestone): MilestoneEvaluation {
    const tally = this.tally(milestone);
    const acceptance = this.evaluateAcceptance(milestone);
    const allDone = tally.total > 0 && tally.done === tally.total;

    const reasons: string[] = [];
    if (tally.blocked > 0) reasons.push(`${tally.blocked} 个子任务被阻塞`);
    if (tally.total === 0) {
      reasons.push('里程碑下没有子任务');
    } else if (!allDone) {
      reasons.push(`还有 ${tally.total - tally.done} 个子任务未完成`);
    }
    for (const u of acceptance.unmet) reasons.push(`验收标准未通过：${u}`);

    let status: SubtaskStatus;
    if (tally.blocked > 0) status = 'blocked';
    else if (allDone && acceptance.allPassed) status = 'done';
    else if (tally.inProgress > 0 || tally.done > 0) status = 'in-progress';
    else status = 'pending';

    return {
      milestoneId: milestone.id,
      tally,
      acceptance,
      status,
      done: status === 'done',
      reasons,
    };
  }
}
