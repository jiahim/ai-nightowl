const adapter = {
  id: 'fixture-provider',
  config: {
    id: 'fixture-provider',
    name: 'Fixture Provider',
    baseUrl: '',
    apiKeyEnv: 'NONE',
    models: [{ name: 'fixture-chat', kind: 'chat', inputPrice: 0, outputPrice: 0, contextWindow: 1000 }],
    costStrategy: {},
  },
  isOffPeak: () => false,
  currentDiscount: () => 1,
  routeModel() { return this.config.models[0]; },
  async chat() { return { content: 'fixture', model: 'fixture-chat', providerId: this.id }; },
};

export default {
  manifest: {
    id: 'fixture.provider',
    name: 'Fixture Provider',
    version: '1.0.0',
    apiVersion: '1',
    contributions: [{ kind: 'provider', id: adapter.id, name: 'Fixture Provider' }],
    permissions: [],
  },
  activate(context) { context.registerProvider(adapter); },
};
