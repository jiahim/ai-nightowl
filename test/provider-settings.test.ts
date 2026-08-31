import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  HttpApi,
  LiveProviderAdapter,
  ProviderSettingsStore,
  Store,
  type ProviderAdapter,
} from '../src/index.js';

function provider(id: 'deepseek' | 'zhipu', calls: string[]): ProviderAdapter {
  const model = id === 'deepseek' ? 'deepseek-chat' : 'glm-chat';
  return {
    id,
    config: {
      id,
      name: id,
      baseUrl: '',
      apiKeyEnv: id === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'ZHIPU_API_KEY',
      models: [{ name: model, kind: 'chat', inputPrice: 0, outputPrice: 0, contextWindow: 1000 }],
      costStrategy: {},
    },
    isOffPeak: () => false,
    currentDiscount: () => 1,
    routeModel() { return this.config.models[0]; },
    async chat(targetModel) {
      calls.push(`${id}:${targetModel}`);
      return { content: id, model: targetModel, providerId: id };
    },
  };
}

test('Provider 设置以 0600 原子落盘，API 永不回显密钥', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nightowl-provider-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = {};
  const settings = new ProviderSettingsStore(dir, { env });
  const api = new HttpApi({ store: new Store(dir), providerSettings: settings });
  const secret = 'sk-local-test-secret';

  const saved = await api.handle({
    method: 'PUT',
    pathname: '/settings/providers',
    body: { preferredProvider: 'deepseek', apiKeys: { deepseek: secret } },
  });
  assert.equal(saved.status, 200);
  assert.doesNotMatch(JSON.stringify(saved.body), new RegExp(secret));
  assert.equal((saved.body as any).providers[0].configured, true);
  assert.equal((saved.body as any).providers[0].source, 'local');
  assert.equal(env.DEEPSEEK_API_KEY, secret);

  const file = join(dir, '.provider-secrets.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.match(await readFile(file, 'utf-8'), /"deepseek"/);

  const reloaded = new ProviderSettingsStore(dir, { env: {} });
  const snapshot = reloaded.snapshot();
  assert.equal(snapshot.providers[0].configured, true);
  assert.equal(snapshot.preferredProvider, 'deepseek');
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(secret));
});

test('删除本地密钥后恢复启动环境变量，不会误删宿主配置', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nightowl-provider-env-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: 'env-key' };
  const settings = new ProviderSettingsStore(dir, { env });
  assert.equal(settings.snapshot().providers[0].source, 'environment');

  await settings.update({ apiKeys: { deepseek: 'local-key' } });
  assert.equal(env.DEEPSEEK_API_KEY, 'local-key');
  assert.equal(settings.snapshot().providers[0].source, 'local');

  await settings.update({ clear: ['deepseek'] });
  assert.equal(env.DEEPSEEK_API_KEY, 'env-key');
  assert.equal(settings.snapshot().providers[0].source, 'environment');
});

test('运行时 Provider 路由在设置变化后立即切换，无需重启', async () => {
  const calls: string[] = [];
  const adapters = [provider('deepseek', calls), provider('zhipu', calls)];
  let preferred = 'deepseek';
  const available = new Set(['deepseek']);
  const live = new LiveProviderAdapter(adapters, {
    preferredProvider: () => preferred,
    isAvailable: (adapter) => available.has(adapter.id),
  });

  assert.equal(live.routeModel('execute').name, 'deepseek-chat');
  assert.equal((await live.chat('deepseek-chat', [])).providerId, 'deepseek');

  preferred = 'zhipu';
  available.clear();
  available.add('zhipu');
  assert.equal(live.routeModel('execute').name, 'glm-chat');
  assert.equal((await live.chat('glm-chat', [])).providerId, 'zhipu');
  assert.deepEqual(calls, ['deepseek:deepseek-chat', 'zhipu:glm-chat']);
});

test('Provider 设置 API 拒绝空密钥与未知平台', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nightowl-provider-validation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const api = new HttpApi({
    store: new Store(dir),
    providerSettings: new ProviderSettingsStore(dir, { env: {} }),
  });
  const empty = await api.handle({
    method: 'PUT', pathname: '/settings/providers', body: { apiKeys: { deepseek: '  ' } },
  });
  assert.equal(empty.status, 400);
  const unknown = await api.handle({
    method: 'PUT', pathname: '/settings/providers', body: { apiKeys: { unknown: 'secret' } },
  });
  assert.equal(unknown.status, 400);
});

test('MiniMax 普通、MiniMax Plan、OpenAI 与自定义兼容接口分别保存且不回显密钥', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nightowl-provider-expanded-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = {};
  const settings = new ProviderSettingsStore(dir, { env });
  const api = new HttpApi({ store: new Store(dir), providerSettings: settings });
  const secrets = {
    minimax: 'minimax-payg-secret',
    'minimax-plan': 'minimax-plan-secret',
    openai: 'openai-secret',
    'openai-compatible': 'custom-secret',
  };
  const saved = await api.handle({
    method: 'PUT',
    pathname: '/settings/providers',
    body: {
      preferredProvider: 'minimax-plan',
      apiKeys: secrets,
      customOpenAI: {
        enabled: true,
        name: '公司网关',
        baseUrl: 'https://gateway.example.com/v1/',
        apiKeyRequired: true,
        models: [{
          name: 'company-chat', kind: 'chat', inputPrice: 1, outputPrice: 3, contextWindow: 128_000,
        }],
      },
    },
  });
  assert.equal(saved.status, 200);
  for (const secret of Object.values(secrets)) assert.doesNotMatch(JSON.stringify(saved.body), new RegExp(secret));
  assert.equal(env.MINIMAX_API_KEY, secrets.minimax);
  assert.equal(env.MINIMAX_PLAN_API_KEY, secrets['minimax-plan']);
  assert.equal(env.OPENAI_API_KEY, secrets.openai);
  assert.equal(env.OPENAI_COMPATIBLE_API_KEY, secrets['openai-compatible']);
  const providers = (saved.body as any).providers;
  assert.equal(providers.find((item: any) => item.id === 'minimax').configured, true);
  assert.equal(providers.find((item: any) => item.id === 'minimax-plan').configured, true);
  assert.equal(providers.find((item: any) => item.id === 'openai').configured, true);
  assert.equal(providers.find((item: any) => item.id === 'openai-compatible').name, '公司网关');
  assert.equal(settings.customOpenAIProviderConfig().baseUrl, 'https://gateway.example.com/v1');
});

test('自定义 OpenAI 可显式配置为无需 Key，但拒绝不安全或不完整端点', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nightowl-provider-custom-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const api = new HttpApi({
    store: new Store(dir),
    providerSettings: new ProviderSettingsStore(dir, { env: {} }),
  });
  const local = await api.handle({
    method: 'PUT', pathname: '/settings/providers', body: { customOpenAI: {
      enabled: true,
      name: '本地模型',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKeyRequired: false,
      models: [{ name: 'qwen-local', kind: 'chat', inputPrice: 0, outputPrice: 0, contextWindow: 32_000 }],
    } },
  });
  assert.equal(local.status, 200);
  assert.equal((local.body as any).providers.find((item: any) => item.id === 'openai-compatible').configured, true);

  const unsafe = await api.handle({
    method: 'PUT', pathname: '/settings/providers', body: { customOpenAI: {
      enabled: true,
      name: 'bad',
      baseUrl: 'file:///tmp/model',
      apiKeyRequired: false,
      models: [{ name: 'm', kind: 'chat', inputPrice: 0, outputPrice: 0, contextWindow: 1000 }],
    } },
  });
  assert.equal(unsafe.status, 400);
});

test('旧版 Provider 密钥文件可无损迁移读取', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nightowl-provider-migrate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, '.provider-secrets.json'), JSON.stringify({
    version: 1,
    preferredProvider: 'deepseek',
    apiKeys: { deepseek: 'legacy-secret' },
  }), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {};
  const settings = new ProviderSettingsStore(dir, { env });
  assert.equal(env.DEEPSEEK_API_KEY, 'legacy-secret');
  assert.equal(settings.snapshot().preferredProvider, 'deepseek');
  assert.equal(settings.customOpenAI().enabled, false);
});
