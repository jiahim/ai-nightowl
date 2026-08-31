# ai-nightowl 夜猫子

本地优先、成本感知的 Agent 任务编排服务。把长期目标拆成 `Blueprint → Milestone → Subtask`，在后台可靠推进，并通过 Web、CLI、HTTP 或 MCP 查看进度、处理阻塞和核对成本。

> 当前 `v0.2` 是 **可信单运行预览版**：单进程、单蓝图，默认 Executor 产出 LLM 文本 evidence。多 Run 历史、Artifact、完整审批和插件隔离仍在蓝图中，不把 POC 描述成生产完成品。

## 已有能力

- Blueprint 引导、草稿组装、DAG 与 verdict 校验；
- DeepSeek、智谱、MiniMax 普通/Plan、OpenAI 与自定义 OpenAI 兼容 Provider；
- Provider 自报/用户覆盖的工作日、非工作日、峰谷资费画像，以及滚动、日、周、月额度；
- AI 自然语言识别任务需求，确定性核算价格与额度后给出可确认的路由建议；
- 单运行租约、串行 tick、后台 start/stop、崩溃遗留恢复、显式 retry；
- LLM / check / manual 子任务判定，里程碑 acceptance 与整体 DoD 验收钩子；
- 原子 JSON 状态、checkpoint、滚动摘要与稳定前缀模块；
- 本地 Web Console、CLI、HTTP API、MCP stdio；
- 可信本地插件 manifest/registry/loader 预览，首个运行扩展点为 Provider；
- 真断言单元测试与 HTTP 集成测试。

## 快速开始

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm serve -- --dir ./.ai-nightowl
```

然后打开 [http://127.0.0.1:8787](http://127.0.0.1:8787)。Console 可以导入蓝图、推进一步、后台连续运行、停止、查看 evidence、重试 blocked 任务、人工批准 manual 任务，并在“模型设置”中配置 Provider、资费与额度。密钥仅保存在本地数据目录且文件权限为 `0600`，网页不会回显；MiniMax 普通 Key 与 Plan Key 分开保存，自定义 OpenAI 兼容接口还可显式启用无密钥的本地服务。

真正执行 LLM 任务前配置至少一个密钥：

```bash
export DEEPSEEK_API_KEY="..."
# 或
export ZHIPU_API_KEY="..."
# 或（MiniMax 普通与 Plan 二选一或分别配置）
export MINIMAX_API_KEY="..."
export MINIMAX_PLAN_API_KEY="..."
# 或
export OPENAI_API_KEY="..."
```

可用 `NIGHTOWL_PROVIDER=deepseek|zhipu|minimax|minimax-plan|openai|openai-compatible|<插件 Provider id>` 显式选择首选平台。MiniMax 普通模式读取 `MINIMAX_API_KEY`，Plan 模式读取独立的 `MINIMAX_PLAN_API_KEY`；OpenAI 官方接口读取 `OPENAI_API_KEY`。服务默认只允许 loopback 监听；当前预览版不允许直接用 `0.0.0.0` 暴露无认证控制端。

## 入口与模式

| 入口 | 用途 | 命令 |
|---|---|---|
| Web + HTTP | 本地控制台与 API | `ai-nightowl-serve` |
| CLI | 交互创建蓝图、查看状态 | `ai-nightowl init` / `ai-nightowl status` |
| MCP stdio | 宿主 Agent 集成 | `ai-nightowl-mcp` |
| Embedded SDK | TypeScript 代码内嵌 | `import { NightOwlLoop } from 'ai-nightowl'` |

产品模式按多个维度组合，而不是一个混乱的 mode：部署方式、自治级别、触发策略、执行能力和成本策略。Plan-only、完整 daemon、远程 Worker 等进度见 [产品蓝图](docs/blueprint.md)。

## HTTP API（兼容层）

当前单运行 API：

- `GET /health`、`GET /status`、`GET /cost`；
- `GET /runtime`、`POST /runtime/start`、`POST /runtime/stop`；
- `POST /blueprint`、`POST /blueprint/raw`；
- `POST /tick`、`POST /run`（同步兼容接口）；
- `GET /subtasks/:id`、`POST /subtasks/:id/retry|approve`；
- `POST /milestones/:id/retry`、`POST /completion/retry`；
- `GET|PUT /settings/providers`、`POST /settings/providers/recommend|apply`；
- `GET /plugins`、`GET /capabilities`。

请求体上限为 1 MiB，后台运行每次最多 1000 tick。后续 `/api/v1` 会切换到耐久 `BlueprintVersion → Run → TaskRun → Attempt` 资源模型；以上路径会作为兼容包装保留一段时间。

## MCP 工具

MCP 复用同一控制语义，提供状态/成本/插件查询、蓝图提交、tick、非阻塞 run/start、stop、retry 和 manual approve。stdout 只输出 JSON-RPC，运行日志走 stderr。

## 可信本地插件预览

启动时可重复传入 `--plugin`，或使用逗号分隔的 `NIGHTOWL_PLUGINS`：

```bash
pnpm serve -- --plugin ./dist/my-provider-plugin.js
pnpm mcp -- --plugin @acme/nightowl-provider
```

模块默认导出 `{ manifest, activate(context) }`，`apiVersion` 当前为 `1`。Phase A 只开放 `context.registerProvider(adapter)`；Executor、Verifier、权限执行和健康隔离会按 PRD 继续实现。

插件代码与主服务在同一进程运行，权限声明目前用于展示和审计，**不是安全沙箱**。只加载你信任且主动指定的本地模块，不支持从 HTTP URL 动态加载。接口细节见 [插件开发预览](docs/plugin-development.md)。

## 可靠性语义

- 每次 tick 从磁盘重新加载真相源，所有状态命令在进程内串行；
- 同步兼容 run、后台 run 与 tick 互斥；stop 可收束同一控制器中的连续运行；
- `pending` 才可运行，`blocked` 必须显式 retry；
- `in-progress` 在进程重启后的下一 tick 恢复为 pending；
- 子任务完成后还要通过 milestone acceptance 与 definitionOfDone；
- 状态先写同目录临时文件再原子 rename，损坏状态会显式报错；旧 schema 会退回重新验收；
- 故障转移的成本按实际 Provider、模型与折扣记录；路由前会重新计算当前日历价格与周期额度，并将用量写入耐久账本。

这些保证当前限于单进程。跨进程 lease、revision/CAS、事件日志和 SQLite Repository 属于下一阶段。

## 开发与验证

```bash
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:package
pnpm build
pnpm check
```

核心回归覆盖 stale state、运行租约、blocked 隐式重跑、验收异常重复执行、acceptance/DoD 假完成、Store 迁移/损坏、后台控制、manual approve、插件校验、故障转移计费和安装包三个 bin。

## 架构

```text
interfaces     Web / CLI / HTTP / MCP / Embedded SDK
control        RunController / NightOwlLoop / Scheduler
domain         Blueprint / PlanState / Judge / Cost
capabilities   Provider / Executor / Verifier（插件边界持续扩展）
adapters       DeepSeek / Zhipu / MiniMax / OpenAI / JSON Store / trusted-local plugins
```

目标数据模型、Web 信息架构、插件边界、优先级和验收标准见：

- [Blueprint V2](docs/blueprint.md)
- [V1 PRD](docs/PRD.md)
- [插件开发预览](docs/plugin-development.md)
- [Provider 资费、额度与智能匹配](docs/provider-policies.md)

## 已知边界

- Store 仍只有一个 `state.json`，提交新蓝图会替换当前运行，没有历史 Run；
- 默认 Executor 只生成文本 evidence，不会直接修改工作区；
- CostTracker 仍为进程内累计，尚未并入耐久 CostEntry；Provider 周期额度另有本地耐久用量账本；
- check verifier 需要宿主注入安全实现，服务不会执行 raw blueprint 中的任意 shell；
- 插件尚无进程隔离、启停、healthcheck、Secret manager；
- 完整 pause/resume、SSE、Artifact、认证远程控制与 Worker 尚未交付。

License: MIT
