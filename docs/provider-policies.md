# Provider 资费、额度与智能匹配

ai-nightowl 不再假设所有 Provider 都有“高峰/低谷”。每个平台先形成一份统一资费画像，再用同一个确定性决策器比较当前价格、工作日历和周期额度。

## 数据来源与可信边界

资费画像按以下优先级产生：

1. **用户确认的覆盖规则**：Web Console 或 `PUT /settings/providers` 保存，立即生效；
2. **Provider 自报目录**：从 `ProviderAdapter.config.models` 和 `costStrategy` 自动生成；
3. 没有时段规则时按固定目录价处理，不会虚构低谷窗口。

“自查询”首先指已安装 Provider/插件读取声明式目录，不会抓取价格网页。网页价格经常变化、页面结构也不稳定；正式对账应接 Provider 官方 API。当前 MiniMax Plan 已接官方 `token_plan/remains`，读取 5 小时与每周剩余百分比并缓存 60 秒；其他 Provider 没有稳定官方套餐接口时继续使用目录和人工覆盖。人工覆盖文件与用量账本分别保存在数据目录的 `.provider-policies.json` 和 `.provider-usage.json`，均不包含 prompt、响应正文或密钥。

AI 只把“复杂任务、8 万 tokens、可等 6 小时、优先省钱”这类自然语言归一化为任务类型、优先级、预计 tokens、可等待时间和预算。候选价格、额度是否足够、排序与最终路由都由确定性规则重新计算，AI 不能提交未知价格。用户选择候选后才会应用。

## 画像结构

下面示例同时表达工作日/非工作日价格、夜间价格、法定假日/调休，以及滚动/周/月额度：

```json
{
  "timezone": "Asia/Shanghai",
  "weekendDays": [0, 6],
  "nonWorkingDates": ["2026-10-01", "2026-10-02"],
  "workingDates": ["2026-10-10"],
  "defaultRate": { "multiplier": 1 },
  "pricingRules": [
    {
      "id": "weekday",
      "label": "工作日价",
      "dayType": "working-day",
      "rate": { "inputPrice": 3, "outputPrice": 9 },
      "priority": 10
    },
    {
      "id": "non-working",
      "label": "非工作日价",
      "dayType": "non-working-day",
      "rate": { "inputPrice": 2, "outputPrice": 6 },
      "priority": 10
    },
    {
      "id": "night",
      "label": "夜间优惠",
      "windows": [{ "start": "00:00", "end": "06:00" }],
      "rate": { "multiplier": 0.5 },
      "priority": 20
    }
  ],
  "usageLimits": [
    { "id": "rolling-requests", "label": "5 小时请求额度", "period": "rolling", "windowMinutes": 300, "unit": "requests", "limit": 1500, "warningAt": 0.8 },
    { "id": "weekly-tokens", "label": "周 tokens", "period": "week", "unit": "tokens", "limit": 1000000, "warningAt": 0.8 },
    { "id": "monthly-cost", "label": "月预算", "period": "month", "unit": "cost", "limit": 100 }
  ]
}
```

- `dayType` 可为 `any`、`working-day` 或 `non-working-day`；`daysOfWeek` 可进一步指定 0（周日）到 6（周六）。
- `windows` 支持多个窗口与跨午夜。
- `rate` 可使用绝对输入/输出/缓存价格，也可用 `multiplier`；两者同时存在时先取绝对价，再应用倍率。
- 多条规则命中时，`priority` 更大者生效；相同 priority 后声明者优先。
- 额度单位支持 `requests`、`tokens`、`cost`，周期支持 `rolling`、`day`、`week`、`month`；`rolling` 必须给出 `windowMinutes`，周从画像时区的周一开始。
- 预计调用会越过任何额度上限时，该 Provider 不进入自动路由；达到 `warningAt` 后仍可使用，但候选会显示预警。

## HTTP 流程

- `GET /settings/providers`：返回 Provider 目录、画像来源、当前有效价格与额度使用情况；
- `PUT /settings/providers`：保存 `preferredProvider`、`priority`、`profiles` 或 `clearProfiles`；
- `POST /settings/providers/recommend`：请求体 `{ "request": "..." }`，返回意图识别、候选、预计费用、等待后的更低价和限制原因；
- `POST /settings/providers/apply`：请求体 `{ "recommendationId": "rec-...", "optionId": "provider:model" }`；服务会按最新凭据、价格与额度重新核验后，持久化平台和模型选择。

Web Console 的“模型设置”封装了同一流程：常见套餐可直接填写工作日倍率、非工作日倍率、优惠时段和一个周期额度；复杂套餐可编辑完整 JSON。

## 内建 Provider 类型

- `minimax`：普通开放平台 Key，按 token 计费；目录价来自 MiniMax 中国区按量价格。
- `minimax-plan`：Plan/Token Plan 专属 Key，订阅内下一次调用按边际成本 0 参与比较，同时以官方 5 小时/每周剩余额度决定是否可选；与普通 Key 分开存储。
- `openai`：官方 `https://api.openai.com/v1`，使用 Chat Completions 与 Models 兼容协议；美元价先换算为人民币再与国内 Provider 比较。
- `openai-compatible`：用户配置的 OpenAI 格式接口。启用前必须确认 Base URL、模型 ID、模型类型、价格和上下文窗口；可显式允许无密钥的本地服务。

MiniMax 的普通 Key 与 Token Plan Key 不可互换，详见 [MiniMax API 指引](https://platform.minimaxi.com/docs/api-reference/api-overview)；Plan 额度查询端点见 [MiniMax Token Plan FAQ](https://platform.minimaxi.com/docs/token-plan/faq)。OpenAI 的目录发现与调用分别遵循 [Models API](https://developers.openai.com/api/reference/resources/models) 和 [Chat Completions API](https://developers.openai.com/api/reference/cli/resources/chat/subresources/completions)。
