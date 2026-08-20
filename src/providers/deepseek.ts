import type { Message, ModelSpec, ProviderConfig, TaskKind } from '../types.js';
import type { ChatResult, ProviderAdapter } from './adapter.js';
import { inWindow, minutesInBeijing } from '../time.js';

/**
 * DeepSeek 适配器。
 *
 * 时段定价（官方）：空闲时段 = 高峰半价（5 折）；
 * 高峰 = 北京时间 9:00-12:00、14:00-18:00，其余全空闲。
 * 价格（人民币 / 百万 tokens）为可配置默认值，随官方调价可覆盖。
 */

const DEFAULT_MODELS: ModelSpec[] = [
  {
    name: 'deepseek-chat',
    kind: 'chat',
    inputPrice: 0.5,
    outputPrice: 8,
    cacheHitPrice: 0.5,
    contextWindow: 128000,
  },
  {
    name: 'deepseek-reasoner',
    kind: 'reasoner',
    inputPrice: 1,
    outputPrice: 16,
    cacheHitPrice: 1,
    contextWindow: 128000,
  },
];

export class DeepSeekAdapter implements ProviderAdapter {
  readonly id = 'deepseek';
  readonly config: ProviderConfig;

  constructor(config?: Partial<ProviderConfig>) {
    this.config = {
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      models: DEFAULT_MODELS,
      costStrategy: {
        peakWindows: [
          { start: '09:00', end: '12:00' },
          { start: '14:00', end: '18:00' },
        ],
        offPeakDiscount: 0.5,
        preferCache: true,
      },
      ...config,
    };
  }

  isOffPeak(now: Date): boolean {
    const peaks = this.config.costStrategy.peakWindows;
    if (!peaks || peaks.length === 0) return false;
    // 关键：用北京时间，不能用 getHours()（服务器可能是 UTC）
    const nowMin = minutesInBeijing(now);
    // 空闲 = 不在任何高峰时段内
    return !peaks.some((w) => inWindow(nowMin, w.start, w.end));
  }

  currentDiscount(now: Date): number {
    const d = this.config.costStrategy.offPeakDiscount;
    if (d === undefined) return 1;
    return this.isOffPeak(now) ? d : 1;
  }

  routeModel(_kind: TaskKind): ModelSpec {
    // 第一版：统一走 deepseek-chat（便宜）；reasoner 留给后续显式指定深度推理的场景
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
      throw new Error(`DeepSeek API error ${res.status}: ${body}`);
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
