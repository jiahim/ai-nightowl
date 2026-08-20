import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Blueprint, Checkpoint, RollingSummary } from '../types.js';

/**
 * 落盘状态机（真相源）。
 *
 * 无限 loop 能存活的第一原则：进度靠磁盘，不靠上下文记忆。
 * 每次 tick 只从这里加载"当前工作集"，模型上下文只承载
 * "稳定前缀 + 当前工作集"，历史细节由 checkpoint + 滚动摘要承载。
 */

export interface StoreState {
  blueprint: Blueprint;
  checkpoints: Checkpoint[];
  rollingSummaries: RollingSummary[];
  updatedAt: string;
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
    try {
      const raw = await readFile(this.file, 'utf-8');
      return JSON.parse(raw) as StoreState;
    } catch {
      return null;
    }
  }

  async save(state: StoreState): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    state.updatedAt = new Date().toISOString();
    await writeFile(this.file, JSON.stringify(state, null, 2), 'utf-8');
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
