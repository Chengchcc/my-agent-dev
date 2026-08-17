# Spec: MCP Client -- Agent 连接外部 MCP server 消费工具

> 状态：待评审
> 关联：ADR 0012（MCP Client 架构）
> 设计约束：`docs/architecture/design-philosophy.md` -- 暴露业务、隐藏机制

## 1. 目标

让 Agent 运行时连接外部 MCP server（stdio/SSE），发现其 tools，适配为 `Tool[]` 注入 agent session。per-agent 配置，常驻连接，预连接缓存。

## 2. 架构设计

### 2.1 数据流

```
用户配置 MCP server (POST /api/agents/:id/mcp-servers)
  -> 写 DB mcp_server 表
  -> 异步：McpClientManager.connect(serverId)
    -> 建立 stdio/SSE 连接
    -> client.listTools() discovery
    -> 缓存: Map<serverId, { tools: Tool[], connection }>
  -> HTTP 响应（不等连接完成）

Agent session 创建 (sessionManager.create)
  -> agent-helpers 组装 tools
  -> mcpClientManager.getTools(agentId) 同步读缓存
  -> tools: [...defaultTools(cwd), ...convTools, ...mcpTools]
  -> AgentSession.prompt() -> spanLoop -> model.stream(msgs, { tools })

MCP tool 被调用
  -> tool.execute(input) -> client.callTool({ name, arguments })
  -> 返回结果

进程关闭
  -> shutdown handler -> mcpClientManager.disconnectAll()
  -> stdio: kill 子进程; SSE: close session
```

### 2.2 工具名格式

`mcp__{serverName}__{toolName}`

- `serverName`：用户配置的 MCP server 名（sanitize 为 `[a-z0-9-]`）
- `toolName`：MCP server 暴露的原始 tool 名
- 示例：`mcp__github-server__create_issue`

防冲突：和内置 tool（`bash`/`read`/`write` 等）及 plugin tools 永不重名（前缀隔离）。

### 2.3 降级策略

| 故障 | 行为 |
|------|------|
| 配置时连接失败 | 记日志，缓存空 tools 数组。session 创建时该 server 无 tools。 |
| 运行中 MCP server 崩溃 | tool.execute() 返回 error result。agent 继续运行。 |
| discovery 返回空 tools | 正常，该 server 贡献 0 个 tools。 |

**不重试**。配置变更时才重新连接。用户手动改配置（disable/enable 或重新 POST）触发重连。

## 3. 后端设计

### 3.1 新增 `packages/adapter-mcp`

```
packages/adapter-mcp/
├── src/
│   ├── index.ts              # barrel
│   ├── mcp-client-manager.ts # McpClientManager: 连接池 + discovery 缓存
│   ├── mcp-tool-adapter.ts   # MCP tool -> Tool 接口适配
│   └── types.ts              # McpServerConfig, McpConnection
├── package.json
└── tsconfig.json
```

依赖：`@modelcontextprotocol/sdk`、`@chengchenccc/core`（Tool 接口）。

#### McpClientManager

```typescript
interface McpServerConfig {
  serverId: string;
  name: string;
  transport: "stdio" | "sse";
  command?: string;       // stdio
  args?: string[];        // stdio
  env?: Record<string, string>; // stdio
  url?: string;           // sse
  enabled: boolean;
}

interface McpClientManager {
  /** 配置变更时调用：连接 + discovery + 缓存。异步，不阻塞调用方。 */
  connect(config: McpServerConfig): Promise<void>;
  /** 配置删除/disable 时调用：断开连接，清缓存。 */
  disconnect(serverId: string): Promise<void>;
  /** 同步读缓存：返回 agentId 绑定的所有 enabled server 的 tools。 */
  getTools(agentId: string): Tool[];
  /** 进程关闭时清理所有连接。 */
  disconnectAll(): Promise<void>;
}
```

#### MCP Tool 适配器

```typescript
// MCP tool -> Tool 接口
function adaptMcpTool(
  serverName: string,
  mcpTool: { name: string; description: string; inputSchema: object },
  client: MCPClient,
): Tool {
  return {
    name: `mcp__${sanitizeName(serverName)}__${mcpTool.name}`,
    description: mcpTool.description,
    inputSchema: mcpTool.inputSchema,
    execute: async (input) => {
      const result = await client.callTool({ name: mcpTool.name, arguments: input });
      return { content: JSON.stringify(result.content) };
    },
  };
}
```

### 3.2 新增 `apps/backend/src/features/mcp`

```
apps/backend/src/features/mcp/
├── domain.ts          # McpServerRow 接口
├── ports.ts           # McpServerPort
├── adapter-sqlite.ts  # SQLite 实现
├── service.ts         # createMcpService（CRUD + 连接管理协调）
├── http.ts            # GET/POST/PUT/DELETE /api/agents/:id/mcp-servers
└── index.ts           # barrel
```

### 3.3 DB schema

```typescript
export const mcpServer = sqliteTable("mcp_server", {
  serverId: text("server_id").primaryKey(),
  agentId: text("agent_id").notNull(),
  name: text().notNull(),
  transport: text().notNull(),  // "stdio" | "sse"
  command: text(),              // stdio only
  args: text(),                 // stdio only, JSON array
  env: text(),                  // stdio only, JSON object
  url: text(),                  // sse only
  enabled: integer({ mode: "boolean" }).notNull().default(true),
  createdAt: integer({ mode: "number" }).notNull(),
  updatedAt: integer({ mode: "number" }).notNull(),
}, (table) => [index("idx_mcp_server_agent").on(table.agentId)]);
```

### 3.4 API

```
GET    /api/agents/:id/mcp-servers          -> { servers: McpServerRow[] }  (env 脱敏)
POST   /api/agents/:id/mcp-servers          -> { server: McpServerRow }     (创建 + 异步连接)
PUT    /api/agents/:id/mcp-servers/:serverId -> { server: McpServerRow }    (更新 + 重连)
DELETE /api/agents/:id/mcp-servers/:serverId -> { ok: true }                (删除 + 断开)
```

POST/PUT 后异步调 `mcpClientManager.connect/disconnect`，不阻塞 HTTP 响应。

### 3.5 工具注入

`conversation-compose.ts` 的 `startAgentRun`：
```typescript
const mcpTools = mcpClientManager.getTools(agentId);
const agentConfig = {
  tools: [...defaultTools(cwd), ...cTools, ...mcpTools],
  ...
};
```

`loop/http.ts` 的 `buildConfig` 回调同理。

### 3.6 main.ts wiring

```typescript
const mcpClientManager = createMcpClientManager();

const mcpSvc = createMcpService({
  port: sqliteMcpServerAdapter(db),
  mcpClientManager,
  agentExists: (id) => agentSvc.exists(id),
});

// shutdown
process.on("SIGTERM", () => { ...; mcpClientManager.disconnectAll(); ... });
```

## 4. 前端设计

### 4.1 Agent 详情页新 tab

`/team/[agentId]` 页面加 `mcp` tab，和 `persona` / `skills` / `activity` 并列。

### 4.2 MCP tab 内容

- MCP Server 列表（卡片）：name、transport badge、enabled switch、tools count
- 每个 server 卡片：编辑（name/transport/command+args+env 或 url）、删除
- "Add MCP Server" 按钮 -> 表单弹窗
- 表单根据 transport 切换字段：
  - stdio: command + args（逗号分隔）+ env（key=value 逐行）
  - sse: url

### 4.3 前端 hooks

```typescript
// features/agents/hooks.ts
export function useAgentMcpServers(agentId: string) { ... }
export function useCreateMcpServer(agentId: string) { ... }
export function useUpdateMcpServer(agentId: string) { ... }
export function useDeleteMcpServer(agentId: string) { ... }
```

### 4.4 api.ts

```typescript
listMcpServers: (agentId: string) => unwrap(client.api.agents({ id: agentId })["mcp-servers"].get()),
createMcpServer: (agentId: string, body: { name, transport, command?, args?, env?, url? }) =>
  unwrap(client.api.agents({ id: agentId })["mcp-servers"].post(body)),
updateMcpServer: (agentId: string, serverId: string, body: { ... }) =>
  unwrap(client.api.agents({ id: agentId })["mcp-servers"]({ serverId }).put(body)),
deleteMcpServer: (agentId: string, serverId: string) =>
  unwrap(client.api.agents({ id: agentId })["mcp-servers"]({ serverId }).delete()),
```

## 5. 验收标准

1. `GET /api/agents/:id/mcp-servers` 返回 agent 的 MCP server 列表（env 脱敏）
2. `POST /api/agents/:id/mcp-servers` 创建配置 + 异步连接
3. `PUT /api/agents/:id/mcp-servers/:serverId` 更新配置 + 重连
4. `DELETE /api/agents/:id/mcp-servers/:serverId` 删除配置 + 断开连接
5. MCP server 连接成功后，agent session 可使用其 tools（名字格式 `mcp__{server}__{tool}`）
6. MCP server 连接失败时，agent session 照常创建（缺 MCP tools）
7. MCP tool execute 返回结果给 agent
8. 进程关闭时清理所有 MCP 连接
9. `/team/[agentId]` 有 MCP tab，可 CRUD MCP server 配置
10. typecheck + test + lint 全绿

## 6. 不做的事

- 不做 MCP Server（暴露后端资源给外部 -- ADR 0005 延迟的方向）
- 不做 MCP resource/template（只支持 tool）
- 不做连接自动重试/重连（配置变更才重连）
- 不做 per-session MCP 配置（per-agent 全局）
- 不做活 session 热更（新 session 才用新 tools）
- 不做 MCP tool 权限审批（复用 agent 的 permissionMode）
