import type { ProviderAdapter } from '../providers/adapter.js';

/**
 * 时间段调度：判断当前是否在低价窗口、算距离下一个窗口多久。
 * 供运行时 loop 决定"现在该不该跑重活"。
 */
export class Scheduler {
  private providers: ProviderAdapter[];

  constructor(providers: ProviderAdapter[]) {
    this.providers = providers;
  }

  /** 是否处于任一 provider 的低价窗口 */
  inAnyOffPeak(now: Date = new Date()): boolean {
    return this.providers.some((p) => p.isOffPeak(now));
  }

  /** 当前折扣最好的 provider（无任何窗口时返回 null） */
  bestOffPeakProvider(now: Date = new Date()): ProviderAdapter | null {
    let best: ProviderAdapter | null = null;
    let bestDiscount = 1;
    for (const p of this.providers) {
      const d = p.currentDiscount(now);
      if (d < bestDiscount) {
        bestDiscount = d;
        best = p;
      }
    }
    return best;
  }

  /**
   * 距离下一个优惠窗口还有多久。按未来八天的分钟粒度探测，因而同时支持
   * 跨午夜、任意时区、工作日/非工作日和人工节假日覆盖；没有优惠返回 null。
   */
  msUntilNextOffPeak(now: Date = new Date()): number | null {
    if (this.providers.some((provider) => provider.isOffPeak(now))) return 0;
    const maxMinutes = 8 * 24 * 60;
    for (let minute = 1; minute <= maxMinutes; minute += 1) {
      const candidate = new Date(now.getTime() + minute * 60_000);
      if (this.providers.some((provider) => provider.isOffPeak(candidate))) {
        return minute * 60_000;
      }
    }
    return null;
  }
}
