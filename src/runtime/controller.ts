import { randomUUID } from 'node:crypto';
import { NightOwlLoop, type TickReport } from './loop.js';

export type RuntimePhase =
  | 'idle'
  | 'running'
  | 'stopping'
  | 'succeeded'
  | 'blocked'
  | 'cancelled'
  | 'limit-reached'
  | 'failed';

export interface RuntimeSnapshot {
  phase: RuntimePhase;
  active: boolean;
  operationId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  maxTicks: number | null;
  reportCount: number;
  lastReport: TickReport | null;
  recentReports: TickReport[];
  error: string | null;
}

export class RuntimeBusyError extends Error {
  constructor() {
    super('已有后台运行正在进行');
    this.name = 'RuntimeBusyError';
  }
}

/**
 * 把 loop.run 包装为非阻塞后台操作，供 Web/HTTP/MCP 查询与停止。
 * 这是本地单运行控制器；持久化 Run/事件与重启恢复在下一阶段实现。
 */
export class RunController {
  private phase: RuntimePhase = 'idle';
  private operationId: string | null = null;
  private startedAt: string | null = null;
  private finishedAt: string | null = null;
  private maxTicks: number | null = null;
  private reports: TickReport[] = [];
  private error: string | null = null;
  private abortController: AbortController | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly loop: NightOwlLoop,
    private readonly maxRecentReports = 50,
  ) {}

  snapshot(): RuntimeSnapshot {
    const recentReports = this.reports.slice(-this.maxRecentReports);
    return {
      phase: this.phase,
      active: this.phase === 'running' || this.phase === 'stopping',
      operationId: this.operationId,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      maxTicks: this.maxTicks,
      reportCount: this.reports.length,
      lastReport: this.reports.at(-1) ?? null,
      recentReports,
      error: this.error,
    };
  }

  /** 同步兼容 API 使用；后台状态快照仍只暴露最近若干条。 */
  allReports(): TickReport[] {
    return [...this.reports];
  }

  /** 立即返回快照，执行在后台继续。 */
  start(options: { maxTicks?: number } = {}): RuntimeSnapshot {
    if (this.phase === 'running' || this.phase === 'stopping' || this.loop.isRunning()) {
      throw new RuntimeBusyError();
    }

    const maxTicks = Math.min(1000, Math.max(1, Math.floor(options.maxTicks ?? 100)));
    this.phase = 'running';
    this.operationId = randomUUID();
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
    this.maxTicks = maxTicks;
    this.reports = [];
    this.error = null;
    this.abortController = new AbortController();
    this.running = this.execute(maxTicks, this.abortController);
    return this.snapshot();
  }

  /** 请求停止；当前模型调用不可强制中断，但不会再领取下一项。 */
  stop(): RuntimeSnapshot {
    if (this.phase === 'running') {
      this.phase = 'stopping';
      this.abortController?.abort();
    }
    return this.snapshot();
  }

  /** 测试和优雅停机使用：等待当前后台操作收束。 */
  async wait(): Promise<RuntimeSnapshot> {
    await this.running;
    return this.snapshot();
  }

  private async execute(maxTicks: number, controller: AbortController): Promise<void> {
    try {
      const reports = await this.loop.run({
        maxTicks,
        signal: controller.signal,
        onReport: (report) => {
          this.reports.push(report);
        },
      });

      const last = reports.at(-1);
      // 状态事实优先于晚到的 stop：最后一轮已经完成时应报告 succeeded。
      if (last?.done) this.phase = 'succeeded';
      else if (controller.signal.aborted) this.phase = 'cancelled';
      else if (
        last?.terminalReason !== undefined ||
        (last?.blocked ?? 0) > 0 ||
        last?.idleReason === 'no-runnable' ||
        last?.idleReason === 'no-blueprint'
      ) this.phase = 'blocked';
      else if (reports.length >= maxTicks) this.phase = 'limit-reached';
      else this.phase = 'idle';
    } catch {
      this.phase = 'failed';
      this.error = '运行失败；请检查状态文件与 Provider 配置后重试。';
    } finally {
      this.finishedAt = new Date().toISOString();
      this.abortController = null;
      this.running = null;
    }
  }
}
