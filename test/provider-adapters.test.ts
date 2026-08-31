import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MiniMaxAdapter,
  MiniMaxPlanAdapter,
  OpenAIAdapter,
  OpenAICompatibleAdapter,
  defaultProviderPolicy,
  usageLimitStatuses,
  type ProviderConfig,
} from '../src/index.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('OpenAI 官方适配器使用独立类型、官方端点与新版 token 字段', async () => {
  let calledUrl = '';
  let calledInit: RequestInit | undefined;
  const adapter = new OpenAIAdapter({}, {
    apiKey: () => 'openai-secret',
    fetch: (async (input, init) => {
      calledUrl = String(input);
      calledInit = init;
      return jsonResponse({
        model: 'gpt-5.6-terra',
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      });
    }) as typeof fetch,
  });

  const result = await adapter.chat('gpt-5.6-terra', [{ role: 'user', content: 'hello' }], { maxTokens: 321 });
  assert.equal(adapter.id, 'openai');
  assert.equal(calledUrl, 'https://api.openai.com/v1/chat/completions');
  assert.equal((calledInit?.headers as Record<string, string>).Authorization, 'Bearer openai-secret');
  assert.equal((JSON.parse(String(calledInit?.body)) as any).max_completion_tokens, 321);
  assert.equal(result.content, 'ok');
  assert.deepEqual(result.usage, { promptTokens: 11, completionTokens: 7 });
});

test('MiniMax 普通与 Plan 是独立 Provider、独立 Key、不同计费画像并使用兼容 token 字段', async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  const options = {
    apiKey: () => 'minimax-secret',
    fetch: (async (_input: URL | RequestInfo, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    }) as typeof fetch,
  };
  const normal = new MiniMaxAdapter({}, options);
  const plan = new MiniMaxPlanAdapter({}, options);
  assert.equal(normal.id, 'minimax');
  assert.equal(plan.id, 'minimax-plan');
  assert.equal(normal.config.apiKeyEnv, 'MINIMAX_API_KEY');
  assert.equal(plan.config.apiKeyEnv, 'MINIMAX_PLAN_API_KEY');
  assert.ok(normal.config.models.every((model) => model.inputPrice > 0));
  assert.ok(plan.config.models.every((model) => model.inputPrice === 0 && model.outputPrice === 0));
  assert.ok(normal.config.models.every((model) => model.kind === 'chat'));
  assert.ok(plan.config.models.every((model) => model.kind === 'chat'));
  assert.equal(plan.routeModel('judge').name, 'MiniMax-M2.7');
  assert.deepEqual(defaultProviderPolicy(plan.config).usageLimits, []);
  await normal.chat('MiniMax-M2.7', [], { maxTokens: 321 });
  await plan.chat('MiniMax-M2.7', [], { maxTokens: 654 });
  assert.deepEqual(requestBodies.map((body) => body.max_completion_tokens), [321, 654]);
  assert.ok(requestBodies.every((body) => body.max_tokens === undefined));
});

test('5 小时滚动额度只统计窗口内请求', () => {
  const plan = new MiniMaxPlanAdapter();
  const policy = defaultProviderPolicy(plan.config);
  policy.usageLimits = [{
    id: 'minimax-plan-5h', label: 'Plan 5 小时滚动请求额度', period: 'rolling',
    windowMinutes: 300, unit: 'requests', limit: 600, warningAt: 0.8,
  }];
  const now = new Date('2026-08-30T12:00:00Z');
  const event = (at: string) => ({
    at,
    providerId: 'minimax-plan',
    model: 'MiniMax-M2.7',
    promptTokens: 1,
    completionTokens: 1,
    actualCost: 0,
  });
  const [status] = usageLimitStatuses(policy, 'minimax-plan', [
    event('2026-08-30T07:01:00Z'),
    event('2026-08-30T06:59:00Z'),
    event('2026-08-30T12:01:00Z'),
  ], now);
  assert.equal(status.used, 1);
  assert.equal(status.remaining, 599);
  assert.equal(status.periodKey, 'rolling-300m');
});

test('MiniMax Plan 从官方接口读取 5 小时与每周剩余额度', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const plan = new MiniMaxPlanAdapter({}, {
    apiKey: () => 'plan-secret',
    fetch: (async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return jsonResponse({
        model_remains: [{
          model_name: 'general',
          current_interval_remaining_percent: 18,
          current_interval_status: 1,
          remains_time: 60_000,
          current_weekly_remaining_percent: 73,
          current_weekly_status: 1,
          weekly_remains_time: 120_000,
        }],
        base_resp: { status_code: 0, status_msg: 'success' },
      });
    }) as typeof fetch,
  });
  const usage = await plan.queryUsage();
  assert.equal(requestUrl, 'https://www.minimaxi.com/v1/token_plan/remains');
  assert.equal((requestInit?.headers as Record<string, string>).Authorization, 'Bearer plan-secret');
  assert.equal(usage.source, 'provider-api');
  assert.deepEqual(usage.windows.map((window) => ({
    id: window.id, remainingPercent: window.remainingPercent, status: window.status,
  })), [
    { id: 'minimax-plan-5h', remainingPercent: 18, status: 'available' },
    { id: 'minimax-plan-weekly', remainingPercent: 73, status: 'available' },
  ]);
});

test('自定义 OpenAI 兼容适配器支持动态 Base URL、无密钥本地接口与模型发现', async () => {
  let config: ProviderConfig = {
    id: 'openai-compatible',
    name: 'Local API',
    baseUrl: 'http://127.0.0.1:11434/v1/',
    // PATH 故意代表一个已有环境值：显式 apiKey resolver 返回 undefined 时
    // 不得回退到环境变量并把无关旧值发送给无密钥端点。
    apiKeyEnv: 'PATH',
    models: [{ name: 'local-chat', kind: 'chat', inputPrice: 0, outputPrice: 0, contextWindow: 32_000 }],
    costStrategy: {},
  };
  const calls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const adapter = new OpenAICompatibleAdapter(() => config, {
    allowMissingApiKey: true,
    apiKey: () => undefined,
    fetch: (async (input, init) => {
      calls.push(String(input));
      headers.push(init?.headers as Record<string, string>);
      if (String(input).endsWith('/models')) {
        return jsonResponse({ data: [{ id: 'local-chat', owned_by: 'local' }] });
      }
      return jsonResponse({ choices: [{ message: { content: 'local result' } }] });
    }) as typeof fetch,
  });

  assert.equal((await adapter.chat('local-chat', [])).content, 'local result');
  config = { ...config, baseUrl: 'http://localhost:9000/v1' };
  assert.deepEqual(await adapter.discoverModels(), [{ id: 'local-chat', ownedBy: 'local' }]);
  assert.deepEqual(calls, [
    'http://127.0.0.1:11434/v1/chat/completions',
    'http://localhost:9000/v1/models',
  ]);
  assert.ok(headers.every((item) => item.Authorization === undefined));
});
