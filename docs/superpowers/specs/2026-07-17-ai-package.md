# Spec: @chengchenccc/ai — Provider + Model 统一管理

## Problem

当前 `createModel()` 硬编码 Anthropic，Model 只是一个裸字符串。需要参考 pi-ai 的设计，引入 Provider + Model 元数据体系，放在独立的 `@chengchenccc/ai` 包中。

## Goal

新建 `packages/ai/` 包，提供：
1. `Model` 元数据对象（cost/contextWindow/maxTokens/reasoning/input）
2. `Provider` 接口（id/auth/models/createModel）
3. `ModelRegistry` 注册表（register/getModels/createModel）
4. `anthropicProvider()` 工厂 + Claude 模型元数据

## Design

### 包结构

```
packages/ai/
  src/
    types.ts                 -- Model/Provider/ModelRegistry/Usage 类型
    registry.ts              -- createModelRegistry 实现
    providers/
      anthropic.ts           -- anthropicProvider()
      anthropic-models.ts    -- Claude 模型元数据列表
      index.ts               -- re-export all providers
    index.ts                 -- barrel
  package.json
  tsconfig.json
```

### 类型定义 (types.ts)

```typescript
import type { ChatModel } from "@chengchenccc/core";

/** 模型输入模态 */
export type InputModality = "text" | "image";

/** 模型成本（$/million tokens） */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Model 元数据对象 — 替代裸字符串。 */
export interface Model {
  id: string;                // "claude-sonnet-4-20250514"
  name: string;              // "Claude Sonnet 4"
  provider: string;          // "anthropic"
  baseUrl?: string;          // provider 默认 baseUrl（可被 provider 级覆盖）
  reasoning: boolean;        // 是否支持 reasoning/thinking
  input: InputModality[];    // ["text", "image"]
  cost: ModelCost;           // $/million tokens
  contextWindow: number;     // 上下文窗口（tokens）
  maxTokens: number;         // 最大输出 tokens
}

/** Provider 认证配置 */
export interface ProviderAuth {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

/** 一个 LLM 提供商的运行时定义。 */
export interface Provider {
  readonly id: string;       // "anthropic"
  readonly name: string;     // "Anthropic"
  readonly baseUrl?: string;
  getModels(): readonly Model[];
  createModel(model: Model, auth?: ProviderAuth): ChatModel;
}

/** Provider 注册表。启动时注册，全局复用。 */
export interface ModelRegistry {
  register(provider: Provider): void;
  getProvider(id: string): Provider | undefined;
  getProviders(): readonly Provider[];
  getModels(provider?: string): readonly Model[];
  getModel(provider: string, id: string): Model | undefined;
  createModel(model: Model, auth?: ProviderAuth): ChatModel;
}
```

### 注册表实现 (registry.ts)

```typescript
export function createModelRegistry(): ModelRegistry {
  const providers = new Map<string, Provider>();
  // 与当前实现相同，只是 Model 字段更丰富
}
```

### Anthropic Provider (providers/anthropic.ts)

```typescript
export function anthropicProvider(auth: ProviderAuth): Provider {
  const cache = new Map<string, ChatModel>(); // model.id -> ChatModel
  return {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: auth.baseUrl,
    getModels: () => ANTHROPIC_MODELS,
    createModel(model: Model, opts?: ProviderAuth): ChatModel {
      const key = model.id;
      let instance = cache.get(key);
      if (!instance) {
        instance = new AnthropicChatModel({
          model: model.id,
          apiKey: opts?.apiKey ?? auth.apiKey,
          baseUrl: opts?.baseUrl ?? auth.baseUrl,
        });
        cache.set(key, instance);
      }
      return instance;
    },
  };
}
```

### Claude 模型元数据 (providers/anthropic-models.ts)

```typescript
export const ANTHROPIC_MODELS: readonly Model[] = [
  {
    id: "claude-sonnet-4-20250514",
    name: "Claude Sonnet 4",
    provider: "anthropic",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  // ... 其他 Claude 模型
];
```

### 与现有代码的集成

**core 包改动：**
- `packages/core/src/provider.ts` — 删除（类型移到 ai 包）
- `packages/core/src/index.ts` — 移除 Provider/ModelRef/ModelRegistry 导出
- 保留 `ChatModel` / `ChatModelOptions` / `AIMessageChunk` 在 core

**adapter-anthropic 包改动：**
- `packages/adapter-anthropic/src/anthropic-provider.ts` — 删除（移到 ai 包）
- 保留 `AnthropicChatModel` / `AnthropicChatModelConfig`

**backend 改动：**
- `agent-helpers.ts` — `createDefaultModelRegistry` 改为从 `@chengchenccc/ai` 导入
- `createModel` 签名改为 `(model: Model, registry: ModelRegistry, auth: ProviderAuth)`
- agent 的 `modelName` 字段解析为 `Model` 对象：`registry.getModel(provider, id)`

**agent 配置改动：**
- DB schema 不变（`modelName` TEXT + `modelProvider` TEXT）
- 读取时：`registry.getModel(agent.modelProvider, agent.modelName)` 得到完整 Model 对象
- 新建 agent 时前端发 `{provider, modelId}`，后端拆开存两列

### API

```
GET /api/models          — { providers: [{ id, name, models: Model[] }] }
```

Model 对象包含完整元数据（cost/contextWindow/maxTokens），前端可展示。

### 不做

- 不做 OAuth
- 不做动态 model 列表拉取
- 不做 images API
- 不做 compat 系统
- 不做 `TApi` 泛型分派
- 不做向后兼容（裸字符串不自动解析为 anthropic）

## 依赖关系

```
@chengchenccc/ai
  ├── @chengchenccc/core (ChatModel 类型)
  └── @chengchenccc/adapter-anthropic (AnthropicChatModel 类)

@chengchenccc/backend
  └── @chengchenccc/ai (registry + providers)
```

## Plan

### Phase 1: 新建 ai 包 (1 天)
1. 创建 `packages/ai/` 包骨架（package.json/tsconfig.json）
2. 写 `types.ts` — Model/Provider/ModelRegistry/ProviderAuth/ModelCost/InputModality
3. 写 `registry.ts` — createModelRegistry 实现
4. 写 `providers/anthropic-models.ts` — Claude 模型元数据（6 个模型）
5. 写 `providers/anthropic.ts` — anthropicProvider 工厂
6. 写 `providers/index.ts` + `index.ts` — barrel 导出

### Phase 2: 清理旧代码 (半天)
1. 删 `packages/core/src/provider.ts`
2. 清理 `packages/core/src/index.ts` 导出
3. 删 `packages/adapter-anthropic/src/anthropic-provider.ts`
4. 清理 `packages/adapter-anthropic/src/index.ts` 导出

### Phase 3: backend 接线 (1 天)
1. `agent-helpers.ts` — 从 `@chengchenccc/ai` 导入，改 `createModel` 签名
2. `main.ts` — `createDefaultModelRegistry` 改用 ai 包
3. `conversation-compose.ts` — 传 Model 对象替代字符串
4. `scheduler.ts` — 同上
5. `models/http.ts` — 返回完整 Model 元数据

### Phase 4: agent 配置 (半天)
1. agent 创建/编辑 — 存 `modelProvider` + `modelName` 两列
2. agent 读取 — `registry.getModel(provider, name)` 解析为 Model 对象
3. 前端 AgentForm — Select 下拉显示 model name + cost

### Phase 5: 验证 (半天)
1. typecheck 全包通过
2. backend tests 通过
3. 手动验证：创建 agent -> 选模型 -> 发消息 -> 正常回复
