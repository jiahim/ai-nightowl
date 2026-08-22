// 临时 smoke 测试：FailoverAdapter（多平台故障转移）+ Executor 困难升级
// 跑法：cd ai-nightowl && npx tsx test-smoke-failover.ts
import { FailoverAdapter, Executor, isRetryableProviderError } from './src/index.js';
import type { ProviderAdapter, ChatResult } from './src/index.js';
import type { Blueprint, Message, ModelSpec, ProviderConfig, Subtask, TaskKind } from './src/index.js';

const flash: ModelSpec = {
  name: 'deepseek-v4-flash', kind: 'chat', inputPrice: 3, outputPrice: 9, cacheHitPrice: 0.1, contextWindow: 1000000,
};
const pro: ModelSpec = {
  name: 'deepseek-v4-pro', kind: 'reasoner', inputPrice: 9, outputPrice: 27, cacheHitPrice: 0.3, contextWindow: 1000000,
};
const glm: ModelSpec = {
  name: 'glm-5.3', kind: 'chat', inputPrice: 8, outputPrice: 28, cacheHitPrice: 2, contextWindow: 1000000,
};

/** 可控 fake adapter：按模型名决定抛错或成功 */
function fakeAdapter(
  id: string,
  models: ModelSpec[],
  opts: { failModels?: string[]; errText?: (model: string) => string } = {},
): ProviderAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    id,
    calls,
    config: { id, name: id, baseUrl: 'http://fake', apiKeyEnv: 'FAKE', models, costStrategy: {} } as ProviderConfig,
    isOffPeak: () => false,
    currentDiscount: () => 1,
    routeModel: () => models[0],
    async chat(model: string, _messages: Message[]): Promise<ChatResult> {
      calls.push(model);
      if (opts.failModels?.includes(model)) {
        throw new Error((opts.errText ?? ((m: string) => `${m} boom`))(model));
      }
      return { content: `ok-${id}-${model}`, model };
    },
  };
}

let ok = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { ok++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
}

async function main(): Promise<void> {
  // 1. primary 429（余额不足）→ 自动切 glm-5.3，spec 修正为 glm 价格
  {
    const ds = fakeAdapter('deepseek', [flash, pro], { failModels: ['deepseek-v4-flash'], errText: () => 'DeepSeek API error 429: 余额不足' });
    const zp = fakeAdapter('zhipu', [glm]);
    const f = new FailoverAdapter([ds, zp]);
    const r = await f.chat('deepseek-v4-flash', [{ role: 'user', content: 'hi' }]);
    check('1. 429 → fallback glm-5.3', r.model === 'glm-5.3' && r.content === 'ok-zhipu-glm-5.3', `got ${r.model}/${r.content}`);
    check('1. spec 修正为实际模型', r.spec?.name === 'glm-5.3' && r.spec.inputPrice === 8, `got ${r.spec?.name}`);
  }

  // 2. primary 网络错误 → 切
  {
    const ds = fakeAdapter('deepseek', [flash], { failModels: ['deepseek-v4-flash'], errText: () => 'fetch failed: ECONNREFUSED' });
    const zp = fakeAdapter('zhipu', [glm]);
    const f = new FailoverAdapter([ds, zp]);
    const r = await f.chat('deepseek-v4-flash', []);
    check('2. 网络错误 → fallback', r.model === 'glm-5.3', `got ${r.model}`);
  }

  // 3. primary 400（不可恢复）→ 不切，直接抛
  {
    const ds = fakeAdapter('deepseek', [flash], { failModels: ['deepseek-v4-flash'], errText: () => 'DeepSeek API error 400: bad request' });
    const zp = fakeAdapter('zhipu', [glm]);
    const f = new FailoverAdapter([ds, zp]);
    let threw = '';
    try { await f.chat('deepseek-v4-flash', []); } catch (e) { threw = (e as Error).message; }
    check('3. 400 不切换直接抛', /400/.test(threw), `got ${threw}`);
  }

  // 4. glm-5.3 请求直接走 zhipu（primary 不被调）
  {
    const ds = fakeAdapter('deepseek', [flash], { failModels: ['glm-5.3'], errText: () => 'should not be called' });
    const zp = fakeAdapter('zhipu', [glm]);
    const f = new FailoverAdapter([ds, zp]);
    const r = await f.chat('glm-5.3', []);
    check('4. glm-5.3 → 直连 zhipu', r.model === 'glm-5.3' && ds.calls.length === 0, `ds.calls=${ds.calls.length}`);
  }

  // 5. 全链失败 → 抛最后错误
  {
    const ds = fakeAdapter('deepseek', [flash], { failModels: ['deepseek-v4-flash'], errText: () => 'DeepSeek API error 429: a' });
    const zp = fakeAdapter('zhipu', [glm], { failModels: ['glm-5.3'], errText: () => 'Zhipu API error 429: b' });
    const f = new FailoverAdapter([ds, zp]);
    let threw = '';
    try { await f.chat('deepseek-v4-flash', []); } catch (e) { threw = (e as Error).message; }
    check('5. 全链失败抛最后错误', /Zhipu/.test(threw), `got ${threw}`);
  }

  // 6. routeModel / isOffPeak 委托 primary
  {
    const ds = fakeAdapter('deepseek', [flash, pro]);
    const zp = fakeAdapter('zhipu', [glm]);
    const f = new FailoverAdapter([ds, zp]);
    check('6. routeModel 委托 primary → flash', f.routeModel('execute').name === 'deepseek-v4-flash', `got ${f.routeModel('execute').name}`);
    check('6. isOffPeak 委托 primary', f.isOffPeak(new Date()) === false);
  }

  // 7. isRetryableProviderError 分类
  {
    check('7. 429 可恢复', isRetryableProviderError(new Error('DeepSeek API error 429: x')));
    check('7. 500 可恢复', isRetryableProviderError(new Error('Zhipu API error 500: x')));
    check('7. fetch failed 可恢复', isRetryableProviderError(new Error('fetch failed')));
    check('7. 余额不足 可恢复', isRetryableProviderError(new Error('余额不足或无可用资源包')));
    check('7. 400 不可恢复', !isRetryableProviderError(new Error('DeepSeek API error 400: x')));
    check('7. 401 不可恢复', !isRetryableProviderError(new Error('401 Unauthorized')));
  }

  // 8. Executor 困难升级：同一子任务已执行 ≥2 次仍失败 → 用 v4-pro 重试
  {
    const ds = fakeAdapter('deepseek', [flash, pro]);
    const zp = fakeAdapter('zhipu', [glm]);
    const f = new FailoverAdapter([ds, zp]);
    const exec = new Executor(f);
    const bp: Blueprint = {
      id: 'bp', title: 't', description: 'd', constraints: [], definitionOfDone: 'x',
      milestones: [{ id: 'm1', name: 'm', goal: 'g', acceptance: [], status: 'pending', subtasks: [] }],
    };
    const st: Subtask = {
      id: 's1', name: 's1', detail: 'd', dependencies: [], status: 'pending',
      verdict: { kind: 'llm', criteria: ['c'] }, evidence: [
        { kind: 'log', content: '模型 deepseek-v4-flash 产出：\nfoo', at: 'x' },
        { kind: 'note', content: '判定未完成：质量不足', at: 'x' },
        { kind: 'log', content: '模型 deepseek-v4-flash 产出：\nbar', at: 'x' },
        { kind: 'note', content: '判定未完成：质量不足', at: 'x' },
      ],
    };
    const r = await exec.execute(bp, st);
    check('8. 已失败 2 次 → 升级 v4-pro', r.model === 'deepseek-v4-pro' && r.output === 'ok-deepseek-deepseek-v4-pro', `got ${r.model}/${r.output}`);
    check('8. 升级后 zhipu 未被调', zp.calls.length === 0, `zp.calls=${zp.calls.length}`);
  }

  // 9. 升级链仍失败（pro 429 → failover 切 glm-5.3 也 429）→ 抛
  {
    const ds = fakeAdapter('deepseek', [flash, pro], { failModels: ['deepseek-v4-pro'], errText: () => '429 balance' });
    const zp = fakeAdapter('zhipu', [glm], { failModels: ['glm-5.3'], errText: () => '429 no quota' });
    const f = new FailoverAdapter([ds, zp]);
    const exec = new Executor(f);
    const bp: Blueprint = {
      id: 'bp', title: 't', description: 'd', constraints: [], definitionOfDone: 'x',
      milestones: [{ id: 'm1', name: 'm', goal: 'g', acceptance: [], status: 'pending', subtasks: [] }],
    };
    const st: Subtask = {
      id: 's1', name: 's1', detail: 'd', dependencies: [], status: 'pending',
      verdict: { kind: 'llm', criteria: ['c'] }, evidence: [
        { kind: 'log', content: '模型 deepseek-v4-flash 产出：\nfoo', at: 'x' },
        { kind: 'note', content: '判定未完成', at: 'x' },
        { kind: 'log', content: '模型 deepseek-v4-flash 产出：\nbar', at: 'x' },
        { kind: 'note', content: '判定未完成', at: 'x' },
      ],
    };
    let threw = '';
    try { await exec.execute(bp, st); } catch (e) { threw = (e as Error).message; }
    check('9. 升级链全败 → 抛错', /no quota/.test(threw), `got ${threw}`);
  }

  console.log(`\nfailover smoke: ${ok} ok, ${fail} fail`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error('smoke error:', e); process.exit(1); });
