#!/usr/bin/env node
/**
 * ai-nightowl CLI 入口（m4-cli）。
 *
 * 宿主零改造对接的第一种方式：命令行交互。
 *   - init   ：聊天式多轮问答 → 结构化 Blueprint → 落盘 state.json
 *   - status ：读 state.json，展示蓝图 + 子任务 + 里程碑进度
 *
 * 分层职责：init 复用 BlueprintGuide（纯逻辑引导状态机），
 * 持久化复用 Store（落盘状态机）；CLI 只负责读 stdin / 写 stdout 的
 * 交互外壳与命令分发，不掺业务逻辑，保持薄。
 */

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BlueprintGuide } from './blueprint/guide.js';
import { Store, type StoreState } from './memory/store.js';
import type { SubtaskStatus } from './types.js';

const USAGE = `ai-nightowl —— 夜猫子（夜间任务编排引擎）CLI

用法：
  ai-nightowl init [--dir <path>]    交互式问答创建蓝图，保存到 <path>/state.json（默认 ./.ai-nightowl）
  ai-nightowl status [--dir <path>]  查看当前蓝图与子任务进度
  ai-nightowl help                   显示本帮助
`;

/** 解析命令行参数：返回命令名 + 数据目录（绝对路径） */
function parseArgs(argv: string[]): { command: string; dir: string } {
  const args = argv.slice(2);
  const command = args[0] ?? 'help';
  let dir = resolve('.ai-nightowl');
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === '--dir' && args[i + 1]) {
      dir = resolve(args[i + 1]);
      i += 1;
    } else if (!args[i].startsWith('-')) {
      dir = resolve(args[i]);
    }
  }
  return { command, dir };
}

function statusMark(s: SubtaskStatus): string {
  switch (s) {
    case 'done':
      return '✅';
    case 'in-progress':
      return '🔄';
    case 'blocked':
      return '⛔';
    default:
      return '⬜';
  }
}

/** 格式化进度文本（纯函数，供 status 命令与测试复用） */
export function statusText(state: StoreState | null): string {
  if (!state) {
    return '（无蓝图）当前目录尚未初始化，请先运行 `ai-nightowl init`。';
  }
  const bp = state.blueprint;
  const subtasks = bp.milestones.flatMap((m) => m.subtasks);
  const doneCount = subtasks.filter((s) => s.status === 'done').length;
  const total = subtasks.length;

  const lines: string[] = [];
  lines.push(`蓝图「${bp.title}」(${bp.id})`);
  if (bp.description) lines.push(`  描述：${bp.description}`);
  lines.push('');
  for (const m of bp.milestones) {
    const md = m.subtasks.filter((s) => s.status === 'done').length;
    lines.push(
      `${statusMark(m.status)} ${m.id} ${m.name}  ${md}/${m.subtasks.length}`,
    );
    if (m.goal) lines.push(`   目标：${m.goal}`);
    for (const s of m.subtasks) {
      lines.push(`    ${statusMark(s.status)} ${s.id} ${s.name}`);
    }
  }
  lines.push('');
  lines.push(
    `整体进度：${doneCount}/${total} 子任务${total > 0 && doneCount === total ? '（全部完成 🎉）' : ''}`,
  );
  if (state.checkpoints.length > 0) {
    lines.push(`里程碑 checkpoint：${state.checkpoints.length} 个已达成`);
  }
  return lines.join('\n');
}

/** init 命令：多轮问答 → 组装蓝图 → 落盘 */
async function initBlueprint(dir: string): Promise<void> {
  const rl = createInterface({ input, output });
  console.log('欢迎使用 ai-nightowl 蓝图引导，按提示逐条回答即可。\n');
  const guide = new BlueprintGuide('blueprint');
  try {
    while (!guide.isDone()) {
      const q = guide.currentQuestion();
      if (!q) break;
      const answer = await rl.question(`> ${q}\n你：`);
      guide.answer(answer);
    }
    const bp = guide.build();
    const store = new Store(dir);
    await store.save({
      blueprint: bp,
      checkpoints: [],
      rollingSummaries: [],
      updatedAt: '',
    });
    console.log(
      `\n蓝图「${bp.title}」已创建，共 ${bp.milestones.length} 个里程碑，保存到 ${join(dir, 'state.json')}`,
    );
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const { command, dir } = parseArgs(process.argv);
  switch (command) {
    case 'init':
      await initBlueprint(dir);
      break;
    case 'status': {
      const store = new Store(dir);
      const state = await store.load();
      console.log(statusText(state));
      break;
    }
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      break;
    default:
      console.error(`未知命令：${command}\n`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

// 仅当作为入口直接执行时运行 main()（被 import 做测试时不触发副作用）
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((err: unknown) => {
    console.error('错误：', (err as Error).message);
    process.exitCode = 1;
  });
}
