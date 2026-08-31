import type {
  Blueprint,
  SubtaskStatus,
  Verdict,
  VerdictKind,
} from '../types.js';
import { PlanState } from '../plan/state.js';
import { Store, STORE_SCHEMA_VERSION, type StoreState } from '../memory/store.js';
import { assembleBlueprint, type BlueprintDraft } from '../blueprint/guide.js';
import { validateBlueprint } from '../blueprint/validate.js';
import { LoopBusyError, type NightOwlLoop } from '../runtime/loop.js';
import type { CostTracker } from '../cost/tracker.js';
import { RunController, RuntimeBusyError } from '../runtime/controller.js';
import type { PluginRegistry } from '../plugins/registry.js';
import {
  MANAGED_PROVIDER_DEFINITIONS,
  ProviderSettingsStore,
  type BuiltInProviderId,
  type CustomOpenAISettings,
  type PreferredProvider,
  type ProviderSettingsUpdate,
} from '../config/provider-settings.js';
import { ProviderPoliciesStore, type ProviderPoliciesUpdate } from '../config/provider-policies.js';
import type { ProviderManagementService } from '../providers/management.js';

/**
 * HTTP API（m4-http）。
 *
 * 宿主零改造对接的第二种方式：宿主（QwenPaw / deepseek-harness）经标准
 * HTTP + JSON 发任务、查状态、触发推进。核心是 `HttpApi` 这个**框架无关**
 * 的路由层（纯逻辑、不碰 socket），真正的 TCP 接线在 server.ts。
 *
 * 端点：
 *   GET  /health         健康检查
 *   GET  /status         查状态（蓝图 + 里程碑 + 子任务 + 进度）
 *   POST /blueprint      发任务：BlueprintDraft → assembleBlueprint → 落盘
 *   POST /blueprint/raw  发任务：已组装的完整 Blueprint → 校验 → 落盘
 *   POST /tick           推进一轮（需注入 loop）
 *   POST /run            循环推进（需注入 loop；可选 body { maxTicks }）
 *
 * 分层职责：
 *   - handle() 只做「路由 + 入参规整 + 出参 JSON」，IO 由 Store / loop 承担
 *   - buildStatus() 是纯函数（读 StoreState → 结构化进度对象），可测试
 *   - 输入宽松规整（缺字段给默认值），非法结构抛 HttpError(400)，不吞错
 */

export const PROJECT_VERSION = '0.2.0';

/** 框架无关的请求形状（server.ts 从 node:http 映射过来） */
export interface HttpRequest {
  method: string;
  pathname: string;
  /** 已解析的 JSON body（GET 等无 body 时为 undefined） */
  body: unknown;
}

/** 框架无关的响应形状（server.ts 序列化回写 socket） */
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** 状态查询返回的结构（供宿主展示 / 判定） */
export interface StatusResponse {
  project: 'ai-nightowl';
  hasBlueprint: boolean;
  blueprint?: {
    id: string;
    title: string;
    description: string;
    constraints: string[];
    definitionOfDone: string;
  };
  milestones: Array<{
    id: string;
    name: string;
    status: SubtaskStatus;
    goal: string;
    done: number;
    total: number;
    subtasks: Array<{
      id: string;
      name: string;
      detail: string;
      status: SubtaskStatus;
      dependencies: string[];
      verdictKind: VerdictKind;
      approvable: boolean;
      evidenceCount: number;
      lastEvidence?: string;
    }>;
  }>;
  progress: { done: number; total: number; percent: number };
  done: boolean;
  completion: StoreState['completion'] | null;
  checkpoints: number;
  updatedAt: string | null;
}

export interface HttpApiOptions {
  store: Store;
  /** 可选：注入后 /tick /run 才可用；未注入时这两个端点返回 501 */
  loop?: NightOwlLoop;
  /** 可选：注入后 GET /cost 返回累计成本汇总 */
  tracker?: CostTracker;
  /** 可选：后台运行控制器；注入后开放 /runtime/*。 */
  controller?: RunController;
  /** 可选：可信本地插件目录；注入后开放 GET /plugins。 */
  plugins?: PluginRegistry;
  /** 本地 Provider 密钥与首选平台设置；注入后开放 /settings/providers。 */
  providerSettings?: ProviderSettingsStore;
  /** Provider 资费覆盖；与 providerManagement 一起提供通用规则设置。 */
  providerPolicies?: ProviderPoliciesStore;
  /** 自动发现、配额评估、智能推荐与运行时路由。 */
  providerManagement?: ProviderManagementService;
}

/** 带状态码的业务错误（入参非法 → 400；能力缺失 → 501） */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** 纯函数：把落盘状态转成结构化进度对象（无蓝图时返回空态） */
export function buildStatus(state: StoreState | null): StatusResponse {
  if (!state) {
    return {
      project: 'ai-nightowl',
      hasBlueprint: false,
      milestones: [],
      progress: { done: 0, total: 0, percent: 0 },
      done: false,
      completion: null,
      checkpoints: 0,
      updatedAt: null,
    };
  }
  const bp = state.blueprint;
  const plan = new PlanState(bp);
  const subtasks = plan.subtasks();
  const doneCount = subtasks.filter((s) => s.status === 'done').length;
  const total = subtasks.length;

  return {
    project: 'ai-nightowl',
    hasBlueprint: true,
    blueprint: {
      id: bp.id,
      title: bp.title,
      description: bp.description,
      constraints: bp.constraints,
      definitionOfDone: bp.definitionOfDone,
    },
    milestones: bp.milestones.map((m) => ({
      id: m.id,
      name: m.name,
      status: m.status,
      goal: m.goal,
      done: m.subtasks.filter((s) => s.status === 'done').length,
      total: m.subtasks.length,
      subtasks: m.subtasks.map((s) => {
        const last = s.evidence.at(-1);
        return {
          id: s.id,
          name: s.name,
          detail: s.detail,
          status: s.status,
          dependencies: s.dependencies,
          verdictKind: s.verdict.kind,
          approvable:
            s.verdict.kind === 'manual' &&
            s.status === 'blocked' &&
            s.dependencies.every((id) => subtasks.find((item) => item.id === id)?.status === 'done') &&
            s.evidence.some((item) => item.kind === 'log' || item.kind === 'artifact'),
          evidenceCount: s.evidence.length,
          lastEvidence: last?.content ?? last?.path,
        };
      }),
    })),
    progress: {
      done: doneCount,
      total,
      percent: total > 0 ? Math.round((doneCount / total) * 100) : 0,
    },
    done: state.completion.status === 'done',
    completion: state.completion,
    checkpoints: state.checkpoints.length,
    updatedAt: state.updatedAt || null,
  };
}

// ---------- 入参规整（宽松 + 缺省，非法抛 HttpError(400)） ----------

function asString(v: unknown, d = ''): string {
  return typeof v === 'string' ? v : d;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function asObject(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

function asVerdictKind(v: unknown, field = 'verdict.kind'): VerdictKind {
  if (v === undefined) return 'llm';
  if (v === 'llm' || v === 'check' || v === 'manual') return v;
  throw new HttpError(400, `${field} 必须是 llm、check 或 manual`);
}

function asVerdict(v: unknown, strict = false): Verdict {
  const o = asObject(v);
  if (strict && (!v || typeof v !== 'object' || Array.isArray(v) || o.kind === undefined)) {
    throw new HttpError(400, 'raw Blueprint 的每个子任务都必须提供 verdict.kind');
  }
  const kind = asVerdictKind(o.kind);
  return {
    kind,
    prompt: typeof o.prompt === 'string' ? o.prompt : undefined,
    check: typeof o.check === 'string' ? o.check : undefined,
    criteria: asStringArray(o.criteria),
  };
}

/** BlueprintDraft 规整：host 只需给 title + milestones，其余缺省填充 */
function draftFromBody(body: unknown): BlueprintDraft {
  const b = asObject(body);
  const title = asString(b.title).trim();
  if (!title) throw new HttpError(400, '缺少必填字段 title');

  const milestonesRaw = Array.isArray(b.milestones) ? b.milestones : [];
  if (milestonesRaw.length === 0) throw new HttpError(400, '至少需要一个里程碑');

  const milestones = milestonesRaw.map((mRaw) => {
    const m = asObject(mRaw);
    const subtasksRaw = Array.isArray(m.subtasks) ? m.subtasks : [];
    return {
      name: asString(m.name).trim(),
      goal: asString(m.goal),
      acceptance: asStringArray(m.acceptance),
      subtasks: subtasksRaw.map((sRaw) => {
        const s = asObject(sRaw);
        return {
          name: asString(s.name).trim(),
          detail: asString(s.detail),
          dependencies: asStringArray(s.dependencies),
          verdictKind: asVerdictKind(s.verdictKind, 'verdictKind'),
          check: typeof s.check === 'string' ? s.check : undefined,
          criteria: asStringArray(s.criteria),
        };
      }),
    };
  });

  return {
    id: asString(b.id, 'blueprint'),
    title,
    description: asString(b.description, title).trim() || title,
    constraints: asStringArray(b.constraints),
    milestones,
    definitionOfDone: asString(b.definitionOfDone),
  };
}

/** 完整 Blueprint 规整：host 自定 id / 依赖（按 id），status/evidence 缺省填充 */
function blueprintFromBody(body: unknown): Blueprint {
  const b = asObject(body);
  const id = asString(b.id).trim();
  const title = asString(b.title).trim();
  if (!id) throw new HttpError(400, '缺少必填字段 id');
  if (!title) throw new HttpError(400, '缺少必填字段 title');

  const milestonesRaw = Array.isArray(b.milestones) ? b.milestones : [];
  if (milestonesRaw.length === 0) throw new HttpError(400, '至少需要一个里程碑');

  const bp: Blueprint = {
    id,
    title,
    description: asString(b.description, title).trim() || title,
    constraints: asStringArray(b.constraints),
    definitionOfDone: asString(b.definitionOfDone),
    milestones: milestonesRaw.map((mRaw, mi) => {
      const m = asObject(mRaw);
      const subtasksRaw = Array.isArray(m.subtasks) ? m.subtasks : [];
      return {
        id: asString(m.id, `m${mi + 1}`),
        name: asString(m.name).trim(),
        goal: asString(m.goal),
        acceptance: asStringArray(m.acceptance),
        status: 'pending',
        subtasks: subtasksRaw.map((sRaw, si) => {
          const s = asObject(sRaw);
          return {
            id: asString(s.id, `m${mi + 1}-t${si + 1}`),
            name: asString(s.name).trim(),
            detail: asString(s.detail),
            dependencies: asStringArray(s.dependencies),
            verdict: asVerdict(s.verdict, true),
            status: 'pending',
            evidence: [],
          };
        }),
      };
    }),
  };

  const errors = validateBlueprint(bp);
  if (errors.length > 0) {
    throw new HttpError(400, `蓝图校验失败：${errors.join('；')}`);
  }
  return bp;
}

export class HttpApi {
  private readonly store: Store;
  private readonly loop?: NightOwlLoop;
  private readonly tracker?: CostTracker;
  private readonly controller?: RunController;
  private readonly plugins?: PluginRegistry;
  private readonly providerSettings?: ProviderSettingsStore;
  private readonly providerPolicies?: ProviderPoliciesStore;
  private readonly providerManagement?: ProviderManagementService;
  /** 兼容的同步 /run 与单步 /tick 共享一个前台执行租约。 */
  private foregroundActive = false;

  constructor(options: HttpApiOptions) {
    this.store = options.store;
    this.loop = options.loop;
    this.tracker = options.tracker;
    this.controller = options.controller;
    this.plugins = options.plugins;
    this.providerSettings = options.providerSettings;
    this.providerPolicies = options.providerPolicies;
    this.providerManagement = options.providerManagement;
  }

  /** 统一入口：路由 + 错误兜底（业务错误按 status，未知错误 500） */
  async handle(req: HttpRequest): Promise<HttpResponse> {
    try {
      return await this.route(req.method, req.pathname, req.body);
    } catch (err) {
      if (err instanceof HttpError) {
        return this.json(err.status, { error: err.message });
      }
      if (err instanceof LoopBusyError) {
        return this.json(409, { error: err.message });
      }
      return this.json(500, { error: '内部执行错误', code: 'INTERNAL_ERROR' });
    }
  }

  private async route(
    method: string,
    pathname: string,
    body: unknown,
  ): Promise<HttpResponse> {
    const dynamic = await this.routeDynamic(method, pathname, body);
    if (dynamic) return dynamic;

    switch (pathname) {
      case '/health':
        if (method !== 'GET') return this.methodNotAllowed('GET');
        return this.json(200, { ok: true, project: 'ai-nightowl', version: PROJECT_VERSION });

      case '/status':
        if (method !== 'GET') return this.methodNotAllowed('GET');
        return this.json(200, buildStatus(await this.store.load()));

      case '/cost':
        if (method !== 'GET') return this.methodNotAllowed('GET');
        if (!this.tracker) throw new HttpError(501, '未注入 tracker，/cost 不可用');
        return this.json(200, this.tracker.summary());

      case '/runtime':
        if (method !== 'GET') return this.methodNotAllowed('GET');
        if (!this.controller) throw new HttpError(501, '未注入 controller，后台运行不可用');
        return this.json(200, this.controller.snapshot());

      case '/runtime/start':
        if (method !== 'POST') return this.methodNotAllowed('POST');
        return this.startRuntime(body);

      case '/runtime/stop':
        if (method !== 'POST') return this.methodNotAllowed('POST');
        if (!this.controller) throw new HttpError(501, '未注入 controller，后台运行不可用');
        return this.json(202, this.controller.stop());

      case '/plugins':
        if (method !== 'GET') return this.methodNotAllowed('GET');
        return this.json(200, this.plugins?.snapshot() ?? {
          apiVersion: '1',
          trustModel: 'trusted-local',
          plugins: [],
          providers: [],
        });

      case '/settings/providers':
        if (!this.providerSettings) throw new HttpError(501, '未注入 Provider 设置仓储');
        if (method === 'GET') {
          await this.providerManagement?.refreshRemoteUsage();
          return this.json(200, this.providerSnapshot());
        }
        if (method === 'PUT') return this.updateProviderSettings(body);
        return this.methodNotAllowed('GET, PUT');

      case '/settings/providers/recommend':
        if (method !== 'POST') return this.methodNotAllowed('POST');
        return this.recommendProvider(body);

      case '/settings/providers/apply':
        if (method !== 'POST') return this.methodNotAllowed('POST');
        return this.applyProviderRecommendation(body);

      case '/capabilities':
        if (method !== 'GET') return this.methodNotAllowed('GET');
        return this.json(200, {
          version: PROJECT_VERSION,
          modes: {
            cli: 'available',
            http: 'available',
            mcp: 'available',
            web: 'preview',
            plugin: 'preview',
            remoteWorker: 'planned',
          },
          runtimeControl: Boolean(this.controller),
        });

      case '/blueprint':
        if (method !== 'POST') return this.methodNotAllowed('POST');
        return this.submitDraft(body);

      case '/blueprint/raw':
        if (method !== 'POST') return this.methodNotAllowed('POST');
        return this.submitRaw(body);

      case '/tick':
        if (method !== 'POST') return this.methodNotAllowed('POST');
        return this.tickLoop();

      case '/run':
        if (method !== 'POST') return this.methodNotAllowed('POST');
        return this.runLoop(body);

      default:
        return this.json(404, { error: `未知路径：${method} ${pathname}` });
    }
  }

  private async submitDraft(body: unknown): Promise<HttpResponse> {
    const draft = draftFromBody(body);
    let bp: Blueprint;
    try {
      bp = assembleBlueprint(draft.id, draft);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    await this.freshSave(bp);
    return this.json(201, { created: true, blueprint: bp });
  }

  private async updateProviderSettings(body: unknown): Promise<HttpResponse> {
    if (!this.providerSettings) throw new HttpError(501, '未注入 Provider 设置仓储');
    const input = asObject(body);
    const update: ProviderSettingsUpdate = {};
    const policyUpdate: ProviderPoliciesUpdate = {};
    let changed = false;
    let providerSettingsChanged = false;
    let providerPoliciesChanged = false;

    if (input.preferredProvider !== undefined) {
      const allowed = [
        'auto',
        ...(this.providerManagement?.providerIds() ?? MANAGED_PROVIDER_DEFINITIONS.map((provider) => provider.id)),
      ];
      if (!allowed.includes(String(input.preferredProvider))) {
        throw new HttpError(400, `preferredProvider 必须是 ${allowed.join('、')}`);
      }
      update.preferredProvider = input.preferredProvider as PreferredProvider;
      changed = true;
      providerSettingsChanged = true;
    }

    if (input.apiKeys !== undefined) {
      const rawKeys = asObject(input.apiKeys);
      const managedIds = MANAGED_PROVIDER_DEFINITIONS.map((provider) => provider.id);
      const unknown = Object.keys(rawKeys).filter((key) => !managedIds.includes(key as BuiltInProviderId));
      if (unknown.length > 0) throw new HttpError(400, 'apiKeys 包含未知 Provider');
      const apiKeys: ProviderSettingsUpdate['apiKeys'] = {};
      for (const providerId of managedIds) {
        if (rawKeys[providerId] === undefined) continue;
        if (typeof rawKeys[providerId] !== 'string') throw new HttpError(400, 'API Key 必须是字符串');
        const key = rawKeys[providerId].trim();
        if (!key) throw new HttpError(400, 'API Key 不能为空；不修改时请省略该字段');
        if (key.length > 4096) throw new HttpError(400, 'API Key 长度超出限制');
        apiKeys[providerId] = key;
        changed = true;
        providerSettingsChanged = true;
      }
      update.apiKeys = apiKeys;
    }

    if (input.clear !== undefined) {
      if (!Array.isArray(input.clear)) throw new HttpError(400, 'clear 必须是 Provider id 数组');
      const clear: BuiltInProviderId[] = [];
      for (const providerId of input.clear) {
        if (!MANAGED_PROVIDER_DEFINITIONS.some((provider) => provider.id === providerId)) {
          throw new HttpError(400, 'clear 包含未知 Provider');
        }
        if (!clear.includes(providerId as BuiltInProviderId)) clear.push(providerId as BuiltInProviderId);
      }
      update.clear = clear;
      changed ||= clear.length > 0;
      providerSettingsChanged ||= clear.length > 0;
    }

    if (input.customOpenAI !== undefined) {
      update.customOpenAI = input.customOpenAI as CustomOpenAISettings;
      changed = true;
      providerSettingsChanged = true;
    }

    if (input.priority !== undefined) {
      if (!this.providerPolicies) throw new HttpError(501, '未注入 Provider 资费设置仓储');
      if (!['cost', 'balanced', 'speed', 'quality'].includes(String(input.priority))) {
        throw new HttpError(400, 'priority 必须是 cost、balanced、speed 或 quality');
      }
      policyUpdate.priority = input.priority as ProviderPoliciesUpdate['priority'];
      changed = true;
      providerPoliciesChanged = true;
    }

    if (input.profiles !== undefined) {
      if (!this.providerPolicies || !this.providerManagement) throw new HttpError(501, 'Provider 资费配置不可用');
      if (!input.profiles || typeof input.profiles !== 'object' || Array.isArray(input.profiles)) {
        throw new HttpError(400, 'profiles 必须是 Provider id 到资费画像的对象');
      }
      const profiles = asObject(input.profiles);
      const unknown = Object.keys(profiles).filter((id) => !this.providerManagement!.providerIds().includes(id));
      if (unknown.length > 0) throw new HttpError(400, `profiles 包含未知 Provider：${unknown.join('、')}`);
      policyUpdate.profiles = profiles;
      changed = true;
      providerPoliciesChanged = true;
    }

    if (input.clearProfiles !== undefined) {
      if (!this.providerPolicies || !this.providerManagement) throw new HttpError(501, 'Provider 资费配置不可用');
      if (!Array.isArray(input.clearProfiles)) throw new HttpError(400, 'clearProfiles 必须是 Provider id 数组');
      const clearProfiles = input.clearProfiles.map(String);
      const unknown = clearProfiles.filter((id) => !this.providerManagement!.providerIds().includes(id));
      if (unknown.length > 0) throw new HttpError(400, `clearProfiles 包含未知 Provider：${unknown.join('、')}`);
      policyUpdate.clearProfiles = [...new Set(clearProfiles)];
      changed ||= clearProfiles.length > 0;
      providerPoliciesChanged ||= clearProfiles.length > 0;
    }

    if (!changed) throw new HttpError(400, '没有可保存的 Provider 设置');
    if (providerSettingsChanged) {
      try {
        await this.providerSettings.update(update);
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : 'Provider 设置非法');
      }
    }
    if (providerPoliciesChanged) {
      try {
        await this.providerPolicies!.update(policyUpdate);
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : 'Provider 资费设置非法');
      }
    }
    await this.providerManagement?.refreshRemoteUsage(undefined, true);
    return this.json(200, this.providerSnapshot());
  }

  private async recommendProvider(body: unknown): Promise<HttpResponse> {
    if (!this.providerManagement) throw new HttpError(501, '智能 Provider 匹配不可用');
    const input = asObject(body);
    if (typeof input.request !== 'string' || !input.request.trim()) {
      throw new HttpError(400, 'request 必须是非空字符串');
    }
    try {
      return this.json(200, await this.providerManagement.recommend(input.request));
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : '无法分析 Provider 需求');
    }
  }

  private async applyProviderRecommendation(body: unknown): Promise<HttpResponse> {
    if (!this.providerManagement || !this.providerPolicies || !this.providerSettings) {
      throw new HttpError(501, 'Provider 决策应用不可用');
    }
    const input = asObject(body);
    if (typeof input.optionId !== 'string') throw new HttpError(400, '缺少 optionId');
    const option = this.providerManagement.candidateExists(input.optionId);
    if (!option) throw new HttpError(400, '推荐候选已失效，请重新分析');
    const priority = input.priority === undefined ? this.providerPolicies.priority() : String(input.priority);
    if (!['cost', 'balanced', 'speed', 'quality'].includes(priority)) {
      throw new HttpError(400, 'priority 非法');
    }
    await this.providerSettings.update({ preferredProvider: option.providerId });
    await this.providerPolicies.update({ priority: priority as ProviderPoliciesUpdate['priority'] });
    await this.providerManagement.refreshRemoteUsage(option.providerId, true);
    return this.json(200, {
      applied: true,
      providerId: option.providerId,
      model: option.model,
      settings: this.providerSnapshot(),
    });
  }

  private providerSnapshot(): unknown {
    return this.providerManagement?.snapshot() ?? this.providerSettings?.snapshot();
  }

  private async submitRaw(body: unknown): Promise<HttpResponse> {
    const bp = blueprintFromBody(body);
    await this.freshSave(bp);
    return this.json(201, { created: true, blueprint: bp });
  }

  private async runLoop(body: unknown): Promise<HttpResponse> {
    if (!this.loop) throw new HttpError(501, '未注入 loop，/run 不可用');
    let maxTicks = 100;
    const b = asObject(body);
    if (b.maxTicks !== undefined) {
      if (!Number.isInteger(b.maxTicks) || (b.maxTicks as number) <= 0 || (b.maxTicks as number) > 1000) {
        throw new HttpError(400, 'maxTicks 必须是 1–1000 的整数');
      }
      maxTicks = b.maxTicks as number;
    }

    // 正式服务中的同步兼容接口也复用同一个 controller，因而可被
    // /runtime/stop 停止，且不会与后台 start 形成第二个运行 driver。
    if (this.controller) {
      try {
        this.controller.start({ maxTicks });
      } catch (err) {
        if (err instanceof RuntimeBusyError) throw new HttpError(409, err.message);
        throw err;
      }
      const runtime = await this.controller.wait();
      if (runtime.phase === 'failed') {
        return this.json(500, { error: runtime.error, code: 'RUN_FAILED', runtime });
      }
      return this.json(200, { reports: this.controller.allReports(), runtime });
    }

    this.acquireForeground();
    try {
      const reports = await this.loop.run({ maxTicks });
      return this.json(200, { reports });
    } finally {
      this.foregroundActive = false;
    }
  }

  private async tickLoop(): Promise<HttpResponse> {
    if (!this.loop) throw new HttpError(501, '未注入 loop，/tick 不可用');
    this.acquireForeground();
    try {
      return this.json(200, await this.loop.tick());
    } finally {
      this.foregroundActive = false;
    }
  }

  private acquireForeground(): void {
    if (this.foregroundActive || this.controller?.snapshot().active) {
      throw new HttpError(409, '已有运行正在进行；请等待完成或先停止后台运行');
    }
    this.foregroundActive = true;
  }

  /** 发新任务 = 全新状态：清空旧 checkpoint / 滚动摘要 */
  private async freshSave(bp: Blueprint): Promise<void> {
    if (this.foregroundActive || this.controller?.snapshot().active) {
      throw new HttpError(409, '后台运行进行中；请先停止，再替换蓝图');
    }
    if (this.loop) {
      await this.loop.replaceBlueprint(bp);
    } else {
      await this.store.save({
        schemaVersion: STORE_SCHEMA_VERSION,
        blueprint: bp,
        checkpoints: [],
        rollingSummaries: [],
        updatedAt: '',
        completion: { status: 'pending' },
      });
    }
  }

  private startRuntime(body: unknown): HttpResponse {
    if (!this.controller) throw new HttpError(501, '未注入 controller，后台运行不可用');
    if (this.foregroundActive) throw new HttpError(409, '已有前台运行正在进行');
    const b = asObject(body);
    let maxTicks: number | undefined;
    if (b.maxTicks !== undefined) {
      if (!Number.isInteger(b.maxTicks) || (b.maxTicks as number) <= 0 || (b.maxTicks as number) > 1000) {
        throw new HttpError(400, 'maxTicks 必须是 1–1000 的整数');
      }
      maxTicks = b.maxTicks as number;
    }
    try {
      return this.json(202, this.controller.start(maxTicks ? { maxTicks } : undefined));
    } catch (err) {
      if (err instanceof RuntimeBusyError) throw new HttpError(409, err.message);
      throw err;
    }
  }

  private async routeDynamic(
    method: string,
    pathname: string,
    body: unknown,
  ): Promise<HttpResponse | null> {
    const subtaskMatch = pathname.match(/^\/subtasks\/([^/]+)(?:\/(retry|approve))?$/);
    if (subtaskMatch) {
      const id = decodePathSegment(subtaskMatch[1]);
      const action = subtaskMatch[2];
      if (!action) {
        if (method !== 'GET') return this.methodNotAllowed('GET');
        const state = await this.store.load();
        const milestone = state?.blueprint.milestones.find((m) => m.subtasks.some((s) => s.id === id));
        const subtask = milestone?.subtasks.find((s) => s.id === id);
        if (!state || !milestone || !subtask) return this.json(404, { error: `子任务不存在：${id}` });
        return this.json(200, { blueprintId: state.blueprint.id, milestone: {
          id: milestone.id,
          name: milestone.name,
          status: milestone.status,
        }, subtask });
      }
      if (method !== 'POST') return this.methodNotAllowed('POST');
      return action === 'retry' ? this.retrySubtask(id) : this.approveSubtask(id, body);
    }

    const milestoneMatch = pathname.match(/^\/milestones\/([^/]+)\/retry$/);
    if (milestoneMatch) {
      if (method !== 'POST') return this.methodNotAllowed('POST');
      return this.retryMilestone(decodePathSegment(milestoneMatch[1]));
    }

    if (pathname === '/completion/retry') {
      if (method !== 'POST') return this.methodNotAllowed('POST');
      const updated = await this.mutateState((state) => {
        if (state.completion?.status !== 'blocked') {
          throw new HttpError(409, '整体完成验收当前不处于 blocked');
        }
        state.completion = { status: 'pending' };
      });
      if (!updated) return this.json(404, { error: '尚未创建蓝图' });
      return this.json(200, buildStatus(updated));
    }
    return null;
  }

  private async retrySubtask(id: string): Promise<HttpResponse> {
    const updated = await this.mutateState((state) => {
      const milestone = state.blueprint.milestones.find((m) => m.subtasks.some((s) => s.id === id));
      const subtask = milestone?.subtasks.find((s) => s.id === id);
      if (!milestone || !subtask) throw new HttpError(404, `子任务不存在：${id}`);
      if (subtask.status !== 'blocked') throw new HttpError(409, '只有 blocked 子任务可以重试');
      subtask.status = 'pending';
      subtask.evidence.push({
        kind: 'note',
        content: '用户请求重试。',
        at: new Date().toISOString(),
      });
      milestone.status = 'pending';
      state.completion = { status: 'pending' };
    });
    if (!updated) return this.json(404, { error: '尚未创建蓝图' });
    return this.json(200, buildStatus(updated));
  }

  private async approveSubtask(id: string, body: unknown): Promise<HttpResponse> {
    const b = asObject(body);
    const note = asString(b.note, '用户人工确认通过').slice(0, 500);
    const updated = await this.mutateState((state) => {
      const milestone = state.blueprint.milestones.find((m) => m.subtasks.some((s) => s.id === id));
      const subtask = milestone?.subtasks.find((s) => s.id === id);
      if (!milestone || !subtask) throw new HttpError(404, `子任务不存在：${id}`);
      if (subtask.verdict.kind !== 'manual') throw new HttpError(409, '只有 manual 子任务可以人工批准');
      if (subtask.status === 'done') return;
      if (subtask.status !== 'blocked') {
        throw new HttpError(409, 'manual 子任务只有在执行后进入 blocked 才可批准');
      }
      const allSubtasks = state.blueprint.milestones.flatMap((item) => item.subtasks);
      if (!subtask.dependencies.every((depId) => allSubtasks.find((item) => item.id === depId)?.status === 'done')) {
        throw new HttpError(409, 'manual 子任务的依赖尚未全部完成');
      }
      if (!subtask.evidence.some((item) => item.kind === 'log' || item.kind === 'artifact')) {
        throw new HttpError(409, 'manual 子任务尚无可审批的执行证据');
      }
      subtask.status = 'done';
      subtask.evidence.push({ kind: 'note', content: `人工批准：${note}`, at: new Date().toISOString() });
      milestone.status = 'in-progress';
      state.completion = { status: 'pending' };
    });
    if (!updated) return this.json(404, { error: '尚未创建蓝图' });
    return this.json(200, buildStatus(updated));
  }

  private async retryMilestone(id: string): Promise<HttpResponse> {
    const updated = await this.mutateState((state) => {
      const milestone = state.blueprint.milestones.find((m) => m.id === id);
      if (!milestone) throw new HttpError(404, `里程碑不存在：${id}`);
      if (milestone.status !== 'blocked' || !milestone.subtasks.every((s) => s.status === 'done')) {
        throw new HttpError(409, '只有子任务全部完成但验收 blocked 的里程碑可以重试');
      }
      milestone.status = 'pending';
      state.completion = { status: 'pending' };
    });
    if (!updated) return this.json(404, { error: '尚未创建蓝图' });
    return this.json(200, buildStatus(updated));
  }

  private async mutateState(
    mutate: (state: StoreState) => void | Promise<void>,
  ): Promise<StoreState | null> {
    if (this.loop) return this.loop.updateState(mutate);
    const state = await this.store.load();
    if (!state) return null;
    await mutate(state);
    await this.store.save(state);
    return state;
  }

  private methodNotAllowed(allowed: string): HttpResponse {
    return {
      status: 405,
      headers: { Allow: allowed },
      body: { error: `仅支持 ${allowed} 方法` },
    };
  }

  private json(status: number, body: unknown): HttpResponse {
    return {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body,
    };
  }
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, '路径参数不是合法的 URL 编码');
  }
}
