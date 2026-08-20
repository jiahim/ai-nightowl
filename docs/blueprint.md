# Blueprint: nightowl 自己（dogfood 第一份蓝图）

> 用 nightowl 自己的 Blueprint schema 表达"开发 nightowl"这个目标。
> 这既是开发计划，也是 blueprint 模块的第一个真实输入样例。

- **id**: `nightowl-self`
- **title**: 夜猫子 —— 夜间任务编排引擎
- **description**: 自驱动 agent 服务，在模型平台夜间低谷时段自动推进「蓝图 → 子任务 → 里程碑」直至完成大目标；宿主（QwenPaw / deepseek-harness）零改造对接。
- **constraints**:
  - 技术栈 TypeScript / Node.js（deepseek-harness 同生态）
  - 引擎核心纯逻辑、无 IO、可独立复用
  - 宿主零改造：仅通过 MCP / HTTP / CLI 对接
  - 平台先做 DeepSeek 一家，成本策略留口子（Kimi / MiniMax 后续加）
  - 无限 loop 必须靠落盘状态机 + 上下文压缩存活
- **definitionOfDone**: nightowl 能独立运行，接收一个蓝图，在夜间低谷时段自动推进子任务、判定里程碑，直至整体完成；并能被 QwenPaw / deepseek-harness 经标准协议调用。

## Milestones

### M1 · 核心骨架（engine 地基）
- **goal**: 类型定义 + DeepSeek adapter + 状态机 + 落盘存储 + 调度器可跑通
- **subtasks**:
  1. `m1-types` — 核心类型定义（Blueprint/Milestone/Subtask/Verdict/Provider/CostStrategy）✅ done
  2. `m1-adapter` — ProviderAdapter 接口 + DeepSeek 实现 ✅ done
  3. `m1-state` — 计划状态机（依赖/可运行/里程碑刷新）✅ done
  4. `m1-store` — 落盘状态机（真相源）✅ done
  5. `m1-scheduler` — 时间段调度（低谷窗口判断）✅ done
  6. `m1-typecheck` — 类型检查通过
- **acceptance**: `pnpm typecheck` 零错误；`tsx` 能 import 各模块不崩

### M2 · 引擎完整（planning + judging + executing）
- **goal**: blueprint 引导引擎、executor、milestone 判定补全
- **subtasks**:
  1. `m2-blueprint` — 蓝图引导引擎（聊天式多轮问答 → 结构化 Blueprint）
  2. `m2-executor` — LLM executor（子任务 → 调 provider 模型干活）
  3. `m2-milestone` — 里程碑聚合判定（子任务全 done + acceptance 检查）
  4. `m2-judge` — 子任务完成判定（llm / check / manual 三态）
- **acceptance**: 给定一个蓝图，能拆分子任务、执行、判定完成、推进里程碑

### M3 · 运行时 + 上下文压缩
- **goal**: 自驱动 loop 跑起来，无限循环靠落盘 + 压缩存活
- **subtasks**:
  1. `m3-loop` — 自驱动事件循环（低谷时段唤醒 + tick 推进）
  2. `m3-memory` — 上下文压缩完整（滚动摘要 + checkpoint + 缓存友好前缀）
  3. `m3-prefix` — 稳定前缀构造（system + blueprint + checkpoint 固定顺序吃缓存）
- **acceptance**: loop 连续运行多轮不爆上下文、不丢进度、重启后能续跑

### M4 · 接口层
- **goal**: 宿主零改造对接
- **subtasks**:
  1. `m4-cli` — CLI 入口（聊天交互画蓝图、查进度）
  2. `m4-http` — HTTP API
  3. `m4-mcp` — MCP server（QwenPaw / dsh 跨语言对接）
- **acceptance**: QwenPaw / deepseek-harness 能经协议发任务、查状态

### M5 · dogfood 验证
- **goal**: 用 nightowl 跑一个真实夜间任务，验证全链路
- **subtasks**:
  1. `m5-real-task` — 选一个真实产品目标，用 nightowl 在低谷时段端到端跑通
  2. `m5-cost` — 记录 token 成本，验证低谷时段确实省钱
- **acceptance**: 端到端跑通 + 成本可量化
