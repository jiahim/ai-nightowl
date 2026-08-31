import type { Message, ModelSpec, ProviderConfig, TaskKind } from '../types.js';
import { inWindow, zonedDateParts } from '../time.js';
import { ProviderRequestError, type ChatResult, type ProviderAdapter } from './adapter.js';

export interface OpenAICompatibleAdapterOptions {
  /** 自定义接口可显式允许无密钥（例如仅监听本机的推理服务）。 */
  allowMissingApiKey?: boolean | (() => boolean);
  /** 测试或嵌入宿主可注入 fetch。 */
  fetch?: typeof fetch;
  /** 新版 OpenAI 模型推荐 max_completion_tokens；兼容接口通常仍使用 max_tokens。 */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  /** 不经过环境变量时可直接提供动态密钥解析器。 */
  apiKey?: () => string | undefined;
}

export interface DiscoveredOpenAIModel {
  id: string;
  ownedBy?: string;
}

type ConfigSource = ProviderConfig | (() => ProviderConfig);

/**
 * 标准 OpenAI Chat Completions 兼容适配器。
 *
 * config 可以是 getter，因此 Web Console 修改自定义 Base URL/模型后无需重启。
 * 密钥只在服务端解析，不会进入错误文本或返回对象。
 */
export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly id: string;
  private readonly configSource: ConfigSource;
  protected readonly fetchImpl: typeof fetch;

  constructor(config: ConfigSource, private readonly options: OpenAICompatibleAdapterOptions = {}) {
    this.configSource = config;
    const initial = this.resolveConfig();
    if (!initial.id) throw new Error('OpenAICompatibleAdapter: config.id 不能为空');
    this.id = initial.id;
    this.fetchImpl = options.fetch ?? fetch;
  }

  get config(): ProviderConfig {
    const config = this.resolveConfig();
    if (config.id !== this.id) throw new Error(`Provider ${this.id} 的动态 config.id 不可变更`);
    return config;
  }

  isOffPeak(now: Date): boolean {
    const strategy = this.config.costStrategy;
    const peaks = strategy.peakWindows ?? [];
    if (peaks.length === 0) return false;
    const parts = zonedDateParts(now, strategy.timezone ?? 'Asia/Shanghai');
    const minute = parts.hour * 60 + parts.minute;
    return !peaks.some((window) => inWindow(minute, window.start, window.end));
  }

  currentDiscount(now: Date): number {
    const discount = this.config.costStrategy.offPeakDiscount;
    return discount !== undefined && this.isOffPeak(now) ? discount : 1;
  }

  routeModel(kind: TaskKind): ModelSpec {
    const models = this.config.models;
    if (kind === 'plan' || kind === 'judge') {
      return models.find((model) => model.kind === 'reasoner') ?? models[0];
    }
    return models.find((model) => model.kind === 'chat') ?? models[0];
  }

  async chat(
    model: string,
    messages: Message[],
    opts?: { maxTokens?: number; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ChatResult> {
    const config = this.config;
    const apiKey = this.resolveApiKey();
    const allowMissing = typeof this.options.allowMissingApiKey === 'function'
      ? this.options.allowMissingApiKey()
      : this.options.allowMissingApiKey ?? false;
    if (!apiKey && !allowMissing) {
      throw new Error(`Missing API key: env ${config.apiKeyEnv} not set`);
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const maxTokensField = this.options.maxTokensField ?? 'max_tokens';
    const response = await this.fetchImpl(endpoint(config.baseUrl, 'chat/completions'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        [maxTokensField]: opts?.maxTokens ?? 4096,
        stream: false,
      }),
      signal: opts?.signal ?? AbortSignal.timeout(opts?.timeoutMs ?? 120_000),
    });

    if (!response.ok) {
      const body = (await response.text()).slice(0, 4096);
      const retryable = [408, 425, 429].includes(response.status) || response.status >= 500 ||
        /余额不足|insufficient|quota|rate.?limit|无可用资源包/i.test(body);
      throw new ProviderRequestError(this.id, response.status, retryable);
    }

    const data = (await response.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        input_tokens?: number;
        output_tokens?: number;
      };
    };
    const pricedAt = new Date();
    return {
      content: messageText(data.choices?.[0]?.message?.content),
      model: data.model ?? model,
      providerId: this.id,
      pricing: {
        offPeak: this.isOffPeak(pricedAt),
        discount: this.currentDiscount(pricedAt),
      },
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens ?? data.usage.input_tokens ?? 0,
        completionTokens: data.usage.completion_tokens ?? data.usage.output_tokens ?? 0,
      } : undefined,
    };
  }

  /** 按 OpenAI Models API 读取当前凭据可见的模型目录。 */
  async discoverModels(options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<DiscoveredOpenAIModel[]> {
    const config = this.config;
    const apiKey = this.resolveApiKey();
    const allowMissing = typeof this.options.allowMissingApiKey === 'function'
      ? this.options.allowMissingApiKey()
      : this.options.allowMissingApiKey ?? false;
    if (!apiKey && !allowMissing) throw new Error(`Missing API key: env ${config.apiKeyEnv} not set`);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await this.fetchImpl(endpoint(config.baseUrl, 'models'), {
      method: 'GET',
      headers,
      signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });
    if (!response.ok) throw new ProviderRequestError(this.id, response.status, response.status === 429 || response.status >= 500);
    const payload = (await response.json()) as { data?: Array<{ id?: unknown; owned_by?: unknown }> };
    return (payload.data ?? []).flatMap((item) => typeof item.id === 'string' && item.id.trim()
      ? [{ id: item.id.trim(), ownedBy: typeof item.owned_by === 'string' ? item.owned_by : undefined }]
      : []);
  }

  private resolveConfig(): ProviderConfig {
    return typeof this.configSource === 'function' ? this.configSource() : this.configSource;
  }

  protected resolveApiKey(): string | undefined {
    return this.options.apiKey?.() ?? process.env[this.config.apiKeyEnv]?.trim();
  }
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function messageText(content: string | Array<{ text?: string }> | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => part.text ?? '').join('');
}
