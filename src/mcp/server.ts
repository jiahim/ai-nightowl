#!/usr/bin/env node
/**
 * nightowl MCP server 入口（m4-mcp 的 IO 外壳）。
 *
 * 把框架无关的 McpRouter 接到 stdio transport 上，并提供一个
 * `nightowl-mcp` 独立进程入口（也可被宿主 import 后自行嵌入）。
 *
 * 分层职责：
 *   - McpStdioServer：从 stdin 逐行读 JSON-RPC，调 router.dispatch，
 *     把非 null 响应 JSON.stringify 成单行写回 stdout。只有这里碰 stdio。
 *   - buildServeMcp(dir)：复用 buildServeApi 组装「Store + 真实 DeepSeek
 *     loop + HttpApi」，再包成 MCP 工具 + router。
 *   - serveMcpMain：命令行入口（--dir）。
 *
 * 约束（MCP stdio 规范）：stdout 只用于 JSON-RPC 消息（一行一条、无内嵌
 * 换行）；所有日志走 stderr。
 */

import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpRouter, type JsonRpcResponse } from './protocol.js';
import { buildMcpTools } from './tools.js';
import { buildServeApi } from '../http/server.js';
import { PROJECT_VERSION } from '../http/api.js';

export interface McpServeOptions {
  dir?: string;
}

/** stdio transport：stdin 一行一消息 → dispatch → stdout 一行一响应 */
export class McpStdioServer {
  private readonly router: McpRouter;

  constructor(router: McpRouter) {
    this.router = router;
  }

  /** 启动：阻塞消费 stdin 直到 EOF */
  async start(): Promise<void> {
    const rl = createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
      terminal: false,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let msg: unknown;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        // 协议级 parse error，无 id 可回
        this.write({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: '解析错误：非法 JSON' },
        });
        continue;
      }

      const out = await this.router.dispatch(msg);
      if (out !== null) this.write(out);
    }
  }

  private write(res: JsonRpcResponse): void {
    process.stdout.write(JSON.stringify(res) + '\n');
  }
}

/** 组装完整 MCP 服务：复用 HttpApi 的完整引擎装配，包成 MCP 工具 + router */
export function buildServeMcp(dir: string): McpRouter {
  const api = buildServeApi(dir);
  const tools = buildMcpTools(api);
  return new McpRouter({
    tools,
    serverInfo: { name: 'ai-nightowl', version: PROJECT_VERSION },
  });
}

/** 解析命令行：--dir */
function parseArgs(argv: string[]): McpServeOptions {
  const args = argv.slice(2);
  const opts: McpServeOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--dir' && args[i + 1]) {
      opts.dir = args[i + 1];
      i += 1;
    }
  }
  return opts;
}

async function serveMcpMain(): Promise<void> {
  const opts = parseArgs(process.argv);
  const dir = resolve(opts.dir ?? '.ai-nightowl');
  const router = buildServeMcp(dir);
  console.error(`ai-nightowl MCP server 已启动（stdio）`);
  console.error(`数据目录：${dir}`);
  console.error('工具：get_status、get_cost、submit_blueprint、submit_blueprint_raw、tick、run');
  await new McpStdioServer(router).start();
}

// 仅当作为入口直接执行时运行（被 import 做测试时不触发副作用）
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  serveMcpMain().catch((err: unknown) => {
    console.error('错误：', (err as Error).message);
    process.exitCode = 1;
  });
}
