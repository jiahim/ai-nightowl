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
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HttpApi, type HttpResponse } from './api.js';
import { Store } from '../memory/store.js';
import { DeepSeekAdapter } from '../providers/deepseek.js';
import { ZhipuAdapter } from '../providers/zhipu.js';
import { FailoverAdapter } from '../providers/failover.js';
import type { ProviderAdapter } from '../providers/adapter.js';
import { Executor } from '../executor/executor.js';
import { SubtaskJudge, type LlmJudgeFn } from '../judge/subtask.js';
import { Scheduler } from '../runtime/scheduler.js';
import { NightOwlLoop } from '../runtime/loop.js';
import { RunController } from '../runtime/controller.js';
import { CostTracker } from '../cost/tracker.js';
import type { Message } from '../types.js';
import {
  PluginRegistry,
  collectPluginSpecifiers,
  loadPluginModules,
} from '../plugins/registry.js';
import { getWebAsset } from '../web/console.js';

export interface ServeOptions {
  host?: string;
  port?: number;
  dir?: string;
  plugins?: string[];
}

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 1_048_576;

class BodyTooLargeError extends Error {}

/** 读 JSON body；空 body → undefined；非法 JSON 抛错（由调用方转 400） */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(buffer);
  }
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
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...response.headers,
  });
  res.end(payload);
}

/** 把 node:http 请求映射到 HttpApi.handle 的 HttpRequest，回写 HttpResponse */
export function createHttpServer(api: HttpApi): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';

    if (method === 'GET') {
      const asset = getWebAsset(url.pathname);
      if (asset) {
        const payload = Buffer.from(asset.body, 'utf-8');
        res.writeHead(200, {
          'Content-Type': asset.contentType,
          'Content-Length': payload.length,
          'Cache-Control': asset.cacheControl,
          'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
        });
        res.end(payload);
        return;
      }
    }

    let body: unknown;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      const hasBody = Number(req.headers['content-length'] ?? 0) > 0 || Boolean(req.headers['transfer-encoding']);
      const contentType = req.headers['content-type'] ?? '';
      if (hasBody && !contentType.toLowerCase().startsWith('application/json')) {
        send(res, {
          status: 415,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: { error: '请求体必须使用 application/json' },
        });
        return;
      }
      try {
        body = await readJsonBody(req);
      } catch (err) {
        send(res, {
          status: err instanceof BodyTooLargeError ? 413 : 400,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: { error: err instanceof BodyTooLargeError ? '请求体超过 1 MiB 限制' : '请求体不是合法 JSON' },
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
/**
 * 按环境选择平台链（Failover）。
 * 用户模型策略（2026-08-21）：正常 DeepSeek v4-flash；flash 没钱 → glm-5.3 顶上；
 * 困难问题 → v4-pro / glm-5.3。failover 按模型名路由链，429/5xx/网络自动切下一个平台。
 *
 * - env `NIGHTOWL_PROVIDER=deepseek|zhipu` 显式锁定首选平台
 * - 缺省：有 DEEPSEEK_API_KEY → deepseek 优先；否则 zhipu
 * - 都没 key：仍包 DeepSeek（保留 "Missing API key" 报错语义）
 */
export function resolveAdapter(registry: PluginRegistry = new PluginRegistry()): ProviderAdapter {
  const provider = process.env.NIGHTOWL_PROVIDER;
  const hasDeepseek = Boolean(process.env.DEEPSEEK_API_KEY);
  const hasZhipu = Boolean(process.env.ZHIPU_API_KEY);

  if (!registry.provider('deepseek')) registry.registerCoreProvider(new DeepSeekAdapter());
  if (!registry.provider('zhipu')) registry.registerCoreProvider(new ZhipuAdapter());

  const adapters: ProviderAdapter[] = [];
  if (provider) {
    const explicit = registry.provider(provider);
    if (!explicit) throw new Error(`未知 NIGHTOWL_PROVIDER：${provider}`);
    adapters.push(explicit);
    if (provider !== 'deepseek' && hasDeepseek) adapters.push(registry.provider('deepseek')!);
    if (provider !== 'zhipu' && hasZhipu) adapters.push(registry.provider('zhipu')!);
  } else {
    if (hasDeepseek) adapters.push(registry.provider('deepseek')!);
    if (hasZhipu) adapters.push(registry.provider('zhipu')!);
    for (const adapter of registry.providers()) {
      if (adapter.id !== 'deepseek' && adapter.id !== 'zhipu') adapters.push(adapter);
    }
  }
  if (adapters.length === 0) adapters.push(registry.provider('deepseek')!);

  return adapters.length === 1
    ? adapters[0]
    : new FailoverAdapter(adapters);
}

export function buildServeApi(
  dir: string,
  options: { plugins?: PluginRegistry } = {},
): HttpApi {
  const store = new Store(dir);
  const plugins = options.plugins ?? new PluginRegistry();
  const adapter = resolveAdapter(plugins);
  const tracker = new CostTracker();
  const configuredInterval = Number(process.env.NIGHTOWL_TICK_INTERVAL_MS ?? 1000);
  const tickIntervalMs = Number.isFinite(configuredInterval)
    ? Math.max(0, Math.floor(configuredInterval))
    : 1000;

  const judgeWithModel = async (system: string, prompt: string, kind: string) => {
    const messages: Message[] = [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ];
    const spec = adapter.routeModel('judge');
    const result = await adapter.chat(spec.name, messages);
    if (result.usage) {
      tracker.record({
        model: result.spec ?? spec,
        providerId: result.providerId,
        kind,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        offPeak: result.pricing?.offPeak ?? adapter.isOffPeak(new Date()),
        discount: result.pricing?.discount ?? adapter.currentDiscount(new Date()),
      });
    }
    const first = result.content.trim().toLowerCase().match(/^(done|not_done)/)?.[1];
    return { passed: first === 'done', detail: result.content.trim() };
  };

  const llmJudge: LlmJudgeFn = async (_subtask, prompt, _criteria) => {
    return judgeWithModel('你是任务完成判定器，只回答 done 或 not_done，随后简述理由。', prompt, 'judge');
  };

  const loop = new NightOwlLoop({
    store,
    executor: new Executor(adapter, { tracker }),
    judge: new SubtaskJudge({ llmJudge }),
    scheduler: new Scheduler([adapter]),
    options: {
      runOffPeakOnly: false,
      pollIntervalMs: tickIntervalMs,
      milestoneVerifier: async (milestone) => {
        const evidence = milestone.subtasks.flatMap((subtask) =>
          subtask.evidence.map((item) => `[${subtask.name}] ${item.content ?? item.path ?? ''}`),
        );
        const prompt = [
          `里程碑：${milestone.name}`,
          `目标：${milestone.goal}`,
          '验收标准：',
          ...milestone.acceptance.map((item, index) => `${index + 1}. ${item}`),
          '证据：',
          ...evidence,
          '只有所有验收标准都有充分证据时回答 done，否则回答 not_done。',
        ].join('\n');
        return judgeWithModel('你是严格的里程碑验收器。', prompt, 'milestone-judge');
      },
      blueprintVerifier: async (blueprint) => {
        const evidence = blueprint.milestones.flatMap((milestone) =>
          milestone.subtasks.flatMap((subtask) =>
            subtask.evidence.map((item) => `[${milestone.name}/${subtask.name}] ${item.content ?? item.path ?? ''}`),
          ),
        );
        return judgeWithModel(
          '你是严格的整体目标验收器。',
          [`完成定义：${blueprint.definitionOfDone}`, '证据：', ...evidence, '满足时回答 done，否则回答 not_done。'].join('\n'),
          'blueprint-judge',
        );
      },
    },
  });

  const controller = new RunController(loop);

  return new HttpApi({ store, loop, tracker, controller, plugins });
}

/** 监听；成功返回 Server（已 listen） */
export async function startServer(
  api: HttpApi,
  options: ServeOptions = {},
): Promise<Server> {
  const server = createHttpServer(api);
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? DEFAULT_HOST;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`端口必须是 0–65535 的整数（收到 ${String(port)}）`);
  }
  if (!isLoopbackHost(host)) {
    throw new Error(
      `为保护本地任务与密钥，当前版本只允许 loopback 监听（收到 ${host}）。` +
      '请使用 SSH tunnel，或等待带认证的远程控制模式。',
    );
  }
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolveListen);
  });
  return server;
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
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
    } else if (args[i] === '--plugin' && args[i + 1]) {
      (opts.plugins ??= []).push(args[i + 1]);
      i += 1;
    }
  }
  return opts;
}

async function serveMain(): Promise<void> {
  const opts = parseArgs(process.argv);
  const dir = resolve(opts.dir ?? '.ai-nightowl');
  const plugins = await loadPluginModules(collectPluginSpecifiers(opts.plugins));
  const api = buildServeApi(dir, { plugins });
  const server = await startServer(api, opts);

  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : (opts.port ?? DEFAULT_PORT);
  const host = typeof addr === 'object' && addr !== null && typeof addr.address === 'string'
    ? addr.address
    : (opts.host ?? DEFAULT_HOST);

  console.log(`ai-nightowl HTTP API 已启动：http://${host}:${port}`);
  console.log(`数据目录：${dir}`);
  console.log('控制台：打开上面的地址；API 包含 /status、/runtime、/plugins、/tick、/run');
}

// 仅当作为入口直接执行时运行（被 import 做测试时不触发副作用）
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (isMain) {
  serveMain().catch((err: unknown) => {
    console.error('错误：', (err as Error).message);
    process.exitCode = 1;
  });
}
