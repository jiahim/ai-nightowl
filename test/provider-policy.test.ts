import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  HttpApi,
  LiveProviderAdapter,
  ProviderManagementService,
  ProviderPoliciesStore,
  ProviderSettingsStore,
  ProviderUsageLedger,
  Store,
  evaluatePricing,
  inferProviderIntent,
  usageLimitStatuses,
  validateProviderPolicy,
  type ProviderAdapter,
  type ProviderPolicy,
} from '../src/index.js';

function adapter(id: 'deepseek' | 'zhipu', inputPrice: number, calls: string[] = []): ProviderAdapter {
  const model = `${id}-chat`;
  return {
    id,
    config: {
      id,
      name: id === 'deepseek' ? 'DeepSeek' : '智谱',
      baseUrl: '',
      apiKeyEnv: id === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'ZHIPU_API_KEY',
      models: [{ name: model, kind: 'chat', inputPrice, outputPrice: inputPrice * 2, contextWindow: 100_000 }],
      costStrategy: {},
    },
    isOffPeak: () => false,
    currentDiscount: () => 1,
    routeModel() { return this.config.models[0]; },
    async chat(target) {
      calls.push(`${id}:${target}`);
      return {
        content: id,
        model: target,
        providerId: id,
        usage: { promptTokens: 10, completionTokens: 5 },
      };
    },
  };
}

function policy(overrides: Partial<ProviderPolicy> = {}): ProviderPolicy {
  return {
    timezone: 'Asia/Shanghai',
    weekendDays: [0, 6],
    nonWorkingDates: [],
    workingDates: [],
    defaultRate: { multiplier: 1 },
    pricingRules: [],
    usageLimits: [],
    ...overrides,
  };
}

test('资费规则支持工作日、非工作日、节假日覆盖与时段优先级', () => {
  const provider = adapter('deepseek', 10);
  const configured = policy({
    nonWorkingDates: ['2026-08-31'],
    pricingRules: [
      { id: 'working', label: '工作日价', dayType: 'working-day', rate: { multiplier: 0.8 }, priority: 10 },
      { id: 'rest', label: '非工作日价', dayType: 'non-working-day', rate: { inputPrice: 4, outputPrice: 8 }, priority: 10 },
      {
        id: 'night', label: '夜间价', windows: [{ start: '00:00', end: '06:00' }],
        rate: { multiplier: 0.25 }, priority: 20,
      },
    ],
  });

  // 2026-08-31 是周一，但显式列为非工作日。
  const holiday = evaluatePricing('deepseek', provider.config.models[0], configured, new Date('2026-08-31T02:00:00Z'));
  assert.equal(holiday.label, '非工作日价');
  assert.equal(holiday.model.inputPrice, 4);
  assert.equal(holiday.discount, 1);

  const night = evaluatePricing('deepseek', provider.config.models[0], configured, new Date('2026-08-30T18:00:00Z'));
  assert.equal(night.label, '夜间价');
  assert.equal(night.discount, 0.25);
  assert.equal(night.offPeak, true);
});

test('资费画像拒绝不存在的日历日期', () => {
  assert.throws(() => validateProviderPolicy(policy({
    nonWorkingDates: ['2026-02-30'],
  })), /日期/);
});

test('本地意图识别尊重用户显式优先级', () => {
  const intent = inferProviderIntent('复杂代码审查，约 8 万 tokens，可以等 6 小时，但优先省钱');
  assert.equal(intent.priority, 'cost');
  assert.equal(intent.expectedPromptTokens, 80_000);
  assert.equal(intent.maxWaitMinutes, 360);
});

test('周期额度按画像时区分别计算日、周、月窗口', () => {
  const configured = policy({
    usageLimits: [
      { id: 'weekly', label: '每周 tokens', period: 'week', unit: 'tokens', limit: 100 },
      { id: 'monthly', label: '每月调用', period: 'month', unit: 'requests', limit: 3 },
    ],
  });
  const now = new Date('2026-08-30T12:00:00Z');
  const statuses = usageLimitStatuses(configured, 'deepseek', [
    { at: '2026-08-24T00:00:00Z', providerId: 'deepseek', model: 'm', promptTokens: 30, completionTokens: 10, actualCost: 1 },
    { at: '2026-08-23T00:00:00Z', providerId: 'deepseek', model: 'm', promptTokens: 90, completionTokens: 0, actualCost: 1 },
    { at: '2026-08-20T00:00:00Z', providerId: 'deepseek', model: 'm', promptTokens: 1, completionTokens: 1, actualCost: 1 },
  ], now);
  assert.equal(statuses[0].used, 40);
  assert.equal(statuses[0].remaining, 60);
  assert.equal(statuses[1].used, 3);
  assert.equal(statuses[1].exhausted, true);
});

test('动态路由跳过已耗尽的低价 Provider，并把实际调用写入用量账本', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nightowl-policy-route-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls: string[] = [];
  const providers = [adapter('deepseek', 1, calls), adapter('zhipu', 5, calls)];
  const settings = new ProviderSettingsStore(dir, {
    env: { DEEPSEEK_API_KEY: 'd', ZHIPU_API_KEY: 'z' },
  });
  const policies = new ProviderPoliciesStore(dir);
  const usage = new ProviderUsageLedger(dir);
  await policies.update({ profiles: {
    deepseek: policy({
      usageLimits: [{ id: 'monthly', label: '月额度', period: 'month', unit: 'tokens', limit: 100 }],
    }),
  } });
  await usage.record({
    at: new Date().toISOString(), providerId: 'deepseek', model: 'deepseek-chat',
    promptTokens: 100, completionTokens: 0, actualCost: 0,
  });
  const management = new ProviderManagementService(providers, settings, policies, usage, () => true);
  const live = new LiveProviderAdapter(providers, {
    preferredProvider: () => settings.effectivePreferredProvider(),
    isAvailable: () => true,
    routeModel: (kind) => management.routeModel(kind),
    primaryProvider: (kind) => management.currentProvider(kind),
    orderForCall: (context) => management.orderForCall(context),
    quote: (providerId, model, now) => management.quote(providerId, model, now),
    recordUsage: (event) => management.recordUsage(event),
  });

  const result = await live.chat(live.routeModel('execute').name, [{ role: 'user', content: 'hello' }]);
  assert.equal(result.providerId, 'zhipu');
  assert.deepEqual(calls, ['zhipu:zhipu-chat']);
  assert.equal(usage.events().filter((event) => event.providerId === 'zhipu').length, 1);
});

test('上游不返回 token usage 时仍记录一次成功请求', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nightowl-policy-request-count-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = adapter('deepseek', 1);
  const provider: ProviderAdapter = {
    ...base,
    async chat(target) {
      return { content: 'ok', model: target, providerId: 'deepseek' };
    },
  };
  const settings = new ProviderSettingsStore(dir, { env: { DEEPSEEK_API_KEY: 'd' } });
  const policies = new ProviderPoliciesStore(dir);
  const usage = new ProviderUsageLedger(dir);
  const management = new ProviderManagementService([provider], settings, policies, usage, () => true);
  const live = new LiveProviderAdapter([provider], {
    preferredProvider: () => settings.effectivePreferredProvider(),
    isAvailable: () => true,
    routeModel: (kind) => management.routeModel(kind),
    primaryProvider: (kind) => management.currentProvider(kind),
    orderForCall: (context) => management.orderForCall(context),
    quote: (providerId, model, now) => management.quote(providerId, model, now),
    recordUsage: (event) => management.recordUsage(event),
  });

  await live.chat(live.routeModel('execute').name, [{ role: 'user', content: 'hello' }]);
  assert.equal(usage.events().length, 1);
  assert.equal(usage.events()[0].promptTokens, 0);
  assert.equal(usage.events()[0].completionTokens, 0);
});

test('并发调用会先预留额度，不会同时越过最后一次请求限制', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nightowl-policy-reservation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const base = adapter('deepseek', 1);
  const provider: ProviderAdapter = {
    ...base,
    async chat(target) {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { content: 'ok', model: target, providerId: 'deepseek' };
    },
  };
  const settings = new ProviderSettingsStore(dir, { env: { DEEPSEEK_API_KEY: 'd' } });
  const policies = new ProviderPoliciesStore(dir);
  await policies.update({ profiles: { deepseek: policy({
    usageLimits: [{ id: 'daily-request', label: '每日调用', period: 'day', unit: 'requests', limit: 1 }],
  }) } });
  const usage = new ProviderUsageLedger(dir);
  const management = new ProviderManagementService([provider], settings, policies, usage, () => true);
  const live = new LiveProviderAdapter([provider], {
    preferredProvider: () => settings.effectivePreferredProvider(),
    isAvailable: () => true,
    routeModel: (kind) => management.routeModel(kind),
    primaryProvider: (kind) => management.currentProvider(kind),
    orderForCall: (context) => management.orderForCall(context),
    quote: (providerId, model, now) => management.quote(providerId, model, now),
    reserveCall: (context) => management.reserveCall(context),
    completeReservation: (id, event) => management.completeReservation(id, event),
  });

  const results = await Promise.allSettled([
    live.chat(live.routeModel('execute').name, [{ role: 'user', content: 'one' }]),
    live.chat(live.routeModel('execute').name, [{ role: 'user', content: 'two' }]),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(calls, 1);
  assert.equal(usage.events().length, 1);
});

test('成功调用的账本落盘失败时保留额度占用并阻止继续超额', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nightowl-policy-ledger-failure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const base = adapter('deepseek', 1);
  const provider: ProviderAdapter = {
    ...base,
    async chat(target) {
      calls += 1;
      return { content: 'ok', model: target, providerId: 'deepseek' };
    },
  };
  const settings = new ProviderSettingsStore(dir, { env: { DEEPSEEK_API_KEY: 'd' } });
  const policies = new ProviderPoliciesStore(dir);
  await policies.update({ profiles: { deepseek: policy({
    usageLimits: [{ id: 'daily-request', label: '每日调用', period: 'day', unit: 'requests', limit: 1 }],
  }) } });
  const usage = new ProviderUsageLedger(dir);
  const persistUsage = usage.record.bind(usage);
  let ledgerAvailable = false;
  usage.record = async (event) => {
    if (!ledgerAvailable) throw new Error('simulated ledger write failure');
    await persistUsage(event);
  };
  const management = new ProviderManagementService([provider], settings, policies, usage, () => true);
  const live = new LiveProviderAdapter([provider], {
    preferredProvider: () => settings.effectivePreferredProvider(),
    isAvailable: () => true,
    routeModel: (kind) => management.routeModel(kind),
    primaryProvider: (kind) => management.currentProvider(kind),
    orderForCall: (context) => management.orderForCall(context),
    quote: (providerId, model, now) => management.quote(providerId, model, now),
    reserveCall: (context) => management.reserveCall(context),
    completeReservation: (id, event) => management.completeReservation(id, event),
  });

  await live.chat(live.routeModel('execute').name, [{ role: 'user', content: 'first' }]);
  assert.equal(calls, 1);
  assert.equal(usage.events().length, 0);
  await assert.rejects(
    live.chat(live.routeModel('execute').name, [{ role: 'user', content: 'must not run' }]),
    /没有满足凭据、预算与周期额度约束的 Provider/,
  );
  assert.equal(calls, 1);

  ledgerAvailable = true;
  await assert.rejects(
    live.chat(live.routeModel('execute').name, [{ role: 'user', content: 'still exhausted' }]),
    /没有满足凭据、预算与周期额度约束的 Provider/,
  );
  assert.equal(calls, 1);
  assert.equal(usage.events().length, 1);
});

test('设置 API 可保存画像、给出可解释候选并一键应用', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nightowl-policy-api-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const providers = [adapter('deepseek', 1), adapter('zhipu', 8)];
  const settings = new ProviderSettingsStore(dir, {
    env: { DEEPSEEK_API_KEY: 'd', ZHIPU_API_KEY: 'z' },
  });
  const policies = new ProviderPoliciesStore(dir);
  const usage = new ProviderUsageLedger(dir);
  const management = new ProviderManagementService(providers, settings, policies, usage, () => true);
  const api = new HttpApi({
    store: new Store(dir), providerSettings: settings, providerPolicies: policies, providerManagement: management,
  });

  const saved = await api.handle({
    method: 'PUT', pathname: '/settings/providers', body: {
      priority: 'cost',
      profiles: { deepseek: policy({
        pricingRules: [{ id: 'weekend', label: '周末价', dayType: 'non-working-day', rate: { multiplier: 0.5 } }],
        usageLimits: [{ id: 'weekly', label: '周额度', period: 'week', unit: 'tokens', limit: 1_000_000 }],
      }) },
    },
  });
  assert.equal(saved.status, 200);
  assert.equal((saved.body as any).providers[0].policySource, 'configured');

  const recommended = await api.handle({
    method: 'POST', pathname: '/settings/providers/recommend',
    body: { request: '不着急，2万 tokens，优先省钱' },
  });
  assert.equal(recommended.status, 200);
  assert.equal((recommended.body as any).recommendedOptionId, 'deepseek:deepseek-chat');
  assert.equal((recommended.body as any).analyzedBy, 'local');

  const applied = await api.handle({
    method: 'POST', pathname: '/settings/providers/apply',
    body: {
      recommendationId: (recommended.body as any).recommendationId,
      optionId: 'deepseek:deepseek-chat',
    },
  });
  assert.equal(applied.status, 200);
  assert.equal(settings.snapshot().preferredProvider, 'deepseek');
  assert.deepEqual((settings.snapshot() as any).preferredModel, {
    providerId: 'deepseek', model: 'deepseek-chat',
  });
});

test('采用推荐会重新核验当前凭据并拒绝已失效候选', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nightowl-policy-stale-recommendation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const providers = [adapter('deepseek', 1), adapter('zhipu', 8)];
  const settings = new ProviderSettingsStore(dir, { env: {} });
  await settings.update({ apiKeys: { deepseek: 'd', zhipu: 'z' } });
  const policies = new ProviderPoliciesStore(dir);
  const usage = new ProviderUsageLedger(dir);
  const management = new ProviderManagementService(
    providers,
    settings,
    policies,
    usage,
    (provider) => settings.isConfigured(provider.id as 'deepseek' | 'zhipu'),
  );
  const api = new HttpApi({
    store: new Store(dir), providerSettings: settings, providerPolicies: policies, providerManagement: management,
  });
  const recommended = await api.handle({
    method: 'POST', pathname: '/settings/providers/recommend', body: { request: '优先省钱' },
  });
  await settings.update({ clear: ['deepseek'] });

  const applied = await api.handle({
    method: 'POST', pathname: '/settings/providers/apply', body: {
      recommendationId: (recommended.body as any).recommendationId,
      optionId: 'deepseek:deepseek-chat',
    },
  });
  assert.equal(applied.status, 400);
  assert.equal(settings.snapshot().preferredProvider, 'auto');
});

test('联合设置中的非法资费不会先保存密钥或首选项', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nightowl-policy-atomic-api-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const providers = [adapter('deepseek', 1)];
  const settings = new ProviderSettingsStore(dir, { env: {} });
  const policies = new ProviderPoliciesStore(dir);
  const usage = new ProviderUsageLedger(dir);
  const management = new ProviderManagementService(providers, settings, policies, usage, () => true);
  const api = new HttpApi({
    store: new Store(dir), providerSettings: settings, providerPolicies: policies, providerManagement: management,
  });

  const response = await api.handle({
    method: 'PUT', pathname: '/settings/providers', body: {
      preferredProvider: 'deepseek',
      apiKeys: { deepseek: 'must-not-save' },
      profiles: { deepseek: { ...policy(), timezone: 'Not/A-Timezone' } },
    },
  });
  assert.equal(response.status, 400);
  assert.equal(settings.snapshot().preferredProvider, 'auto');
  assert.equal(settings.snapshot().providers[0].source, null);
});

test('智能匹配会查询并跳过官方额度已耗尽的 MiniMax Plan', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nightowl-policy-remote-quota-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const regular = adapter('deepseek', 3);
  const plan: ProviderAdapter = {
    ...adapter('zhipu', 1),
    id: 'minimax-plan',
    config: {
      id: 'minimax-plan',
      name: 'MiniMax Plan',
      baseUrl: 'https://api.minimaxi.com/v1',
      apiKeyEnv: 'MINIMAX_PLAN_API_KEY',
      models: [{ name: 'MiniMax-M2.7', kind: 'chat', inputPrice: 0, outputPrice: 0, contextWindow: 204_800 }],
      costStrategy: {},
    },
    async queryUsage() {
      return {
        source: 'provider-api',
        fetchedAt: new Date().toISOString(),
        windows: [{
          id: 'minimax-plan-5h', label: 'Plan 5 小时滚动额度', period: 'rolling',
          windowMinutes: 300, remainingPercent: 0, status: 'exhausted',
        }],
      };
    },
  };
  const settings = new ProviderSettingsStore(dir, {
    env: { DEEPSEEK_API_KEY: 'd', MINIMAX_PLAN_API_KEY: 'plan' },
  });
  const management = new ProviderManagementService(
    [plan, regular], settings, new ProviderPoliciesStore(dir), new ProviderUsageLedger(dir), () => true,
  );
  const result = await management.recommend('两万 tokens，优先省钱');
  assert.equal(result.recommendedOptionId, 'deepseek:deepseek-chat');
  const planCandidate = result.candidates.find((candidate) => candidate.providerId === 'minimax-plan')!;
  assert.equal(planCandidate.eligible, false);
  assert.match(planCandidate.warnings.join(' '), /已耗尽/);
});
