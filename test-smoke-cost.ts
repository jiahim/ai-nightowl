// 临时 smoke 测试：验证成本追踪（m5-cost）计算正确、低谷 5 折确实省钱
import { CostTracker, computeCallCost, DeepSeekAdapter } from './src/index.js';
import type { ModelSpec } from './src/index.js';

const model: ModelSpec = {
  name: 'deepseek-chat',
  kind: 'chat',
  inputPrice: 0.5, // 元 / 百万 tokens
  outputPrice: 8,
  cacheHitPrice: 0.5,
  contextWindow: 128000,
};

let ok = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    ok++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name} ${detail}`);
  }
}

// 1. computeCallCost 定价：1M 输入 + 1M 输出
//    miss 1M * 0.5 = 0.5 元；out 1M * 8 = 8 元；原价 8.5 元
const c1 = computeCallCost({ model, promptTokens: 1_000_000, completionTokens: 1_000_000 });
check('1M in + 1M out listCost = 8.5', Math.abs(c1.listCost - 8.5) < 1e-9, `got ${c1.listCost}`);
check('原价不打折 actualCost = 8.5', Math.abs(c1.actualCost - 8.5) < 1e-9, `got ${c1.actualCost}`);

// 2. 折扣：低谷 5 折
const c2 = computeCallCost({ model, promptTokens: 1_000_000, completionTokens: 1_000_000, discount: 0.5 });
check('5 折 actualCost = 4.25', Math.abs(c2.actualCost - 4.25) < 1e-9, `got ${c2.actualCost}`);

// 3. 缓存命中：命中部分按 cacheHitPrice 计价
//    1M 命中输入 + 0 输出 = 0.5 元（cacheHitPrice 0.5）
const c3 = computeCallCost({ model, promptTokens: 1_000_000, completionTokens: 0, cacheHitTokens: 1_000_000 });
check('1M cache-hit listCost = 0.5', Math.abs(c3.listCost - 0.5) < 1e-9, `got ${c3.listCost}`);

// 4. CostTracker 累计：1 次高峰 + 1 次低谷，各 1M in + 1M out
const tracker = new CostTracker();
tracker.record({
  model, kind: 'execute',
  promptTokens: 1_000_000, completionTokens: 1_000_000,
  offPeak: false, discount: 1,
});
tracker.record({
  model, kind: 'execute',
  promptTokens: 1_000_000, completionTokens: 1_000_000,
  offPeak: true, discount: 0.5,
});
const s = tracker.summary();
check('summary calls = 2', s.calls === 2, `got ${s.calls}`);
check('summary offPeakCalls = 1, peakCalls = 1', s.offPeakCalls === 1 && s.peakCalls === 1, `got ${s.offPeakCalls}/${s.peakCalls}`);
check('summary promptTokens = 2M', s.promptTokens === 2_000_000, `got ${s.promptTokens}`);
check('summary listCost = 17', Math.abs(s.listCost - 17) < 1e-9, `got ${s.listCost}`);
check('summary actualCost = 12.75', Math.abs(s.actualCost - 12.75) < 1e-9, `got ${s.actualCost}`);
check('summary saved = 4.25', Math.abs(s.saved - 4.25) < 1e-9, `got ${s.saved}`);

// 5. 序列化往返
const t2 = CostTracker.fromJSON(tracker.toJSON());
check('toJSON/fromJSON roundtrip 成本一致', Math.abs(t2.summary().actualCost - 12.75) < 1e-9);

// 6. DeepSeek adapter 真实时段：高峰原价、低谷 5 折（用北京时间）
const ds = new DeepSeekAdapter();
const peak = new Date('2026-08-20T10:00:00+08:00');
const off = new Date('2026-08-20T03:00:00+08:00');
check('DeepSeek 高峰 discount = 1', ds.currentDiscount(peak) === 1);
check('DeepSeek 低谷 discount = 0.5', ds.currentDiscount(off) === 0.5);
check('DeepSeek 低谷 isOffPeak = true', ds.isOffPeak(off) === true);

console.log(`\n${ok} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
