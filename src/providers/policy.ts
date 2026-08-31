import type { ModelSpec, ProviderConfig, ProviderUsageLimitSpec } from '../types.js';
import type { ProviderRemoteUsage } from './adapter.js';
import { inWindow, zonedDateParts } from '../time.js';

export type BillingDayType = 'any' | 'working-day' | 'non-working-day';
export type UsageLimitPeriod = ProviderUsageLimitSpec['period'];
export type UsageLimitUnit = 'requests' | 'tokens' | 'cost';
export type ProviderPriority = 'cost' | 'balanced' | 'speed' | 'quality';

export interface PriceRate {
  /** 绝对输入价（元 / 百万 tokens）；省略时沿用模型目录价。 */
  inputPrice?: number;
  /** 绝对输出价（元 / 百万 tokens）；省略时沿用模型目录价。 */
  outputPrice?: number;
  /** 绝对缓存命中价（元 / 百万 tokens）；省略时沿用模型目录价。 */
  cacheHitPrice?: number;
  /** 对上述价格再乘的系数；0.5 表示五折。 */
  multiplier?: number;
}

export interface PricingWindow {
  start: string;
  end: string;
}

/**
 * 一条资费规则。规则可同时约束模型、工作日类型、星期与时段；
 * 多条同时命中时 priority 较大的规则生效，同 priority 后声明者优先。
 */
export interface PricingRule {
  id: string;
  label: string;
  models?: string[];
  dayType?: BillingDayType;
  /** 0=周日、1=周一 … 6=周六。 */
  daysOfWeek?: number[];
  windows?: PricingWindow[];
  rate: PriceRate;
  priority?: number;
}

export interface UsageLimit extends ProviderUsageLimitSpec {}

export interface ProviderPolicy {
  /** IANA 时区，例如 Asia/Shanghai。 */
  timezone: string;
  /** 0=周日；默认 [0, 6]。 */
  weekendDays: number[];
  /** YYYY-MM-DD；优先级高于 weekendDays。 */
  nonWorkingDates: string[];
  /** YYYY-MM-DD；用于补班，优先级高于 nonWorkingDates。 */
  workingDates: string[];
  /** 没有规则命中时使用；省略即模型目录原价。 */
  defaultRate?: PriceRate;
  pricingRules: PricingRule[];
  usageLimits: UsageLimit[];
}

export interface PricingQuote {
  providerId: string;
  model: ModelSpec;
  at: string;
  timezone: string;
  ruleId: string | null;
  label: string;
  offPeak: boolean;
  discount: number;
  source: 'provider' | 'configured';
}

export interface UsageEvent {
  at: string;
  providerId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  actualCost: number;
}

export interface UsageLimitStatus extends UsageLimit {
  used: number;
  remaining: number;
  ratio: number;
  warning: boolean;
  exhausted: boolean;
  periodKey: string;
}

export interface ProviderCallEstimate {
  promptTokens: number;
  completionTokens: number;
  requests?: number;
}

export interface ProviderCandidate {
  providerId: string;
  providerName: string;
  model: string;
  eligible: boolean;
  estimatedCost: number;
  currentRate: PricingQuote;
  usageLimits: UsageLimitStatus[];
  remoteUsage?: ProviderRemoteUsage;
  reasons: string[];
  warnings: string[];
  score: number;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function defaultProviderPolicy(config: ProviderConfig): ProviderPolicy {
  const strategy = config.costStrategy;
  const discount = strategy.offPeakDiscount ?? 1;
  const peaks = strategy.peakWindows ?? [];
  return {
    timezone: strategy.timezone ?? 'Asia/Shanghai',
    weekendDays: [0, 6],
    nonWorkingDates: [],
    workingDates: [],
    defaultRate: { multiplier: peaks.length > 0 ? discount : 1 },
    pricingRules: peaks.map((window, index) => ({
      id: `provider-peak-${index + 1}`,
      label: '平台高峰价',
      windows: [window],
      rate: { multiplier: 1 },
      priority: 10,
    })),
    usageLimits: structuredClone(strategy.usageLimits ?? []),
  };
}

export function cloneProviderPolicy(policy: ProviderPolicy): ProviderPolicy {
  return structuredClone(policy);
}

export function validateProviderPolicy(value: unknown): ProviderPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Provider 资费画像必须是对象');
  }
  const raw = value as Partial<ProviderPolicy>;
  const timezone = typeof raw.timezone === 'string' ? raw.timezone.trim() : '';
  if (!timezone) throw new Error('资费画像缺少 timezone');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`无效 IANA 时区：${timezone}`);
  }

  const weekendDays = validateDays(raw.weekendDays ?? [0, 6], 'weekendDays');
  const nonWorkingDates = validateDates(raw.nonWorkingDates ?? [], 'nonWorkingDates');
  const workingDates = validateDates(raw.workingDates ?? [], 'workingDates');
  const defaultRate = raw.defaultRate === undefined
    ? undefined
    : validateRate(raw.defaultRate, 'defaultRate');
  if (!Array.isArray(raw.pricingRules)) throw new Error('pricingRules 必须是数组');
  if (!Array.isArray(raw.usageLimits)) throw new Error('usageLimits 必须是数组');

  const ruleIds = new Set<string>();
  const pricingRules = raw.pricingRules.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`pricingRules[${index}] 必须是对象`);
    }
    const rule = item as Partial<PricingRule>;
    const id = requiredId(rule.id, `pricingRules[${index}].id`);
    if (ruleIds.has(id)) throw new Error(`计价规则 id 重复：${id}`);
    ruleIds.add(id);
    const label = typeof rule.label === 'string' ? rule.label.trim() : '';
    if (!label) throw new Error(`pricingRules[${index}] 缺少 label`);
    const dayType = rule.dayType ?? 'any';
    if (!['any', 'working-day', 'non-working-day'].includes(dayType)) {
      throw new Error(`pricingRules[${index}].dayType 非法`);
    }
    const models = rule.models === undefined
      ? undefined
      : validateStringList(rule.models, `pricingRules[${index}].models`);
    const daysOfWeek = rule.daysOfWeek === undefined
      ? undefined
      : validateDays(rule.daysOfWeek, `pricingRules[${index}].daysOfWeek`);
    const windows = rule.windows === undefined
      ? undefined
      : validateWindows(rule.windows, `pricingRules[${index}].windows`);
    const priority = rule.priority ?? 0;
    if (!Number.isInteger(priority) || priority < -1000 || priority > 1000) {
      throw new Error(`pricingRules[${index}].priority 必须是 -1000–1000 的整数`);
    }
    return {
      id,
      label,
      models,
      dayType: dayType as BillingDayType,
      daysOfWeek,
      windows,
      rate: validateRate(rule.rate, `pricingRules[${index}].rate`),
      priority,
    };
  });

  const limitIds = new Set<string>();
  const usageLimits = raw.usageLimits.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`usageLimits[${index}] 必须是对象`);
    }
    const limit = item as Partial<UsageLimit>;
    const id = requiredId(limit.id, `usageLimits[${index}].id`);
    if (limitIds.has(id)) throw new Error(`用量限制 id 重复：${id}`);
    limitIds.add(id);
    const label = typeof limit.label === 'string' ? limit.label.trim() : '';
    if (!label) throw new Error(`usageLimits[${index}] 缺少 label`);
    if (!['rolling', 'day', 'week', 'month'].includes(String(limit.period))) {
      throw new Error(`usageLimits[${index}].period 非法`);
    }
    const windowMinutes = limit.windowMinutes;
    if (limit.period === 'rolling') {
      if (!Number.isInteger(windowMinutes) || Number(windowMinutes) <= 0 || Number(windowMinutes) > 525_600) {
        throw new Error(`usageLimits[${index}].windowMinutes 必须是 1–525600 的整数`);
      }
    } else if (windowMinutes !== undefined) {
      throw new Error(`usageLimits[${index}].windowMinutes 仅适用于 rolling`);
    }
    if (!['requests', 'tokens', 'cost'].includes(String(limit.unit))) {
      throw new Error(`usageLimits[${index}].unit 非法`);
    }
    if (!Number.isFinite(limit.limit) || Number(limit.limit) <= 0) {
      throw new Error(`usageLimits[${index}].limit 必须大于 0`);
    }
    const warningAt = limit.warningAt ?? 0.8;
    if (!Number.isFinite(warningAt) || warningAt < 0 || warningAt > 1) {
      throw new Error(`usageLimits[${index}].warningAt 必须在 0–1 之间`);
    }
    return {
      id,
      label,
      period: limit.period as UsageLimitPeriod,
      windowMinutes: limit.period === 'rolling' ? Number(windowMinutes) : undefined,
      unit: limit.unit as UsageLimitUnit,
      limit: Number(limit.limit),
      warningAt,
    };
  });

  return {
    timezone,
    weekendDays,
    nonWorkingDates,
    workingDates,
    defaultRate,
    pricingRules,
    usageLimits,
  };
}

export function evaluatePricing(
  providerId: string,
  baseModel: ModelSpec,
  policy: ProviderPolicy,
  now: Date,
  source: PricingQuote['source'] = 'configured',
): PricingQuote {
  const matches = policy.pricingRules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => matchesRule(rule, baseModel.name, policy, now))
    .sort((a, b) => (a.rule.priority ?? 0) - (b.rule.priority ?? 0) || a.index - b.index);
  const selected = matches.at(-1)?.rule;
  const rate = selected?.rate ?? policy.defaultRate ?? {};
  const discount = rate.multiplier ?? 1;
  const model: ModelSpec = {
    ...baseModel,
    inputPrice: rate.inputPrice ?? baseModel.inputPrice,
    outputPrice: rate.outputPrice ?? baseModel.outputPrice,
    cacheHitPrice: rate.cacheHitPrice ?? baseModel.cacheHitPrice,
  };
  const effectiveInput = model.inputPrice * discount;
  const effectiveOutput = model.outputPrice * discount;
  const baseCache = baseModel.cacheHitPrice ?? baseModel.inputPrice;
  const effectiveCache = (model.cacheHitPrice ?? model.inputPrice) * discount;
  const offPeak = effectiveInput < baseModel.inputPrice ||
    effectiveOutput < baseModel.outputPrice || effectiveCache < baseCache;
  return {
    providerId,
    model,
    at: now.toISOString(),
    timezone: policy.timezone,
    ruleId: selected?.id ?? null,
    label: selected?.label ?? (offPeak ? '默认优惠价' : '默认价'),
    offPeak,
    discount,
    source,
  };
}

export function estimateQuoteCost(
  quote: PricingQuote,
  estimate: ProviderCallEstimate,
): number {
  const prompt = Math.max(0, estimate.promptTokens);
  const completion = Math.max(0, estimate.completionTokens);
  return (
    (prompt / 1_000_000) * quote.model.inputPrice +
    (completion / 1_000_000) * quote.model.outputPrice
  ) * quote.discount;
}

export function usageLimitStatuses(
  policy: ProviderPolicy,
  providerId: string,
  events: readonly UsageEvent[],
  now: Date,
): UsageLimitStatus[] {
  return policy.usageLimits.map((limit) => {
    const currentKey = usagePeriodKey(now, policy.timezone, limit.period, limit.windowMinutes);
    const rollingCutoff = limit.period === 'rolling'
      ? now.getTime() - Number(limit.windowMinutes) * 60_000
      : undefined;
    let used = 0;
    for (const event of events) {
      if (event.providerId !== providerId) continue;
      const at = new Date(event.at);
      if (!Number.isFinite(at.getTime())) continue;
      if (rollingCutoff !== undefined) {
        if (at.getTime() <= rollingCutoff || at.getTime() > now.getTime()) continue;
      } else if (usagePeriodKey(at, policy.timezone, limit.period, limit.windowMinutes) !== currentKey) continue;
      if (limit.unit === 'requests') used += 1;
      else if (limit.unit === 'tokens') used += event.promptTokens + event.completionTokens;
      else used += event.actualCost;
    }
    const remaining = Math.max(0, limit.limit - used);
    const ratio = used / limit.limit;
    return {
      ...limit,
      used,
      remaining,
      ratio,
      warning: ratio >= (limit.warningAt ?? 0.8),
      exhausted: used >= limit.limit,
      periodKey: currentKey,
    };
  });
}

export function estimateFitsLimits(
  statuses: readonly UsageLimitStatus[],
  estimate: ProviderCallEstimate,
  estimatedCost: number,
): boolean {
  return statuses.every((status) => {
    const extra = status.unit === 'requests'
      ? estimate.requests ?? 1
      : status.unit === 'tokens'
        ? estimate.promptTokens + estimate.completionTokens
        : estimatedCost;
    return status.used + extra <= status.limit;
  });
}

export function usagePeriodKey(
  now: Date,
  timezone: string,
  period: UsageLimitPeriod,
  windowMinutes?: number,
): string {
  if (period === 'rolling') return `rolling-${windowMinutes ?? 0}m`;
  const parts = zonedDateParts(now, timezone);
  const date = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  if (period === 'day') return date;
  if (period === 'month') return `${parts.year}-${pad(parts.month)}`;
  const utc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const mondayOffset = (utc.getUTCDay() + 6) % 7;
  utc.setUTCDate(utc.getUTCDate() - mondayOffset);
  return `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())}`;
}

export function isWorkingDay(policy: ProviderPolicy, now: Date): boolean {
  const parts = zonedDateParts(now, policy.timezone);
  const date = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  if (policy.workingDates.includes(date)) return true;
  if (policy.nonWorkingDates.includes(date)) return false;
  return !policy.weekendDays.includes(parts.dayOfWeek);
}

function matchesRule(
  rule: PricingRule,
  model: string,
  policy: ProviderPolicy,
  now: Date,
): boolean {
  if (rule.models && rule.models.length > 0 && !rule.models.includes(model)) return false;
  const parts = zonedDateParts(now, policy.timezone);
  if (rule.daysOfWeek && rule.daysOfWeek.length > 0 && !rule.daysOfWeek.includes(parts.dayOfWeek)) {
    return false;
  }
  const working = isWorkingDay(policy, now);
  if (rule.dayType === 'working-day' && !working) return false;
  if (rule.dayType === 'non-working-day' && working) return false;
  if (rule.windows && rule.windows.length > 0) {
    const minute = parts.hour * 60 + parts.minute;
    if (!rule.windows.some((window) => inWindow(minute, window.start, window.end))) return false;
  }
  return true;
}

function validateRate(value: unknown, path: string): PriceRate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} 必须是对象`);
  }
  const raw = value as Partial<PriceRate>;
  const rate: PriceRate = {};
  for (const key of ['inputPrice', 'outputPrice', 'cacheHitPrice'] as const) {
    if (raw[key] === undefined) continue;
    if (!Number.isFinite(raw[key]) || Number(raw[key]) < 0) throw new Error(`${path}.${key} 必须大于等于 0`);
    rate[key] = Number(raw[key]);
  }
  if (raw.multiplier !== undefined) {
    if (!Number.isFinite(raw.multiplier) || Number(raw.multiplier) < 0) {
      throw new Error(`${path}.multiplier 必须大于等于 0`);
    }
    rate.multiplier = Number(raw.multiplier);
  }
  if (Object.keys(rate).length === 0) throw new Error(`${path} 至少需要一个价格或 multiplier`);
  return rate;
}

function validateWindows(value: unknown, path: string): PricingWindow[] {
  if (!Array.isArray(value)) throw new Error(`${path} 必须是数组`);
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${path}[${index}] 必须是对象`);
    const window = item as Partial<PricingWindow>;
    if (!TIME_PATTERN.test(String(window.start)) || !TIME_PATTERN.test(String(window.end))) {
      throw new Error(`${path}[${index}] 必须使用 HH:MM`);
    }
    if (window.start === window.end) throw new Error(`${path}[${index}] 起止时间不能相同`);
    return { start: String(window.start), end: String(window.end) };
  });
}

function validateDays(value: unknown, path: string): number[] {
  if (!Array.isArray(value)) throw new Error(`${path} 必须是数组`);
  const result: number[] = [];
  for (const day of value) {
    if (!Number.isInteger(day) || Number(day) < 0 || Number(day) > 6) {
      throw new Error(`${path} 只能包含 0–6`);
    }
    if (!result.includes(Number(day))) result.push(Number(day));
  }
  return result;
}

function validateDates(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} 必须是数组`);
  const result: string[] = [];
  for (const date of value) {
    if (typeof date !== 'string' || !DATE_PATTERN.test(date)) throw new Error(`${path} 必须使用 YYYY-MM-DD`);
    if (!result.includes(date)) result.push(date);
  }
  return result;
}

function validateStringList(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} 必须是数组`);
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) throw new Error(`${path} 只能包含非空字符串`);
    if (!result.includes(item.trim())) result.push(item.trim());
  }
  return result;
}

function requiredId(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) {
    throw new Error(`${path} 只能包含字母、数字、点、下划线和短横线`);
  }
  return value;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
