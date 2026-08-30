import type { Blueprint, Milestone, Subtask, SubtaskStatus } from '../types.js';

/**
 * 计划状态机：管理蓝图 + 子任务 + 里程碑的状态转换。
 *
 * 纯逻辑、无 IO —— 持久化交给 memory/store。
 * 引擎核心的"计划层"：拆分后的任务清单在这里推进状态。
 */
export class PlanState {
  blueprint: Blueprint;

  constructor(blueprint: Blueprint) {
    this.blueprint = blueprint;
  }

  /** 摊平所有子任务 */
  subtasks(): Subtask[] {
    return this.blueprint.milestones.flatMap((m) => m.subtasks);
  }

  getSubtask(id: string): Subtask | undefined {
    return this.subtasks().find((s) => s.id === id);
  }

  getMilestone(id: string): Milestone | undefined {
    return this.blueprint.milestones.find((m) => m.id === id);
  }

  /**
   * 子任务是否可启动：只有 pending 可启动，且所有依赖已 done。
   * blocked 必须显式 retry；in-progress 由运行时在崩溃恢复时处理。
   */
  isRunnable(subtask: Subtask): boolean {
    if (subtask.status !== 'pending') return false;
    return subtask.dependencies.every((depId) => {
      const dep = this.getSubtask(depId);
      return dep !== undefined && dep.status === 'done';
    });
  }

  setSubtaskStatus(id: string, status: SubtaskStatus): void {
    const s = this.getSubtask(id);
    if (s) s.status = status;
  }

  /**
   * 刷新单个里程碑状态：
   * 全部 done → done；任一 blocked → blocked；
   * 有 in-progress 或部分 done → in-progress；否则 pending
   */
  refreshMilestone(milestoneId: string): SubtaskStatus {
    const m = this.getMilestone(milestoneId);
    if (!m) return 'pending';
    const statuses = m.subtasks.map((s) => s.status);
    if (statuses.length === 0) m.status = 'blocked';
    else if (statuses.every((s) => s === 'done')) m.status = 'done';
    else if (statuses.some((s) => s === 'blocked')) m.status = 'blocked';
    else if (statuses.some((s) => s === 'in-progress' || s === 'done')) m.status = 'in-progress';
    else m.status = 'pending';
    return m.status;
  }

  refreshAllMilestones(): void {
    for (const m of this.blueprint.milestones) this.refreshMilestone(m.id);
  }

  /** 当前可执行（依赖已满足且未完成）的子任务 */
  runnableSubtasks(): Subtask[] {
    return this.subtasks().filter((s) => this.isRunnable(s));
  }

  /** 蓝图是否整体完成（所有里程碑 done） */
  isDone(): boolean {
    return this.blueprint.milestones.every((m) => m.status === 'done');
  }
}
