# ADR 0012: MCP Client 架构：per-agent 常驻连接 + 预连接缓存

## 状态

Proposed

## 上下文

项目需要让 Agent 运行时连接外部 MCP server，发现其 tools 并作为 `Tool[]` 暴露给模型。这是 MCP Client 角色（不是 MCP Server，ADR 0005 延迟的那个方向）。

当前架构中，外部资源挂载到 agent 有两个先例：

- **Skill Pack**：per-agent 关联表，session 创建时解析为 skill roots，注入 `progressiveSkillPlugin`。
- **模型配置**：per-agent 字段（`AgentRow.modelName`），session 创建时读。

MCP server 配置本质上是**外部工具源**，类似 skill-pack 但粒度是"工具"而非"指令"。核心架构约束：

1. `Tool` 接口（`packages/core/src/tool.ts`）是工具注入的唯一契约。MCP tools 必须适配成 `Tool[]` 才能进入 `spanLoop` -> `model.stream(msgs, { tools })` 管道。
2. `sessionManager.create(config)` 是**同步**的。MCP tool discovery 是异步的（需连 server + listTools）。不能改 session 创建签名，那会波及所有 feature。
3. `validatePlugins()` 对工具名冲突直接抛异常。MCP tool 名由远程 server 定义，不可控。

## 决策

**预连接 + 缓存模式**：MCP 连接和 discovery 在配置变更时（非 session 创建时）异步完成，结果缓存在进程内存。session 创建时同步读缓存拼 Tool[]。连接失败时降级继续（session 照常创建，缺 MCP tools）。

### 配置模型

per-agent 独立表 `mcp_server`，和 `skill_pack` / `agent_skill_pack` 同级。每个 MCP server 记录绑定一个 agent，包含 transport 类型（stdio/SSE）、command+args+env 或 url、enabled 状态。

API：独立 CRUD `GET/POST/PUT/DELETE /api/agents/:id/mcp-servers`，和 skill-packs 模式对齐。

### 连接管理

- **连接时机**：配置变更时（POST/PUT/DELETE MCP server）异步连接 + discovery + 缓存。不阻塞 HTTP 响应。
- **连接生命周期**：per-agent 常驻，到进程结束。agent 归档不断开。
- **discovery 缓存**：配置变更时刷新。不做 TTL 过期，不每 session discovery。
- **连接失败**：降级继续。记日志，session 照常创建，缺该 server 的 tools。
- **进程关闭**：shutdown handler 清理所有连接（stdio 杀子进程，HTTP 关会话）。

### 工具名冲突

MCP tool 名加 server 前缀：`mcp__{serverName}__{toolName}`。彻底防冲突，模型通过名字区分来源。

### SDK 归属

新建 `packages/adapter-mcp` 包，和 `adapter-anthropic` 同级。MCP client 逻辑 + Tool[] 适配器都在这里。backend 通过 barrel 引用。

### 安全

- env（可能含 API key）明文存 DB，API 返回时脱敏（`****`+末4位）。和 `ANTHROPIC_API_KEY` 同策略。
- 复用现有 auth，无额外权限层。

## 后果

- **session 创建签名不变**：`sessionManager.create(config)` 保持同步。MCP tools 通过缓存同步注入，不需要 async 改造。
- **新包 `packages/adapter-mcp`**：引入 `@modelcontextprotocol/sdk` 依赖。backend 依赖 adapter-mcp，adapter-mcp 依赖 core（Tool 接口）。
- **新表 `mcp_server`**：drizzle schema 加表 + migration。
- **agent 工具组装扩展**：`conversation-compose.ts` 和 `loop/http.ts` 的 `startAgentRun` / `buildConfig` 需要从 MCP 缓存读 tools 拼进 `tools: [...defaultTools(cwd), ...mcpTools]`。
- **进程内有常驻子进程**：stdio 类 MCP server 是子进程，数量随配置增长。shutdown handler 必须清理。
- **不热更活 session**：MCP 配置变更后，新 session 用新 tools，活 session 不受影响（和 skill-pack 一致）。

### 考虑过的替代方案

- **Plugin 动态注入**：写 mcpPlugin，beforeRun hook 里异步注入 tools。但 plugin `tools` 是 `readonly Tool[]`，构造时确定，需改 Plugin 接口支持动态 tools。改动 framework 层，波及面大。否决。
- **异步发现 + 直接注入**：session 创建时异步发现 MCP tools。需要改 `sessionManager.create()` 为 async，波及所有 feature 的调用点。否决。
- **全局 MCP 配置**：所有 agent 共享同一组 MCP server。存 settings KV。但 MCP 是 per-agent 的（不同 agent 用不同工具集），全局配置不对齐。否决。

## 关联

- [ADR 0005](./0005-mcp-deferred-for-loop.md) - 延迟的 MCP Server 方向（本 ADR 是 Client 方向，两者独立）
- [CONTEXT.md](../../CONTEXT.md) - MCP Server / MCP Client / MCP Tool 术语定义
- 配套 spec：`docs/superpowers/specs/2026-07-08-mcp-client-design.md`
