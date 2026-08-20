// 临时 smoke：验证 m4-http（HttpApi 路由 + 发任务/查状态/推进 + server 接线）端到端跑通
import {
  HttpApi,
  HttpError,
  buildStatus,
  NightOwlLoop,
  Store,
  Executor,
  SubtaskJudge,
  Scheduler,
  createHttpServer,
  startServer,
} from './src/index';
import type { Blueprint, ProviderAdapter } from './src/index';

const dir = '/tmp/nightowl-http-smoke';
const store = new Store(dir);
const api = new HttpApi({ store }); // 无 loop：/tick /run 应 501

const call = (method: string, pathname: string, body?: unknown) =>
  api.handle({ method, pathname, body });

// [1] health
const health = await call('GET', '/health');
console.log('[a] health =', health.status === 200 && (health.body as any).ok === true, '(期望 true)');

// [2] 空状态
const empty = await call('GET', '/status');
console.log('[b] 空态 hasBlueprint =', buildStatus(await store.load()).hasBlueprint === false, '(期望 true)');

// [3] 发任务（draft）
const draft = {
  id: 'http-draft',
  title: 'http 任务',
  description: '测试 HTTP 发任务',
  constraints: ['技术栈 TS'],
  definitionOfDone: '全部完成',
  milestones: [
    {
      name: '里程碑一',
      goal: '第一个里程碑',
      acceptance: ['验收 A'],
      subtasks: [
        { name: '子任务1', detail: '做第一步', dependencies: [], criteria: ['标准1'] },
        { name: '子任务2', detail: '做第二步', dependencies: ['子任务1'], criteria: ['标准2'] },
      ],
    },
  ],
};
const created = await call('POST', '/blueprint', draft);
console.log('[c] draft 创建 =', created.status === 201, '(期望 true)');
const createdBp = (created.body as any).blueprint as Blueprint;
console.log('[d] 子任务数 =', createdBp.milestones[0].subtasks.length, '(期望 2)');
console.log('[e] 依赖按名解析 =', createdBp.milestones[0].subtasks[1].dependencies[0] === 'm1-t1', '(期望 true)');

// [4] 查状态
const status = await call('GET', '/status');
const st = status.body as any;
console.log('[f] 查状态 hasBlueprint =', st.hasBlueprint === true, '(期望 true)');
console.log('[g] 进度 total =', st.progress.total, '(期望 2)');

// [5] 发任务（raw，完整蓝图）
const rawBp: Blueprint = {
  id: 'http-raw',
  title: 'raw 任务',
  description: '完整蓝图直接提交',
  constraints: [],
  definitionOfDone: 'done',
  milestones: [
    {
      id: 'm1',
      name: 'M1',
      goal: 'g',
      acceptance: [],
      status: 'pending',
      subtasks: [
        { id: 's1', name: 's1', detail: '', dependencies: [], verdict: { kind: 'check', check: 'ok', criteria: [] }, status: 'pending', evidence: [] },
      ],
    },
  ],
};
const raw = await call('POST', '/blueprint/raw', rawBp);
console.log('[h] raw 创建 =', raw.status === 201, '(期望 true)');

// [6] 错误路径
const bad = await call('POST', '/blueprint', { milestones: [] });
console.log('[i] 缺 title =', bad.status === 400, '(期望 true)');
const notFound = await call('GET', '/nope');
console.log('[j] 未知路径 =', notFound.status === 404, '(期望 true)');
const noLoop = await call('POST', '/tick');
console.log('[k] 无 loop tick =', noLoop.status === 501, '(期望 true)');
const wrongMethod = await call('DELETE', '/status');
console.log('[l] 错误方法 =', wrongMethod.status === 405, '(期望 true)');

// [7] 注入 loop 后 tick 推进（fake adapter + checkFn 判定）
const fakeAdapter: ProviderAdapter = {
  id: 'fake',
  config: { id: 'fake', name: 'fake', baseUrl: '', apiKeyEnv: 'X', models: [], costStrategy: {} },
  isOffPeak: () => true,
  currentDiscount: () => 1,
  routeModel: () => ({ name: 'fake-chat', kind: 'chat', inputPrice: 0, outputPrice: 0, contextWindow: 1000 }),
  chat: async () => ({ content: 'DONE OUTPUT', model: 'fake-chat' }),
};
await store.save({ blueprint: rawBp, checkpoints: [], rollingSummaries: [], updatedAt: '' });
const loop = new NightOwlLoop({
  store,
  executor: new Executor(fakeAdapter),
  judge: new SubtaskJudge({ checkFn: async () => true }),
  scheduler: new Scheduler([fakeAdapter]),
  options: { maxSubtasksPerTick: 1, runOffPeakOnly: false, pollIntervalMs: 1, _sleep: async () => {} },
});
const loopApi = new HttpApi({ store, loop });
const t1 = await loopApi.handle({ method: 'POST', pathname: '/tick', body: undefined });
const t1r = (t1.body as any) as { ran: number; completed: number; done: boolean };
console.log('[m] tick1 completed =', t1r.completed === 1, '(期望 true)');
const after1 = buildStatus(await store.load());
console.log('[n] 进度 after tick1 =', after1.progress.done, '(期望 1)');
const t2 = await loopApi.handle({ method: 'POST', pathname: '/tick', body: undefined });
const t2r = (t2.body as any) as { completed: number; done: boolean };
console.log('[o] tick2 done =', t2r.done === true, '(期望 true)');
console.log('[p] 蓝图整体完成 =', buildStatus(await store.load()).done === true, '(期望 true)');

// [8] server 接线：起真实端口，fetch 验证
const server = await startServer(new HttpApi({ store }), { host: '127.0.0.1', port: 0 });
const addr = server.address();
const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
const healthJson = (await healthRes.json()) as { ok: boolean };
console.log('[q] 真实 server /health =', healthRes.status === 200 && healthJson.ok === true, '(期望 true)');
const statusRes = await fetch(`http://127.0.0.1:${port}/status`);
console.log('[r] 真实 server /status =', statusRes.status === 200, '(期望 true)');
server.close();

console.log('\n✅ m4-http smoke 通过');
