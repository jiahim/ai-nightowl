import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CostTracker,
  Executor,
  FailoverAdapter,
  isRetryableProviderError,
} from '../src/index.js';
import type { Blueprint, ProviderAdapter } from '../src/index.js';
import { blueprint } from './helpers.js';

function provider(id: string, model: string, price: number, fail: boolean): ProviderAdapter {
  return {
    id,
    config: {
      id, name: id, baseUrl: '', apiKeyEnv: 'NONE',
      models: [{ name: model, kind: 'chat', inputPrice: price, outputPrice: 0, contextWindow: 1000 }],
      costStrategy: id === 'deepseek' ? { offPeakDiscount: 0.5 } : {},
    },
    isOffPeak: () => id === 'deepseek',
    currentDiscount: () => id === 'deepseek' ? 0.5 : 1,
    routeModel() { return this.config.models[0]; },
    async chat() {
      if (fail) throw new Error('429 rate limit');
      return { content: 'fallback', model, usage: { promptTokens: 1_000_000, completionTokens: 0 } };
    },
  };
}

test('故障转移成本按实际 Provider 折扣计算', async () => {
  const adapter = new FailoverAdapter([
    provider('deepseek', 'deepseek-v4-flash', 3, true),
    provider('zhipu', 'glm-5.3', 8, false),
  ]);
  const tracker = new CostTracker();
  const executor = new Executor(adapter, { tracker });
  const bp: Blueprint = blueprint();
  await executor.execute(bp, bp.milestones[0].subtasks[0]);
  const summary = tracker.summary();
  assert.equal(summary.listCost, 8);
  assert.equal(summary.actualCost, 8);
  assert.equal(summary.offPeakCalls, 0);
});

test('Provider 超时会故障转移，用户取消不会被错误重试', async () => {
  const primary = provider('deepseek', 'deepseek-v4-flash', 3, false);
  primary.chat = async () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  };
  const adapter = new FailoverAdapter([
    primary,
    provider('zhipu', 'glm-5.3', 8, false),
  ]);
  const result = await adapter.chat('deepseek-v4-flash', []);
  assert.equal(result.providerId, 'zhipu');
  assert.equal(isRetryableProviderError(new DOMException('cancelled', 'AbortError')), false);
});
