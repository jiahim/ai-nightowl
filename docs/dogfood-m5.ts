/**
 * m5-real-task dogfood：用真实模型端到端跑通
 *   blueprint → loop → executor → judge → milestone → cost
 *
 * 走完整 HTTP 外壳（buildServeApi + startServer），provider 由
 * NIGHTOWL_PROVIDER / 环境 key 决定（默认 DEEPSEEK_API_KEY → v4-flash）。
 *
 * 跑法：cd ai-nightowl && set -a && source .env && set +a &&
 *       npx tsx docs/dogfood-m5.ts
 */
import { buildServeApi, startServer } from '../src/index.js';

const BLUEPRINT = {
  id: 'dogfood-changelog',
  title: 'ai-nightowl v0.2.0 CHANGELOG 草稿',
  description:
    '基于代码库真实情况，产出一份 Markdown 格式的 CHANGELOG.md 草稿，覆盖 v0.1.0 与 v0.2.0 两个版本段。',
  constraints: [
    '只描述代码库中真实存在的功能，不得虚构',
    '输出必须为 Markdown 格式',
    '使用中文',
  ],
  definitionOfDone:
    'CHANGELOG 草稿包含 v0.1.0 与 v0.2.0 两个版本段，每段列出真实变更点，格式为合法 Markdown。',
  milestones: [
    {
      id: 'm1',
      name: '盘点代码库',
      goal: '梳理 ai-nightowl 当前实现的功能模块与版本变更',
      acceptance: ['列出 src/ 下的核心模块清单', '说明 v0.1 与 v0.2 的差异'],
      status: 'pending',
      subtasks: [
        {
          id: 's1-modules',
          name: '模块清单',
          detail:
            '列出 ai-nightowl src/ 下的核心模块（providers / blueprint / plan / executor / judge / memory / runtime / cost / interfaces 等），简述每个模块职责。',
          dependencies: [],
          verdict: {
            kind: 'llm',
            prompt: '请判定该子任务是否完成：模块清单必须覆盖 src/ 主要目录并给出职责简述。',
            criteria: ['覆盖核心模块', '有职责简述'],
          },
          status: 'pending',
          evidence: [],
        },
        {
          id: 's2-versions',
          name: '版本差异',
          detail:
            '根据已知信息：v0.1 为初始骨架（M1-M4 + m5-cost），v0.2 引入 V4 模型适配与智谱 coding plan 支持。梳理两个版本的变更点。',
          dependencies: [],
          verdict: {
            kind: 'llm',
            prompt: '请判定该子任务是否完成：版本差异需说明 v0.1 与 v0.2 各自主要变更。',
            criteria: ['有 v0.1 变更', '有 v0.2 变更'],
          },
          status: 'pending',
          evidence: [],
        },
      ],
    },
    {
      id: 'm2',
      name: '生成 CHANGELOG',
      goal: '产出合法 Markdown 的 CHANGELOG.md 草稿',
      acceptance: ['Markdown 合法', '含 v0.1.0 / v0.2.0 两段'],
      status: 'pending',
      subtasks: [
        {
          id: 's3-draft',
          name: '生成草稿',
          detail:
            '依据模块清单与版本差异，生成完整 CHANGELOG.md 草稿，格式：## [Unreleased]、## [v0.2.0]、## [v0.1.0]，每段列出 Added / Changed / Fixed 条目。',
          dependencies: ['s1-modules', 's2-versions'],
          verdict: {
            kind: 'llm',
            prompt:
              '请判定该子任务是否完成：草稿必须包含 v0.1.0 与 v0.2.0 两个版本段，且为合法 Markdown 列表。',
            criteria: ['含 v0.1.0 段', '含 v0.2.0 段', 'Markdown 列表合法'],
          },
          status: 'pending',
          evidence: [],
        },
        {
          id: 's4-review',
          name: '复核草稿',
          detail:
            '复核生成的 CHANGELOG 草稿：条目是否都能对应代码库真实功能，是否遗漏核心模块。给出复核结论。',
          dependencies: ['s3-draft'],
          verdict: {
            kind: 'llm',
            prompt: '请判定该子任务是否完成：复核结论需明确说明草稿质量与可改进点。',
            criteria: ['给出复核结论', '指出问题或确认无误'],
          },
          status: 'pending',
          evidence: [],
        },
      ],
    },
  ],
};

async function main(): Promise<void> {
  const dir = '.nightowl-dogfood';
  const api = buildServeApi(dir);
  const server = await startServer(api, { host: '127.0.0.1', port: 0 });
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 8787;
  const base = `http://127.0.0.1:${port}`;

  const post = async (path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      // undici 默认 headers/body timeout 300s，单个 tick 也可能跑几分钟，放宽
      signal: AbortSignal.timeout(900_000),
    });
    return { status: res.status, data: (await res.json()) as unknown };
  };
  const get = async (path: string) => {
    const res = await fetch(base + path, { signal: AbortSignal.timeout(60_000) });
    return { status: res.status, data: (await res.json()) as unknown };
  };

  console.log(`[dogfood] server: ${base}  data: ${dir}`);

  const sub = await post('/blueprint/raw', BLUEPRINT);
  console.log('[dogfood] /blueprint/raw:', sub.status);
  console.log('  ', JSON.stringify(sub.data).slice(0, 300));

  // /run 单请求可能超过 undici 300s 超时（多次 LLM 调用），改逐 tick 推进：
  // 每个 tick 独立短请求，直到 done 或 ran=0（无进展）。
  for (let i = 1; i <= 20; i += 1) {
    const tick = await post('/tick');
    const t = tick.data as {
      ran?: number;
      completed?: number;
      blocked?: number;
      done?: boolean;
      idleReason?: string;
    };
    console.log(`[dogfood] tick#${i}:`, JSON.stringify(t));
    if (t.done || (t.ran === 0 && i > 1)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  const status = await get('/status');
  console.log('[dogfood] /status:');
  console.log('  ', JSON.stringify(status.data).slice(0, 1200));

  const cost = await get('/cost');
  console.log('[dogfood] /cost:');
  console.log('  ', JSON.stringify(cost.data));

  server.close();
}

main().catch((e: unknown) => {
  console.error('[dogfood] FAIL:', (e as Error).message);
  process.exit(1);
});
