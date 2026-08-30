import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Blueprint, Checkpoint, RollingSummary } from '../types.js';

export const STORE_SCHEMA_VERSION = 2 as const;

/**
 * 落盘状态机（真相源）。
 *
 * 无限 loop 能存活的第一原则：进度靠磁盘，不靠上下文记忆。
 * 每次 tick 只从这里加载"当前工作集"，模型上下文只承载
 * "稳定前缀 + 当前工作集"，历史细节由 checkpoint + 滚动摘要承载。
 */

export interface StoreState {
  schemaVersion: typeof STORE_SCHEMA_VERSION;
  blueprint: Blueprint;
  checkpoints: Checkpoint[];
  rollingSummaries: RollingSummary[];
  updatedAt: string;
  /** 整体 definitionOfDone 的验收状态；旧状态文件可缺省。 */
  completion: {
    status: 'pending' | 'done' | 'blocked';
    detail?: string;
    at?: string;
  };
}

/** 状态文件存在但无法可靠读取时抛出，不能伪装成“尚未初始化”。 */
export class StoreReadError extends Error {
  readonly file: string;

  constructor(file: string, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'StoreReadError';
    this.file = file;
  }
}

export class Store {
  private dir: string;
  private file: string;

  constructor(dir: string) {
    this.dir = dir;
    this.file = join(dir, 'state.json');
  }

  /** 加载状态；首次运行（无文件）返回 null */
  async load(): Promise<StoreState | null> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new StoreReadError(this.file, `无法读取状态文件：${this.file}`, err);
    }

    try {
      const parsed = JSON.parse(raw) as Partial<StoreState> & { schemaVersion?: unknown };
      if (!parsed || typeof parsed !== 'object' || !parsed.blueprint) {
        throw new Error('缺少 blueprint');
      }
      if (!Array.isArray(parsed.checkpoints) || !Array.isArray(parsed.rollingSummaries)) {
        throw new Error('checkpoints / rollingSummaries 必须是数组');
      }
      return migrateState(parsed);
    } catch (err) {
      throw new StoreReadError(this.file, `状态文件已损坏或结构不兼容：${this.file}`, err);
    }
  }

  /**
   * 原子保存：先在同目录写临时文件，再 rename 覆盖。
   * 进程在写入中途退出时，旧 state.json 仍保持完整。
   */
  async save(state: StoreState): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    state.schemaVersion = STORE_SCHEMA_VERSION;
    state.completion ??= { status: 'pending' };
    state.updatedAt = new Date().toISOString();
    const temp = join(this.dir, `.state.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(state, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temp, this.file);
    } catch (err) {
      await unlink(temp).catch(() => undefined);
      throw err;
    }
  }

  /** 追加 checkpoint，并截断旧的滚动摘要（只保留最近 keepSummaries 个） */
  async addCheckpoint(
    state: StoreState,
    cp: Checkpoint,
    keepSummaries = 5,
  ): Promise<void> {
    state.checkpoints.push(cp);
    state.rollingSummaries = state.rollingSummaries.slice(-keepSummaries);
    await this.save(state);
  }
}

/**
 * v1 状态没有 schemaVersion/completion，且 milestone=done 可能从未经过后来
 * 加入的 acceptance/DoD。迁移时保留子任务证据，但把聚合验收退回待判定。
 */
function migrateState(parsed: Partial<StoreState> & { schemaVersion?: unknown }): StoreState {
  const version = parsed.schemaVersion ?? 1;
  if (version !== 1 && version !== STORE_SCHEMA_VERSION) {
    throw new Error(`不支持的 Store schemaVersion：${String(version)}`);
  }

  const state = parsed as StoreState;
  if (version === 1) {
    for (const milestone of state.blueprint.milestones) {
      const statuses = milestone.subtasks.map((subtask) => subtask.status);
      if (statuses.length === 0) milestone.status = 'blocked';
      else if (statuses.some((status) => status === 'blocked')) milestone.status = 'blocked';
      else if (statuses.every((status) => status === 'done')) {
        milestone.status = milestone.acceptance.length > 0 ? 'pending' : 'done';
      } else if (statuses.some((status) => status === 'done' || status === 'in-progress')) {
        milestone.status = 'in-progress';
      } else milestone.status = 'pending';
    }
    const stillVerified = new Set(
      state.blueprint.milestones
        .filter((milestone) => milestone.status === 'done')
        .map((milestone) => milestone.id),
    );
    state.checkpoints = state.checkpoints.filter((checkpoint) =>
      stillVerified.has(checkpoint.milestoneId)
    );
    state.completion = { status: 'pending' };
    state.schemaVersion = STORE_SCHEMA_VERSION;
    return state;
  }

  if (
    !state.completion ||
    !['pending', 'done', 'blocked'].includes(state.completion.status)
  ) {
    throw new Error('schemaVersion=2 的状态缺少合法 completion');
  }
  return state;
}
