import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  cloneProviderPolicy,
  validateProviderPolicy,
  type ProviderPolicy,
  type ProviderPriority,
} from '../providers/policy.js';

export const PROVIDER_POLICIES_VERSION = 1 as const;

interface PersistedProviderPolicies {
  version: typeof PROVIDER_POLICIES_VERSION;
  priority: ProviderPriority;
  profiles: Record<string, ProviderPolicy>;
}

export interface ProviderPoliciesUpdate {
  priority?: ProviderPriority;
  profiles?: Record<string, unknown>;
  clearProfiles?: string[];
}

export interface ProviderPoliciesSnapshot {
  priority: ProviderPriority;
  profiles: Record<string, ProviderPolicy>;
}

export class ProviderPoliciesError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'ProviderPoliciesError';
  }
}

/** 非密钥的 Provider 资费覆盖与自动路由偏好。 */
export class ProviderPoliciesStore {
  private readonly file: string;
  private state: PersistedProviderPolicies;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {
    this.file = join(dir, '.provider-policies.json');
    this.state = this.loadSync();
  }

  priority(): ProviderPriority {
    return this.state.priority;
  }

  profile(providerId: string): ProviderPolicy | undefined {
    const policy = this.state.profiles[providerId];
    return policy ? cloneProviderPolicy(policy) : undefined;
  }

  snapshot(): ProviderPoliciesSnapshot {
    return {
      priority: this.state.priority,
      profiles: structuredClone(this.state.profiles),
    };
  }

  validateUpdate(update: ProviderPoliciesUpdate): void {
    this.nextState(update);
  }

  update(update: ProviderPoliciesUpdate): Promise<ProviderPoliciesSnapshot> {
    return this.serialize(async () => {
      const next = this.nextState(update);
      await this.persist(next);
      this.state = next;
      return this.snapshot();
    });
  }

  private nextState(update: ProviderPoliciesUpdate): PersistedProviderPolicies {
    const next = structuredClone(this.state);
    if (update.priority !== undefined) {
      if (!['cost', 'balanced', 'speed', 'quality'].includes(update.priority)) {
        throw new ProviderPoliciesError('priority 必须是 cost、balanced、speed 或 quality');
      }
      next.priority = update.priority;
    }
    for (const providerId of update.clearProfiles ?? []) {
      assertProviderId(providerId);
      delete next.profiles[providerId];
    }
    for (const [providerId, raw] of Object.entries(update.profiles ?? {})) {
      assertProviderId(providerId);
      next.profiles[providerId] = validateProviderPolicy(raw);
    }
    return next;
  }

  private loadSync(): PersistedProviderPolicies {
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: PROVIDER_POLICIES_VERSION, priority: 'balanced', profiles: {} };
      }
      throw new ProviderPoliciesError('无法读取 Provider 资费设置', error);
    }
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedProviderPolicies>;
      if (!parsed || parsed.version !== PROVIDER_POLICIES_VERSION) throw new Error('不支持的设置版本');
      if (!['cost', 'balanced', 'speed', 'quality'].includes(String(parsed.priority))) {
        throw new Error('priority 非法');
      }
      if (!parsed.profiles || typeof parsed.profiles !== 'object' || Array.isArray(parsed.profiles)) {
        throw new Error('profiles 非法');
      }
      const profiles: Record<string, ProviderPolicy> = {};
      for (const [providerId, profile] of Object.entries(parsed.profiles)) {
        assertProviderId(providerId);
        profiles[providerId] = validateProviderPolicy(profile);
      }
      return {
        version: PROVIDER_POLICIES_VERSION,
        priority: parsed.priority as ProviderPriority,
        profiles,
      };
    } catch (error) {
      throw new ProviderPoliciesError('Provider 资费设置已损坏或结构不兼容', error);
    }
  }

  private async persist(state: PersistedProviderPolicies): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const temp = join(this.dir, `.provider-policies.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(state, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temp, this.file);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw new ProviderPoliciesError('无法保存 Provider 资费设置', error);
    }
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(work, work);
    this.writeTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function assertProviderId(providerId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(providerId)) {
    throw new ProviderPoliciesError(`非法 Provider id：${providerId}`);
  }
}
