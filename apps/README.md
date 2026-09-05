# Apps

`apps/` 是面向用户的 surfaces 层:用户从这里接触系统。真正有状态的核心是 `backend`——它持有会话、ledger、run 调度和 agent 生命周期;`web`、`lark-bot` 都是不持久化会话状态的接入端,各自把一种界面(浏览器、飞书)桥接到 backend,统一通过 HTTP + SSE 对话。

## 各应用一句话

- [`backend`](./backend/):有状态核心(L5)。提供 REST API、SSE 事件流、run 调度与 conversation/ledger,统管 agent 生命周期,并拉起/管理 lark-bot 实例。
- [`web`](./web/):浏览器观测与管理界面。Next.js 应用,经 BFF 代理把请求转发到 backend(注入鉴权头),用于查看会话、管理 agent。
- [`lark-bot`](./lark-bot/):飞书/Lark 桥接进程。把 IM 事件转发给 backend,订阅 run/会话事件并渲染卡片回推飞书,卡片失败时降级为文本;每个 agent 一个进程。

## 怎么跑起来

```bash
# 核心(其他 surface 多数依赖它)
cd apps/backend && ANTHROPIC_API_KEY=sk-... BACKEND_AUTH_TOKEN=dev bun run src/main.ts

# 浏览器界面
cd apps/web && BACKEND_URL=http://localhost:3000 BACKEND_AUTH_TOKEN=dev bun run dev
```

各应用的参数、环境变量与内部数据流详见其子目录 README。
