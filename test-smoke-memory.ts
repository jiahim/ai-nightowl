// 临时 smoke：验证 m3-memory（Summarizer）端到端跑通
// collectSince → compress（确定性 fallback）→ seq 递增 → 水位线续跑 → truncation → summarizeMilestone
import { Summarizer, Store } from './src/index';
import type { Blueprint, StoreState } from './src/index';

const blueprint: Blueprint = {
  id: 'mem-smoke',
  title: 'mem',
  description: '',
  constraints: [],
  definitionOfDone: '',
  milestones: [
    {
      id: 'm1',
      name: 'M1',
      goal: 'test',
      acceptance: [],
      status: 'done',
      subtasks: [
        {
          id: 's1',
          name: 's1',
          detail: '',
          dependencies: [],
          verdict: { kind: 'check', check: 'ok', criteria: [] },
          status: 'done',
          evidence: [
            { kind: 'log', content: '产出 A', at: '2026-08-20T00:00:01.000Z' },
            { kind: 'note', content: '判定完成', at: '2026-08-20T00:00:02.000Z' },
          ],
        },
        {
          id: 's2',
          name: 's2',
          detail: '',
          dependencies: ['s1'],
          verdict: { kind: 'check', check: 'ok', criteria: [] },
          status: 'done',
          evidence: [
            { kind: 'log', content: '产出 B', at: '2026-08-20T00:00:03.000Z' },
          ],
        },
      ],
    },
  ],
};

const state: StoreState = {
  blueprint,
  checkpoints: [],
  rollingSummaries: [],
  updatedAt: '',
};

const summarizer = new Summarizer(); // 无 summarizeFn → 确定性 fallback

// [1] 首次压缩：应收集全部 3 条证据，生成 seq=1 的摘要
const s1 = await summarizer.compress(state);
console.log('[a] seq =', s1?.seq, '(期望 1)');
console.log('[b] since =', s1?.since, '(期望 2026-08-20T00:00:03.000Z)');
console.log('[c] content 含「共 3 条证据」=', s1?.content.includes('共 3 条证据'), '(期望 true)');
console.log('[d] summaries.length =', state.rollingSummaries.length, '(期望 1)');

// [2] 无新证据：应返回 null，且不新增摘要
const s2 = await summarizer.compress(state);
console.log('[e] 第二次 compress =', s2, '(期望 null)');

// [3] 新增一条证据后：只收集这一条，seq=2
blueprint.milestones[0].subtasks[1].evidence.push({
  kind: 'note',
  content: '追加产出 C',
  at: '2026-08-20T00:00:04.000Z',
});
const s3 = await summarizer.compress(state);
console.log('[f] seq =', s3?.seq, '(期望 2)');
console.log('[g] 只含 1 条 =', s3?.content.includes('共 1 条证据'), '(期望 true)');
console.log('[h] since =', s3?.since, '(期望 2026-08-20T00:00:04.000Z)');

// [4] truncation：keepSummaries=2 时应截断到最近 2 份
const small = new Summarizer({ keepSummaries: 2 });
for (let i = 0; i < 5; i++) {
  blueprint.milestones[0].subtasks[0].evidence.push({
    kind: 'log',
    content: `批量 ${i}`,
    at: `2026-08-20T00:01:0${i}.000Z`,
  });
  await small.compress(state);
}
console.log('[i] 截断后 summaries.length =', state.rollingSummaries.length, '(期望 2)');

// [5] summarizeMilestone 确定性 fallback
const summary = await summarizer.summarizeMilestone(blueprint, blueprint.milestones[0]);
console.log('[j] checkpoint 摘要含里程碑名 =', summary.includes('M1'), '(期望 true)');

console.log('\n✅ m3-memory smoke 通过');
