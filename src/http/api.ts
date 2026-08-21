import type {
  Blueprint,
  SubtaskStatus,
  Verdict,
  VerdictKind,
} from '../types.js';
import { PlanState } from '../plan/state.js';
import { Store, type StoreState } from '../memory/store.js';
import { assembleBlueprint, type BlueprintDraft } from '../blueprint/guide.js';
import { validateBlueprint } from '../blueprint/validate.js';
import type { NightOwlLoop } from '../runtime/loop.js';
import type { CostTracker } from '../cost/tracker.js';

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

export const PROJECT_VERSION = '0.1.0';

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
    subtasks: Array<{ id: string; name: string; status: SubtaskStatus }>;
  }>;
  progress: { done: number; total: number; percent: number };
  done: boolean;
  checkpoints: number;
  updatedAt: string | null;
}

export interface HttpApiOptions {
  store: Store;
  /** 可选：注入后 /tick /run 才可用；未注入时这两个端点返回 501 */
  loop?: NightOwlLoop;
  /** 可选：注入后 GET /cost 返回累计成本汇总 */
  tracker?: CostTracker;
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
      subtasks: m.subtasks.map((s) => ({ id: s.id, name: s.name, status: s.status })),
    })),
    progress: {
      done: doneCount,
      total,
      percent: total > 0 ? Math.round((doneCount / total) * 100) : 0,
    },
    done: plan.isDone(),
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

function asStatus(v: unknown): SubtaskStatus {
  return v === 'done' || v === 'in-progress' || v === 'blocked' ? v : 'pending';
}

function asVerdictKind(v: unknown): VerdictKind {
  return v === 'check' || v === 'manual' ? v : 'llm';
}

function asVerdict(v: unknown): Verdict {
  const o = asObject(v);
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
          verdictKind: asVerdictKind(s.verdictKind),
          criteria: asStringArray(s.criteria),
        };
      }),
    };
  });

  return {
    id: asString(b.id, 'blueprint'),
    title,
    description: asString(b.description),
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
    description: asString(b.description),
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
        status: asStatus(m.status),
        subtasks: subtasksRaw.map((sRaw, si) => {
          const s = asObject(sRaw);
          return {
            id: asString(s.id, `t${si + 1}`),
            name: asString(s.name).trim(),
            detail: asString(s.detail),
            dependencies: asStringArray(s.dependencies),
            verdict: asVerdict(s.verdict),
            status: asStatus(s.status),
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

  constructor(options: HttpApiOptions) {
    this.store = options.store;
    this.loop = options.loop;
    this.tracker = options.tracker;
  }

  /** 统一入口：路由 + 错误兜底（业务错误按 status，未知错误 500） */
  async handle(req: HttpRequest): Promise<HttpResponse> {
    try {
      return await this.route(req.method, req.pathname, req.body);
    } catch (err) {
      if (err instanceof HttpError) {
        return this.json(err.status, { error: err.message });
      }
      return this.json(500, { error: (err as Error).message });
    }
  }

  private async route(
    method: string,
    pathname: string,
    body: unknown,
  ): Promise<HttpResponse> {
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

      case '/blueprint':
        if (method !== 'POST') return this.methodNotAllowed('POST');
        return this.submitDraft(body);

      case '/blueprint/raw':
        if (method !== 'POST') return this.methodNotAllowed('POST');
        return this.submitRaw(body);

      case '/tick':
        if (method !== 'POST') return this.methodNotAllowed('POST');
        if (!this.loop) throw new HttpError(501, '未注入 loop，/tick 不可用');
        return this.json(200, await this.loop.tick());

      case '/run':
        if (method !== 'POST') return this.methodNotAllowed('POST');
        return this.runLoop(body);

      default:
        return this.json(404, { error: `未知路径：${method} ${pathname}` });
    }
  }

  private async submitDraft(body: unknown): Promise<HttpResponse> {
    const draft = draftFromBody(body);
    const bp = assembleBlueprint(draft.id, draft);
    await this.freshSave(bp);
    return this.json(201, { created: true, blueprint: bp });
  }

  private async submitRaw(body: unknown): Promise<HttpResponse> {
    const bp = blueprintFromBody(body);
    await this.freshSave(bp);
    return this.json(201, { created: true, blueprint: bp });
  }

  private async runLoop(body: unknown): Promise<HttpResponse> {
    if (!this.loop) throw new HttpError(501, '未注入 loop，/run 不可用');
    let maxTicks: number | undefined;
    const b = asObject(body);
    if (typeof b.maxTicks === 'number' && b.maxTicks > 0) maxTicks = b.maxTicks;
    const reports = await this.loop.run(maxTicks !== undefined ? { maxTicks } : undefined);
    return this.json(200, { reports });
  }

  /** 发新任务 = 全新状态：清空旧 checkpoint / 滚动摘要 */
  private async freshSave(bp: Blueprint): Promise<void> {
    await this.store.save({
      blueprint: bp,
      checkpoints: [],
      rollingSummaries: [],
      updatedAt: '',
    });
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
