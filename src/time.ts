/**
 * 时区工具。
 *
 * nightowl 的低谷时段以北京时间为准（国内平台）。
 * 部署服务器系统时区可能是 UTC，所以必须显式转换，
 * 绝不能用 now.getHours()（它返回服务器本地时区）。
 */

const TIMEZONE = 'Asia/Shanghai';

export interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  dayOfWeek: number;
  hour: number;
  minute: number;
}

/** 获取任意 IANA 时区下的本地日历字段；dayOfWeek 为 0=周日 … 6=周六。 */
export function zonedDateParts(now: Date, timeZone: string): ZonedDateParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  let hour = value('hour');
  if (hour === 24) hour = 0;
  const year = value('year');
  const month = value('month');
  const day = value('day');
  return {
    year,
    month,
    day,
    dayOfWeek: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    hour,
    minute: value('minute'),
  };
}

/** 获取指定时刻在北京时区的一天内分钟数（0-1439） */
export function minutesInBeijing(now: Date): number {
  const parts = zonedDateParts(now, TIMEZONE);
  return parts.hour * 60 + parts.minute;
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
