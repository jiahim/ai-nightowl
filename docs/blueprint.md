# Blueprint V2：ai-nightowl 产品蓝图

> 更新日期：2026-08-30
> 本文是目标蓝图，不是完成清单。已交付范围以 README 和测试结果为准，详细需求与验收见 [PRD](./PRD.md)。

## 愿景

ai-nightowl 是一个 **local-first、耐久、成本感知的 Agent 工作流控制平台**：用户把长期目标表达为版本化蓝图，系统在合适的时间和预算内，把它推进为可恢复、可审批、可审计的运行，并交付真实产物。

nightowl 负责计划、调度、状态、成本、审批、恢复与观察；真正的模型调用、工作区操作、校验和通知通过可替换的能力适配器或插件完成。

## 产品承诺

1. **可信**：不会因为一次模型自评就虚假宣告完成；完成必须有证据并通过验收。
2. **耐久**：进程退出、网络波动或模型故障后可恢复，不重复执行已成功工作。
3. **可控**：用户随时知道系统在做什么、花了多少、为什么阻塞，并能暂停、重试、批准或取消。
4. **可扩展**：Provider、Executor、Verifier、Trigger 和 Notifier 有稳定插件边界。
5. **成本感知**：时段、缓存、模型路由、预算上限共同参与调度，而不是只记录事后账单。
6. **本地优先**：默认只监听本机，密钥不进入蓝图、日志、事件或 API 响应。

## 当前基线（V0.2）

已经存在：

- Blueprint → Milestone → Subtask 数据模型、DAG 校验和问答式引导；
- DeepSeek、智谱 Provider 与故障转移；
- Executor、SubtaskJudge、tick/run loop；
- JSON 状态、checkpoint、滚动摘要与稳定前缀模块；
- CLI、HTTP、MCP 三种入口；
- token 成本计算和真实模型 dogfood。

当前仍是 **单进程、单蓝图、LLM 文本执行 POC**。主要缺口：

- 蓝图定义与运行状态耦合，无法安全保留多次运行历史；
- Executor 默认只生成文本 evidence，不会真正修改工作区或产出受管 Artifact；
- Run/Attempt/Event/Approval/Artifact 尚未成为耐久数据模型；
- acceptance 与 definitionOfDone 已接入单运行链路，但验收记录尚未建模为耐久 Event/Attempt；摘要和稳定前缀仍未接入正式运行链；
- Web 控制端、后台生命周期控制和插件宿主尚不完整；
- 远程 Worker、多租户与团队权限尚未开始。

## 目标架构

```text
Interfaces
  Web Console · CLI · HTTP API · MCP · Embedded SDK
                         │
Control Plane            ▼
  BlueprintService · RunController · Scheduler · ApprovalService
                         │
Durable Domain           ▼
  Project → BlueprintVersion → Run → TaskRun → Attempt
                                  ├→ Event
                                  ├→ Approval
                                  ├→ Artifact
                                  └→ CostEntry
                         │
Capability Plane         ▼
  Provider · Executor · Verifier · Trigger · Notifier · Storage
                         │
Adapters / Plugins       ▼
  DeepSeek · Zhipu · MCP Agent · Workspace Tools · Webhook · SQLite
```

### 正交模式

“模式”不做成一个含义混乱的枚举，而拆为五个可组合维度：

| 维度 | 选项 |
|---|---|
| 部署/集成 | Local daemon、CLI one-shot、MCP host、Embedded SDK、Remote worker |
| 自主度 | Plan-only、Supervised、Autonomous |
| 触发 | Manual、Immediate、Scheduled/off-peak、CI/Webhook |
| 执行能力 | LLM-only、Local workspace tools、Host agent、Remote worker |
| 成本策略 | Economy、Balanced、Quality、Budget cap |

### 插件边界

- `provider`：模型调用、模型目录、价格与路由元数据；
- `executor`：真正执行子任务并产出 Artifact/Evidence；
- `verifier`：LLM、自动检查或人工审批；
- `trigger`：cron、Webhook、文件变化等触发源；
- `notifier`：IM、邮件、Webhook；
- `storage`：后期扩展，首个正式版本使用内建存储。

插件首版仅支持用户主动加载的 **可信本地插件**。在进程隔离与权限执行器落地前，不宣称插件是安全沙箱。

## 里程碑

### M1–M5 · POC 闭环（已完成）

地基、引擎模块、运行循环、记忆模块、CLI/HTTP/MCP、成本统计和真实模型文本链路已经实现。这里的“完成”只表示 POC 能力存在，不代表生产级产品完成。

### M6 · 可信单运行核心 + 本地控制面（进行中，P0/P1）

目标：把现有单蓝图 POC 变成不会重复执行、不会无限烧钱、可后台控制和可观察的本地单运行产品。

本轮交付：

- 修复 stale state、并发 tick 和 blocked 自动重跑；
- Store 原子写入并显式暴露损坏状态；
- 后台 RunController：start/stop/status，旧同步 API 保持兼容；
- blocked retry 与 manual approve 操作；
- milestone acceptance 与整体 definitionOfDone 的正式验收钩子；
- 单运行租约、严格 verdict 输入、人工批准门槛与旧状态重新验收迁移；
- HTTP body 限制、安全响应头和本地 Web Console；
- 真实断言、HTTP 集成与安装包三个 bin 冒烟测试；
- 插件 manifest/registry/loader 的可信本地预览。

M6 后续：

- BlueprintVersion 与 RunState 分离；
- Attempt/Event/Approval/Artifact/CostEntry 耐久化；
- 验收结果升级为可追溯、幂等的耐久记录；
- 摘要和稳定前缀进入生产执行链；
- 版本化 `/api/v1` 与 SSE 事件流；
- pause/resume/cancel 的完整持久语义。

验收：

- 同一子任务的并发 tick 只执行一次；
- 提交新蓝图后不会被旧内存状态覆盖；
- blocked 不会被自动重试；
- 后台运行可查询和停止；
- 状态文件损坏不会伪装成“没有蓝图”；
- 浏览器可以创建蓝图、推进、连续运行、停止、查看阻塞与插件；
- 自动测试失败时命令返回非零。

### M7 · 耐久 Run 与审批（P0/P1）

目标：建立真正可恢复的 `BlueprintVersion → Run → TaskRun → Attempt` 模型。

- 不可变蓝图版本和多 Run 历史；
- revision/CAS、单写者 lease、幂等命令；
- Event、Approval、Artifact、CostEntry 持久化；
- retry/backoff/maxAttempts、预算和 deadline；
- milestone acceptance 与整体 DoD 验证；
- SQLite Repository 与 JSON 迁移器；
- daemon 自动调度、优雅停机与崩溃恢复。

### M8 · Web Control 完整版（P1）

目标：让非开发者也能安全管理夜间任务。

- 首页、Projects、Blueprint、Runs、Inbox、Artifacts、Providers & Cost；
- DAG 预览、dry-run、成本预估；
- Timeline/SSE、Attempt 日志、Artifact 预览；
- 审批、暂停、恢复、取消、重试；
- 首次配置、诊断和恢复指引；
- loopback 默认安全，非本机监听要求认证。

### M9 · 插件运行时（P2）

目标：把扩展接口从代码约定升级为可安装、可诊断的插件体系。

- `nightowl.plugin.json`、API version、兼容性检查；
- Provider/Executor/Verifier 首批扩展点；
- 配置 schema、Secret 引用、权限声明；
- 启停、healthcheck、timeout、错误隔离；
- DeepSeek/智谱内建能力插件化；
- 一个能产生真实文件 Artifact 的示例 Executor 插件。

### M10 · 策略、远程 Worker 与生产加固（P3）

目标：支持多机执行和团队级可靠性。

- Controller/Worker、租约、心跳、断线恢复和 Artifact 传输；
- Plan-only/Supervised/Autonomous 策略组合；
- TLS、认证、RBAC、审计、配额；
- 指标、追踪、备份恢复和升级迁移；
- Node LTS CI、发布签名与兼容性矩阵。

## 总体验收（Definition of Done）

ai-nightowl 只有在以下条件同时满足时才算兑现蓝图：

- 用户可从 Web、CLI 或标准协议创建版本化蓝图和 Run；
- daemon 能按时段/预算策略自治推进，并在重启后准确恢复；
- 每个完成结论都能追溯到 Attempt、Evidence、Verifier 和 Artifact；
- 高风险操作与 manual verdict 可进入审批，而不是被模型代替决定；
- 插件有版本、权限、健康状态和故障边界；
- 本地默认安全，远程部署有认证、授权和审计；
- 端到端测试证明真实产物被创建、验证并交付，而不只是模型文本自评。
