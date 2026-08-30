import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  HttpApi,
  McpRouter,
  Store,
  buildMcpTools,
} from '../src/index.js';

test('MCP 初始化与工具清单使用当前产品名和完整能力', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nightowl-mcp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const router = new McpRouter({
    tools: buildMcpTools(new HttpApi({ store: new Store(dir) })),
    serverInfo: { name: 'ai-nightowl', version: '0.2.0' },
  });
  const initialized = await router.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal((initialized?.result as any).serverInfo.name, 'ai-nightowl');
  const listed = await router.dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const names = (listed?.result as any).tools.map((tool: any) => tool.name);
  assert.deepEqual(names.sort(), [
    'approve_subtask', 'get_cost', 'get_plugins', 'get_runtime', 'get_status', 'retry_subtask',
    'run', 'start', 'stop', 'submit_blueprint', 'submit_blueprint_raw', 'tick',
  ].sort());
});

test('MCP 区分无 id 通知与显式 null id 请求，并校验 required', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nightowl-mcp-id-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const router = new McpRouter({
    tools: buildMcpTools(new HttpApi({ store: new Store(dir) })),
    serverInfo: { name: 'ai-nightowl', version: '0.2.0' },
  });
  assert.equal(await router.dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const ping = await router.dispatch({ jsonrpc: '2.0', id: null, method: 'ping' });
  assert.equal(ping?.id, null);
  assert.deepEqual(ping?.result, {});
  const missing = await router.dispatch({
    jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'retry_subtask', arguments: {} },
  });
  assert.equal(missing?.error?.code, -32602);
});
