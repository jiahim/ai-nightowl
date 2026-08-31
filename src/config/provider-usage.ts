import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { UsageEvent } from '../providers/policy.js';

export const PROVIDER_USAGE_VERSION = 1 as const;

interface PersistedProviderUsage {
  version: typeof PROVIDER_USAGE_VERSION;
  events: UsageEvent[];
}

const RETENTION_MS = 400 * 24 * 60 * 60 * 1000;

export class ProviderUsageError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'ProviderUsageError';
  }
}

/**
 * 周/月额度需要跨重启判断，因此使用独立轻量账本；只记录汇总 token/成本，
 * 不保存 prompt、响应或密钥。
 */
export class ProviderUsageLedger {
  private readonly file: string;
  private state: PersistedProviderUsage;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {
    this.file = join(dir, '.provider-usage.json');
    this.state = this.loadSync();
  }

  events(): UsageEvent[] {
    return structuredClone(this.state.events);
  }

  record(event: UsageEvent): Promise<void> {
    validateUsageEvent(event);
    return this.serialize(async () => {
      const cutoff = new Date(event.at).getTime() - RETENTION_MS;
      const next: PersistedProviderUsage = {
        version: PROVIDER_USAGE_VERSION,
        events: [
          ...this.state.events.filter((item) => new Date(item.at).getTime() >= cutoff),
          structuredClone(event),
        ],
      };
      await this.persist(next);
      this.state = next;
    });
  }

  private loadSync(): PersistedProviderUsage {
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: PROVIDER_USAGE_VERSION, events: [] };
      }
      throw new ProviderUsageError('无法读取 Provider 用量账本', error);
    }
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedProviderUsage>;
      if (!parsed || parsed.version !== PROVIDER_USAGE_VERSION || !Array.isArray(parsed.events)) {
        throw new Error('账本版本或结构非法');
      }
      for (const event of parsed.events) validateUsageEvent(event);
      return { version: PROVIDER_USAGE_VERSION, events: parsed.events };
    } catch (error) {
      throw new ProviderUsageError('Provider 用量账本已损坏或结构不兼容', error);
    }
  }

  private async persist(state: PersistedProviderUsage): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const temp = join(this.dir, `.provider-usage.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(state), {
        encoding: 'utf-8',
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temp, this.file);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw new ProviderUsageError('无法保存 Provider 用量账本', error);
    }
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(work, work);
    this.writeTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function validateUsageEvent(value: unknown): asserts value is UsageEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('非法用量事件');
  const event = value as Partial<UsageEvent>;
  if (typeof event.at !== 'string' || !Number.isFinite(new Date(event.at).getTime())) throw new Error('用量事件时间非法');
  if (typeof event.providerId !== 'string' || !event.providerId) throw new Error('用量事件 Provider 非法');
  if (typeof event.model !== 'string' || !event.model) throw new Error('用量事件模型非法');
  for (const key of ['promptTokens', 'completionTokens', 'actualCost'] as const) {
    if (!Number.isFinite(event[key]) || Number(event[key]) < 0) throw new Error(`用量事件 ${key} 非法`);
  }
}
