# 跨页架构地图

这张地图把各页之间的依赖关系画出来，方便从任意一页快速跳到它的上下游。

## 核心事实图

```mermaid
flowchart LR
  SO[system-overview] --> FP[foundations/facts-and-projections]
  FP --> Ledger[conversation/ledger]
  FP --> CE[checkpointer/checkpoint_events]
  AG[harness/harness - Agent] -->|onEvent 消息回调| Ledger
  RL[agent runtime - span-loop] -->|appendEvent 按 spanId| CE
  CP[backend/conversation-projection] -.best-effort fan-out.-> Ledger
  Ledger --> Web[surfaces/web]
  Ledger --> Lark[surfaces/lark-adapter]
```

## 执行图

```mermaid
flowchart LR
  AG[harness/harness - Agent] --> FW[runtime/framework]
  FW --> CM[runtime/context-manager]
  FW --> PL[runtime/plugin]
  PL --> M[plugins/fs-memory]
  PL --> PS[plugins/progressive-skill]
  PL --> TG[plugins/task-guard]
  CM --> AG
  AG --> P[persistence ports]
```

## Web 路径

`flows/e2e-web-message` -> `surfaces/web` -> `conversation/ledger` -> `harness/harness`（Agent 的 onEvent 回调直写账本）；非消息执行事件旁路由 span-loop 写入持久化端口的 `checkpoint_events`（按 spanId），`backend/conversation-projection` 仅做 best-effort fan-out。

## 飞书路径

`flows/e2e-lark-message` -> `surfaces/lark-adapter` -> `conversation/conversation-and-members` -> `harness/harness`（Agent）-> `backend/conversation-projection`。

## 排障路径

`operations/troubleshooting` 把症状指回正确的事实层：账本、会话消息流、Agent、Web 或飞书投递。

## 协作设计图

```mermaid
flowchart LR
  Issue[foundations/issue] -->|按 status 分组的视图| Kanban[Kanban 看板]
  Issue -->|projectId 归属| Project[Project = git 子目录]
  WF[foundations/issue-workflow] -->|演进设计| Issue
  WF -->|演进设计| Orch
  Orch[backend/orchestrator] -->|固定转移表 + status 回填| Issue
  Orch -->|复用运行| AG[harness/harness - Agent]
  Cron[foundations/cron-job] -.同级触发型实体.-> Issue
  Cron -->|Bun.cron 到点 dispatch| AG
  Flow[flows/e2e-issue-lifecycle] -.串起时间线.-> Orch
```
