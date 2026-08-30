import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  Executor,
  HttpApi,
  LoopBusyError,
  NightOwlLoop,
  Scheduler,
  Store,
  SubtaskJudge,
} from '../src/index.js';
import { blueprint, fakeProvider } from './helpers.js';

async function fixture(options: {
  check?: boolean;
  delayMs?: number;
  acceptance?: string[];
  milestonePassed?: boolean;
  milestoneThrows?: boolean;
  definitionOfDone?: string;
  blueprintPassed?: boolean;
  blueprintThrows?: boolean;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'nightowl-runtime-'));
  const store = new Store(dir);
  let calls = 0;
  const provider = fakeProvider({ delayMs: options.delayMs, onChat: () => { calls += 1; } });
  const loop = new NightOwlLoop({
    store,
    executor: new Executor(provider),
    judge: new SubtaskJudge({ checkFn: async () => options.check ?? true }),
    scheduler: new Scheduler([provider]),
    options: {
      runOffPeakOnly: false,
      pollIntervalMs: options.pollIntervalMs ?? 0,
      _sleep: options.sleep,
      milestoneVerifier: async () => {
        if (options.milestoneThrows) throw new Error('temporary verifier failure');
        return { passed: options.milestonePassed ?? true, detail: 'milestone verdict' };
      },
      blueprintVerifier: async () => {
        if (options.blueprintThrows) throw new Error('temporary verifier failure');
        return { passed: options.blueprintPassed ?? true, detail: 'blueprint verdict' };
      },
    },
  });
  await loop.replaceBlueprint(blueprint({
    acceptance: options.acceptance,
    definitionOfDone: options.definitionOfDone,
  }));
  return { dir, store, loop, calls: () => calls };
}

test('并发 tick 对同一子任务只执行一次', async (t) => {
  const f = await fixture({ delayMs: 25 });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const reports = await Promise.all([f.loop.tick(), f.loop.tick()]);
  assert.equal(f.calls(), 1);
  assert.deepEqual(reports.map((r) => r.ran).sort(), [0, 1]);
  assert.equal((await f.store.load())?.blueprint.milestones[0].subtasks[0].status, 'done');
});

test('blocked 子任务不会被下一 tick 隐式重试', async (t) => {
  const f = await fixture({ check: false });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const first = await f.loop.tick();
  const second = await f.loop.tick();
  assert.equal(first.blocked, 1);
  assert.equal(second.ran, 0);
  assert.equal(second.idleReason, 'no-runnable');
  assert.equal(f.calls(), 1);
});

test('提交新蓝图后旧状态不会覆盖新蓝图', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  await f.loop.tick();
  const api = new HttpApi({ store: f.store, loop: f.loop });
  const replacement = blueprint({ id: 'replacement' });
  const response = await api.handle({ method: 'POST', pathname: '/blueprint/raw', body: replacement });
  assert.equal(response.status, 201);
  await f.loop.tick();
  const state = await f.store.load();
  assert.equal(state?.blueprint.id, 'replacement');
  assert.equal(state?.blueprint.milestones[0].subtasks[0].status, 'done');
});

test('acceptance 未通过时里程碑与整体都不会假完成', async (t) => {
  const f = await fixture({ acceptance: ['必须通过'], milestonePassed: false });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const report = await f.loop.tick();
  const state = await f.store.load();
  assert.equal(report.done, false);
  assert.equal(state?.blueprint.milestones[0].status, 'blocked');
  assert.notEqual(state?.completion?.status, 'done');
});

test('definitionOfDone 未通过时 completion=blocked', async (t) => {
  const f = await fixture({ definitionOfDone: '整体必须验收', blueprintPassed: false });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const report = await f.loop.tick();
  const state = await f.store.load();
  assert.equal(report.done, false);
  assert.equal(state?.blueprint.milestones[0].status, 'done');
  assert.equal(state?.completion?.status, 'blocked');
});

test('验收器异常会固化为 blocked，不会重做已完成子任务', async (t) => {
  const f = await fixture({ acceptance: ['必须通过'], milestoneThrows: true });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const first = await f.loop.tick();
  const second = await f.loop.tick();
  const state = await f.store.load();
  assert.equal(first.done, false);
  assert.equal(second.ran, 0);
  assert.equal(f.calls(), 1);
  assert.equal(state?.blueprint.milestones[0].status, 'blocked');
  assert.equal(state?.blueprint.milestones[0].subtasks[0].status, 'done');
  assert.match(state?.blueprint.milestones[0].subtasks[0].evidence.at(-1)?.content ?? '', /验收执行失败/);
});

test('连续 run 持有唯一运行租约，拒绝外部 tick 与蓝图替换', async (t) => {
  const f = await fixture({ delayMs: 20 });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const running = f.loop.run({ maxTicks: 5 });
  await assert.rejects(() => f.loop.tick(), LoopBusyError);
  await assert.rejects(() => f.loop.replaceBlueprint(blueprint({ id: 'too-early' })), LoopBusyError);
  assert.equal((await running).at(-1)?.done, true);
});

test('可取消等待会清理 abort listener', async (t) => {
  const f = await fixture({ pollIntervalMs: 1, sleep: async () => undefined });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const state = await f.store.load();
  assert.ok(state);
  state.blueprint.milestones[0].subtasks.push({
    id: 's2', name: 'S2', detail: '第二步', dependencies: ['s1'],
    verdict: { kind: 'check', check: 'ok', criteria: [] }, status: 'pending', evidence: [],
  });
  await f.store.save(state);
  const controller = new AbortController();
  const reports = await f.loop.run({ maxTicks: 3, signal: controller.signal });
  assert.equal(reports.at(-1)?.done, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('高峰轮询即使配置 0ms 也保留正等待，避免忙循环', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nightowl-offpeak-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const provider = fakeProvider();
  const controller = new AbortController();
  let slept = 0;
  const loop = new NightOwlLoop({
    store: new Store(dir),
    executor: new Executor(provider),
    judge: new SubtaskJudge({ checkFn: () => true }),
    scheduler: { msUntilNextOffPeak: () => 10_000 } as unknown as Scheduler,
    options: {
      runOffPeakOnly: true,
      pollIntervalMs: 0,
      _sleep: async (ms) => { slept = ms; controller.abort(); },
    },
  });
  await loop.run({ signal: controller.signal });
  assert.equal(slept, 1_000);
});

test('执行错误写入 evidence 前会脱敏并截断', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nightowl-redaction-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const provider = fakeProvider();
  provider.chat = async () => { throw new Error('Bearer demo-token api_key=demo-secret'); };
  const store = new Store(dir);
  const loop = new NightOwlLoop({
    store,
    executor: new Executor(provider),
    judge: new SubtaskJudge({ checkFn: () => true }),
    scheduler: new Scheduler([provider]),
    options: { runOffPeakOnly: false },
  });
  await loop.replaceBlueprint(blueprint());
  await loop.tick();
  const evidence = (await store.load())?.blueprint.milestones[0].subtasks[0].evidence
    .map((item) => item.content).join('\n') ?? '';
  assert.doesNotMatch(evidence, /demo-token|demo-secret/);
  assert.match(evidence, /REDACTED/);
});
