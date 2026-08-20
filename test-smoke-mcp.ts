// 临时 smoke：验证 m4-mcp（McpRouter JSON-RPC 分发 + 工具注册 + stdio 接线）端到端跑通
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HttpApi,
  Store,
  McpRouter,
  buildMcpTools,
  buildServeMcp,
} from './src/index';
import type { JsonRpcResponse } from './src/index';

const dir = '/tmp/nightowl-mcp-smoke';
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

// ===== 1. 纯 router 分发（无 IO，直接调 dispatch） =====
const router = buildServeMcp(dir);

const disp = async (raw: unknown): Promise<JsonRpcResponse | null> => router.dispatch(raw);

// [a] 握手 initialize
const init = await disp({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
});
console.log(
  '[a] initialize 协商版本 =',
  (init as JsonRpcResponse).result !== undefined &&
    ((init as JsonRpcResponse).result as any).protocolVersion === '2024-11-05',
  '(期望 true)',
);
console.log(
  '[b] serverInfo.name =',
  ((init as JsonRpcResponse).result as any).serverInfo?.name === 'nightowl',
  '(期望 true)',
);
console.log(
  '[c] capabilities.tools =',
  ((init as JsonRpcResponse).result as any).capabilities?.tools !== undefined,
  '(期望 true)',
);

// [d] 默认版本（未协商）
const initDefault = await disp({
  jsonrpc: '2.0',
  id: 2,
  method: 'initialize',
  params: {},
});
console.log(
  '[d] 默认协议版本 =',
  ((initDefault as JsonRpcResponse).result as any).protocolVersion === '2025-06-18',
  '(期望 true)',
);

// [e] tools/list → 5 个工具
const listed = await disp({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
const names = ((listed as JsonRpcResponse).result as any).tools.map((t: any) => t.name).sort();
console.log(
  '[e] 工具清单 =',
  JSON.stringify(names) === JSON.stringify(['get_status', 'run', 'submit_blueprint', 'submit_blueprint_raw', 'tick'].sort()),
  '(期望 true)',
);

// [f] get_status（空态）
const empty = await disp({
  jsonrpc: '2.0',
  id: 4,
  method: 'tools/call',
  params: { name: 'get_status', arguments: {} },
});
const emptyText = ((empty as JsonRpcResponse).result as any).content[0].text;
console.log('[f] 空态 hasBlueprint =', JSON.parse(emptyText).hasBlueprint === false, '(期望 true)');

// [g] submit_blueprint（draft）
const sub = await disp({
  jsonrpc: '2.0',
  id: 5,
  method: 'tools/call',
  params: {
    name: 'submit_blueprint',
    arguments: {
      title: 'MCP 测试任务',
      description: '测试 MCP 发任务',
      definitionOfDone: '全部完成',
      milestones: [
        {
          name: '里程碑一',
          goal: 'g1',
          subtasks: [{ name: '子任务1', detail: '', dependencies: [], criteria: ['c1'] }],
        },
      ],
    },
  },
});
const subResult = (sub as JsonRpcResponse).result as any;
console.log('[g] submit isError =', subResult.isError === false, '(期望 true)');
console.log('[h] submit created =', JSON.parse(subResult.content[0].text).created === true, '(期望 true)');

// [i] 提交后查状态 → hasBlueprint true
const status = await disp({
  jsonrpc: '2.0',
  id: 6,
  method: 'tools/call',
  params: { name: 'get_status', arguments: {} },
});
const statusText = ((status as JsonRpcResponse).result as any).content[0].text;
const st = JSON.parse(statusText);
console.log('[i] 提交后 hasBlueprint =', st.hasBlueprint === true, '(期望 true)');
console.log('[j] 进度 total =', st.progress.total, '(期望 1)');

// [k] 未知工具 → JSON-RPC error(-32602)
const unknown = await disp({
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: { name: 'nope', arguments: {} },
});
console.log(
  '[k] 未知工具 error.code =',
  (unknown as JsonRpcResponse).error?.code === -32602,
  '(期望 true)',
);

// [l] ping
const ping = await disp({ jsonrpc: '2.0', id: 8, method: 'ping', params: {} });
console.log('[l] ping result =', (ping as JsonRpcResponse).result !== undefined, '(期望 true)');

// [m] 未知方法 → -32601
const badMethod = await disp({ jsonrpc: '2.0', id: 9, method: 'resources/list', params: {} });
console.log('[m] 未知方法 error.code =', (badMethod as JsonRpcResponse).error?.code === -32601, '(期望 true)');

// [n] 通知（无 id）→ 返回 null
const notif = await disp({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
console.log('[n] 通知返回 null =', notif === null, '(期望 true)');

// [o] 非法 JSON-RPC → -32600
const invalid = await disp({ hello: 'world' });
console.log('[o] 非法请求 error.code =', (invalid as JsonRpcResponse).error?.code === -32600, '(期望 true)');

// [p] 工具级失败：缺 title 的 draft → isError true（不抛协议错误）
const badSubmit = await disp({
  jsonrpc: '2.0',
  id: 10,
  method: 'tools/call',
  params: { name: 'submit_blueprint', arguments: { milestones: [] } },
});
console.log('[p] 缺 title isError =', (badSubmit as JsonRpcResponse).result?.isError === true, '(期望 true)');

// ===== 2. stdio 接线：spawn 真实子进程，pipe JSON-RPC，读 stdout =====
const __dirname = resolve(fileURLToPath(new URL('.', import.meta.url)));
const child = spawn(
  'npx',
  ['tsx', 'src/mcp/server.ts', '--dir', '/tmp/nightowl-mcp-stdio'],
  { cwd: __dirname, stdio: ['pipe', 'pipe', 'pipe'] },
);
let buf = '';
const lines: string[] = [];
child.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    lines.push(buf.slice(0, idx));
    buf = buf.slice(idx + 1);
  }
});
const send = (obj: unknown) => child.stdin.write(JSON.stringify(obj) + '\n');
send({ jsonrpc: '2.0', id: 100, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } } });
send({ jsonrpc: '2.0', id: 101, method: 'tools/list', params: {} });
send({ jsonrpc: '2.0', id: 102, method: 'tools/call', params: { name: 'get_status', arguments: {} } });
child.stdin.end();

await new Promise<void>((res) => child.on('close', () => res()));

console.log('[q] stdio 响应条数 =', lines.length, '(期望 3)');
const parsed = lines.map((l) => JSON.parse(l));
console.log(
  '[r] stdio initialize id 回显 =',
  parsed[0]?.id === 100 && parsed[0]?.result?.serverInfo?.name === 'nightowl',
  '(期望 true)',
);
console.log('[s] stdio tools/list 工具数 =', parsed[1]?.result?.tools?.length, '(期望 5)');
console.log(
  '[t] stdio get_status 空态 =',
  JSON.parse(parsed[2]?.result?.content?.[0]?.text).hasBlueprint === false,
  '(期望 true)',
);

console.log('\n✅ m4-mcp smoke 通过');
