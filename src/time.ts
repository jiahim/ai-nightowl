/**
 * 时区工具。
 *
 * nightowl 的低谷时段以北京时间为准（国内平台）。
 * 部署服务器系统时区可能是 UTC，所以必须显式转换，
 * 绝不能用 now.getHours()（它返回服务器本地时区）。
 */

const TIMEZONE = 'Asia/Shanghai';

/** 获取指定时刻在北京时区的一天内分钟数（0-1439） */
export function minutesInBeijing(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  let hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  if (hour === 24) hour = 0; // 午夜时 Intl 可能返回 24
  return hour * 60 + minute;
}

/** 解析 'HH:MM' 为分钟数 */
export function parseHHMM(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

/** 判断 nowMin（一天内分钟数）是否落在 [start, end] 窗口内（HH:MM，支持跨午夜） */
export function inWindow(nowMin: number, start: string, end: string): boolean {
  const s = parseHHMM(start);
  const e = parseHHMM(end);
  if (s <= e) {
    return nowMin >= s && nowMin < e;
  }
  return nowMin >= s || nowMin < e;
}
