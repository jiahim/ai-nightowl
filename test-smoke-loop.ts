// 临时 smoke：验证 m3-loop 端到端跑通（执行 → 判定 → 状态回写 → 里程碑 → checkpoint → 落盘）
import {
  NightOwlLoop,
  PlanState,
  Store,
  Executor,
  SubtaskJudge,
  Scheduler,
  DeepSeekAdapter,
} from './src/index';
import type { Blueprint, ProviderAdapter } from './src/index';

// 假 adapter：不真调 API，返回固定产出
const fakeAdapter: ProviderAdapter = {
  id: 'fake',
  config: { id: 'fake', name: 'fake', baseUrl: '', apiKeyEnv: 'X', models: [], costStrategy: {} },
  isOffPeak: () => true,
  currentDiscount: () => 1,
  routeModel: () => ({ name: 'fake-chat', kind: 'chat', inputPrice: 0, outputPrice: 0, contextWindow: 1000 }),
  chat: async () => ({ content: 'DONE OUTPUT', model: 'fake-chat' }),
};

const blueprint: Blueprint = {
  id: 'loop-smoke',
  title: 'loop',
  description: '',
  constraints: [],
  definitionOfDone: '',
  milestones: [
    {
      id: 'm1',
      name: 'M1',
      goal: 'test',
      acceptance: [],
      status: 'pending',
      subtasks: [
        { id: 's1', name: 's1', detail: '', dependencies: [], verdict: { kind: 'check', check: 'ok', criteria: [] }, status: 'pending', evidence: [] },
        { id: 's2', name: 's2', detail: '', dependencies: ['s1'], verdict: { kind: 'check', check: 'ok', criteria: [] }, status: 'pending', evidence: [] },
      ],
    },
  ],
};

const dir = '/tmp/nightowl-loop-smoke';
const store = new Store(dir);
// 先落一份初始状态（loop 从磁盘加载）
await store.save({ blueprint, checkpoints: [], rollingSummaries: [], updatedAt: '' });

const loop = new NightOwlLoop({
  store,
  executor: new Executor(fakeAdapter),
  judge: new SubtaskJudge({ checkFn: async () => true }),
  scheduler: new Scheduler([fakeAdapter]),
  options: { maxSubtasksPerTick: 1, runOffPeakOnly: false, pollIntervalMs: 1, _sleep: async () => {} },
});

const reports = await loop.run({ maxTicks: 10 });
console.log('reports:', JSON.stringify(reports, null, 2));

const final = await loop.blueprint();
const plan = new PlanState(final!);
console.log('[a] s1 =', plan.getSubtask('s1')!.status, '(期望 done)');
console.log('[b] s2 =', plan.getSubtask('s2')!.status, '(期望 done)');
console.log('[c] m1 =', final!.milestones[0].status, '(期望 done)');
console.log('[d] isDone =', plan.isDone(), '(期望 true)');
console.log('[e] checkpoints =', JSON.stringify((await store.load())!.checkpoints));

console.log('\n✅ loop smoke 通过');
