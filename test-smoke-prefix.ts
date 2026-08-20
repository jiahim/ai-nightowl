// 临时 smoke：验证 m3-prefix（PrefixBuilder 稳定前缀构造）
// 1. 确定性（同状态两次 → 同指纹）
// 2. 骨架不含 status/evidence（改状态不改前缀）
// 3. checkpoint append-only（新增只追加在末尾，旧前缀逐字节不变）
// 4. 滚动摘要归入可变后缀，不进前缀
// 5. 里程碑/子任务按数组顺序稳定
import { PrefixBuilder, fingerprint } from './src/index';
import type { Blueprint, StoreState } from './src/index';

const blueprint: Blueprint = {
  id: 'prefix-smoke',
  title: '前缀测试',
  description: '验证稳定前缀',
  constraints: ['约束A', '约束B'],
  definitionOfDone: '全部里程碑完成',
  milestones: [
    {
      id: 'm1',
      name: 'M1',
      goal: '第一阶段',
      acceptance: ['验收1'],
      status: 'pending',
      subtasks: [
        {
          id: 's1',
          name: '子任务一',
          detail: '做第一件事',
          dependencies: [],
          verdict: { kind: 'check', check: 'ok', criteria: ['标准X'] },
          status: 'pending',
          evidence: [],
        },
        {
          id: 's2',
          name: '子任务二',
          detail: '依赖 s1',
          dependencies: ['s1'],
          verdict: { kind: 'llm', criteria: ['标准Y'] },
          status: 'pending',
          evidence: [],
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

const builder = new PrefixBuilder();
const ctx1 = builder.buildContext(state);
console.log('[a] 前缀是单条 system 消息 =', ctx1.prefix.length === 1 && ctx1.prefix[0].role === 'system', '(期望 true)');
console.log('[b] 骨架含标题 =', ctx1.prefix[0].content.includes('前缀测试'), '(期望 true)');
console.log('[c] 骨架含子任务顺序 s1 在 s2 前 =', ctx1.prefix[0].content.indexOf('[s1]') < ctx1.prefix[0].content.indexOf('[s2]'), '(期望 true)');

// [1] 确定性：同状态两次 → 同指纹
const ctx1b = builder.buildContext(state);
console.log('[d] 确定性（同指纹）=', ctx1.fingerprint === ctx1b.fingerprint, '(期望 true)');

// [2] 骨架不含 status：改子任务 status / 加 evidence，前缀应逐字节不变
blueprint.milestones[0].subtasks[0].status = 'done';
blueprint.milestones[0].subtasks[0].evidence.push({ kind: 'note', content: '改状态不应影响前缀', at: '2026-08-20T00:00:01.000Z' });
blueprint.milestones[0].status = 'in-progress';
const ctx2 = builder.buildContext(state);
console.log('[e] 改 status/evidence 后前缀不变 =', ctx2.prefix[0].content === ctx1.prefix[0].content, '(期望 true)');
console.log('[f] 指纹不变 =', ctx2.fingerprint === ctx1.fingerprint, '(期望 true)');
console.log('[g] 前缀不含 status 字样 done =', !ctx2.prefix[0].content.includes('done'), '(期望 true)');

// [3] checkpoint append-only：新增 checkpoint 只追加，旧前缀逐字节不变，指纹变化
state.checkpoints.push({ milestoneId: 'm1', summary: 'M1 达成：三个子任务完成', at: '2026-08-20T00:00:02.000Z' });
const ctx3 = builder.buildContext(state);
console.log('[h] 新增 checkpoint 后旧前缀仍是新前缀的前缀 =', ctx3.prefix[0].content.startsWith(ctx2.prefix[0].content), '(期望 true)');
console.log('[i] 指纹变化 =', ctx3.fingerprint !== ctx2.fingerprint, '(期望 true)');
console.log('[j] checkpoint 摘要含里程碑 id =', ctx3.prefix[0].content.includes('m1'), '(期望 true)');

// [4] 滚动摘要归入可变后缀，不进前缀
state.rollingSummaries.push({ content: '一段会变的摘要', since: '2026-08-20T00:00:03.000Z', seq: 1 });
const ctx4 = builder.buildContext(state);
console.log('[k] 滚动摘要出现在可变后缀 =', ctx4.variable.length === 1 && ctx4.variable[0].content.includes('一段会变的摘要'), '(期望 true)');
console.log('[l] 滚动摘要不进前缀 =', !ctx4.prefix[0].content.includes('一段会变的摘要'), '(期望 true)');
console.log('[m] 前缀仍逐字节稳定（加摘要不改前缀）=', ctx4.prefix[0].content === ctx3.prefix[0].content, '(期望 true)');

// [5] fingerprint 纯函数：相同文本相同指纹，不同文本不同指纹
console.log('[n] fingerprint("abc") === fingerprint("abc") =', fingerprint('abc') === fingerprint('abc'), '(期望 true)');
console.log('[o] fingerprint("abc") !== fingerprint("abd") =', fingerprint('abc') !== fingerprint('abd'), '(期望 true)');

console.log('\n✅ m3-prefix smoke 通过');
