import type { Blueprint, ProviderAdapter } from '../src/index.js';

export function blueprint(options: {
  id?: string;
  verdictKind?: 'llm' | 'check' | 'manual';
  acceptance?: string[];
  definitionOfDone?: string;
} = {}): Blueprint {
  return {
    id: options.id ?? 'test-blueprint',
    title: `测试蓝图 ${options.id ?? ''}`.trim(),
    description: '用于自动化测试的蓝图',
    constraints: [],
    definitionOfDone: options.definitionOfDone ?? '',
    milestones: [{
      id: 'm1',
      name: 'M1',
      goal: '完成测试',
      acceptance: options.acceptance ?? [],
      status: 'pending',
      subtasks: [{
        id: 's1',
        name: 'S1',
        detail: '执行一次',
        dependencies: [],
        verdict: {
          kind: options.verdictKind ?? 'check',
          check: options.verdictKind === 'check' || options.verdictKind === undefined ? 'ok' : undefined,
          criteria: [],
        },
        status: 'pending',
        evidence: [],
      }],
    }],
  };
}

export function fakeProvider(options: {
  id?: string;
  delayMs?: number;
  content?: string;
  onChat?: () => void;
} = {}): ProviderAdapter {
  const id = options.id ?? 'fake';
  return {
    id,
    config: {
      id,
      name: id,
      baseUrl: '',
      apiKeyEnv: 'NONE',
      models: [{ name: `${id}-chat`, kind: 'chat', inputPrice: 0, outputPrice: 0, contextWindow: 1000 }],
      costStrategy: {},
    },
    isOffPeak: () => false,
    currentDiscount: () => 1,
    routeModel() {
      return this.config.models[0];
    },
    async chat() {
      options.onChat?.();
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      return { content: options.content ?? 'done output', model: `${id}-chat`, providerId: id };
    },
  };
}
