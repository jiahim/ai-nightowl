import type { Blueprint } from '../types.js';

/**
 * 蓝图校验工具（纯逻辑、无 IO）。
 *
 * 蓝图是引擎的输入，结构一旦出错（id 重复、依赖指向不存在的任务、
 * 依赖成环），后续状态机会静默错乱。所以引导引擎在组装蓝图后、
 * 落盘前必须过一遍这里。
 */

/** 简单 slug：保留字母数字，其余字符折叠成 '-' */
export function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * 校验蓝图，返回错误列表（空数组 = 合法）。
 * 规则：
 *  - 顶层 id / title / description 非空
 *  - 至少一个里程碑
 *  - 里程碑 / 子任务 id 全局唯一、name 非空
 *  - 子任务 name 全局唯一（依赖按 name 解析时需要无歧义）
 *  - 依赖必须指向已存在的子任务，且不能依赖自己
 *  - 依赖图无环
 */
export function validateBlueprint(bp: Blueprint): string[] {
  const errors: string[] = [];

  if (!bp.id.trim()) errors.push('id 不能为空');
  if (!bp.title.trim()) errors.push('title 不能为空');
  if (!bp.description.trim()) errors.push('description 不能为空');
  if (bp.milestones.length === 0) errors.push('至少需要一个里程碑');

  const milestoneIds = new Set<string>();
  const subtaskIds = new Set<string>();
  const subtaskNames = new Map<string, string>(); // name → id（查重）

  for (const m of bp.milestones) {
    if (!m.name.trim()) errors.push(`里程碑 ${m.id} 的 name 不能为空`);
    if (milestoneIds.has(m.id)) errors.push(`里程碑 id 重复：${m.id}`);
    milestoneIds.add(m.id);

    for (const s of m.subtasks) {
      if (!s.name.trim()) errors.push(`子任务 ${s.id} 的 name 不能为空`);
      if (subtaskIds.has(s.id)) errors.push(`子任务 id 重复：${s.id}`);
      subtaskIds.add(s.id);

      if (subtaskNames.has(s.name)) {
        errors.push(`子任务名称重复（依赖按名称解析会歧义）：${s.name}`);
      }
      subtaskNames.set(s.name, s.id);
    }
  }

  // 依赖合法性
  for (const m of bp.milestones) {
    for (const s of m.subtasks) {
      for (const dep of s.dependencies) {
        if (!subtaskIds.has(dep)) {
          errors.push(`子任务 ${s.id} 依赖了不存在的任务：${dep}`);
        } else if (dep === s.id) {
          errors.push(`子任务 ${s.id} 不能依赖自己`);
        }
      }
    }
  }

  if (hasDependencyCycle(bp)) errors.push('子任务依赖存在环');

  return errors;
}

/** 依赖图环检测（DFS 三色标记） */
function hasDependencyCycle(bp: Blueprint): boolean {
  const edges = new Map<string, string[]>();
  for (const m of bp.milestones) {
    for (const s of m.subtasks) edges.set(s.id, s.dependencies);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();

  const visit = (id: string): boolean => {
    color.set(id, GRAY);
    for (const dep of edges.get(id) ?? []) {
      const c = color.get(dep) ?? WHITE;
      if (c === GRAY) return true; // 回到灰色 → 环
      if (c === WHITE && visit(dep)) return true;
    }
    color.set(id, BLACK);
    return false;
  };

  for (const id of edges.keys()) {
    if ((color.get(id) ?? WHITE) === WHITE && visit(id)) return true;
  }
  return false;
}
