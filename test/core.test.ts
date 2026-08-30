import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CostTracker,
  DeepSeekAdapter,
  PrefixBuilder,
  Scheduler,
  Summarizer,
  assembleBlueprint,
  validateBlueprint,
} from '../src/index.js';
import { blueprint } from './helpers.js';

test('蓝图组装解析依赖并拒绝空里程碑', () => {
  const bp = assembleBlueprint('demo', {
    id: 'demo', title: 'Demo', description: 'desc', constraints: [], definitionOfDone: '',
    milestones: [{
      name: 'M1', goal: 'g', acceptance: [],
      subtasks: [
        { name: 'A', detail: '', dependencies: [], verdictKind: 'llm', criteria: [] },
        { name: 'B', detail: '', dependencies: ['A'], verdictKind: 'manual', criteria: [] },
      ],
    }],
  });
  assert.deepEqual(bp.milestones[0].subtasks[1].dependencies, ['m1-t1']);
  const invalid = structuredClone(bp);
  invalid.milestones[0].subtasks = [];
  assert.ok(validateBlueprint(invalid).some((error) => /至少需要一个子任务/.test(error)));
});

test('DeepSeek 调度按北京时间识别高峰与低谷', () => {
  const provider = new DeepSeekAdapter();
  const scheduler = new Scheduler([provider]);
  const peak = new Date('2026-08-30T02:00:00.000Z'); // 北京 10:00
  const offPeak = new Date('2026-08-29T19:00:00.000Z'); // 北京 03:00
  assert.equal(provider.isOffPeak(peak), false);
  assert.equal(provider.currentDiscount(offPeak), 0.5);
  assert.equal(scheduler.msUntilNextOffPeak(peak), 2 * 60 * 60 * 1000);
});

test('稳定前缀不随运行状态和 evidence 改变', () => {
  const bp = blueprint();
  const state = {
    schemaVersion: 2 as const, blueprint: bp, checkpoints: [], rollingSummaries: [],
    updatedAt: '', completion: { status: 'pending' as const },
  };
  const builder = new PrefixBuilder();
  const before = builder.buildContext(state);
  bp.milestones[0].subtasks[0].status = 'done';
  bp.milestones[0].subtasks[0].evidence.push({ kind: 'note', content: 'x', at: new Date().toISOString() });
  const after = builder.buildContext(state);
  assert.equal(before.fingerprint, after.fingerprint);
  assert.deepEqual(before.prefix, after.prefix);
});

test('滚动摘要按水位线只压缩新增证据', async () => {
  const bp = blueprint();
  bp.milestones[0].subtasks[0].evidence.push({ kind: 'note', content: 'first', at: '2026-01-01T00:00:01.000Z' });
  const state = {
    schemaVersion: 2 as const, blueprint: bp, checkpoints: [], rollingSummaries: [],
    updatedAt: '', completion: { status: 'pending' as const },
  };
  const summarizer = new Summarizer({ keepSummaries: 2 });
  assert.equal((await summarizer.compress(state))?.seq, 1);
  assert.equal(await summarizer.compress(state), null);
  bp.milestones[0].subtasks[0].evidence.push({ kind: 'note', content: 'second', at: '2026-01-01T00:00:02.000Z' });
  assert.equal((await summarizer.compress(state))?.seq, 2);
  assert.equal(state.rollingSummaries.length, 2);
});

test('CostTracker 可序列化恢复', () => {
  const tracker = new CostTracker();
  tracker.record({
    model: { name: 'm', kind: 'chat', inputPrice: 2, outputPrice: 4, contextWindow: 1000 },
    providerId: 'p', kind: 'execute', promptTokens: 1_000_000, completionTokens: 1_000_000,
    offPeak: true, discount: 0.5,
  });
  assert.equal(tracker.summary().actualCost, 3);
  assert.deepEqual(CostTracker.fromJSON(tracker.toJSON()).summary(), tracker.summary());
});
