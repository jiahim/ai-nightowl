#!/usr/bin/env node
/**
 * ai-nightowl HTTP server 入口（m4-http 的 IO 外壳）。
 *
 * 把框架无关的 HttpApi 接到 node:http 上，并提供一个 `ai-nightowl-serve`
 * 独立进程入口（也可被宿主 import 后自行 startServer 嵌入）。
 *
 * 分层职责：
 *   - createHttpServer(api)：把 node:http 请求 → HttpRequest 映射到 api.handle，
 *     再把 HttpResponse 序列化回 socket。只有这里碰 TCP / JSON 解析。
 *   - buildServeApi(dir)：组装「Store + 真实 DeepSeek loop + HttpApi」，
 *     供独立进程跑完整引擎（发任务 → 推进 → 查状态）。
 *   - startServer / serveMain：监听 + 命令行入口。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HttpApi, type HttpResponse } from './api.js';
import { Store } from '../memory/store.js';
import { DeepSeekAdapter } from '../providers/deepseek.js';
import { Executor } from '../executor/executor.js';
import { SubtaskJudge, type LlmJudgeFn } from '../judge/subtask.js';
import { Scheduler } from '../runtime/scheduler.js';
import { NightOwlLoop } from '../runtime/loop.js';
import { CostTracker } from '../cost/tracker.js';
import type { Message } from '../types.js';

export interface ServeOptions {
  host?: string;
  port?: number;
  dir?: string;
}

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '127.0.0.1';

/** 读 JSON body；空 body → undefined；非法 JSON 抛错（由调用方转 400） */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw.trim()) return undefined;
  return JSON.parse(raw);
}

/** 序列化响应回 socket（统一 JSON） */
function send(
  res: ServerResponse,
  response: HttpResponse,
): void {
  const payload = JSON.stringify(response.body);
  res.writeHead(response.status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...response.headers,
  });
  res.end(payload);
}

/** 把 node:http 请求映射到 HttpApi.handle 的 HttpRequest，回写 HttpResponse */
export function createHttpServer(api: HttpApi): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';

    let body: unknown;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      try {
        body = await readJsonBody(req);
      } catch {
        send(res, {
          status: 400,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: { error: '请求体不是合法 JSON' },
        });
        return;
      }
    }

    const response = await api.handle({ method, pathname: url.pathname, body });
    send(res, response);
  });
}

/**
 * 组装完整引擎：Store + 真实 DeepSeek loop + HttpApi + CostTracker。
 * llmJudge 桥：把 SubtaskJudge 的「done/not_done」判定接到 DeepSeek adapter。
 * runOffPeakOnly=false：HTTP 显式触发即跑，不做时段门控（宿主决定何时调）。
 * CostTracker：execute 与 judge 的每次模型调用都记录 token 成本，供 GET /cost 查询。
 */
export function buildServeApi(dir: string): HttpApi {
  const store = new Store(dir);
  const adapter = new DeepSeekAdapter();
  const tracker = new CostTracker();

  const llmJudge: LlmJudgeFn = async (_subtask, prompt, _criteria) => {
    const messages: Message[] = [
      { role: 'system', content: '你是任务完成判定器，只回答 done 或 not_done。' },
      { role: 'user', content: prompt },
    ];
    const spec = adapter.routeModel('judge');
    const r = await adapter.chat(spec.name, messages);
    if (r.usage) {
      tracker.record({
        model: spec,
        kind: 'judge',
        promptTokens: r.usage.promptTokens,
        completionTokens: r.usage.completionTokens,
        offPeak: adapter.isOffPeak(new Date()),
        discount: adapter.currentDiscount(new Date()),
      });
    }
    const first = r.content.trim().toLowerCase().match(/^(done|not_done)/)?.[1];
    return { passed: first === 'done', detail: r.content.trim() };
  };

  const loop = new NightOwlLoop({
    store,
    executor: new Executor(adapter, { tracker }),
    judge: new SubtaskJudge({ llmJudge }),
    scheduler: new Scheduler([adapter]),
    options: { runOffPeakOnly: false },
  });

  return new HttpApi({ store, loop, tracker });
}

/** 监听；成功返回 Server（已 listen） */
export async function startServer(
  api: HttpApi,
  options: ServeOptions = {},
): Promise<Server> {
  const server = createHttpServer(api);
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? DEFAULT_HOST;
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolveListen);
  });
  return server;
}

/** 解析命令行：--port / --host / --dir */
function parseArgs(argv: string[]): ServeOptions {
  const args = argv.slice(2);
  const opts: ServeOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--port' && args[i + 1]) {
      opts.port = Number(args[i + 1]);
      i += 1;
    } else if (args[i] === '--host' && args[i + 1]) {
      opts.host = args[i + 1];
      i += 1;
    } else if (args[i] === '--dir' && args[i + 1]) {
      opts.dir = args[i + 1];
      i += 1;
    }
  }
  return opts;
}

async function serveMain(): Promise<void> {
  const opts = parseArgs(process.argv);
  const dir = resolve(opts.dir ?? '.ai-nightowl');
  const api = buildServeApi(dir);
  const server = await startServer(api, opts);

  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : (opts.port ?? DEFAULT_PORT);
  const host = typeof addr === 'object' && addr !== null && typeof addr.address === 'string'
    ? addr.address
    : (opts.host ?? DEFAULT_HOST);

  console.log(`ai-nightowl HTTP API 已启动：http://${host}:${port}`);
  console.log(`数据目录：${dir}`);
  console.log('端点：GET /health、GET /status、POST /blueprint、POST /blueprint/raw、POST /tick、POST /run');
}

// 仅当作为入口直接执行时运行（被 import 做测试时不触发副作用）
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  serveMain().catch((err: unknown) => {
    console.error('错误：', (err as Error).message);
    process.exitCode = 1;
  });
}
