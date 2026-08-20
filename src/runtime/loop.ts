import type { Blueprint } from '../types.js';
import { PlanState } from '../plan/state.js';
import { Store, type StoreState } from '../memory/store.js';
import { Executor } from '../executor/executor.js';
import { SubtaskJudge } from '../judge/subtask.js';
import { Scheduler } from './scheduler.js';

/**
 * 自驱动事件循环（m3-loop）。
 *
 * 把前面几层串起来：低谷时段唤醒 → tick 推进（挑可运行子任务 → 执行 →
 * 判定 → 回写状态 → 刷新里程碑 → 落盘）。无限循环能存活的关键：
 * 每一步进度都写回 Store（磁盘），tick 之间不依赖任何内存上下文。
 *
 * 分层职责：
 *   - tick() 是核心推进单元（纯编排，IO 由 executor / judge / store 承担）
 *   - run() 是自驱动外壳：低谷唤醒 + 反复 tick，直到 done 或卡住（无进展）
 *   - LLM 滚动摘要（上下文压缩）属于 m3-memory，本模块只在里程碑达成时
 *     落一份确定性 checkpoint（无 LLM），m3-memory 后续可替换为 LLM 摘要。
 *
 * 已知边界（留待后续层接入，非本轮 blocker）：
 *   - 里程碑 status 暂按「子任务聚合」推进（PlanState.refreshAllMilestones），
 *     里程碑 acceptance 标准的验证由 MilestoneJudge.evaluate + verifyAcceptance
 *     承担，m3-memory / interfaces 层接入后可在达成前再做一次验收把关。
 *   - 判定 not_done 或执行失败的子任务标为 blocked（记录原因），重试策略
 *     （如限次重试 / 退避）留待后续细化。
 */

export interface LoopOptions {
  /** 单次 tick 最多推进几个子任务（默认 1，省 token） */
  maxSubtasksPerTick?: number;
  /** 非低谷时轮询间隔（毫秒，默认 60000） */
  pollIntervalMs?: number;
  /** 只在低谷时段跑重活（默认 true） */
  runOffPeakOnly?: boolean;
  /** 里程碑达成时回调（供 m3-memory 生成 LLM 摘要，可选） */
  onMilestoneDone?: (milestoneId: string, bp: Blueprint) => void | Promise<void>;
  /** 注入式 sleep / now（测试用） */
  _sleep?: (ms: number) => Promise<void>;
  _now?: () => Date;
}

export interface TickReport {
  /** 本 tick 开始时刻（ISO） */
  startedAt: string;
  /** 本 tick 实际推进的子任务数 */
  ran: number;
  completed: number;
  blocked: number;
  /** 未推进的原因（无蓝图 / 无子任务可运行 / 已完成） */
  idleReason?: 'no-blueprint' | 'no-runnable' | 'done';
  /** 蓝图整体是否完成 */
  done: boolean;
}

const DEFAULT_POLL_MS = 60_000;

export class NightOwlLoop {
  private readonly store: Store;
  private readonly executor: Executor;
  private readonly judge: SubtaskJudge;
  private readonly scheduler: Scheduler;
  private readonly maxSubtasksPerTick: number;
  private readonly pollIntervalMs: number;
  private readonly runOffPeakOnly: boolean;
  private readonly onMilestoneDone?: LoopOptions['onMilestoneDone'];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;

  /** 内存里的工作副本；从磁盘加载一次后持续使用，每次 tick 结束落盘 */
  private state: StoreState | null = null;

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
    this.maxSubtasksPerTick = o.maxSubtasksPerTick ?? 1;
    this.pollIntervalMs = o.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.runOffPeakOnly = o.runOffPeakOnly ?? true;
    this.onMilestoneDone = o.onMilestoneDone;
    this.sleep = o._sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.now = o._now ?? (() => new Date());
  }

  /** 从磁盘加载状态（仅首次）；已加载则直接返回 */
  private async ensureLoaded(): Promise<StoreState | null> {
    if (this.state === null) {
      this.state = await this.store.load();
    }
    return this.state;
  }

  /** 当前蓝图（未加载 / 无状态时返回 null） */
  async blueprint(): Promise<Blueprint | null> {
    return (await this.ensureLoaded())?.blueprint ?? null;
  }

  /**
   * 单次推进。挑一个（批）可运行子任务：执行 → 判定 → 回写状态 →
   * 刷新里程碑 → （里程碑达成时）落 checkpoint → 落盘。返回本 tick 报告。
   */
  async tick(): Promise<TickReport> {
    const startedAt = this.now().toISOString();
    await this.ensureLoaded();

    if (!this.state) {
      return { startedAt, ran: 0, completed: 0, blocked: 0, idleReason: 'no-blueprint', done: false };
    }

    const bp = this.state.blueprint;
    const plan = new PlanState(bp);

    if (plan.isDone()) {
      return { startedAt, ran: 0, completed: 0, blocked: 0, idleReason: 'done', done: true };
    }

    const runnable = plan.runnableSubtasks();
    if (runnable.length === 0) {
      return { startedAt, ran: 0, completed: 0, blocked: 0, idleReason: 'no-runnable', done: false };
    }

    const batch = runnable.slice(0, this.maxSubtasksPerTick);
    let completed = 0;
    let blocked = 0;

    for (const st of batch) {
      st.status = 'in-progress';
      try {
        const result = await this.executor.execute(bp, st);
        st.evidence.push(...result.evidence);

        const judgment = await this.judge.judge(st);
        const at = this.now().toISOString();
        if (judgment.done) {
          st.status = 'done';
          completed += 1;
          st.evidence.push({
            kind: 'note',
            content: `判定完成：${judgment.detail ?? 'ok'}`,
            at,
          });
        } else {
          st.status = 'blocked';
          blocked += 1;
          st.evidence.push({
            kind: 'note',
            content: `判定未完成：${judgment.detail ?? judgment.reasons.join('；')}`,
            at,
          });
        }
      } catch (err) {
        st.status = 'blocked';
        blocked += 1;
        st.evidence.push({
          kind: 'note',
          content: `执行失败：${(err as Error).message}`,
          at: this.now().toISOString(),
        });
      }
    }

    plan.refreshAllMilestones();
    await this.checkpointDoneMilestones(plan);

    // 每个 tick 结束都落盘，保证崩溃 / 重启后进度不丢
    await this.store.save(this.state);

    return {
      startedAt,
      ran: batch.length,
      completed,
      blocked,
      done: plan.isDone(),
    };
  }

  /** 里程碑达成时落一份确定性 checkpoint（LLM 摘要由 m3-memory 接管） */
  private async checkpointDoneMilestones(plan: PlanState): Promise<void> {
    if (!this.state) return;
    const already = new Set(this.state.checkpoints.map((c) => c.milestoneId));
    for (const m of plan.blueprint.milestones) {
      if (m.status !== 'done' || already.has(m.id)) continue;
      this.state.checkpoints.push({
        milestoneId: m.id,
        summary: `里程碑「${m.name}」达成：${m.subtasks.length} 个子任务全部完成。${m.goal}`,
        at: this.now().toISOString(),
      });
      await this.onMilestoneDone?.(m.id, plan.blueprint);
    }
  }

  /**
   * 自驱动外壳：低谷唤醒 + 反复 tick，直到 done 或卡住（无进展）。
   * 卡住（ran=0）时停下来，等外部处理 blocker，不做空转。
   * maxTicks 用于限定轮数（测试 / 单次批跑），默认无限。
   */
  async run(options?: { maxTicks?: number }): Promise<TickReport[]> {
    const maxTicks = options?.maxTicks ?? Infinity;
    const reports: TickReport[] = [];
    let ticks = 0;

    while (ticks < maxTicks) {
      // 低谷唤醒：不在低价窗口时，睡到下一个窗口（或轮询间隔，取小者）
      if (this.runOffPeakOnly) {
        const wait = this.scheduler.msUntilNextOffPeak(this.now());
        if (wait !== null && wait > 0) {
          await this.sleep(Math.min(wait, this.pollIntervalMs));
          continue;
        }
      }

      const report = await this.tick();
      reports.push(report);
      ticks += 1;

      if (report.done) break;
      if (report.ran === 0) break; // 无蓝图 / 无可运行子任务：停下来等外部处理
      await this.sleep(this.pollIntervalMs);
    }

    return reports;
  }
}
