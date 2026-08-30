# ai-nightowl V1 PRD

> 状态：Living document
>
> 版本：2026-08-30
> 对应蓝图：[Blueprint V2](./blueprint.md)

## 1. 产品摘要

ai-nightowl 面向“任务太长、白天太贵、过程不可见”的 Agent 工作。它把目标编译成结构化蓝图，在本地常驻服务中创建可恢复 Run，并在低价时段或指定策略下执行。用户通过 Web、CLI、HTTP 或 MCP 观察进度、处理审批和获取产物。

一句话定位：**让长期 Agent 工作像可靠的后台作业，而不是一段不能恢复的聊天。**

## 2. 用户与核心任务

### 独立开发者

- 睡前提交需要数小时的代码、研究或内容任务；
- 设置预算、时间窗和自主度；
- 早上查看真实产物、失败原因和节省成本；
- 对高风险动作做批准或拒绝。

### Agent 平台集成者

- 通过 MCP/HTTP 创建、查询和控制 Run；
- 订阅事件而不是阻塞等待长请求；
- 获取结构化 Artifact、Evidence 和 Cost；
- 使用幂等请求安全重试。

### 插件作者

- 注册 Provider、Executor 或 Verifier；
- 声明兼容版本、配置、权限和 Secret；
- 在本地诊断插件健康与错误；
- 不依赖 nightowl 内部实现细节。

## 3. 范围与边界

V1 范围：

- local-first 单用户 daemon；
- 版本化 Blueprint 与多 Run 历史；
- 单机可靠执行、审批、重试、预算、事件和 Artifact；
- Web Control、CLI、HTTP v1、MCP；
- 可信本地 Provider/Executor/Verifier 插件。

非目标：

- 不在 V1 自建通用 Coding Agent，优先委托宿主 Agent 或 Executor 插件；
- 不在 V1 做插件市场、未知代码沙箱或多租户 SaaS；
- 不保证任意 LLM 输出正确，保证过程可验证、可追溯、可干预；
- Remote worker、RBAC 和团队协作属于后续阶段。

## 4. 产品模式

| 模式 | 使用场景 | V1 要求 |
|---|---|---|
| Local daemon | 后台调度与恢复 | 必须 |
| Web Control | 创建、观察、审批和诊断 | 必须 |
| CLI one-shot | CI、脚本、快速本地使用 | 必须 |
| MCP host | QwenPaw/Codex 等宿主集成 | 必须 |
| Embedded SDK | TypeScript 应用内嵌 | 稳定核心 API |
| Plan-only / dry-run | 校验 DAG、估价，不执行 | 必须 |
| Supervised | 高风险或 manual 步骤等待批准 | 必须 |
| Autonomous | 策略允许范围内自动执行 | 必须 |
| Remote worker | 控制与执行节点分离 | V1 之后 |

## 5. 核心用户流程

### 首次使用

1. 用户启动本地 daemon，浏览器打开 Console。
2. Console 检查 Provider、数据目录、时区和监听安全状态。
3. 用户只保存 Secret 引用，API 不回传密钥值。
4. 系统提供健康检查和最小测试调用。

### 创建与运行

1. 用户输入目标，或导入 Blueprint JSON。
2. 系统生成/校验里程碑、子任务、依赖和验收标准。
3. 用户先做 dry-run，查看 DAG、预计模型、成本与权限。
4. 发布不可变 BlueprintVersion，创建 Run。
5. 选择立即、低谷时段、cron、deadline 或预算策略。
6. daemon 创建 TaskRun/Attempt，持续追加 Event 和 CostEntry。
7. 完成后交付 Artifact 与可复现报告。

### 阻塞与审批

1. manual verdict 或高风险能力创建 ApprovalRequest。
2. Web Inbox、CLI 与 MCP 都能看到同一审批。
3. approve/reject 带操作者、时间和理由，且幂等。
4. 可恢复错误按策略重试；不可恢复错误进入 blocked/failed，不无限重跑。

## 6. 功能需求

### Blueprint

- **BP-01** Blueprint 定义与运行状态分离。
- **BP-02** 发布后生成不可变版本；修改产生新版本。
- **BP-03** 校验全局 ID、DAG、空里程碑、依赖、verdict 与 acceptance。
- **BP-04** 支持 plan-only 生成候选蓝图，用户确认后发布。
- **BP-05** raw 输入不得注入伪造的运行状态和 evidence。

### Run 生命周期

- **RUN-01** 状态：`queued/scheduled/running/waiting_approval/paused/succeeded/failed/cancelled`。
- **RUN-02** 支持 start、pause、resume、cancel、retry；重复命令幂等。
- **RUN-03** 同一 TaskRun 同时只能有一个有效 Attempt lease。
- **RUN-04** 每次 Attempt 记录能力、模型、输入摘要、结果、错误、时间和成本。
- **RUN-05** blocked 不自动重跑；retry 有 maxAttempts、backoff 和预算硬上限。
- **RUN-06** 重启后恢复中断 Attempt，不重复已成功 Attempt。
- **RUN-07** milestone acceptance 和整体 DoD 通过后才可 succeeded。

### Event、Artifact 与 Cost

- **OBS-01** 所有状态变化追加不可变 Event，支持 cursor 续读。
- **OBS-02** Web/API 通过 SSE 获取事件；断线续传不丢、不重复迁移。
- **OBS-03** Artifact 有类型、路径/URI、摘要、校验和、创建者 Attempt。
- **OBS-04** CostEntry 按实际 Provider/模型/折扣持久化，重启不清零。
- **OBS-05** 首页展示今晚计划、运行中、待审批、失败和预算使用。

### Web Control

- **WEB-01** 首页：当前运行、整体进度、成本、阻塞和下一计划。
- **WEB-02** Blueprint：编辑、校验、DAG、dry-run、版本。
- **WEB-03** Run：Summary、Timeline、Tasks/Attempts、Evidence/Artifacts、Cost。
- **WEB-04** Inbox：批准、拒绝、重试、补充输入。
- **WEB-05** Plugins：状态、版本、能力、权限、配置与 health。
- **WEB-06** 默认只允许 loopback；远程访问必须显式认证。
- **WEB-07** 页面刷新和 daemon 重启后显示一致的耐久状态。

### 插件

- **PLG-01** manifest 包含 `id/version/apiVersion/capabilities/permissions`。
- **PLG-02** 不兼容 API version、重复 ID 或非法 manifest 必须拒绝并给出原因。
- **PLG-03** 插件启用前展示权限与 Secret 请求。
- **PLG-04** 插件可启停、healthcheck、timeout；单插件失败不退出 daemon。
- **PLG-05** V1 首批运行扩展点为 Provider、Executor、Verifier。
- **PLG-06** 只有用户显式加载的可信本地插件可进程内运行；UI 不接受任意代码 URL。

### 接口

- **API-01** `/api/v1` 使用 projects、blueprints、runs、events、approvals、artifacts、plugins 资源模型。
- **API-02** 写命令支持 idempotency key；错误使用稳定 code，不泄露上游敏感响应。
- **API-03** body、并发、速率和运行时长有硬限制。
- **API-04** MCP 使用异步 Run 语义，长任务不阻塞同一 stdio 的 status/cancel。
- **CLI-01** `plan/run/status/pause/resume/cancel/retry/approve/serve` 有稳定退出码和 JSON 输出。

## 7. 非功能需求

### 可靠性

- 状态写入原子；损坏数据显式报错并提供备份恢复，不当成空状态；
- 命令单写者或 revision/CAS；
- daemon 优雅停机，运行中 Attempt 记录为可恢复中断；
- 所有时间使用 ISO 8601，调度显式时区。

### 安全与隐私

- 默认绑定 `127.0.0.1`；非 loopback 必须认证和明确告警；
- Secret 只通过引用注入，不落蓝图、事件、日志或 API；
- 工作区、进程、网络权限最小化；危险操作进入审批；
- 请求体限制、超时、CSP、安全响应头、日志脱敏。

### 兼容与发布

- Node.js LTS 矩阵；
- Store schema 与插件 API 有版本和迁移；
- CI 执行 frozen install、typecheck、真断言测试、build、pack 和三个 bin smoke；
- HTTP/MCP/包版本从同一来源生成。

## 8. 数据模型

```text
Project
└── Blueprint
    └── BlueprintVersion (immutable spec)
        └── Run
            ├── TaskRun
            │   └── Attempt
            ├── Event (append-only)
            ├── ApprovalRequest
            ├── Artifact
            └── CostEntry
```

定义对象不含 `status/evidence`；这些只属于 Run。事件用于审计和增量订阅，Repository 快照用于快速读取，两者 revision 必须一致。

## 9. 成功指标

- 任务重复执行率为 0；
- 崩溃恢复后已成功 Attempt 重跑率为 0；
- 所有 succeeded Run 都有验收记录；
- manual 任务误自动完成率为 0；
- 预算超限后新增模型调用为 0；
- Web 控制操作反馈 P95 < 500ms（不含模型执行）；
- 运行事件和成本恢复率 100%；
- 首次安装到创建首个 dry-run < 10 分钟。

## 10. 交付阶段

- **Phase A：可信单运行（当前）**——状态一致性、串行 tick、blocked 语义、Store 原子性、后台控制器、基础 Web、插件注册预览和真断言测试。
- **Phase B：耐久 Run**——BlueprintVersion/Run/Attempt/Event/Approval/Artifact/Cost、SQLite、验收记录持久化、摘要接入和 `/api/v1`。
- **Phase C：完整控制面**——daemon 调度、SSE、完整 Web IA、CLI 生命周期、认证和诊断。
- **Phase D：插件运行时**——权限/Secret、health、错误隔离、内建 Provider 插件化、真实 Artifact Executor。
- **Phase E：远程与团队**——Worker lease/heartbeat、TLS、RBAC、审计、配额和多租户。

## 11. 当前 Phase A 验收

- [x] 新蓝图不会被旧 loop 状态覆盖；
- [x] 并发 tick 不会重复执行同一子任务；
- [x] blocked 不会自动重跑，可显式 retry；
- [x] manual 子任务可显式 approve；
- [x] Store 原子写入，损坏状态显式失败；
- [x] 旧 Store 完成态迁移后重新走 acceptance/DoD，不沿用未经验证的成功；
- [x] `/runtime/start` 非阻塞，`/runtime/stop` 可停止后续 tick；
- [x] 连续运行持有单一租约，冲突的 tick/run/replace 返回 409；
- [x] raw verdict 拼写错误会被拒绝，manual 只能批准已有执行证据的 blocked 任务；
- [x] Web 可完成创建、推进、连续运行、停止、查看状态与插件；
- [x] Web 显示整体 DoD 失败详情，并可重新验收；
- [x] 可信本地 Provider 插件可加载并出现在插件目录；
- [x] `pnpm test` 使用真断言且覆盖上述回归；打包后 exports、文档和三个 bin 可用。
