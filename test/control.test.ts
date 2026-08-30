import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  Executor,
  HttpApi,
  NightOwlLoop,
  PluginRegistry,
  RunController,
  Scheduler,
  Store,
  SubtaskJudge,
  getWebAsset,
  loadPluginModules,
} from '../src/index.js';
import { blueprint, fakeProvider } from './helpers.js';

test('后台 controller 非阻塞启动并可查询完成', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nightowl-control-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  const provider = fakeProvider({ delayMs: 10 });
  const loop = new NightOwlLoop({
    store,
    executor: new Executor(provider),
    judge: new SubtaskJudge({ checkFn: () => true }),
    scheduler: new Scheduler([provider]),
    options: { runOffPeakOnly: false, pollIntervalMs: 0 },
  });
  await loop.replaceBlueprint(blueprint());
  const controller = new RunController(loop);
  const api = new HttpApi({ store, loop, controller });
  const started = await api.handle({ method: 'POST', pathname: '/runtime/start', body: { maxTicks: 5 } });
  assert.equal(started.status, 202);
  assert.equal((started.body as any).active, true);
  const competingTick = await api.handle({ method: 'POST', pathname: '/tick', body: {} });
  assert.equal(competingTick.status, 409);
  const finished = await controller.wait();
  assert.equal(finished.phase, 'succeeded');
  assert.equal(finished.lastReport?.done, true);

  await loop.replaceBlueprint(blueprint({ id: 'foreground' }));
  const foreground = api.handle({ method: 'POST', pathname: '/run', body: { maxTicks: 5 } });
  const competingBackground = await api.handle({
    method: 'POST',
    pathname: '/runtime/start',
    body: { maxTicks: 5 },
  });
  assert.equal(competingBackground.status, 409);
  assert.equal((await foreground).status, 200);
});

test('controller 以真实终态为准：完成优先于晚到 stop，blocked 优先于轮数上限', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nightowl-controller-terminal-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  let controller!: RunController;
  let stopDuringChat = true;
  const provider = fakeProvider({ delayMs: 10, onChat: () => {
    if (stopDuringChat) controller.stop();
  } });
  let passes = true;
  const loop = new NightOwlLoop({
    store,
    executor: new Executor(provider),
    judge: new SubtaskJudge({ checkFn: () => passes }),
    scheduler: new Scheduler([provider]),
    options: { runOffPeakOnly: false, pollIntervalMs: 0 },
  });
  controller = new RunController(loop);

  await loop.replaceBlueprint(blueprint({ id: 'late-stop' }));
  controller.start({ maxTicks: 1 });
  assert.equal((await controller.wait()).phase, 'succeeded');

  stopDuringChat = false;
  passes = false;
  await loop.replaceBlueprint(blueprint({ id: 'blocked-at-limit' }));
  controller.start({ maxTicks: 1 });
  assert.equal((await controller.wait()).phase, 'blocked');

  passes = true;
  await loop.replaceBlueprint(blueprint({ id: 'acceptance-at-limit', acceptance: ['必须验收'] }));
  controller.start({ maxTicks: 1 });
  assert.equal((await controller.wait()).phase, 'blocked');

  await loop.replaceBlueprint(blueprint({ id: 'dod-at-limit', definitionOfDone: '必须整体验收' }));
  controller.start({ maxTicks: 1 });
  assert.equal((await controller.wait()).phase, 'blocked');
});

test('stop 会释放同一 batch 中尚未开始的任务', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nightowl-stop-batch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  let calls = 0;
  let controller!: RunController;
  const provider = fakeProvider({ onChat: () => {
    calls += 1;
    if (calls === 1) controller.stop();
  } });
  const loop = new NightOwlLoop({
    store,
    executor: new Executor(provider),
    judge: new SubtaskJudge({ checkFn: () => true }),
    scheduler: new Scheduler([provider]),
    options: { runOffPeakOnly: false, pollIntervalMs: 0, maxSubtasksPerTick: 2 },
  });
  const bp = blueprint({ id: 'stop-batch' });
  bp.milestones[0].subtasks.push({
    id: 's2', name: 'S2', detail: '不应启动', dependencies: [],
    verdict: { kind: 'check', check: 'ok', criteria: [] }, status: 'pending', evidence: [],
  });
  await loop.replaceBlueprint(bp);
  controller = new RunController(loop);
  controller.start({ maxTicks: 2 });
  const runtime = await controller.wait();
  const state = await store.load();
  assert.equal(runtime.phase, 'cancelled');
  assert.equal(calls, 1);
  assert.equal(state?.blueprint.milestones[0].subtasks[0].status, 'done');
  assert.equal(state?.blueprint.milestones[0].subtasks[1].status, 'pending');
});

test('同步 /run 保留完整 reports，而 runtime 快照只保留最近窗口', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nightowl-run-compat-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  const provider = fakeProvider();
  const loop = new NightOwlLoop({
    store,
    executor: new Executor(provider),
    judge: new SubtaskJudge({ checkFn: () => true }),
    scheduler: new Scheduler([provider]),
    options: { runOffPeakOnly: false, pollIntervalMs: 0 },
  });
  const bp = blueprint({ id: 'run-compat' });
  bp.milestones[0].subtasks.push({
    id: 's2', name: 'S2', detail: '第二步', dependencies: ['s1'],
    verdict: { kind: 'check', check: 'ok', criteria: [] }, status: 'pending', evidence: [],
  });
  await loop.replaceBlueprint(bp);
  const controller = new RunController(loop, 1);
  const api = new HttpApi({ store, loop, controller });
  const response = await api.handle({ method: 'POST', pathname: '/run', body: { maxTicks: 5 } });
  assert.equal(response.status, 200);
  assert.equal((response.body as any).reports.length, 2);
  assert.equal((response.body as any).runtime.recentReports.length, 1);
});

test('同步 /run 保留旧的失败 HTTP 语义', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nightowl-run-failure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'state.json'), '{broken', 'utf-8');
  const store = new Store(dir);
  const provider = fakeProvider();
  const loop = new NightOwlLoop({
    store,
    executor: new Executor(provider),
    judge: new SubtaskJudge({ checkFn: () => true }),
    scheduler: new Scheduler([provider]),
    options: { runOffPeakOnly: false },
  });
  const controller = new RunController(loop);
  const api = new HttpApi({ store, loop, controller });
  const response = await api.handle({ method: 'POST', pathname: '/run', body: { maxTicks: 1 } });
  assert.equal(response.status, 500);
  assert.equal((response.body as any).code, 'RUN_FAILED');
});

test('blocked retry 与 manual approve 都是显式控制命令', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nightowl-actions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  const provider = fakeProvider();
  let checkPasses = false;
  const loop = new NightOwlLoop({
    store,
    executor: new Executor(provider),
    judge: new SubtaskJudge({ checkFn: () => checkPasses }),
    scheduler: new Scheduler([provider]),
    options: { runOffPeakOnly: false, pollIntervalMs: 0 },
  });
  const api = new HttpApi({ store, loop });
  await loop.replaceBlueprint(blueprint());
  await loop.tick();
  const retried = await api.handle({ method: 'POST', pathname: '/subtasks/s1/retry', body: {} });
  assert.equal(retried.status, 200);
  assert.equal((await store.load())?.blueprint.milestones[0].subtasks[0].status, 'pending');
  checkPasses = true;
  assert.equal((await loop.tick()).done, true);

  await loop.replaceBlueprint(blueprint({ id: 'manual', verdictKind: 'manual' }));
  const premature = await api.handle({ method: 'POST', pathname: '/subtasks/s1/approve', body: {} });
  assert.equal(premature.status, 409);
  await loop.tick();
  const approved = await api.handle({ method: 'POST', pathname: '/subtasks/s1/approve', body: { note: 'reviewed' } });
  assert.equal(approved.status, 200);
  assert.equal((await store.load())?.blueprint.milestones[0].subtasks[0].status, 'done');
});

test('Web Console 资源由同源服务提供且不含内联脚本', () => {
  const html = getWebAsset('/');
  const js = getWebAsset('/app.js');
  const css = getWebAsset('/app.css');
  assert.match(html?.body ?? '', /ai-nightowl/);
  assert.match(html?.body ?? '', /<script src="\/app\.js" defer><\/script>/);
  assert.ok(!/<script>/.test(html?.body ?? ''));
  assert.match(js?.contentType ?? '', /javascript/);
  assert.match(js?.body ?? '', /\/completion\/retry/);
  assert.match(css?.body ?? '', /@media/);
});

test('控制 API 把非法 URL 路径参数映射为 400', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nightowl-path-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const api = new HttpApi({ store: new Store(dir) });
  const response = await api.handle({ method: 'GET', pathname: '/subtasks/%E0%A4%A', body: undefined });
  assert.equal(response.status, 400);
});

test('raw 蓝图拒绝未知 verdict，避免静默降级监督模式', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nightowl-verdict-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const api = new HttpApi({ store: new Store(dir) });
  const raw = blueprint() as any;
  raw.milestones[0].subtasks[0].verdict.kind = 'manul';
  const response = await api.handle({ method: 'POST', pathname: '/blueprint/raw', body: raw });
  assert.equal(response.status, 400);
  assert.match((response.body as { error: string }).error, /llm、check 或 manual/);
});

test('PluginRegistry 校验 manifest 并展示 Provider 来源', async () => {
  const registry = new PluginRegistry();
  const provider = fakeProvider({ id: 'plugin-provider' });
  await registry.activate({
    manifest: {
      id: 'example.provider', name: 'Example Provider', version: '1.0.0', apiVersion: '1',
      contributions: [{ kind: 'provider', id: provider.id, name: 'Example' }],
      permissions: ['network', 'secrets'],
    },
    activate(context) { context.registerProvider(provider); },
  });
  assert.equal(registry.provider('plugin-provider'), provider);
  assert.equal(registry.snapshot().providers[0].pluginId, 'example.provider');
  await assert.rejects(() => registry.activate({
    manifest: { id: 'bad', name: 'Bad', version: '1', apiVersion: '2' as '1', contributions: [] },
    activate() {},
  }), /API 不兼容/);
  await assert.rejects(() => registry.activate({
    manifest: {
      id: 'bad-permission', name: 'Bad Permission', version: '1', apiVersion: '1',
      contributions: [], permissions: ['root' as any],
    },
    activate() {},
  }), /未知 permission/);
  await assert.rejects(() => registry.activate({
    manifest: {
      id: 'bad-provider', name: 'Bad Provider', version: '1', apiVersion: '1',
      contributions: [{ kind: 'provider', id: 'broken', name: 'Broken' }],
    },
    activate(context) { context.registerProvider({ id: 'broken' } as any); },
  }), /缺少 config/);
});

test('插件 loader 只加载显式本地模块', async () => {
  const registry = await loadPluginModules(['./test/fixtures/provider-plugin.mjs'], {
    baseDir: process.cwd(),
  });
  assert.equal(registry.provider('fixture-provider')?.id, 'fixture-provider');
  await assert.rejects(() => loadPluginModules(['https://example.com/plugin.js']), /不允许从远程 URL/);
});
