/**
 * nightowl 核心类型定义
 *
 * 这是整个引擎的地基：蓝图三层（Blueprint/Milestone/Subtask）、
 * 完成判定（Verdict/Evidence）、平台成本策略（Provider/CostStrategy）、
 * 以及上下文压缩（Checkpoint/RollingSummary）的数据结构。
 *
 * 设计原则：这些类型是"纯数据 + 判定元数据"，不绑定任何 IO / 框架，
 * 引擎核心（engine）只消费这些结构，运行时外壳（runtime）负责驱动。
 */

// ============================================================
// 蓝图三层：Blueprint → Milestone → Subtask
// ============================================================

export type SubtaskStatus = 'pending' | 'in-progress' | 'done' | 'blocked';

/** 子任务：最小执行与判定单元 */
export interface Subtask {
  id: string;
  name: string;
  detail: string;
  /** 依赖的子任务 id（DAG 边），全 done 后本任务才可启动 */
  dependencies: string[];
  /** 完成判定：怎么算 done */
  verdict: Verdict;
  status: SubtaskStatus;
  /** 完成证据：产出物 / 日志 / 备注 */
  evidence: Evidence[];
}

/** 里程碑：一组子任务的聚合验收点 */
export interface Milestone {
  id: string;
  name: string;
  goal: string;
  subtasks: Subtask[];
  /** 验收标准：人类可读，判定里程碑是否达成 */
  acceptance: string[];
  status: SubtaskStatus;
}

/** 蓝图：产品目标的完整结构化描述 */
export interface Blueprint {
  id: string;
  title: string;
  description: string;
  /** 硬约束：技术栈 / 平台 / 时间窗口等不可违背项 */
  constraints: string[];
  milestones: Milestone[];
  /** 整体"完成"的定义 */
  definitionOfDone: string;
}

// ============================================================
// 完成判定：Verdict / Evidence
// ============================================================

/** 完成判定方式 */
export type VerdictKind = 'llm' | 'check' | 'manual';

/**
 * 完成判定。三种 kind：
 * - llm：让模型判断（给 prompt + criteria，模型读 evidence 判定）
 * - check：自动化检查（跑一段命令 / 断言，返回布尔）
 * - manual：人工确认（抛给用户，等确认）
 */
export interface Verdict {
  kind: VerdictKind;
  /** llm 判定时的判断 prompt */
  prompt?: string;
  /** check 判定时的命令或断言标识 */
  check?: string;
  /** 判定标准（人类可读） */
  criteria: string[];
}

/** 完成证据 */
export interface Evidence {
  kind: 'artifact' | 'log' | 'note';
  /** 产出物路径（artifact 时） */
  path?: string;
  /** 日志 / 备注内容（log / note 时） */
  content?: string;
  /** ISO 时间戳 */
  at: string;
}

// ============================================================
// 平台 Provider 与成本策略
// ============================================================

export type ModelKind = 'chat' | 'reasoner';

/** 单个模型规格与价格（人民币 / 百万 tokens） */
export interface ModelSpec {
  name: string;
  kind: ModelKind;
  /** 输入价（缓存未命中） */
  inputPrice: number;
  /** 输出价 */
  outputPrice: number;
  /** 缓存命中输入价（可选） */
  cacheHitPrice?: number;
  /** 上下文窗口（tokens） */
  contextWindow: number;
}

/**
 * 成本优化策略。
 *
 * 关键设计：不同平台的"省钱维度"不一样——
 * - DeepSeek：时段折扣（空闲时段 = 高峰半价）
 * - Kimi / MiniMax：缓存命中 + 批处理（preferCache / batchDiscount）
 *
 * 所以这里不做"每平台都有低价时段"的假设，而是每个平台配一套策略。
 */
export interface CostStrategy {
  /** 高峰时段列表（全价），其余为空闲（打折）。
   *  DeepSeek 官方：高峰 9:00-12:00、14:00-18:00（北京），其余空闲 5 折。
   *  'HH:MM' 格式，北京时间。Kimi/MiniMax 无时段折扣，不配此项。 */
  peakWindows?: Array<{ start: string; end: string }>;
  /** 空闲时段折扣，0.5 = 5 折 */
  offPeakDiscount?: number;
  /** 批处理折扣（0.6 = 6 折），Batch API */
  batchDiscount?: number;
  /** 是否优先利用缓存命中（稳定前缀） */
  preferCache?: boolean;
}

/** 平台配置（声明式，存配置文件的形状） */
export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  /** API key 从哪个环境变量读取 */
  apiKeyEnv: string;
  models: ModelSpec[];
  costStrategy: CostStrategy;
}

// ============================================================
// 上下文压缩：Checkpoint / RollingSummary
// ============================================================

/** 里程碑 checkpoint：达成时生成一份摘要，后续 tick 只依赖它 */
export interface Checkpoint {
  milestoneId: string;
  summary: string;
  at: string;
}

/** 滚动摘要：执行日志滚动压缩的产物 */
export interface RollingSummary {
  content: string;
  /** 摘要覆盖的起始时间（ISO） */
  since: string;
  /** 摘要序号，递增 */
  seq: number;
}

// ============================================================
// 消息与执行
// ============================================================

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 任务类型：用于 executor 按任务选模型 */
export type TaskKind = 'plan' | 'execute' | 'judge' | 'summarize';
