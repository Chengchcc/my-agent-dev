# Backend Kinds — Gate 0 协议面核实记录

> 状态: **已完成**(2026-08-12)。决策见 §7;四个 kind(coding_agent / claude_code / pi / omp)均已实现并接线,见 ADR 0019 与各 adapter 包。本文件保留协议事实与 wire 证据。
> 目标: 多 coding-agent backend(claude / pi / omp)切换前的协议面核实。本文件只记实测事实与映射点,不产码。

## 0. 本机环境实测

| 项 | 结果 |
|---|---|
| `claude` | `/usr/bin/claude`(npm 全局 @anthropic-ai/claude-code),**2.1.165 → 2.1.228**(2026-08-12 经 npmmirror 升级)。**API 面零变化**: stream-json 全套 flag、wire 事件型录(init/assistant/result/thinking_tokens)与 2.1.165 同构 |
| `pi` | **已装** `@earendil-works/pi-coding-agent@0.84.1`(全局 bun,bin=`pi`)。真机 wire 已抓(2026-08-13): 事件型录与源码/solo parser 一致,另有 `agent_settled`(忽略即可);`--session <path>` 写+续实锤(第二轮 cacheRead 载入、上下文答对);bash 工具调用 ✓。产品栈 E2E(对话→工具→session 续接→stop→aborted)全绿 |
| `omp` | **已装** `@oh-my-pi/pi-coding-agent@17.2.15`,bin=`omp`(注意:与 `pi` 是两个产品) |
| 模型通路 | `DEEPSEEK_API_KEY` 已设;omp 走 `deepseek/deepseek-v4-flash`(api=openai-completions)实测通;claude 本机自带 deepseek-v4-pro 凭据实测通 |

## 1. claude(stream-json)

**调用形状**(实证可用): `claude --output-format stream-json --input-format stream-json --verbose -p` + stdin 一行 `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}`。`--input-format stream-json` 官方注明 only works with `--print`。

**事件清单**(实测 203 行):

| 类型 | 载荷要点 | 映射 |
|---|---|---|
| `system`/`hook_started`,`hook_response` | — | 忽略 |
| `system`/`init` | `session_id`,`tools[]`,`cwd` | 记录 session_id;工具面提示 |
| `system`/`thinking_tokens` | 高频(实测 197 条,deepseek-v4-pro 思考流) | 忽略(未知 subtype 一律忽略,向前兼容) |
| `assistant` | `message.content[]`: `thinking`/`text`/`tool_use{id,name,input}`;`message.usage{input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens}`;`model` | text→`text_delta`,thinking→`thinking_delta`,tool_use→`native_tool_started`;usage 累计点之一 |
| `user` | `message.content[]`: `tool_result{content,is_error,tool_use_id}` | →`native_tool_completed` |
| `result` | `subtype:"success"`, `result`, `is_error`, `session_id`, `total_cost_usd`, `usage`, **`modelUsage{model:{inputTokens,outputTokens,...}}`** | 终态+usage 权威点 |
| `error` | `error_text` | 终态 failed |

**usage 权威点**: `result.modelUsage`(按 model 分键)。**终态信号**: `result`(is_error 区分 failed/success)/ `error` / 进程退出。**abort**: 直接 kill 进程(协议内无 abort)。

**本地限制(实测)**:
- root 下 `--permission-mode bypassPermissions` 被拒(`--dangerously-skip-permissions cannot be used with root/sudo`)。
- 默认权限下工具可执行,但 shell 输出重定向被沙箱挡(`may only write to files in the allowed working directories`);Write 等工具不受影响。
- 未测 `--resume <sessionId>` 续接与 `--fork-session`(solo 的 blocklist 抄自 claude.go:974-986,含 --output-format/--input-format/--permission-mode/--disallowedTools/--max-turns/--resume/-r/--continue/-c/--session-id/--fork-session)。

## 2. pi(@earendil-works,未真机)

**调用形状**(solo pi.go:315-339,与 pi 源码 args.ts 一致): `pi -p --mode json --session <path> [--provider X] [--model Y] --tools read,bash,edit,write,grep,find,ls [--append-system-prompt S] <prompt>`。blocked args: `-p/--print/--mode/--session`。

**事件清单**(自源码确认,agent-session.ts `_emitExtensionEvent`;solo pi.go parser 与之吻合):

| 类型 | 载荷 | 映射 |
|---|---|---|
| `agent_start` / `agent_end{messages}` | — | 忽略 / 尾部可作全量消息源 |
| `turn_start` / `turn_end{message,toolResults}` | message 含 `model`,`usage{input,output,cacheRead,cacheWrite,totalTokens}` | usage 提取点(solo 此处提取) |
| `message_start` / `message_end{message}` | 完整消息对象 | message_end 的 assistant 消息是终态文本兜底 |
| `message_update{assistantMessageEvent}` | delta 流: `text_delta`/`thinking_delta` 等 | →`text_delta`/`thinking_delta` |
| `tool_execution_start{toolCallId,toolName,args}` | — | →`native_tool_started` |
| `tool_execution_update` | partialResult | 忽略 |
| `tool_execution_end{toolCallId,toolName,result,isError}` | — | →`native_tool_completed` |
| `auto_retry_end{success,finalError}` | — | 失败信息兜底 |

**session**: `--session <path|id>`(args.ts:106)写+续;session-manager.ts:821 保留显式 path。**fork = cp 文件 + `--session <副本路径>`**(未真机验证)。**usage 提取点**: `turn_end.message.usage`。**终态**: 进程退出(scanner EOF)+ 退出码;**abort**: kill。

## 3. omp(@oh-my-pi,已真机)

**调用形状**(实测): `omp -p --mode json [--session <path>] [--model M] [--provider P] [--tools ...] <prompt>`。`--session` 不在 help 但被接受(写会话文件);续接用 `-r/--resume <path|id|prefix>`。`--provider` 标记 legacy 但可用。

**事件清单**(实测 130 行 tool run 普查):

| 类型 | 载荷 | 映射 |
|---|---|---|
| `session{version,id,timestamp,cwd}` | 首行 | 忽略 |
| `agent_start` / `agent_end{messages,isTerminal}` | — | 忽略 |
| `turn_start` / `turn_end{message,toolResults}` | message 含 `usage{input,output,cacheRead,cacheWrite,totalTokens,cost}`、`stopReason`;toolResults 数组 | 终态兜底 + usage 提取点之一 |
| `message_start` / `message_end{message}` | 完整消息对象;**message_end 的 assistant 消息含 usage** | **usage 权威点**(比 solo 的 turn_end 提取更稳) |
| `message_update{assistantMessageEvent:{type:thinking_start/thinking_delta/thinking_end/text_start/text_delta/text_end,contentIndex,delta}}` | delta 流 | →`text_delta`/`thinking_delta` |
| `tool_execution_start{toolCallId,toolName,args}` / `tool_execution_update` / `tool_execution_end{toolCallId,toolName,result,isError}` | — | →`native_tool_started`/`native_tool_completed` |
| `error` | 未触发过(failure 面未测) | → failed 兜底 |

**session 续接实测 ✓**: `cp 会话文件 → omp -r <副本> -p --mode json` 成功续上下文(usage cacheRead=21120 证明历史载入,同一 session id)。**fork = cp + `-r`**。**usage 提取**: `message_end.message.usage`(含 cost)。**终态**: 进程退出 + `agent_end`;**abort**: kill。

**MCP(全量对齐的关键)**: omp 支持项目级 `mcp.json`(cwd 下 `mcp.json`/`.mcp.json`,agent-plugins.org 格式 `{$schema, mcpServers}`,与 claude `--mcp-config` 同一格式;另有用户级 `~/.claude/mcp.json` 兜底)。transport 带 `type` 字段(stdio/sse)。→ 产品工具注入: 向 workspace 写 `mcp.json` 即可,无需额外 flag。

**pi 的 MCP 通路**: 官方扩展市场包 [`pi-mcp-adapter@2.23.0`](https://github.com/nicobailon/pi-mcp-adapter)(`pi install npm:pi-mcp-adapter`)。机制是**一个 proxy 工具(~200 tokens)按需拉起 MCP server**,读标准 `.mcp.json`(cwd 或 `~/.config/mcp/mcp.json`),依赖 @modelcontextprotocol/client 2.0.0。→ pi 产品工具注入 = 扩展 + workspace `.mcp.json`;agent 经 proxy 工具发现/调用产品工具(与 claude/omp 的直接挂载不同,是间接面)。

## 4. 事件→CoreBackendEvent 映射总表(提案,grill 后定)

| CoreBackendEvent | claude | pi | omp |
|---|---|---|---|
| `text_delta` | assistant.content[text] | message_update.text_delta | message_update.text_delta |
| `thinking_delta` | assistant.content[thinking] | message_update.thinking_delta | message_update.thinking_delta |
| `native_tool_started` | assistant.content[tool_use] | tool_execution_start | tool_execution_start |
| `native_tool_completed` | user.content[tool_result] | tool_execution_end | tool_execution_end |
| `status` | system(init 起) | — | — |
| usage 提取 | result.modelUsage + assistant.usage | turn_end.message.usage | **message_end.message.usage** |
| 终态信号 | result/error/退出 | 退出+码 | agent_end/退出 |
| abort 语义 | kill | kill | kill |

**注**: 三家 CLI 都无协议内 abort;`stop()` = kill 子进程(与 coding_agent 的协议内 abort 不同 → contracts 测试需按 backend 参数化)。

## 5. 仓库现状核对(§0 地基 + S1 触点,全部核实)

| 触点 | 现状 |
|---|---|
| `transport.ts` 两处 kind literal | 实为 `z.literal("coding_agent")`(transport.ts:29,162 待核行号;S1 改 union) |
| `execution.ts:97` 单一 backend | `AgentRunExecutionDeps.backend: CodingAgentBackend` + `modelCatalog: CodingAgentModelCatalog`;类型硬编码散布: LiveRun(119-121)、forwardEvents(225)、buildRunInput(266)、`run.modelRef as BackendModelRef<"coding_agent">`(272)、deliverInput(293)、assertModelAvailable(237-247,错误文案也写死 "Coding Agent catalog") |
| `resolveModel` 硬编码 | **两处**: `bootstrap/features.ts:469`(loopRoutes)+ `cron/scheduler.ts:161` |
| `/api/models` 聚合 | `features.ts:479-495` list 回调(单一 coding-agent catalog)+ `models/http.ts groupByProvider`(只按 provider 分组,无 kind 维度) |
| agents 表 | `agent/domain.ts:56-68 agentModelRef()` 硬编码 kind;`agents` 表无 backendKind 列 |
| 分支 kind 钉住 | ✓ 已有:`agent_context_branch.backend_kind`(schema.ts:381)、`forkBranch` 支持 backendKind 覆盖(adapter-sqlite.ts:389)、`validateEntry` model_change 校验 kind(domain.ts:140-143) |
| **迁移号** | 实际最新 `0023_drop_agent_model_base_url.sql` → 新列为 **0024**(handoff 写 0023,错) |
| 契约测试 | `contracts.test.ts` 是类型级契约 + FakeBackend 行为测试,参数化可行(steer/stop 断言需按 kind 放宽) |
| web | `(main)/chat/page.tsx handleCreate` 硬编码 `agentId:"default"`(risk 3 属实);`AgentForm.tsx` 有 provider/model 选择(useModelList→providers→groupByProvider),加 Backend 选择器有现成模式 |
| commitlint | scope-enum 已有 `agent-backend`/`adapter-coding-agent`;新增 adapter 包需加 scope |

## 6. 与 CONTEXT.md 的冲突(必须显式处理)

- **不变量 9**: "每个 Run 是 full Product Context projection;无跨 Run session/resume/daemon" — D4 直接打破(claude/pi/omp 依赖 CLI session 续接,run 输入不是全量投影)。
- 术语: Context Branch 定义含 "不是执行 session";CLI session 概念需要独立词条。
- "Coding Agent 不是 daemon(无常驻进程)" — claude 若选常驻进程形态则部分失效。

## 7. 决策记录(grill 已定,2026-08-12)

| # | 决策 | 值 |
|---|---|---|
| 1 | adapter 组织 | **独立双包**: `adapter-pi-agent` + `adapter-omp-agent`(mapper 同源但各自落盘,协议各自演进) |
| 2 | claude 形态 | **per-turn `-p --input-format stream-json` + `--resume <sessionId>`**;steer=下一条输入(与 pi/omp 同构) |
| 3 | 产品工具 | **全量对齐**(claude `--mcp-config` / omp workspace `mcp.json`);**pi 无 MCP → 待定**(降级 or registerTool extension) |
| 4 | 顺序 | **S1 + omp 先行**(本机唯一全链路真机可验);pi 装好后共享 mapper 补验;claude fake 先行 + 受限真机 |
| 5 | claude E2E | 先升最新镜像版(2.1.228,API 零变化已核),再定真机姿态 |
