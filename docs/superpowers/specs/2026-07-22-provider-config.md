# Spec: Provider 配置化（models.yml）

## Problem

当前 `createDefaultModelRegistry()` 硬编码只注册 Anthropic：

```typescript
// agent-helpers.ts
export function createDefaultModelRegistry(config: BackendConfig): ModelRegistry {
  const registry = createModelRegistry();
  registry.register(anthropicProvider({ apiKey: config.anthropicApiKey, baseUrl: config.anthropicBaseUrl }));
  return registry;
}
```

四个问题：

1. **加 provider 要改代码** -- DeepSeek/OpenAI 每次要改 `agent-helpers.ts`，即使 `@chengchenccc/ai` 已内置 `deepseekProvider` / `createOpenAICompatProvider`
2. **无运行时配置** -- 不能通过配置文件切换 provider/model，必须改代码重启
3. **前端无感知** -- Settings 页面 pet 的 `provider`/`model` 字段是自由文本，用户不知道有哪些可用
4. **零配置体验差** -- 设了 `ANTHROPIC_API_KEY` 还得手动改代码注册，migration/新部署都要踩坑

## Goal

**Provider 配置从代码注册转为声明式配置**：`models.yml` 文件（可选的）定义 provider 列表，启动时加载。文件不存在则按环境变量自动注册内置 provider。前端下拉从 `/api/models` 动态加载。

## Design

### 配置格式

```yaml
# config/models.yml（可选）
providers:
  anthropic:
    baseUrl: https://api.anthropic.com
    api: anthropic-messages
    apiKey: ANTHROPIC_API_KEY          # 环境变量名，非明文 key
    models:
      - id: claude-haiku-3-5
        name: Claude 3.5 Haiku
        maxTokens: 8192
      - id: claude-sonnet-4-6
        name: Claude Sonnet 4.6
        maxTokens: 8192

  deepseek:
    baseUrl: https://api.deepseek.com
    api: openai-completions
    apiKey: DEEPSEEK_API_KEY
    models:
      - id: deepseek-chat
        name: DeepSeek Chat
        maxTokens: 8192
```

### 自动注册（无 models.yml 时）

内置 provider 表驻留在 `@chengchenccc/ai` 包内：

```typescript
// packages/ai/src/builtin-providers.ts
const BUILTIN = {
  anthropic: {
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    models: [
      { id: "claude-haiku-3-5", name: "Claude 3.5 Haiku", maxTokens: 8192 },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", maxTokens: 8192 },
    ],
  },
  deepseek: {
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    models: [
      { id: "deepseek-chat", name: "DeepSeek Chat", maxTokens: 8192 },
    ],
  },
  openai: {
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    models: [
      { id: "gpt-4o", name: "GPT-4o", maxTokens: 16384 },
      { id: "gpt-4o-mini", name: "GPT-4o Mini", maxTokens: 16384 },
    ],
  },
};
```

启动流程：

```
loadModelRegistry(yamlPath?)
  ├─ models.yml 存在 →
  │    遍历 providers:
  │      apiKey → process.env[name] → 空? skip : 注册
  │
  └─ 不存在 →
       遍历 BUILTIN:
         process.env[apiKeyEnv] 有? → 注册 : skip
```

### Provider 接口升级

Provider 需要成为自包含的运行时单元（携带 auth + models + stream），匹配 Pi 的设计：

```typescript
// packages/ai/src/types.ts — 升级 Provider

export interface Provider {
  readonly id: string;
  readonly name: string;
  readonly baseUrl?: string;
  readonly auth: ProviderAuth;                           // NEW
  getModels(): readonly Model[];
  createModel(model: Model, auth?: ProviderAuth): ChatModel;
  stream?(model: Model, context: Context, opts?: StreamOptions): Stream;  // NEW 便捷方法
}

// packages/ai/src/types.ts — 升级 ModelRegistry
export interface ModelRegistry {
  register(provider: Provider): void;
  setProvider(provider: Provider): void;                 // NEW upsert
  getProvider(id: string): Provider | undefined;
  getProviders(): readonly Provider[];
  getModels(provider?: string): readonly Model[];
  getModel(provider: string, id: string): Model | undefined;
  createModel(model: Model, auth?: ProviderAuth): ChatModel;
  getAuth(model: Model): ProviderAuth | undefined;       // NEW
}
```

### API 实现映射

```typescript
// packages/ai/src/provider-config.ts — 新文件

interface ProviderConfig {
  id: string;
  api: "anthropic-messages" | "openai-completions" | (string & {});
  baseUrl: string;
  apiKey: string;        // env var name
  models: ModelConfig[];
}

interface ModelConfig {
  id: string;
  name: string;
  maxTokens: number;
}

function loadProvider(config: ProviderConfig): Provider | undefined {
  const apiKey = process.env[config.apiKey];
  if (!apiKey) return undefined;     // key 不存在 → 跳过

  const models: Model[] = config.models.map(m => ({
    ...m,
    api: config.api,
    provider: config.id,
    baseUrl: config.baseUrl,
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 200000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));

  const apiImpl = getApiImplementation(config.api);
  // 用 createOpenAICompatProvider / anthropicProvider 等现有工厂
  return createProviderFromConfig(config, models, apiImpl);
}
```

### 后端改动

```
apps/backend/
├── config/
│   └── models.yml            ← 默认配置（新文件）
├── src/
│   └── features/span/
│       └── agent-helpers.ts   ← createDefaultModelRegistry → loadModelRegistry()
│   └── model-registry-loader.ts  ← 新文件：读 YAML + 自动注册
```

```typescript
// model-registry-loader.ts
import { loadProvider, builtinProviders } from "@chengchenccc/ai";
import { readFileSync } from "node:fs";
import YAML from "yaml";

export function loadModelRegistry(yamlPath?: string): ModelRegistry {
  const registry = createModelRegistry();

  if (yamlPath) {
    const yaml = YAML.parse(readFileSync(yamlPath, "utf-8"));
    for (const [id, cfg] of Object.entries(yaml.providers)) {
      const provider = loadProvider({ id, ...cfg });
      if (provider) registry.setProvider(provider);
    }
  } else {
    for (const [id, builtin] of Object.entries(builtinProviders)) {
      if (process.env[builtin.apiKeyEnv]) {
        const provider = loadProvider({ id, ...builtin });
        if (provider) registry.setProvider(provider);
      }
    }
  }

  return registry;
}
```

### Runtime 模型解析

所有 `modelRegistry.getModel("anthropic", ...)` 改为调用统一入口 `resolveModel(name, registry)`：

```typescript
// packages/ai/src/resolve-model.ts — 新文件

/**
 * Resolve a model reference string to a Model object.
 *
 *   "provider/id"  → registry.getModel(provider, id)  // preferred format
 *   "bare-id"      → search all providers (legacy compat, first match wins)
 *
 * Throws if not found so callers don't silently fall back.
 */
export function resolveModel(name: string, registry: ModelRegistry): Model {
  const slash = name.indexOf("/");
  if (slash > 0) {
    const provider = name.slice(0, slash);
    const id = name.slice(slash + 1);
    const model = registry.getModel(provider, id);
    if (model) return model;
  } else {
    // Legacy: bare id, search all providers
    for (const p of registry.getProviders()) {
      const model = registry.getModel(p.id, name);
      if (model) return model;
    }
  }
  throw new Error(`Model not found in registry: ${name}`);
}
```

**受影响的调用点**（12 处全部替换）：

| 文件 | 当前硬编码 | 改为 |
|------|-----------|------|
| `conversation-compose.ts:79` | `getModel("anthropic", "claude")` | `resolveModel("anthropic/claude", registry)` |
| `conversation-compose.ts:172` | `getModel("anthropic", modelName)` | `resolveModel(modelName, registry)` |
| `conversation-compose.ts:184` | `getModel("anthropic", "claude-sonnet-4")` | `resolveModel("anthropic/claude-sonnet-4", registry)` |
| `conversation-compose.ts:206` | `getModel(pet.provider, pet.model)` | 已正确，不动 |
| `cron/scheduler.ts:77` | `getModel("anthropic", modelName)` | `resolveModel(modelName, registry)` |
| `cron/scheduler.ts:166` | `getModel("anthropic", …)` | `resolveModel(params.modelName, registry)` |
| `main.ts:134,157` | `getModel("anthropic", "claude-sonnet-4-6")` | `resolveModel("anthropic/claude-sonnet-4-6", registry)` |
| `main.ts:354` | `getModel("anthropic", params.modelName)` | `resolveModel(params.modelName, registry)` |

**向后兼容**：`modelName` 从 `"claude-sonnet-4-6"` 变为 `"anthropic/claude-sonnet-4-6"`，`resolveModel` 支持两种格式。存量数据自动兼容 — bare id 会遍历所有 provider 找第一个匹配。


### 前端改动

Settings Pet section 的 `provider`/`model` 字段从 `<input type="text">` 改为 `<select>`：

```typescript
// 从 /api/models 加载
const { data } = useQuery({ queryKey: ["models"], queryFn: () => api.getModels() });

// Provider 下拉
<select value={petProvider} onChange={...}>
  {data.providers.map(p => <option value={p.id}>{p.name}</option>)}
</select>

// Model 下拉（级联，provider 变化时刷新）
<select value={petModel} onChange={...}>
  {selectedProvider.models.map(m => <option value={m.id}>{m.name}</option>)}
</select>
```

### 不做

- hot-reload（改 models.yml 需重启）
- OAuth / credential store（只支持 api key）
- 动态 model 发现（`refreshModels()`）
- cost 追踪（cost 字段存在但未消费）
- reasoning/thinking 支持（API 层未实现）

## Acceptance

1. ✅ 无 `models.yml` 时，仅 `ANTHROPIC_API_KEY` 设了 → 注册 Anthropic
2. ✅ 无 `models.yml` 时，`DEEPSEEK_API_KEY` 也设了 → 注册 Anthropic + DeepSeek
3. ✅ `models.yml` 存在 → 按配置注册，跳过 apiKey 为空的 provider
4. ✅ `/api/models` 返回所有已注册 provider + model
5. ✅ Settings → Pet → provider/model 改为下拉，数据从 API 加载
6. ✅ `createDefaultModelRegistry` 不再硬编码 Anthropic，改为 delegate 给 loader
7. ✅ `BackendConfig.anthropicApiKey` 不再被 `createDefaultModelRegistry` 消费（后续可删字段）
8. ✅ 所有 `getModel("anthropic", ...)` 替换为 `resolveModel(name, registry)`
9. ✅ `resolveModel` 支持 `"provider/id"` 和 bare id 两种格式
10. ✅ Agent/Loop session 运行时模型从 registry 解析，不再硬编码 provider
11. ✅ 前端 Agent 创建/编辑页 model 字段改为 provider + model 下拉（级联选择）
12. ✅ 全量 CI 通过（typecheck + lint + test + build）
