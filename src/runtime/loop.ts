import type { Blueprint, Milestone } from '../types.js';
import { PlanState } from '../plan/state.js';
import { Store, STORE_SCHEMA_VERSION, type StoreState } from '../memory/store.js';
import { Executor } from '../executor/executor.js';
import { SubtaskJudge } from '../judge/subtask.js';
import { Scheduler } from './scheduler.js';

/** 一次里程碑或整体目标验收的结果。 */
export interface VerificationResult {
  passed: boolean;
  detail: string;
}

export type MilestoneVerifier = (
  milestone: Milestone,
  blueprint: Blueprint,
) => Promise<VerificationResult>;

export type BlueprintVerifier = (blueprint: Blueprint) => Promise<VerificationResult>;

export interface LoopOptions {
  /** 单次 tick 最多推进几个子任务（默认 1，省 token） */
  maxSubtasksPerTick?: number;
  /** tick 之间的间隔（毫秒，默认 60000） */
  pollIntervalMs?: number;
  /** 只在低谷时段跑重活（默认 true） */
  runOffPeakOnly?: boolean;
  /** 里程碑达成时回调（供摘要器接入，可选） */
  onMilestoneDone?: (milestoneId: string, bp: Blueprint) => void | Promise<void>;
  /** 非空 acceptance 的正式验收器；缺失时不会假定通过。 */
  milestoneVerifier?: MilestoneVerifier;
  /** 非空 definitionOfDone 的正式验收器；缺失时不会假定通过。 */
  blueprintVerifier?: BlueprintVerifier;
  /** 注入式 sleep / now（测试用） */
  _sleep?: (ms: number) => Promise<void>;
  _now?: () => Date;
}

export interface TickReport {
  startedAt: string;
  ran: number;
  completed: number;
  blocked: number;
  /** 本 tick 从崩溃遗留的 in-progress 恢复为 pending 的任务数。 */
  recovered?: number;
  /** 本 tick 新通过正式验收的里程碑。 */
  verifiedMilestones?: string[];
  /** 当前状态的阻塞层级；用于控制器在轮数恰好耗尽时仍报告真实终态。 */
  terminalReason?: 'subtask-blocked' | 'milestone-blocked' | 'completion-blocked';
  idleReason?: 'no-blueprint' | 'no-runnable' | 'done';
  done: boolean;
}

export interface RunOptions {
  maxTicks?: number;
  signal?: AbortSignal;
  onReport?: (report: TickReport) => void | Promise<void>;
}

const DEFAULT_POLL_MS = 60_000;

export class LoopBusyError extends Error {
  constructor() {
    super('已有连续运行正在进行');
    this.name = 'LoopBusyError';
  }
}

/**
 * 单蓝图可靠执行循环。
 *
 * 当前版本仍是单运行模型，但所有状态变更都经过一个进程内命令队列，并且
 * 每次命令从 Store 重新加载真相源。因此并发 tick 不会重复领取任务，提交
 * 新蓝图也不会再被旧的内存副本覆盖。跨进程 lease 与多 Run 属于下一阶段。
 */
export class NightOwlLoop {
  private readonly store: Store;
  private readonly executor: Executor;
  private readonly judge: SubtaskJudge;
  private readonly scheduler: Scheduler;
  private readonly maxSubtasksPerTick: number;
  private readonly pollIntervalMs: number;
  private readonly runOffPeakOnly: boolean;
  private readonly onMilestoneDone?: LoopOptions['onMilestoneDone'];
  private readonly milestoneVerifier?: MilestoneVerifier;
  private readonly blueprintVerifier?: BlueprintVerifier;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private commandTail: Promise<void> = Promise.resolve();
  private runActive = false;

  constructor(deps: {
    store: Store;
    executor: Executor;
    judge: SubtaskJudge;
    scheduler: Scheduler;
    options?: LoopOptions;
  }) {
    this.store = deps.store;
    this.executor = deps.executor;
    this.judge = deps.judge;
    this.scheduler = deps.scheduler;
    const o = deps.options ?? {};
    this.maxSubtasksPerTick = Math.max(1, Math.floor(o.maxSubtasksPerTick ?? 1));
    this.pollIntervalMs = Math.max(0, Math.floor(o.pollIntervalMs ?? DEFAULT_POLL_MS));
    this.runOffPeakOnly = o.runOffPeakOnly ?? true;
    this.onMilestoneDone = o.onMilestoneDone;
    this.milestoneVerifier = o.milestoneVerifier;
    this.blueprintVerifier = o.blueprintVerifier;
    this.sleep = o._sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = o._now ?? (() => new Date());
  }

  /** 当前蓝图始终从磁盘读取，避免跨接口的陈旧内存状态。 */
  async blueprint(): Promise<Blueprint | null> {
    return (await this.store.load())?.blueprint ?? null;
  }

  isRunning(): boolean {
    return this.runActive;
  }

  /**
   * 原子替换当前蓝图。与 tick 共用命令队列，因此“执行中提交新蓝图”时，
   * 当前 tick 会先完整落盘，随后新蓝图成为最终状态。
   */
  async replaceBlueprint(blueprint: Blueprint): Promise<void> {
    if (this.runActive) throw new LoopBusyError();
    await this.serialize(async () => {
      await this.store.save({
        schemaVersion: STORE_SCHEMA_VERSION,
        blueprint,
        checkpoints: [],
        rollingSummaries: [],
        updatedAt: '',
        completion: { status: 'pending' },
      });
    });
  }

  /** 供控制 API 做 retry/approve 等小型状态命令；同样与 tick 串行。 */
  async updateState(
    mutate: (state: StoreState) => void | Promise<void>,
  ): Promise<StoreState | null> {
    if (this.runActive) throw new LoopBusyError();
    return this.serialize(async () => {
      const state = await this.store.load();
      if (!state) return null;
      await mutate(state);
      await this.store.save(state);
      return state;
    });
  }

  /** 单次推进；并发调用会按到达顺序串行执行。 */
  async tick(): Promise<TickReport> {
    if (this.runActive) throw new LoopBusyError();
    return this.serialize(() => this.tickUnlocked());
  }

  private async tickUnlocked(signal?: AbortSignal): Promise<TickReport> {
    const startedAt = this.now().toISOString();
    const state = await this.store.load();
    if (!state) {
      return { startedAt, ran: 0, completed: 0, blocked: 0, idleReason: 'no-blueprint', done: false };
    }

    const recovered = this.recoverInterrupted(state);
    const verifiedBefore = await this.refreshMilestones(state);
    const doneBefore = await this.refreshBlueprintCompletion(state);
    await this.checkpointDoneMilestones(state);

    if (doneBefore) {
      await this.store.save(state);
      return {
        startedAt,
        ran: 0,
        completed: 0,
        blocked: 0,
        recovered: recovered || undefined,
        verifiedMilestones: verifiedBefore.length > 0 ? verifiedBefore : undefined,
        idleReason: 'done',
        done: true,
      };
    }

    const plan = new PlanState(state.blueprint);
    const runnable = plan.runnableSubtasks();
    if (runnable.length === 0) {
      await this.store.save(state);
      return {
        startedAt,
        ran: 0,
        completed: 0,
        blocked: 0,
        recovered: recovered || undefined,
        verifiedMilestones: verifiedBefore.length > 0 ? verifiedBefore : undefined,
        terminalReason: this.terminalReason(state),
        idleReason: 'no-runnable',
        done: false,
      };
    }

    const batch = runnable.slice(0, this.maxSubtasksPerTick);
    for (const subtask of batch) subtask.status = 'in-progress';
    // 先保存 lease 状态，页面可见；进程崩溃后下一 tick 会显式恢复。
    await this.store.save(state);

    let completed = 0;
    let blocked = 0;
    let ran = 0;
    for (let index = 0; index < batch.length; index += 1) {
      const subtask = batch[index];
      if (signal?.aborted) {
        for (const unstarted of batch.slice(index)) unstarted.status = 'pending';
        await this.store.save(state);
        break;
      }
      ran += 1;
      try {
        const result = await this.executor.execute(state.blueprint, subtask);
        subtask.evidence.push(...result.evidence);
        const judgment = await this.judge.judge(subtask);
        const at = this.now().toISOString();
        if (judgment.done) {
          subtask.status = 'done';
          completed += 1;
          subtask.evidence.push({
            kind: 'note',
            content: `判定完成：${judgment.detail ?? 'ok'}`,
            at,
          });
        } else {
          subtask.status = 'blocked';
          blocked += 1;
          subtask.evidence.push({
            kind: 'note',
            content: `判定未完成：${judgment.detail ?? judgment.reasons.join('；')}`,
            at,
          });
        }
      } catch (err) {
        subtask.status = 'blocked';
        blocked += 1;
        subtask.evidence.push({
          kind: 'note',
          content: `执行失败：${safeErrorMessage(err)}`,
          at: this.now().toISOString(),
        });
      }
      // 每个子任务的 terminal 状态先落盘，再调用外部验收器。即使验收进程
      // 随后崩溃，也只会重试验收，不会重复有副作用的 Executor 调用。
      await this.store.save(state);
    }

    const verifiedAfter = await this.refreshMilestones(state);
    const done = await this.refreshBlueprintCompletion(state);
    await this.checkpointDoneMilestones(state);
    await this.store.save(state);

    const verified = [...new Set([...verifiedBefore, ...verifiedAfter])];
    return {
      startedAt,
      ran,
      completed,
      blocked,
      recovered: recovered || undefined,
      verifiedMilestones: verified.length > 0 ? verified : undefined,
      terminalReason: this.terminalReason(state),
      done,
    };
  }

  private terminalReason(state: StoreState): TickReport['terminalReason'] {
    if (state.completion.status === 'blocked') return 'completion-blocked';
    if (state.blueprint.milestones.some((milestone) =>
      milestone.status === 'blocked' && milestone.subtasks.every((subtask) => subtask.status === 'done')
    )) return 'milestone-blocked';
    if (state.blueprint.milestones.some((milestone) =>
      milestone.subtasks.some((subtask) => subtask.status === 'blocked')
    )) return 'subtask-blocked';
    return undefined;
  }

  /** 崩溃可能留下 in-progress；单进程重启后将其恢复为可重试 pending。 */
  private recoverInterrupted(state: StoreState): number {
    let recovered = 0;
    for (const subtask of state.blueprint.milestones.flatMap((m) => m.subtasks)) {
      if (subtask.status !== 'in-progress') continue;
      subtask.status = 'pending';
      subtask.evidence.push({
        kind: 'note',
        content: '检测到上次运行中断，已恢复为待执行。',
        at: this.now().toISOString(),
      });
      recovered += 1;
    }
    return recovered;
  }

  /** 根据子任务状态聚合，并对已完成子任务的里程碑执行 acceptance 验收。 */
  private async refreshMilestones(state: StoreState): Promise<string[]> {
    const verified: string[] = [];
    for (const milestone of state.blueprint.milestones) {
      const statuses = milestone.subtasks.map((s) => s.status);
      if (statuses.length === 0) {
        milestone.status = 'blocked';
        continue;
      }
      if (statuses.some((s) => s === 'blocked')) {
        milestone.status = 'blocked';
        continue;
      }
      if (!statuses.every((s) => s === 'done')) {
        milestone.status = statuses.some((s) => s === 'done' || s === 'in-progress')
          ? 'in-progress'
          : 'pending';
        continue;
      }
      if (milestone.status === 'done') continue;
      if (milestone.status === 'blocked') continue; // 必须显式 retry acceptance

      if (milestone.acceptance.length === 0) {
        milestone.status = 'done';
        verified.push(milestone.id);
        continue;
      }
      if (!this.milestoneVerifier) {
        milestone.status = 'blocked';
        this.addMilestoneNote(milestone, '里程碑验收被阻塞：未配置 milestoneVerifier。');
        continue;
      }

      let verdict: VerificationResult;
      try {
        verdict = await this.milestoneVerifier(milestone, state.blueprint);
      } catch (err) {
        milestone.status = 'blocked';
        this.addMilestoneNote(milestone, `里程碑验收执行失败：${safeErrorMessage(err)}`);
        continue;
      }
      if (verdict.passed) {
        milestone.status = 'done';
        verified.push(milestone.id);
        this.addMilestoneNote(milestone, `里程碑验收通过：${verdict.detail}`);
      } else {
        milestone.status = 'blocked';
        this.addMilestoneNote(milestone, `里程碑验收未通过：${verdict.detail}`);
      }
    }
    return verified;
  }

  /** 整体 DoD 使用独立状态，避免“所有里程碑 done”被直接当成最终完成。 */
  private async refreshBlueprintCompletion(state: StoreState): Promise<boolean> {
    state.completion ??= { status: 'pending' };
    const allMilestonesDone =
      state.blueprint.milestones.length > 0 &&
      state.blueprint.milestones.every((m) => m.status === 'done');

    if (!allMilestonesDone) {
      if (state.completion.status === 'done') state.completion = { status: 'pending' };
      return false;
    }
    if (state.completion.status === 'done') return true;
    if (state.completion.status === 'blocked') return false;

    const definition = state.blueprint.definitionOfDone.trim();
    if (!definition) {
      state.completion = { status: 'done', detail: '未配置额外完成定义。', at: this.now().toISOString() };
      return true;
    }
    if (!this.blueprintVerifier) {
      state.completion = {
        status: 'blocked',
        detail: '整体完成验收被阻塞：未配置 blueprintVerifier。',
        at: this.now().toISOString(),
      };
      return false;
    }

    let verdict: VerificationResult;
    try {
      verdict = await this.blueprintVerifier(state.blueprint);
    } catch (err) {
      state.completion = {
        status: 'blocked',
        detail: `整体完成验收执行失败：${safeErrorMessage(err)}`,
        at: this.now().toISOString(),
      };
      return false;
    }
    state.completion = {
      status: verdict.passed ? 'done' : 'blocked',
      detail: verdict.detail,
      at: this.now().toISOString(),
    };
    return verdict.passed;
  }

  private addMilestoneNote(milestone: Milestone, content: string): void {
    const target = milestone.subtasks.at(-1);
    if (!target) return;
    target.evidence.push({ kind: 'note', content, at: this.now().toISOString() });
  }

  /** 里程碑达成时落一份确定性 checkpoint。 */
  private async checkpointDoneMilestones(state: StoreState): Promise<void> {
    const already = new Set(state.checkpoints.map((c) => c.milestoneId));
    for (const milestone of state.blueprint.milestones) {
      if (milestone.status !== 'done' || already.has(milestone.id)) continue;
      state.checkpoints.push({
        milestoneId: milestone.id,
        summary: `里程碑「${milestone.name}」达成：${milestone.subtasks.length} 个子任务全部完成并通过验收。${milestone.goal}`,
        at: this.now().toISOString(),
      });
      // checkpoint 先持久化再调用扩展回调；崩溃恢复时 already 集合会阻止
      // 对外部回调的重复调用。完整 outbox/投递确认语义留给耐久 Event 阶段。
      await this.store.save(state);
      try {
        await this.onMilestoneDone?.(milestone.id, state.blueprint);
      } catch (err) {
        this.addMilestoneNote(milestone, `里程碑完成回调失败：${safeErrorMessage(err)}`);
      }
    }
  }

  /** 自驱动外壳：直到完成、阻塞、取消或达到 maxTicks。 */
  async run(options: RunOptions = {}): Promise<TickReport[]> {
    if (this.runActive) throw new LoopBusyError();
    this.runActive = true;
    const maxTicks = options.maxTicks === undefined
      ? 100
      : Math.max(0, Math.floor(options.maxTicks));
    const reports: TickReport[] = [];

    try {
      while (reports.length < maxTicks && !options.signal?.aborted) {
        if (this.runOffPeakOnly) {
          const wait = this.scheduler.msUntilNextOffPeak(this.now());
          if (wait !== null && wait > 0) {
            const poll = Math.max(1_000, this.pollIntervalMs);
            await this.wait(Math.min(wait, poll), options.signal);
            continue;
          }
        }

        const report = await this.serialize(() => this.tickUnlocked(options.signal));
        reports.push(report);
        await options.onReport?.(report);

        if (report.done || report.ran === 0 || options.signal?.aborted) break;
        await this.wait(this.pollIntervalMs, options.signal);
      }
      return reports;
    } finally {
      this.runActive = false;
    }
  }

  private async wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0 || signal?.aborted) return;
    if (!signal) {
      await this.sleep(ms);
      return;
    }
    let onAbort: () => void = () => undefined;
    const aborted = new Promise<void>((resolve) => {
      onAbort = resolve;
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([this.sleep(ms), aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.commandTail.then(work, work);
    this.commandTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

/** 避免把上游长响应或潜在敏感内容完整写进状态。 */
function safeErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(
      /((?:api[_-]?key|access[_-]?token|secret|authorization)\s*[:=]\s*)["']?[^\s,"']+/gi,
      '$1[REDACTED]',
    )
    .slice(0, 1000);
}
