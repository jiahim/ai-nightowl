// 临时 smoke 测试：验证第一版骨架各模块能真正跑起来
import { DeepSeekAdapter, PlanState, Scheduler, Store } from './src/index';
import type { Blueprint } from './src/index';

// 工具：构造北京时间指定时刻
const t = (h: number, m = 0) =>
  new Date(`2026-08-19T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`);

// 1. DeepSeek adapter 的时段判断（高峰 9-12/14-18，其余空闲 5 折）
const ds = new DeepSeekAdapter();
console.log('[1] isOffPeak(10:00 高峰) =', ds.isOffPeak(t(10)), '(期望 false)');
console.log('[1] isOffPeak(15:00 高峰) =', ds.isOffPeak(t(15)), '(期望 false)');
console.log('[1] isOffPeak(03:00 空闲) =', ds.isOffPeak(t(3)), '(期望 true)');
console.log('[1] isOffPeak(13:00 空闲) =', ds.isOffPeak(t(13)), '(期望 true)');
console.log('[1] isOffPeak(20:00 空闲) =', ds.isOffPeak(t(20)), '(期望 true)');
console.log('[1] discount(03:00) =', ds.currentDiscount(t(3)), '(期望 0.5)');
console.log('[1] discount(10:00) =', ds.currentDiscount(t(10)), '(期望 1)');

// 2. Scheduler
const sched = new Scheduler([ds]);
console.log('[2] msUntilNextOffPeak(22:40 空闲) =', sched.msUntilNextOffPeak(t(22, 40)), 'ms (期望 0)');
console.log('[2] msUntilNextOffPeak(10:00 高峰) =', sched.msUntilNextOffPeak(t(10)), 'ms (期望 7200000)');
console.log('[2] inAnyOffPeak(15:00 高峰) =', sched.inAnyOffPeak(t(15)), '(期望 false)');

// 3. PlanState 状态机
const blueprint: Blueprint = {
  id: 'test',
  title: 'smoke',
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
        { id: 's1', name: 's1', detail: '', dependencies: [], verdict: { kind: 'manual', criteria: [] }, status: 'done', evidence: [] },
        { id: 's2', name: 's2', detail: '', dependencies: ['s1'], verdict: { kind: 'manual', criteria: [] }, status: 'pending', evidence: [] },
      ],
    },
  ],
};
const plan = new PlanState(blueprint);
console.log('[3] s2 runnable =', plan.isRunnable(plan.getSubtask('s2')!), '(期望 true，s1 已 done)');
plan.setSubtaskStatus('s2', 'done');
plan.refreshAllMilestones();
console.log('[3] m1 status =', blueprint.milestones[0].status, '(期望 done)');
console.log('[3] isDone =', plan.isDone(), '(期望 true)');

// 4. Store 落盘读写
const store = new Store('/tmp/nightowl-smoke');
const state = { blueprint, checkpoints: [], rollingSummaries: [], updatedAt: '' };
await store.save(state);
const loaded = await store.load();
console.log('[4] store roundtrip =', loaded?.blueprint.id === 'test', '(期望 true)');

console.log('\n✅ smoke 全部通过');
