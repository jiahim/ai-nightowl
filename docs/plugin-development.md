# 可信本地插件开发预览

当前插件 API 版本为 `1`，用于验证 manifest、注册表、显式加载和 Provider 扩展。它是后续完整插件运行时的兼容起点，不是安全沙箱。

## 最小 TypeScript 插件

```ts
import type { NightOwlPlugin, ProviderAdapter } from 'ai-nightowl';

const provider: ProviderAdapter = {
  id: 'acme-models',
  config: {
    id: 'acme-models',
    name: 'Acme Models',
    baseUrl: 'https://models.example.com/v1',
    apiKeyEnv: 'ACME_API_KEY',
    models: [{
      name: 'acme-chat',
      kind: 'chat',
      inputPrice: 1,
      outputPrice: 3,
      contextWindow: 128_000,
    }],
    costStrategy: { preferCache: true },
  },
  isOffPeak: () => false,
  currentDiscount: () => 1,
  routeModel() {
    return this.config.models[0];
  },
  async chat(model, messages, options) {
    // 调用你的 OpenAI-compatible endpoint；不要记录 key 或完整敏感输入。
    return {
      providerId: this.id,
      model,
      content: 'result',
      pricing: { offPeak: false, discount: 1 },
    };
  },
};

const plugin: NightOwlPlugin = {
  manifest: {
    id: 'acme.models',
    name: 'Acme Models',
    version: '0.1.0',
    apiVersion: '1',
    description: 'Acme Provider for ai-nightowl',
    contributions: [{ kind: 'provider', id: provider.id, name: 'Acme Models' }],
    permissions: ['network', 'secrets'],
  },
  activate(context) {
    context.registerProvider(provider);
  },
};

export default plugin;
```

编译为 ESM JavaScript 后启动：

```bash
NIGHTOWL_PROVIDER=acme-models \
  ai-nightowl-serve --plugin ./dist/acme-plugin.js
```

也可设置 `NIGHTOWL_PLUGINS=./a.js,@acme/b`。相对路径按服务启动目录解析；`http:`、`https:` 与 `data:` URL 会被拒绝。

## Manifest 规则

- `id`：小写字母、数字、点、下划线、短横线；全局唯一；
- `name`、`version`：必填；
- `apiVersion`：当前必须严格为 `1`；
- `contributions`：声明 `provider/executor/verifier/trigger/notifier/storage`；
- `permissions`：`network/filesystem:read/filesystem:write/process/secrets`。

当前只有 Provider 能真正注册。其他 contribution 可以用于前瞻设计，但在对应扩展点交付前不会获得运行上下文。

Provider 的 `models` 是固定目录价；`costStrategy.timezone/peakWindows/offPeakDiscount/usageLimits` 会自动转换为平台自报资费画像。没有峰谷价的平台不要声明窗口。滚动额度使用 `period: "rolling"` 与 `windowMinutes`。有稳定官方套餐接口的适配器还可以实现可选的 `queryUsage()`，返回剩余百分比和重置时间；工作日/节假日绝对价格仍可由用户画像覆盖。完整结构见 [Provider 资费、额度与智能匹配](provider-policies.md)。

## 信任与安全边界

- 插件由用户在启动参数或环境变量中显式指定；Web 不接受代码路径或 URL；
- 插件模块在主进程中执行，声明的 permissions 目前不做系统级强制；
- 加载不兼容或重复插件会让启动明确失败，不进入半注册状态；
- Secret 只能通过环境引用读取，不能写入 manifest、蓝图、日志或 API；
- 正式插件运行时将增加配置 schema、healthcheck、timeout、启停、Secret 引用和 Worker 隔离。
