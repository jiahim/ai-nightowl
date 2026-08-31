/**
 * nightowl —— 夜猫子
 * 自驱动的夜间任务编排引擎。
 *
 * 当前为可运行的本地单蓝图 POC，并提供 CLI / HTTP / MCP / Web 控制入口。
 * V1 正在演进为耐久 Run、审批、Artifact 与插件化能力平台。
 */
export * from './types.js';
export { DeepSeekAdapter } from './providers/deepseek.js';
export { ZhipuAdapter } from './providers/zhipu.js';
export { MiniMaxAdapter, MiniMaxPlanAdapter } from './providers/minimax.js';
export { OpenAIAdapter } from './providers/openai.js';
export { OpenAICompatibleAdapter } from './providers/openai-compatible.js';
export type {
  OpenAICompatibleAdapterOptions,
  DiscoveredOpenAIModel,
} from './providers/openai-compatible.js';
export { FailoverAdapter, isRetryableProviderError } from './providers/failover.js';
export { LiveProviderAdapter } from './providers/live.js';
export type { LiveProviderRouting } from './providers/live.js';
export {
  defaultProviderPolicy,
  cloneProviderPolicy,
  validateProviderPolicy,
  evaluatePricing,
  estimateQuoteCost,
  usageLimitStatuses,
  estimateFitsLimits,
  usagePeriodKey,
  isWorkingDay,
} from './providers/policy.js';
export type {
  BillingDayType,
  UsageLimitPeriod,
  UsageLimitUnit,
  ProviderPriority,
  PriceRate,
  PricingWindow,
  PricingRule,
  UsageLimit,
  ProviderPolicy,
  PricingQuote,
  UsageEvent,
  UsageLimitStatus,
  ProviderCallEstimate,
  ProviderCandidate,
} from './providers/policy.js';
export {
  ProviderManagementService,
  inferProviderIntent,
  validateIntent,
  usageEventFromResult,
} from './providers/management.js';
export type {
  ProviderIntent,
  ProviderRecommendationCandidate,
  ProviderRecommendation,
  ProviderIntentInterpreter,
  ProviderManagementSnapshot,
  ProviderCallContext,
  ProviderReservationRequest,
} from './providers/management.js';
export type {
  ProviderAdapter,
  ChatResult,
  ProviderUsageWindow,
  ProviderRemoteUsage,
} from './providers/adapter.js';
export { ProviderRequestError } from './providers/adapter.js';
export { PlanState } from './plan/state.js';
export { Store } from './memory/store.js';
export { StoreReadError } from './memory/store.js';
export { STORE_SCHEMA_VERSION } from './memory/store.js';
export type { StoreState } from './memory/store.js';
export {
  ProviderSettingsStore,
  ProviderSettingsError,
  PROVIDER_SETTINGS_VERSION,
  MANAGED_PROVIDER_DEFINITIONS,
} from './config/provider-settings.js';
export type {
  BuiltInProviderId,
  PreferredProvider,
  ProviderCredentialSource,
  ProviderSettingsUpdate,
  ProviderSettingsSnapshot,
  CustomOpenAISettings,
  PreferredModelSelection,
} from './config/provider-settings.js';
export {
  ProviderPoliciesStore,
  ProviderPoliciesError,
  PROVIDER_POLICIES_VERSION,
} from './config/provider-policies.js';
export type {
  ProviderPoliciesUpdate,
  ProviderPoliciesSnapshot,
} from './config/provider-policies.js';
export {
  ProviderUsageLedger,
  ProviderUsageError,
  PROVIDER_USAGE_VERSION,
} from './config/provider-usage.js';
export { Summarizer } from './memory/summarizer.js';
export type {
  SummarizeFn,
  SummarizerOptions,
  SummarizeItem,
} from './memory/summarizer.js';
export { PrefixBuilder, fingerprint } from './memory/prefix.js';
export type {
  PrefixOptions,
  PrefixContext,
} from './memory/prefix.js';
export { Scheduler } from './runtime/scheduler.js';
export { NightOwlLoop, LoopBusyError } from './runtime/loop.js';
export type {
  LoopOptions,
  TickReport,
  RunOptions,
  VerificationResult,
  MilestoneVerifier,
  BlueprintVerifier,
} from './runtime/loop.js';
export { RunController, RuntimeBusyError } from './runtime/controller.js';
export type { RuntimePhase, RuntimeSnapshot } from './runtime/controller.js';
export { BlueprintGuide, assembleBlueprint } from './blueprint/guide.js';
export type {
  BlueprintDraft,
  MilestoneDraft,
  SubtaskDraft,
  GuideStage,
} from './blueprint/guide.js';
export { validateBlueprint, slugify } from './blueprint/validate.js';
export { Executor } from './executor/executor.js';
export type { ExecutorResult, ExecutorOptions } from './executor/executor.js';
export { MilestoneJudge } from './plan/milestone.js';
export type {
  SubtaskTally,
  AcceptanceVerdict,
  MilestoneEvaluation,
  AcceptanceVerifier,
} from './plan/milestone.js';
export { SubtaskJudge } from './judge/subtask.js';
export type {
  SubtaskJudgment,
  LlmJudgeFn,
  CheckFn,
  ManualFn,
  SubtaskJudgeOptions,
} from './judge/subtask.js';
export { CostTracker, computeCallCost } from './cost/tracker.js';
export type { CostEntry, CostSummary, CallCostInput, RecordInput } from './cost/tracker.js';
export { HttpApi, HttpError, buildStatus, PROJECT_VERSION } from './http/api.js';
export type {
  HttpRequest,
  HttpResponse,
  HttpApiOptions,
  StatusResponse,
} from './http/api.js';
export { createHttpServer, startServer, buildServeApi, resolveAdapter } from './http/server.js';
export type { ServeOptions } from './http/server.js';
export { McpRouter, SUPPORTED_PROTOCOL_VERSIONS } from './mcp/protocol.js';
export type {
  JsonRpcResponse,
  ServerInfo,
  ToolInputSchema,
  ToolResult,
  McpTool,
  McpRouterOptions,
} from './mcp/protocol.js';
export { buildMcpTools } from './mcp/tools.js';
export { McpStdioServer, buildServeMcp } from './mcp/server.js';
export type { McpServeOptions } from './mcp/server.js';
export {
  PluginRegistry,
  PLUGIN_API_VERSION,
  loadPluginModules,
  validatePluginManifest,
  collectPluginSpecifiers,
} from './plugins/registry.js';
export type {
  PluginCapability,
  PluginPermission,
  PluginContribution,
  NightOwlPluginManifest,
  NightOwlPlugin,
  PluginContext,
  PluginSnapshot,
} from './plugins/registry.js';
export { getWebAsset } from './web/console.js';
export type { WebAsset } from './web/console.js';
