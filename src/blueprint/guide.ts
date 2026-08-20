import type { Blueprint, Milestone, Subtask, VerdictKind } from '../types.js';
import { slugify, validateBlueprint } from './validate.js';

/**
 * 蓝图引导引擎（m2-blueprint）。
 *
 * 把一句"我想干嘛"通过**聊天式多轮问答**引导成结构化的 Blueprint。
 * 这里只做"提问 → 收集 → 组装"的纯逻辑（无 IO）：真正的提问/作答由
 * 外层（CLI / LLM）驱动 —— 外层每轮调用 currentQuestion() 拿到问题、
 * 拿到用户/模型回复后调用 answer()，直到 isDone()，最后 build()。
 *
 * 两个入口：
 *  - `BlueprintGuide`：多轮问答状态机
 *  - `assembleBlueprint`：已有完整 draft 时直接组装（跳过问答）
 */

export interface SubtaskDraft {
  name: string;
  detail: string;
  /** 依赖的子任务**名称**（组装时按名称解析成 id） */
  dependencies: string[];
  /** 完成判定方式，默认 llm */
  verdictKind: VerdictKind;
  /** 判定标准（可选） */
  criteria: string[];
}

export interface MilestoneDraft {
  name: string;
  goal: string;
  acceptance: string[];
  subtasks: SubtaskDraft[];
}

export interface BlueprintDraft {
  id: string;
  title: string;
  description: string;
  constraints: string[];
  milestones: MilestoneDraft[];
  definitionOfDone: string;
}

export type GuideStage =
  | 'title'
  | 'description'
  | 'constraints'
  | 'milestones'
  | 'milestone-goal'
  | 'milestone-subtasks'
  | 'milestone-acceptance'
  | 'definitionOfDone'
  | 'done';

/** 按行 + 常见中文分隔符（、，,；;）拆分列表；「无/没有」整体视为空 */
function parseList(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    for (const part of raw.split(/[、，,；;]/)) {
      const t = part.trim();
      if (t) out.push(t);
    }
  }
  if (out.length === 1 && ['无', '没有', 'none'].includes(out[0].toLowerCase())) {
    return [];
  }
  return out;
}

/** 解析子任务行：「名称: 简述」→ SubtaskDraft；无冒号则只给名称 */
function parseSubtaskLine(line: string): SubtaskDraft {
  const idx = line.search(/[:：]/);
  if (idx === -1) {
    return { name: line.trim(), detail: '', dependencies: [], verdictKind: 'llm', criteria: [] };
  }
  return {
    name: line.slice(0, idx).trim(),
    detail: line.slice(idx + 1).trim(),
    dependencies: [],
    verdictKind: 'llm',
    criteria: [],
  };
}

/**
 * 组装蓝图（纯函数）：从 draft 生成带 id 的合法 Blueprint。
 * 依赖按名称解析成 id，最后过一遍 validateBlueprint；非法则抛错。
 */
export function assembleBlueprint(id: string, draft: BlueprintDraft): Blueprint {
  const milestones: Milestone[] = draft.milestones.map((md, mi) => {
    const mid = `m${mi + 1}`;
    const subtasks: Subtask[] = md.subtasks.map((sd, si) => ({
      id: `${mid}-t${si + 1}`,
      name: sd.name,
      detail: sd.detail,
      dependencies: [] as string[], // 下面统一解析
      verdict: { kind: sd.verdictKind, criteria: sd.criteria },
      status: 'pending' as const,
      evidence: [],
    }));
    return {
      id: mid,
      name: md.name,
      goal: md.goal,
      subtasks,
      acceptance: md.acceptance,
      status: 'pending' as const,
    };
  });

  const bp: Blueprint = {
    id: slugify(id) || 'blueprint',
    title: draft.title,
    description: draft.description,
    constraints: draft.constraints,
    milestones,
    definitionOfDone: draft.definitionOfDone,
  };

  // 依赖按名称 → id
  const nameToId = new Map<string, string>();
  for (const m of bp.milestones) {
    for (const s of m.subtasks) nameToId.set(s.name, s.id);
  }
  draft.milestones.forEach((md, mi) => {
    md.subtasks.forEach((sd, si) => {
      milestones[mi].subtasks[si].dependencies = sd.dependencies.map((depName) => {
        const depId = nameToId.get(depName);
        if (!depId) throw new Error(`依赖的子任务不存在：${depName}`);
        return depId;
      });
    });
  });

  const errors = validateBlueprint(bp);
  if (errors.length > 0) {
    throw new Error(`蓝图校验失败：\n- ${errors.join('\n- ')}`);
  }
  return bp;
}

export class BlueprintGuide {
  private draft: BlueprintDraft;
  private stage: GuideStage = 'title';
  private milestoneIndex = 0;

  constructor(id: string) {
    this.draft = {
      id: slugify(id) || 'blueprint',
      title: '',
      description: '',
      constraints: [],
      milestones: [],
      definitionOfDone: '',
    };
  }

  /** 当前引导阶段 */
  currentStage(): GuideStage {
    return this.stage;
  }

  isDone(): boolean {
    return this.stage === 'done';
  }

  /** 当前要问的问题（无问题时返回 null，通常意味着已完成） */
  currentQuestion(): string | null {
    switch (this.stage) {
      case 'title':
        return '给它起个名字（一句话标题）。';
      case 'description':
        return '用一两句话描述这个目标要达成什么。';
      case 'constraints':
        return '有哪些硬约束（技术栈 / 平台 / 时间窗等）？每行一条，没有就回复「无」。';
      case 'milestones':
        return '目标可以拆成哪些里程碑？每行一个里程碑名称。';
      case 'milestone-goal':
        return `里程碑「${this.currentMilestone().name}」的目标是什么？`;
      case 'milestone-subtasks':
        return `里程碑「${this.currentMilestone().name}」下有哪些子任务？每行一条，格式「名称: 简述」（也可只写名称）。`;
      case 'milestone-acceptance':
        return `里程碑「${this.currentMilestone().name}」的验收标准有哪些？每行一条，没有就回复「无」。`;
      case 'definitionOfDone':
        return '整体目标「完成」的判定标准是什么？';
      case 'done':
        return null;
    }
  }

  /** 回答当前问题，推进状态机 */
  answer(text: string): void {
    switch (this.stage) {
      case 'title':
        this.draft.title = text.trim();
        this.stage = 'description';
        break;
      case 'description':
        this.draft.description = text.trim();
        this.stage = 'constraints';
        break;
      case 'constraints':
        this.draft.constraints = parseList(text);
        this.stage = 'milestones';
        break;
      case 'milestones': {
        const names = parseList(text);
        this.draft.milestones = names.map((name) => ({
          name,
          goal: '',
          acceptance: [],
          subtasks: [],
        }));
        this.milestoneIndex = 0;
        this.stage = names.length > 0 ? 'milestone-goal' : 'definitionOfDone';
        break;
      }
      case 'milestone-goal':
        this.currentMilestone().goal = text.trim();
        this.stage = 'milestone-subtasks';
        break;
      case 'milestone-subtasks':
        this.currentMilestone().subtasks = parseList(text).map(parseSubtaskLine);
        this.stage = 'milestone-acceptance';
        break;
      case 'milestone-acceptance':
        this.currentMilestone().acceptance = parseList(text);
        this.advanceMilestone();
        break;
      case 'definitionOfDone':
        this.draft.definitionOfDone = text.trim();
        this.stage = 'done';
        break;
      case 'done':
        throw new Error('引导已完成，不能继续作答');
    }
  }

  /** 组装成 Blueprint；未完成时抛错 */
  build(): Blueprint {
    if (this.stage !== 'done') {
      throw new Error(`引导尚未完成（当前阶段：${this.stage}）`);
    }
    return assembleBlueprint(this.draft.id, this.draft);
  }

  private currentMilestone(): MilestoneDraft {
    return this.draft.milestones[this.milestoneIndex];
  }

  private advanceMilestone(): void {
    this.milestoneIndex += 1;
    if (this.milestoneIndex < this.draft.milestones.length) {
      this.stage = 'milestone-goal';
    } else {
      this.stage = 'definitionOfDone';
    }
  }
}
