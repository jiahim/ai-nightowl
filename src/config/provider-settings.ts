import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelSpec, ProviderConfig } from '../types.js';

export const PROVIDER_SETTINGS_VERSION = 2 as const;

export const MANAGED_PROVIDER_DEFINITIONS = [
  { id: 'deepseek', name: 'DeepSeek', envKey: 'DEEPSEEK_API_KEY', billingMode: 'payg' },
  { id: 'zhipu', name: '智谱 GLM', envKey: 'ZHIPU_API_KEY', billingMode: 'plan' },
  { id: 'minimax', name: 'MiniMax 按量', envKey: 'MINIMAX_API_KEY', billingMode: 'payg' },
  { id: 'minimax-plan', name: 'MiniMax Plan', envKey: 'MINIMAX_PLAN_API_KEY', billingMode: 'plan' },
  { id: 'openai', name: 'OpenAI', envKey: 'OPENAI_API_KEY', billingMode: 'payg' },
  {
    id: 'openai-compatible',
    name: '自定义 OpenAI 兼容',
    envKey: 'OPENAI_COMPATIBLE_API_KEY',
    billingMode: 'custom',
  },
] as const;

export type BuiltInProviderId = typeof MANAGED_PROVIDER_DEFINITIONS[number]['id'];
export type PreferredProvider = 'auto' | (string & {});
export type ProviderCredentialSource = 'local' | 'environment' | null;

export interface CustomOpenAISettings {
  enabled: boolean;
  name: string;
  baseUrl: string;
  /** 本地服务可关闭密钥要求；远端接口建议保持 true。 */
  apiKeyRequired: boolean;
  models: ModelSpec[];
}

interface PersistedProviderSettings {
  version: typeof PROVIDER_SETTINGS_VERSION;
  preferredProvider: PreferredProvider;
  apiKeys: Partial<Record<BuiltInProviderId, string>>;
  customOpenAI: CustomOpenAISettings;
}

export interface ProviderSettingsUpdate {
  preferredProvider?: PreferredProvider;
  apiKeys?: Partial<Record<BuiltInProviderId, string>>;
  clear?: BuiltInProviderId[];
  customOpenAI?: CustomOpenAISettings;
}

export interface ProviderSettingsSnapshot {
  preferredProvider: PreferredProvider;
  effectiveProvider: string | null;
  providers: Array<{
    id: BuiltInProviderId;
    name: string;
    envKey: string;
    billingMode: 'payg' | 'plan' | 'custom';
    configured: boolean;
    source: ProviderCredentialSource;
    credentialManaged: true;
    configuration?: CustomOpenAISettings;
  }>;
  persistence: 'local-file';
  restartRequired: false;
}

export class ProviderSettingsError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'ProviderSettingsError';
  }
}

const PROVIDER_BY_ID = new Map(MANAGED_PROVIDER_DEFINITIONS.map((provider) => [provider.id, provider]));
const PROVIDER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

function cleanKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const key = value.trim();
  return key || undefined;
}

function defaultCustomOpenAI(): CustomOpenAISettings {
  return {
    enabled: false,
    name: '自定义 OpenAI 兼容',
    baseUrl: '',
    apiKeyRequired: true,
    models: [],
  };
}

function emptySettings(): PersistedProviderSettings {
  return {
    version: PROVIDER_SETTINGS_VERSION,
    preferredProvider: 'auto',
    apiKeys: {},
    customOpenAI: defaultCustomOpenAI(),
  };
}

/**
 * 本地 Provider 密钥与自定义 OpenAI 兼容接口仓储。
 *
 * - 文件只落在服务的 --dir 数据目录，权限为 0600；
 * - API 快照永不返回密钥或掩码；
 * - 保存后同步更新当前进程环境，现有 Adapter 下一次调用即可读取；
 * - v1（仅 DeepSeek/智谱）密钥文件会无损迁移到当前结构。
 */
export class ProviderSettingsStore {
  private readonly file: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly inherited: {
    apiKeys: Partial<Record<BuiltInProviderId, string>>;
    preferredProvider?: string;
  };
  private settings: PersistedProviderSettings;

  constructor(
    private readonly dir: string,
    options: { env?: NodeJS.ProcessEnv } = {},
  ) {
    this.file = join(dir, '.provider-secrets.json');
    this.env = options.env ?? process.env;
    const apiKeys: Partial<Record<BuiltInProviderId, string>> = {};
    for (const provider of MANAGED_PROVIDER_DEFINITIONS) {
      apiKeys[provider.id] = cleanKey(this.env[provider.envKey]);
    }
    this.inherited = {
      apiKeys,
      preferredProvider: cleanKey(this.env.NIGHTOWL_PROVIDER),
    };
    this.settings = this.loadSync();
    this.applyRuntimeEnvironment();
  }

  apiKey(providerId: BuiltInProviderId): string | undefined {
    const definition = PROVIDER_BY_ID.get(providerId);
    return definition ? cleanKey(this.env[definition.envKey]) : undefined;
  }

  isConfigured(providerId: BuiltInProviderId): boolean {
    if (providerId === 'openai-compatible') {
      const custom = this.settings.customOpenAI;
      return custom.enabled && Boolean(custom.baseUrl) && custom.models.length > 0 &&
        (!custom.apiKeyRequired || Boolean(this.apiKey(providerId)));
    }
    return Boolean(this.apiKey(providerId));
  }

  effectivePreferredProvider(): string | undefined {
    if (this.settings.preferredProvider !== 'auto') return this.settings.preferredProvider;
    return this.inherited.preferredProvider;
  }

  customOpenAI(): CustomOpenAISettings {
    return structuredClone(this.settings.customOpenAI);
  }

  /** 动态 Adapter 每次调用都读取这里，因而自定义接口保存后无需重启。 */
  customOpenAIProviderConfig(): ProviderConfig {
    const custom = this.settings.customOpenAI;
    return {
      id: 'openai-compatible',
      name: custom.name || '自定义 OpenAI 兼容',
      baseUrl: custom.baseUrl,
      apiKeyEnv: 'OPENAI_COMPATIBLE_API_KEY',
      models: structuredClone(custom.models.length > 0 ? custom.models : [{
        name: 'custom-model',
        kind: 'chat',
        inputPrice: 0,
        outputPrice: 0,
        contextWindow: 128_000,
      }]),
      costStrategy: { preferCache: true },
    };
  }

  snapshot(): ProviderSettingsSnapshot {
    const preferred = this.effectivePreferredProvider();
    const effectiveProvider = preferred
      ?? MANAGED_PROVIDER_DEFINITIONS.find((provider) => this.isConfigured(provider.id))?.id
      ?? null;
    return {
      preferredProvider: this.settings.preferredProvider,
      effectiveProvider,
      providers: MANAGED_PROVIDER_DEFINITIONS.map((provider) => ({
        id: provider.id,
        name: provider.id === 'openai-compatible' ? this.settings.customOpenAI.name : provider.name,
        envKey: provider.envKey,
        billingMode: provider.billingMode,
        configured: this.isConfigured(provider.id),
        source: this.settings.apiKeys[provider.id]
          ? 'local'
          : this.inherited.apiKeys[provider.id]
            ? 'environment'
            : null,
        credentialManaged: true as const,
        ...(provider.id === 'openai-compatible'
          ? { configuration: this.customOpenAI() }
          : {}),
      })),
      persistence: 'local-file',
      restartRequired: false,
    };
  }

  async update(update: ProviderSettingsUpdate): Promise<ProviderSettingsSnapshot> {
    if (update.preferredProvider !== undefined) {
      if (update.preferredProvider !== 'auto' && !PROVIDER_ID_PATTERN.test(update.preferredProvider)) {
        throw new ProviderSettingsError('preferredProvider 非法');
      }
      this.settings.preferredProvider = update.preferredProvider;
    }
    for (const providerId of update.clear ?? []) {
      if (!PROVIDER_BY_ID.has(providerId)) throw new ProviderSettingsError(`未知 Provider：${providerId}`);
      delete this.settings.apiKeys[providerId];
    }
    for (const provider of MANAGED_PROVIDER_DEFINITIONS) {
      const key = cleanKey(update.apiKeys?.[provider.id]);
      if (key) this.settings.apiKeys[provider.id] = key;
    }
    if (update.customOpenAI !== undefined) {
      this.settings.customOpenAI = validateCustomOpenAI(update.customOpenAI);
    }
    await this.persist();
    this.applyRuntimeEnvironment();
    return this.snapshot();
  }

  private loadSync(): PersistedProviderSettings {
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptySettings();
      throw new ProviderSettingsError('无法读取本地 Provider 设置', error);
    }

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('设置必须是对象');
      if (parsed.version !== 1 && parsed.version !== PROVIDER_SETTINGS_VERSION) {
        throw new Error('不支持的设置版本');
      }
      const preferredProvider = parsed.preferredProvider;
      if (
        typeof preferredProvider !== 'string' ||
        (preferredProvider !== 'auto' && !PROVIDER_ID_PATTERN.test(preferredProvider))
      ) throw new Error('preferredProvider 非法');
      const rawApiKeys = parsed.apiKeys && typeof parsed.apiKeys === 'object' && !Array.isArray(parsed.apiKeys)
        ? parsed.apiKeys as Record<string, unknown>
        : {};
      const apiKeys: Partial<Record<BuiltInProviderId, string>> = {};
      for (const provider of MANAGED_PROVIDER_DEFINITIONS) {
        apiKeys[provider.id] = cleanKey(rawApiKeys[provider.id]);
      }
      const customOpenAI = parsed.version === 1 || parsed.customOpenAI === undefined
        ? defaultCustomOpenAI()
        : validateCustomOpenAI(parsed.customOpenAI);
      return {
        version: PROVIDER_SETTINGS_VERSION,
        preferredProvider: preferredProvider as PreferredProvider,
        apiKeys,
        customOpenAI,
      };
    } catch (error) {
      throw new ProviderSettingsError('本地 Provider 设置已损坏或结构不兼容', error);
    }
  }

  private applyRuntimeEnvironment(): void {
    for (const provider of MANAGED_PROVIDER_DEFINITIONS) {
      const effective = this.settings.apiKeys[provider.id] ?? this.inherited.apiKeys[provider.id];
      if (effective) this.env[provider.envKey] = effective;
      else delete this.env[provider.envKey];
    }
    const preferred = this.effectivePreferredProvider();
    if (preferred) this.env.NIGHTOWL_PROVIDER = preferred;
    else delete this.env.NIGHTOWL_PROVIDER;
  }

  private async persist(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const temp = join(this.dir, `.provider-secrets.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(this.settings, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temp, this.file);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw new ProviderSettingsError('无法保存本地 Provider 设置', error);
    }
  }
}

function validateCustomOpenAI(value: unknown): CustomOpenAISettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderSettingsError('自定义 OpenAI 配置必须是对象');
  }
  const raw = value as Partial<CustomOpenAISettings>;
  if (typeof raw.enabled !== 'boolean') throw new ProviderSettingsError('自定义 OpenAI enabled 必须是布尔值');
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || name.length > 80) throw new ProviderSettingsError('自定义 OpenAI 名称必须是 1–80 个字符');
  if (typeof raw.apiKeyRequired !== 'boolean') {
    throw new ProviderSettingsError('自定义 OpenAI apiKeyRequired 必须是布尔值');
  }
  const baseUrl = normalizeBaseUrl(raw.baseUrl, raw.enabled);
  if (!Array.isArray(raw.models)) throw new ProviderSettingsError('自定义 OpenAI models 必须是数组');
  if (raw.models.length > 30) throw new ProviderSettingsError('自定义 OpenAI 最多配置 30 个模型');
  const models = raw.models.map((model, index) => validateModel(model, index));
  if (raw.enabled && models.length === 0) throw new ProviderSettingsError('启用自定义 OpenAI 时至少需要一个模型');
  if (new Set(models.map((model) => model.name)).size !== models.length) {
    throw new ProviderSettingsError('自定义 OpenAI 模型名不能重复');
  }
  return { enabled: raw.enabled, name, baseUrl, apiKeyRequired: raw.apiKeyRequired, models };
}

function normalizeBaseUrl(value: unknown, required: boolean): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    if (required) throw new ProviderSettingsError('启用自定义 OpenAI 时必须填写 Base URL');
    return '';
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderSettingsError('自定义 OpenAI Base URL 不是合法 URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProviderSettingsError('自定义 OpenAI Base URL 只支持 http 或 https');
  }
  if (url.username || url.password) throw new ProviderSettingsError('Base URL 不得内嵌用户名或密码');
  if (url.search || url.hash) throw new ProviderSettingsError('Base URL 不得包含 query 或 hash');
  return url.toString().replace(/\/$/, '');
}

function validateModel(value: unknown, index: number): ModelSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderSettingsError(`自定义模型 ${index + 1} 必须是对象`);
  }
  const raw = value as Partial<ModelSpec>;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || name.length > 200) throw new ProviderSettingsError(`自定义模型 ${index + 1} 名称非法`);
  if (raw.kind !== 'chat' && raw.kind !== 'reasoner') {
    throw new ProviderSettingsError(`自定义模型 ${name} kind 必须是 chat 或 reasoner`);
  }
  for (const key of ['inputPrice', 'outputPrice'] as const) {
    if (!Number.isFinite(raw[key]) || Number(raw[key]) < 0) {
      throw new ProviderSettingsError(`自定义模型 ${name} 的 ${key} 必须大于等于 0`);
    }
  }
  if (raw.cacheHitPrice !== undefined && (!Number.isFinite(raw.cacheHitPrice) || raw.cacheHitPrice < 0)) {
    throw new ProviderSettingsError(`自定义模型 ${name} 的 cacheHitPrice 必须大于等于 0`);
  }
  if (!Number.isInteger(raw.contextWindow) || Number(raw.contextWindow) <= 0 || Number(raw.contextWindow) > 10_000_000) {
    throw new ProviderSettingsError(`自定义模型 ${name} 的 contextWindow 必须是 1–10000000 的整数`);
  }
  return {
    name,
    kind: raw.kind,
    inputPrice: Number(raw.inputPrice),
    outputPrice: Number(raw.outputPrice),
    cacheHitPrice: raw.cacheHitPrice === undefined ? undefined : Number(raw.cacheHitPrice),
    contextWindow: Number(raw.contextWindow),
  };
}
