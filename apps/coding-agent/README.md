# @my-agent-team/coding-agent

Coding Agent 是本仓库自研的 Agent 执行引擎：一个无 UI 的一次性 CLI，被 Product Backend 的 Adapter（`@my-agent-team/adapter-coding-agent`）按 **每个 Agent Run** spawn 一次。

```text
Product Backend → Agent Run → Adapter → spawn coding-agent --mode rpc
→ per-Run Runtime → BackendRunOutcome → stdout → child 退出
```

**不是 daemon**：一个 Run = 一个子进程 = 一个 Runtime = 一个 outcome。没有常驻进程、没有 session supervisor、没有 worker pool。

## CLI 模式

| 模式 | 用途 |
|---|---|
| `print` | 一次 Run；stdout 只有 final assistant text；stderr 日志；非零退出码表示失败 |
| `json` | 一次 Run；stdout 全部事件 JSONL + 恰好一个 terminal outcome 行 |
| `rpc` | 每 Run 一次 `execute` + 可选的 `steer`/`abort`；命令走 stdin，`event`/`outcome`/`response` 走 stdout（严格 LF JSONL，stdout 只承载协议） |

`--mode rpc` 是 Adapter 使用的模式。协议 schema 与事件/outcome mapping 定义在契约包 `@my-agent-team/agent-backend`，两侧共用同一份。

## Runtime

`createCodingAgentRuntime()`（`src/core/create-runtime.ts`）构造一个 Runtime = 一个 Run：

- `run(input)` 返回唯一 segment，其 `outcome` 是 Run 的唯一终态；
- `steer(input)` 注入 live loop；`stop()` 中止；
- `close()` 拆除 MCP clients 与 SessionStore。

Runtime 内部由 `packages/agent` 提供：CodingAgentSession（model/tool loop、retry、compaction、插件、todo）与 in-memory SessionStore。seed 时把 **full Product history + meta + input** 原子写入，Run 结束即销毁。

## 运行

```bash
bun run dev -- --mode print --prompt "hello"     # 本地试跑
bun run --cwd apps/coding-agent test             # 单测（print/json/rpc 模式）
```

正常由 Backend 通过 `CODING_AGENT_BIN` 环境变量定位二进制并 spawn；开发调试也可直接 `bun src/main.ts --help`。

## 目录

```
src/
  main.ts                CLI 入口（模式分发）
  cli/                   print/json 模式、初始输入构建
  modes/                 print-mode / json-mode / rpc-mode
  core/                  create-runtime.ts（per-Run Runtime 装配）、fake-provider（测试）
```

## 相关文档

- [架构 Wiki — Coding Agent](docs/architecture/runtime/coding-agent.md)
- [Agent Backend 协议](docs/architecture/execution/agent-backend.md)
