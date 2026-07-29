# 跨页架构地图

本图展示目标 Product Backend 架构的核心页面关系。

## 核心关系

```mermaid
flowchart LR
  Conversation[Conversation] --> History[Conversation History]
  Conversation --> Context[Agent Context]
  Context --> Run[Agent Run]
  Automation[Task / Cron / Loop] --> Run
  Tools[Product Tools] --> Run
  Run --> Backend[Agent Backend]
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
→ Agent Backend
→ Live Updates
→ terminal outcome
→ atomic History + Context commit
```

详见：

- `flows/e2e-web-message`
- `runs/output-and-live-updates`
- `conversation/history`
- `agents/context`

## Context Branch 与 Agent Backend

```mermaid
flowchart LR
  Context[Agent Context] --> Branch[Context Branch]
  Branch --> Run[Agent Run]
  Run --> Backend[Agent Backend]
  Backend --> Updates[Live Updates]
  Backend --> Message[Final Message]
```

Execution session、projection、transport、MCP、Worker 和 ModelRuntime 都是具体 Backend 的内部实现，不进入公共架构地图。

## 自动化

```mermaid
flowchart LR
  Task[Task] --> Run[Agent Run]
  Cron[Cron] --> Run
  Loop[Loop] --> Run
  Run --> Branch[Context Branch]
  Run --> Backend[Agent Backend]
```

Task、Cron、Loop 选择 Agent 与 Context Branch，但不依赖某个具体执行引擎。
