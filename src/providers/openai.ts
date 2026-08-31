import type { ModelSpec, ProviderConfig, TaskKind } from '../types.js';
import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from './openai-compatible.js';

/**
 * OpenAI 官方美元目录价按固定参考汇率 1 USD = 7 CNY 归一化，供跨平台比较。
 * 用户可在资费画像中按结算汇率覆盖绝对价格。
 */
const USD_TO_CNY_REFERENCE = 7;

function openAIModels(rate: number): ModelSpec[] {
  return [
    {
      name: 'gpt-5.6-luna',
      kind: 'chat',
      inputPrice: 0.2 * rate,
      outputPrice: 1.2 * rate,
      cacheHitPrice: 0.02 * rate,
      contextWindow: 1_050_000,
    },
    {
      name: 'gpt-5.6-terra',
      kind: 'chat',
      inputPrice: 2 * rate,
      outputPrice: 12 * rate,
      cacheHitPrice: 0.2 * rate,
      contextWindow: 1_050_000,
    },
    {
      name: 'gpt-5.6-sol',
      kind: 'reasoner',
      inputPrice: 4 * rate,
      outputPrice: 20 * rate,
      cacheHitPrice: 0.4 * rate,
      contextWindow: 1_050_000,
    },
  ];
}

export class OpenAIAdapter extends OpenAICompatibleAdapter {
  constructor(config: Partial<ProviderConfig> = {}, options: OpenAICompatibleAdapterOptions = {}) {
    const envRate = Number(process.env.NIGHTOWL_USD_CNY_RATE);
    const rate = Number.isFinite(envRate) && envRate > 0 ? envRate : USD_TO_CNY_REFERENCE;
    super({
      id: 'openai',
      name: 'OpenAI',
      baseUrl: process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1',
      apiKeyEnv: 'OPENAI_API_KEY',
      models: openAIModels(rate),
      costStrategy: { timezone: 'UTC', preferCache: true },
      ...config,
    }, { maxTokensField: 'max_completion_tokens', ...options });
  }

  override routeModel(kind: TaskKind): ModelSpec {
    const models = this.config.models;
    if (kind === 'summarize') return models.find((model) => model.name === 'gpt-5.6-luna') ?? models[0];
    if (kind === 'plan' || kind === 'judge') {
      return models.find((model) => model.name === 'gpt-5.6-terra') ?? super.routeModel(kind);
    }
    return models.find((model) => model.name === 'gpt-5.6-terra') ?? super.routeModel(kind);
  }
}
