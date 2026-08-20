import type { ProviderAdapter } from '../providers/adapter.js';
import { minutesInBeijing, parseHHMM } from '../time.js';

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

  /** 距离下一个空闲时段还有多久（毫秒）；已在空闲时返回 0；无时段折扣的 provider 返回 null */
  msUntilNextOffPeak(now: Date = new Date()): number | null {
    const nowMin = minutesInBeijing(now); // 北京时间
    let nearest: number | null = null;
    for (const p of this.providers) {
      const peaks = p.config.costStrategy.peakWindows;
      if (!peaks || peaks.length === 0) continue;
      if (p.isOffPeak(now)) return 0; // 已在空闲，现在就能跑
      // 当前在高峰，找最近的高峰结束时刻（即空闲开始）
      for (const w of peaks) {
        const endMin = parseHHMM(w.end);
        const delta = (endMin - nowMin + 24 * 60) % (24 * 60);
        const ms = delta * 60 * 1000;
        if (nearest === null || ms < nearest) nearest = ms;
      }
    }
    return nearest;
  }
}
