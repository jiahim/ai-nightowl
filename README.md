# nightowl 夜猫子

自驱动的夜间任务编排引擎。在模型平台的夜间低谷时段，自动推进「蓝图 → 子任务 → 里程碑」直至完成大目标。

## 定位

- **自驱动 agent 服务**（不是被嵌入的库）：自己跑 loop、自己调度、自己执行、自带交互入口
- **宿主零改造**：QwenPaw / deepseek-harness 等 agent 产品通过 MCP / HTTP / CLI 对接
- **引擎核心纯逻辑、无 IO**：`providers/blueprint/plan/milestone/executor/memory` 可独立复用

## 架构

```
nightowl —— 自驱动 agent 编排服务（TS/Node.js 常驻进程）

┌─ 运行时外壳 runtime（驱动 + 入口）
│   ├── loop         # 自驱动事件循环：夜间低价时段定时唤醒 + tick 推进
│   ├── scheduler    # 时间段调度（高峰 9-12/14-18，其余空闲 5 折）
│   └── interfaces   # CLI / HTTP / MCP —— 聊天交互入口

└─ 引擎核心 engine（纯逻辑、无 IO、可独立复用）
    ├── providers    # 平台适配器 + 成本策略（先 DeepSeek 一家，留口子）
    ├── blueprint    # 蓝图引导引擎（聊天式多轮问答）
    ├── plan         # 子任务拆分 + 完成判定 + 状态机
    ├── milestone    # 里程碑聚合判定
    ├── executor     # 执行器（LLM 任务）
    └── memory       # 上下文压缩（落盘状态机 + 滚动摘要 + checkpoint + 缓存前缀）
```

## 核心概念

- **Blueprint → Milestone → Subtask** 三层：产品目标的结构化描述
- **Verdict / Evidence**：子任务完成判定（llm / check / manual）+ 完成证据
- **CostStrategy**：成本策略抽象——时段（DeepSeek）/ 缓存（Kimi/MiniMax）/ 批处理 / 档位路由
- **Store 落盘状态机**：进度靠磁盘不靠上下文记忆；checkpoint + 滚动摘要压缩历史

## 目录

```
src/
├── types.ts              # 核心类型定义（地基）
├── providers/
│   ├── adapter.ts        # ProviderAdapter 接口
│   └── deepseek.ts       # DeepSeek 实现（空闲=高峰半价，高峰 9-12/14-18）
├── plan/state.ts         # 计划状态机
├── memory/store.ts       # 落盘状态机（真相源）
├── runtime/scheduler.ts  # 时间段调度
├── blueprint/            # 蓝图引导引擎（待实现）
├── executor/             # 执行器（待实现）
├── milestone/            # 里程碑判定（待实现）
└── index.ts              # 入口导出
```

## 快速开始

```bash
pnpm install
pnpm typecheck     # 类型检查
pnpm dev           # tsx 运行入口
```

## 状态

**第一版骨架已完成**：types + DeepSeek adapter + 状态机 + 落盘存储 + 调度器。
待实现：blueprint 引导引擎、executor、milestone 判定、runtime loop、interfaces。
