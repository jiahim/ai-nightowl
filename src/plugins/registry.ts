import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ProviderAdapter } from '../providers/adapter.js';

export const PLUGIN_API_VERSION = '1';

export type PluginCapability =
  | 'provider'
  | 'executor'
  | 'verifier'
  | 'trigger'
  | 'notifier'
  | 'storage';

export type PluginPermission =
  | 'network'
  | 'filesystem:read'
  | 'filesystem:write'
  | 'process'
  | 'secrets';

export interface PluginContribution {
  kind: PluginCapability;
  id: string;
  name: string;
}

export interface NightOwlPluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: typeof PLUGIN_API_VERSION;
  description?: string;
  contributions: PluginContribution[];
  permissions?: PluginPermission[];
}

export interface PluginContext {
  /** Phase A 只开放 Provider 注册；其他扩展点按 PRD 分阶段接入。 */
  registerProvider(adapter: ProviderAdapter): void;
}

export interface NightOwlPlugin {
  manifest: NightOwlPluginManifest;
  activate(context: PluginContext): void | Promise<void>;
}

export interface PluginSnapshot {
  apiVersion: string;
  trustModel: 'trusted-local';
  plugins: Array<{
    id: string;
    name: string;
    version: string;
    description: string;
    contributions: PluginContribution[];
    permissions: PluginPermission[];
    status: 'active';
  }>;
  providers: Array<{
    id: string;
    name: string;
    source: 'core' | 'plugin';
    pluginId?: string;
    models: string[];
  }>;
}

interface ProviderRegistration {
  adapter: ProviderAdapter;
  source: 'core' | 'plugin';
  pluginId?: string;
}

/**
 * 可信本地插件注册表。
 *
 * 插件模块在当前进程执行，声明的 permissions 目前用于展示和审计，并不构成
 * 沙箱。只有启动参数或环境变量显式给出的模块才会加载，Web API 不接受代码 URL。
 */
export class PluginRegistry {
  private readonly plugins = new Map<string, NightOwlPluginManifest>();
  private readonly providerMap = new Map<string, ProviderRegistration>();

  registerCoreProvider(adapter: ProviderAdapter): void {
    validateProviderAdapter(adapter, 'core');
    this.assertProviderAvailable(adapter.id);
    this.providerMap.set(adapter.id, { adapter, source: 'core' });
  }

  async activate(plugin: NightOwlPlugin): Promise<void> {
    const manifest = validatePluginManifest(plugin?.manifest);
    if (this.plugins.has(manifest.id)) {
      throw new Error(`插件 id 重复：${manifest.id}`);
    }
    if (typeof plugin.activate !== 'function') {
      throw new Error(`插件 ${manifest.id} 缺少 activate(context)`);
    }

    const pending: ProviderAdapter[] = [];
    const context: PluginContext = Object.freeze({
      registerProvider: (adapter: ProviderAdapter) => {
        validateProviderAdapter(adapter, manifest.id);
        this.assertProviderAvailable(adapter.id, pending);
        pending.push(adapter);
      },
    });

    // activate 全部成功后才提交，避免半注册状态。
    await plugin.activate(context);
    const declaredProviders = new Set(
      manifest.contributions.filter((item) => item.kind === 'provider').map((item) => item.id),
    );
    for (const adapter of pending) {
      if (!declaredProviders.has(adapter.id)) {
        throw new Error(`插件 ${manifest.id} 注册了未在 manifest 声明的 Provider：${adapter.id}`);
      }
    }
    for (const id of declaredProviders) {
      if (!pending.some((adapter) => adapter.id === id)) {
        throw new Error(`插件 ${manifest.id} 声明了 Provider 但未注册：${id}`);
      }
    }
    for (const adapter of pending) {
      this.providerMap.set(adapter.id, {
        adapter,
        source: 'plugin',
        pluginId: manifest.id,
      });
    }
    this.plugins.set(manifest.id, manifest);
  }

  provider(id: string): ProviderAdapter | undefined {
    return this.providerMap.get(id)?.adapter;
  }

  providers(): ProviderAdapter[] {
    return [...this.providerMap.values()].map((entry) => entry.adapter);
  }

  snapshot(): PluginSnapshot {
    return {
      apiVersion: PLUGIN_API_VERSION,
      trustModel: 'trusted-local',
      plugins: [...this.plugins.values()].map((manifest) => ({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description ?? '',
        contributions: manifest.contributions,
        permissions: manifest.permissions ?? [],
        status: 'active' as const,
      })),
      providers: [...this.providerMap.values()].map(({ adapter, source, pluginId }) => ({
        id: adapter.id,
        name: adapter.config.name,
        source,
        pluginId,
        models: adapter.config.models.map((model) => model.name),
      })),
    };
  }

  private assertProviderAvailable(id: string, pending: ProviderAdapter[] = []): void {
    if (this.providerMap.has(id) || pending.some((adapter) => adapter.id === id)) {
      throw new Error(`Provider id 重复：${id}`);
    }
  }
}

/** 加载启动参数显式指定的本地模块或已安装包。 */
export async function loadPluginModules(
  specifiers: string[],
  options: { registry?: PluginRegistry; baseDir?: string } = {},
): Promise<PluginRegistry> {
  const registry = options.registry ?? new PluginRegistry();
  const baseDir = options.baseDir ?? process.cwd();

  for (const raw of specifiers) {
    const specifier = raw.trim();
    if (!specifier) continue;
    if (/^(https?|data):/i.test(specifier)) {
      throw new Error(`不允许从远程 URL 加载插件：${specifier}`);
    }
    const target = specifier.startsWith('.') || isAbsolute(specifier)
      ? pathToFileURL(resolve(baseDir, specifier)).href
      : specifier;
    const module = (await import(target)) as {
      default?: NightOwlPlugin;
      plugin?: NightOwlPlugin;
    };
    const plugin = module.default ?? module.plugin;
    if (!plugin) throw new Error(`插件模块没有导出 default 或 plugin：${specifier}`);
    await registry.activate(plugin);
  }
  return registry;
}

export function validatePluginManifest(value: unknown): NightOwlPluginManifest {
  if (!value || typeof value !== 'object') throw new Error('插件 manifest 必须是对象');
  const manifest = value as Partial<NightOwlPluginManifest>;
  if (typeof manifest.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(manifest.id)) {
    throw new Error('插件 manifest.id 只能包含小写字母、数字、点、下划线和短横线');
  }
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) throw new Error(`插件 ${manifest.id} 缺少 name`);
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) throw new Error(`插件 ${manifest.id} 缺少 version`);
  if (manifest.description !== undefined && typeof manifest.description !== 'string') {
    throw new Error(`插件 ${manifest.id} 的 description 必须是字符串`);
  }
  if (manifest.apiVersion !== PLUGIN_API_VERSION) {
    throw new Error(
      `插件 ${manifest.id} API 不兼容：需要 ${PLUGIN_API_VERSION}，收到 ${String(manifest.apiVersion)}`,
    );
  }
  if (!Array.isArray(manifest.contributions)) {
    throw new Error(`插件 ${manifest.id} 的 contributions 必须是数组`);
  }
  const permissionKinds = new Set<PluginPermission>([
    'network', 'filesystem:read', 'filesystem:write', 'process', 'secrets',
  ]);
  if (manifest.permissions !== undefined && !Array.isArray(manifest.permissions)) {
    throw new Error(`插件 ${manifest.id} 的 permissions 必须是数组`);
  }
  const permissions = manifest.permissions ?? [];
  const seenPermissions = new Set<PluginPermission>();
  for (const permission of permissions) {
    if (!permissionKinds.has(permission)) {
      throw new Error(`插件 ${manifest.id} 包含未知 permission：${String(permission)}`);
    }
    if (seenPermissions.has(permission)) {
      throw new Error(`插件 ${manifest.id} 的 permission 重复：${permission}`);
    }
    seenPermissions.add(permission);
  }
  const contributionIds = new Set<string>();
  const capabilityKinds = new Set<PluginCapability>([
    'provider', 'executor', 'verifier', 'trigger', 'notifier', 'storage',
  ]);
  for (const item of manifest.contributions) {
    if (
      !item || typeof item !== 'object' ||
      typeof item.id !== 'string' || !item.id.trim() ||
      typeof item.name !== 'string' || !item.name.trim()
    ) {
      throw new Error(`插件 ${manifest.id} 包含非法 contribution`);
    }
    if (!capabilityKinds.has(item.kind)) {
      throw new Error(`插件 ${manifest.id} 包含未知 capability：${String(item.kind)}`);
    }
    const key = `${item.kind}:${item.id}`;
    if (contributionIds.has(key)) throw new Error(`插件 contribution 重复：${key}`);
    contributionIds.add(key);
  }
  return {
    id: manifest.id,
    name: manifest.name.trim(),
    version: manifest.version.trim(),
    apiVersion: PLUGIN_API_VERSION,
    description: manifest.description?.trim(),
    contributions: manifest.contributions.map((item) => ({ ...item })),
    permissions: [...permissions],
  };
}

function validateProviderAdapter(value: unknown, owner: string): asserts value is ProviderAdapter {
  if (!value || typeof value !== 'object') throw new Error(`${owner} 注册了非法 Provider`);
  const adapter = value as Partial<ProviderAdapter>;
  if (typeof adapter.id !== 'string' || !adapter.id.trim()) {
    throw new Error(`${owner} 注册的 Provider 缺少 id`);
  }
  if (!adapter.config || typeof adapter.config !== 'object') {
    throw new Error(`Provider ${adapter.id} 缺少 config`);
  }
  if (
    adapter.config.id !== adapter.id ||
    typeof adapter.config.name !== 'string' || !adapter.config.name.trim()
  ) {
    throw new Error(`Provider ${adapter.id} 的 config.id/name 非法`);
  }
  if (
    typeof adapter.config.baseUrl !== 'string' ||
    typeof adapter.config.apiKeyEnv !== 'string' ||
    !adapter.config.costStrategy || typeof adapter.config.costStrategy !== 'object' ||
    Array.isArray(adapter.config.costStrategy)
  ) throw new Error(`Provider ${adapter.id} 的 config 结构不完整`);
  if (!Array.isArray(adapter.config.models) || adapter.config.models.length === 0) {
    throw new Error(`Provider ${adapter.id} 至少需要声明一个模型`);
  }
  const modelNames = new Set<string>();
  for (const model of adapter.config.models) {
    if (
      !model || typeof model.name !== 'string' || !model.name.trim() ||
      (model.kind !== 'chat' && model.kind !== 'reasoner') ||
      !Number.isFinite(model.inputPrice) || model.inputPrice < 0 ||
      !Number.isFinite(model.outputPrice) || model.outputPrice < 0 ||
      (model.cacheHitPrice !== undefined && (!Number.isFinite(model.cacheHitPrice) || model.cacheHitPrice < 0)) ||
      !Number.isFinite(model.contextWindow) || model.contextWindow <= 0
    ) throw new Error(`Provider ${adapter.id} 包含非法模型声明`);
    if (modelNames.has(model.name)) throw new Error(`Provider ${adapter.id} 的模型名重复：${model.name}`);
    modelNames.add(model.name);
  }
  const strategy = adapter.config.costStrategy;
  if (strategy.peakWindows !== undefined && (
    !Array.isArray(strategy.peakWindows) ||
    strategy.peakWindows.some((window) =>
      !window || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(window.start) ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(window.end))
  )) throw new Error(`Provider ${adapter.id} 的 peakWindows 非法`);
  for (const discount of [strategy.offPeakDiscount, strategy.batchDiscount]) {
    if (discount !== undefined && (!Number.isFinite(discount) || discount < 0 || discount > 1)) {
      throw new Error(`Provider ${adapter.id} 的折扣必须在 0–1 之间`);
    }
  }
  for (const method of ['isOffPeak', 'currentDiscount', 'routeModel', 'chat'] as const) {
    if (typeof adapter[method] !== 'function') {
      throw new Error(`Provider ${adapter.id} 缺少 ${method}()`);
    }
  }
}

/** 逗号分隔环境变量 + 可重复 CLI 参数的规整。 */
export function collectPluginSpecifiers(
  cli: string[] = [],
  envValue: string | undefined = process.env.NIGHTOWL_PLUGINS,
): string[] {
  return [...cli, ...(envValue?.split(',') ?? [])].map((item) => item.trim()).filter(Boolean);
}
