# 跨页架构地图

本图展示当前 Product Backend 架构的核心页面关系。

## 核心关系

```mermaid
flowchart LR
  Conversation[Conversation] --> History[Conversation History]
  Conversation --> Context[Agent Context]
  Context --> Run[Agent Run]
  Automation[Task / Cron / Loop] --> Run
  Tools[Product Tools] --> Run
  Run --> Backend[Agent Backends ×4]
  Backend --> Child[coding-agent child]
  Backend --> Cli[claude / pi / omp CLI]
  Workspace[Agent Workspace 文件] --> Child
  Workspace --> Cli
  Backend --> Updates[Live Updates]
  Backend --> Message[Final Message]
  Message --> History
  Message --> Context
  History --> Web[Web / Lark]
  Updates --> Web
```

## 消息路径

```text
Web/Lark input
→ Conversation History
→ trigger + visibility
→ Agent Context refs
→ Agent Run
→ Agent Backend spawn child
→ Live Updates
→ terminal outcome
→ atomic History + Context commit
```

详见：

- `flows/e2e-web-message`
- `runs/output-and-live-updates`
- `conversation/history`
- `agents/context`

## Context Branch 与 Agent Run

```mermaid
flowchart LR
  Context[Agent Context] --> Branch[Context Branch]
  Branch --> Run[Agent Run]
  Run --> Backend[Agent Backend]
  Backend --> Updates[Live Updates]
  Backend --> Message[Final Message]
```

子进程内部的 loop、compaction、todo、ModelRuntime 都是具体执行引擎的实现，不进入公共架构地图。

## 自动化

```mermaid
flowchart LR
  Cron[Cron] --> Run[Agent Run]
  Loop[Loop] --> Run
  Run --> Branch[Context Branch]
  Run --> Backend[Agent Backend]
```

Cron、Loop 选择 Agent 与 Context Branch，但不依赖子进程内部实现。
