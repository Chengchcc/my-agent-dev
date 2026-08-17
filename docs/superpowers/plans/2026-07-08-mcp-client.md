# MCP Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Agent 运行时连接外部 MCP server，发现 tools，适配为 `Tool[]` 注入 agent session。

**Architecture:** 预连接+缓存模式。新建 `packages/adapter-mcp`（MCP client + Tool 适配器）+ `apps/backend/src/features/mcp`（CRUD + 连接协调）。配置变更时异步连接+discovery，session 创建时同步读缓存。

**Spec:** `docs/superpowers/specs/2026-07-08-mcp-client-design.md`
**ADR:** `docs/adr/0012-mcp-client-architecture.md`

---

## 代码事实

| 事实 | 位置 |
|------|------|
| `Tool` 接口（name/description/inputSchema/execute） | `packages/core/src/tool.ts:6-16` |
| `sessionManager.create(config)` 是同步的 | `apps/backend/src/features/span/session-manager.ts:43` |
| 工具组装在 `startAgentRun` 内联 | `apps/backend/src/features/conversation/conversation-compose.ts:164-168` |
| loop buildConfig 回调组装工具 | `apps/backend/src/main.ts:326-331` |
| agent HTTP routes 挂 skill-pack 子路由 | `apps/backend/src/features/agent/http.ts:248-264` |
| shutdown handler | `apps/backend/src/main.ts:364-377` |
| FeatureSet 接口 | `apps/backend/src/app.ts:13-24` |
| agent 详情页 tab 结构 | `apps/web/src/app/(main)/team/[agentId]/page.tsx:24,106-134` |
| skill-pack 前端 hooks 模式 | `apps/web/src/features/skill-packs/hooks.ts` |
| adapter-anthropic 包结构（package.json/tsconfig） | `packages/adapter-anthropic/` |
| MCP SDK 参考实现 | `/root/loop-engineering/tools/mcp-server/src/index.ts` |
| `@modelcontextprotocol/sdk` 版本 | `^1.12.1`（参考实现） |
| validatePlugins 工具名冲突检查 | `packages/framework/src/plugin.ts:65-83` |

---

## Task 1: 新建 `packages/adapter-mcp` 包

**Files:**
- Create: `packages/adapter-mcp/package.json`
- Create: `packages/adapter-mcp/tsconfig.json`
- Create: `packages/adapter-mcp/tsconfig.test.json`
- Create: `packages/adapter-mcp/src/types.ts`
- Create: `packages/adapter-mcp/src/mcp-tool-adapter.ts`
- Create: `packages/adapter-mcp/src/mcp-client-manager.ts`
- Create: `packages/adapter-mcp/src/mcp-tool-adapter.test.ts`
- Create: `packages/adapter-mcp/src/index.ts`

- [ ] **Step 1: package.json**

```json
{
  "name": "@chengchenccc/adapter-mcp",
  "version": "0.1.0",
  "description": "MCP client adapter - connects external MCP servers, adapts tools to Tool interface",
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "lint": "biome check . && eslint .",
    "test": "bun test --pass-with-no-tests",
    "typecheck": "tsc -p tsconfig.test.json --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.1",
    "@chengchenccc/core": "workspace:*"
  }
}
```

- [ ] **Step 2: tsconfig.json + tsconfig.test.json**

复制 adapter-anthropic 的 tsconfig 结构。

- [ ] **Step 3: types.ts**

```typescript
import type { Tool } from "@chengchenccc/core";

export type McpTransport = "stdio" | "sse";

export interface McpServerConfig {
  serverId: string;
  agentId: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled: boolean;
}

/** Cached connection + discovered tools for one MCP server. */
export interface McpConnectionEntry {
  config: McpServerConfig;
  tools: Tool[];
  client: unknown; // MCP Client instance
  transport: unknown; // MCP Transport instance (for cleanup)
}
```

- [ ] **Step 4: mcp-tool-adapter.ts**

MCP tool -> Tool 接口适配。名字格式 `mcp__{serverName}__{toolName}`。

```typescript
import type { Tool, ToolExecuteResult } from "@chengchenccc/core";

/** Sanitize server name for tool prefix: lowercase + [a-z0-9-]. */
export function sanitizeServerName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "server";
}

/** Build prefixed tool name: mcp__{server}__{tool}. */
export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${sanitizeServerName(serverName)}__${toolName}`;
}

/** MCP tool shape from listTools(). */
export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** MCP client call interface (subset of SDK Client). */
export interface McpToolCaller {
  callTool(params: { name: string; arguments?: unknown }): Promise<{ content: unknown }>;
}

/** Adapt an MCP tool definition to the Tool interface. */
export function adaptMcpTool(
  serverName: string,
  mcpTool: McpToolDefinition,
  caller: McpToolCaller,
): Tool {
  return {
    name: mcpToolName(serverName, mcpTool.name),
    description: mcpTool.description ?? `MCP tool: ${mcpTool.name}`,
    inputSchema: mcpTool.inputSchema ?? { type: "object", properties: {} },
    execute: async (input): Promise<ToolExecuteResult> => {
      try {
        const result = await caller.callTool({ name: mcpTool.name, arguments: input });
        return { content: JSON.stringify(result.content) };
      } catch (err) {
        return {
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
    },
  };
}
```

- [ ] **Step 5: mcp-tool-adapter.test.ts**

测试 sanitizeServerName、mcpToolName、adaptMcpTool（mock caller）。

- [ ] **Step 6: mcp-client-manager.ts**

```typescript
import type { Tool } from "@chengchenccc/core";
import type { McpServerConfig, McpConnectionEntry } from "./types.js";
import { adaptMcpTool, type McpToolCaller } from "./mcp-tool-adapter.js";

// MCP SDK imports (lazy - only loaded when connecting)
// StdioClientTransport from "@modelcontextprotocol/sdk/client/stdio.js"
// SSEClientTransport from "@modelcontextprotocol/sdk/client/sse.js"
// Client from "@modelcontextprotocol/sdk/client/index.js"

export interface McpClientManager {
  connect(config: McpServerConfig): Promise<void>;
  disconnect(serverId: string): Promise<void>;
  getTools(agentId: string): Tool[];
  disconnectAll(): Promise<void>;
}

export function createMcpClientManager(): McpClientManager {
  // Map<serverId, McpConnectionEntry>
  // Map<agentId, Set<serverId>> for reverse lookup
  // connect: create transport (stdio/sse) -> Client -> initialize -> listTools -> adapt -> cache
  // disconnect: close transport -> delete from both maps
  // getTools: lookup agentId -> serverIds -> flatten tools
  // disconnectAll: disconnect all entries
  // All errors caught -> log + empty tools cache (degraded mode)
}
```

关键实现细节：
- `connect()` 内全 try-catch，失败时缓存 `{ config, tools: [], client: null, transport: null }` 保证 `getTools()` 不会 NPE
- stdio: `new StdioClientTransport({ command, args, env })` + `new Client(...)` + `client.connect(transport)`
- sse: `new SSEClientTransport(new URL(url))` + `new Client(...)` + `client.connect(transport)`
- discovery: `client.listTools()` -> `response.tools.map(t => adaptMcpTool(...))`
- `disconnect()`: `transport.close()` + 删缓存
- 日志：`console.error("[mcp] ...")` 统一前缀

- [ ] **Step 7: index.ts barrel**

导出 `createMcpClientManager`、`McpClientManager`、`adaptMcpTool`、`mcpToolName`、`sanitizeServerName`、types。

- [ ] **Step 8: bun install + typecheck + test**

- [ ] **Step 9: Commit**

---

## Task 2: 后端 mcp feature + DB schema

**Files:**
- Create: `apps/backend/src/features/mcp/domain.ts`
- Create: `apps/backend/src/features/mcp/ports.ts`
- Create: `apps/backend/src/features/mcp/adapter-sqlite.ts`
- Create: `apps/backend/src/features/mcp/service.ts`
- Create: `apps/backend/src/features/mcp/http.ts`
- Create: `apps/backend/src/features/mcp/index.ts`
- Modify: `apps/backend/src/infra/db/schema.ts`（加 mcpServer 表）
- Create: `apps/backend/drizzle/backend/0008_mcp_server.sql` + snapshot + journal（手动生成，drizzle-kit 需 TTY）

- [ ] **Step 1: schema.ts 加 mcpServer 表**

```typescript
export const mcpServer = sqliteTable("mcp_server", {
  serverId: text("server_id").primaryKey(),
  agentId: text("agent_id").notNull(),
  name: text().notNull(),
  transport: text().notNull(),
  command: text(),
  args: text(),   // JSON array
  env: text(),    // JSON object
  url: text(),
  enabled: integer({ mode: "number" }).notNull().default(1),
  createdAt: integer({ mode: "number" }).notNull(),
  updatedAt: integer({ mode: "number" }).notNull(),
}, (table) => [index("idx_mcp_server_agent").on(table.agentId)]);
```

注意：用 `integer({ mode: "number" })` + `boolToInt`（和 cron_job 的 enabled 一致），不用 `mode: "boolean"`（drizzle sqlite 不支持）。

- [ ] **Step 2: migration 0008 手动生成**

参考 settings 的 0007 migration 手动生成方式。SQL:
```sql
CREATE TABLE `mcp_server` (
  `server_id` text PRIMARY KEY NOT NULL,
  `agent_id` text NOT NULL,
  `name` text NOT NULL,
  `transport` text NOT NULL,
  `command` text,
  `args` text,
  `env` text,
  `url` text,
  `enabled` integer NOT NULL DEFAULT 1,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
CREATE INDEX `idx_mcp_server_agent` ON `mcp_server` (`agent_id`);
```

- [ ] **Step 3: domain.ts**

```typescript
export interface McpServerRow {
  serverId: string;
  agentId: string;
  name: string;
  transport: "stdio" | "sse";
  command: string | null;
  args: string[] | null;   // 解析后的数组
  env: Record<string, string> | null;
  url: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CreateMcpServerInput {
  name: string;
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled?: boolean;
}

export interface UpdateMcpServerInput {
  name?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled?: boolean;
}
```

- [ ] **Step 4: ports.ts**

```typescript
export interface McpServerPort {
  create(input: { serverId: string; agentId: string; ... }): McpServerRow;
  getByAgent(agentId: string): McpServerRow[];
  getById(serverId: string): McpServerRow | null;
  update(serverId: string, patch: ...): McpServerRow | null;
  delete(serverId: string): boolean;
}
```

- [ ] **Step 5: adapter-sqlite.ts**

args/env 存 JSON string，读时 JSON.parse。enabled 用 boolToInt/!!row.enabled。参考 project adapter 模式。

- [ ] **Step 6: service.ts**

```typescript
export interface McpService {
  listByAgent(agentId: string): McpServerRow[];  // env 脱敏
  create(agentId: string, input: CreateMcpServerInput): Promise<McpServerRow>;
  update(agentId: string, serverId: string, input: UpdateMcpServerInput): Promise<McpServerRow>;
  delete(agentId: string, serverId: string): Promise<void>;
}
```

- create: 写 DB -> `mcpClientManager.connect(config)` (async, 不 await 阻塞) -> 返回 row
- update: 写 DB -> `mcpClientManager.disconnect(old)` -> `mcpClientManager.connect(new)` -> 返回 row
- delete: `mcpClientManager.disconnect(serverId)` -> 删 DB
- listByAgent: 返回 rows，env 字段脱敏（`****`+末4位）
- 错误：`McpServerNotFoundError`、`McpValidationError`

- [ ] **Step 7: http.ts**

挂到 agentRoutes 上（和 skill-packs 子路由同级），或独立 mcpRoutes。选择独立路由更清晰：
```
GET    /api/agents/:id/mcp-servers
POST   /api/agents/:id/mcp-servers
PUT    /api/agents/:id/mcp-servers/:serverId
DELETE /api/agents/:id/mcp-servers/:serverId
```

- [ ] **Step 8: index.ts barrel**

- [ ] **Step 9: Commit**

---

## Task 3: main.ts wiring + 工具注入 + shutdown

**Files:**
- Modify: `apps/backend/src/main.ts`
- Modify: `apps/backend/src/app.ts`
- Modify: `apps/backend/src/features/conversation/conversation-compose.ts`
- Modify: `apps/backend/src/features/agent/agent-compose.ts`（如果 agentRoutes 签名要改）

- [ ] **Step 1: main.ts 创建 mcpClientManager + mcpSvc**

在 settingsSvc 后面加：
```typescript
const mcpClientManager = createMcpClientManager();
const mcpSvc = createMcpService({
  port: sqliteMcpServerAdapter(db),
  mcpClientManager,
  agentExists: (id) => agentSvc.exists(id),
  idGen: ulid,
});
```

- [ ] **Step 2: main.ts 注入 mcpClientManager 到 conversation-compose**

`createConversationFeature` 加 `mcpClientManager` 参数。
`startAgentRun` 的工具组装加 `...mcpClientManager.getTools(agentId)`。

- [ ] **Step 3: main.ts 注入 mcpClientManager 到 loop buildConfig**

loopRoutes 的 buildConfig 回调加 mcpTools。

- [ ] **Step 4: app.ts FeatureSet 加 mcp 路由**

- [ ] **Step 5: main.ts shutdown 加 mcpClientManager.disconnectAll()**

```typescript
const shutdown = async (signal: string) => {
  ...
  await mcpClientManager.disconnectAll();
  ...
};
```

- [ ] **Step 6: main.ts createApp 加 mcp 路由**

- [ ] **Step 7: backend typecheck + test**

- [ ] **Step 8: Commit**

---

## Task 4: 前端 hooks + api + MCP tab

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/features/agents/hooks.ts`
- Create: `apps/web/src/components/McpServerPanel.tsx`
- Modify: `apps/web/src/app/(main)/team/[agentId]/page.tsx`

- [ ] **Step 1: api.ts 加 MCP API**

4 个 API 函数 + 类型导出。

- [ ] **Step 2: hooks.ts 加 MCP hooks**

`useAgentMcpServers`、`useCreateMcpServer`、`useUpdateMcpServer`、`useDeleteMcpServer`。

- [ ] **Step 3: McpServerPanel 组件**

Server 列表卡片 + Add 按钮 + 表单弹窗（Dialog）。
表单根据 transport 切换字段：stdio = command/args/env，sse = url。
每个 server 卡片：name、transport badge、enabled switch、tools count（如果有）、编辑/删除按钮。

- [ ] **Step 4: agent 详情页加 MCP tab**

Tab 类型加 `"mcp"`，tab 按钮加 MCP，内容区加 `<McpServerPanel agentId={id} />`。

- [ ] **Step 5: web typecheck**

- [ ] **Step 6: Commit**

---

## Task 5: 最终验证

- [ ] **Step 1: backend build（刷新 dist 给 web treaty 推导）**
- [ ] **Step 2: 全量 typecheck**
- [ ] **Step 3: backend test**
- [ ] **Step 4: biome format + check**
- [ ] **Step 5: Commit + push**
