import type { Message, ModelSpec, ProviderConfig, TaskKind } from '../types.js';
import type { ChatResult, ProviderAdapter } from './adapter.js';

/**
 * 智谱（BigModel / Zhipu）适配器。
 *
 * 与 DeepSeekAdapter 同构：智谱 API 是 OpenAI 兼容格式
 * （POST https://open.bigmodel.cn/api/paas/v4/chat/completions，Bearer 鉴权）。
 *
 * 成本策略（2026-08 官方定价，bigmodel.cn/pricing，单位：元/百万 tokens）：
 *   - 无时段折扣（无 peakWindows，isOffPeak 恒 false）
 *   - 省钱靠 Context Caching：缓存命中价约为输入价 20%（0.4 vs 2）
 *     → preferCache: true，与 Kimi/MiniMax 同模式
 *   - GLM-5.x 系列按输入长度分级定价（[0,32k) 低价档 / [32k+) 高价档），
 *     这里取低价档作为默认（dogfood 任务输入远小于 32k），随官方调价可覆盖。
 */

const DEFAULT_MODELS: ModelSpec[] = [
  {
    name: 'glm-5.3',
    kind: 'chat',
    // 输入 8 元/百万；输出 28 元/百万；缓存命中 2 元/百万；1M 上下文
    inputPrice: 8,
    outputPrice: 28,
    cacheHitPrice: 2,
    contextWindow: 1000000,
  },
];

export class ZhipuAdapter implements ProviderAdapter {
  readonly id = 'zhipu';
  readonly config: ProviderConfig;

  constructor(config?: Partial<ProviderConfig>) {
    this.config = {
      id: 'zhipu',
      name: '智谱 GLM',
      // GLM Coding Plan 独立端点（订阅额度走这里，不走按量付费）
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      apiKeyEnv: 'ZHIPU_API_KEY',
      models: DEFAULT_MODELS,
      costStrategy: {
        // 无时段折扣：不配 peakWindows，isOffPeak 恒 false
        preferCache: true,
      },
      ...config,
    };
  }

  isOffPeak(_now: Date): boolean {
    return false;
  }

  currentDiscount(_now: Date): number {
    return 1;
  }

  routeModel(_kind: TaskKind): ModelSpec {
    // 第一版：统一走 glm-4.7（便宜）；reasoner 留给后续显式指定深度推理的场景
    return this.config.models.find((m) => m.kind === 'chat') ?? this.config.models[0];
  }

  async chat(
    model: string,
    messages: Message[],
    opts?: { maxTokens?: number },
  ): Promise<ChatResult> {
    const apiKey = process.env[this.config.apiKeyEnv];
    if (!apiKey) {
      throw new Error(`Missing API key: env ${this.config.apiKeyEnv} not set`);
    }

    const res = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: opts?.maxTokens ?? 4096,
        stream: false,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Zhipu API error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    return {
      content: data.choices?.[0]?.message?.content ?? '',
      model,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens ?? 0,
            completionTokens: data.usage.completion_tokens ?? 0,
          }
        : undefined,
    };
  }
}
