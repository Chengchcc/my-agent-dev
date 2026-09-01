# web

系统的 Next.js 控制台,是后端面向人的主要入口。它把后端的 HTTP/SSE API 包装成一个可视化的工作台:既能管理 agent、进行多方对话,也能在 ops 观测面里查看运行、成本、trace 与各 surface 的健康状态。浏览器从不直接连后端,所有请求都经由应用自身的 BFF 代理转发。

## 它负责什么 / 解决什么问题

web 是一个纯前端 surface,自己不持有业务状态,所有数据都来自后端。它解决的是"让人能操作和观察这套多 agent 系统"的问题,主要分两块:

- **对话与 agent 管理**:列出与创建 agent、编辑模型/权限/身份(SOUL、USER)与 Lark 配置;在会话画布里和一个或多个 agent 多方对话,实时看到流式输出、推理过程、工具调用与审批、todo 进度,并用 @mention 触发指定 agent 接力。
- **ops 观测面**:面向运维的只读视图,汇总运行列表与详情诊断、需要关注的异常、token/成本趋势、按 agent 的运行时状态、分布式 trace 瀑布,以及 Lark bot 等 surface 的健康情况。

此外它承担一层薄薄的鉴权与代理:基于 cookie 的会话登录,以及把浏览器请求安全转发到后端的 BFF。

## 关键构成 / 怎么组织的

页面用 Next.js App Router 组织在 `src/app/` 下,并按访问性质分组。`(auth)` 分组是公开的登录页;`(main)` 分组是登录后的主体,套着 `AppShell` + `ShellProvider` 布局,里面又分成两片区域:一片是工作区(`agents`、`agents/[id]`、`conversations/[id]`)对应对话与 agent 管理,另一片是 `ops/` 子树(`ops`、`ops/runs`、`ops/runs/[runId]`、`ops/agents`、`ops/agents/[agentId]`、`ops/traces`、`ops/traces/[traceId]`、`ops/surfaces`)对应观测面。根路径 `/` 直接重定向到 `/agents`。

BFF 代理是这个应用的关键中间层。`src/app/api/bff/[...path]/route.ts` 捕获所有 `/api/bff/*` 请求,先校验会话 cookie,再交给 `src/lib/bff.ts` 的 `proxyRequest` 转发到后端:它注入后端鉴权 token 与用户标识、剥掉 hop-by-hop 头,并对 `stream` / `events` 结尾的路径做 SSE 透传。这样浏览器永远拿不到后端凭证。前端统一通过 `src/lib/api.ts` 的 `apiFetch`(带 `/api/bff/` 前缀)发起类型化请求,401 时自动跳登录。鉴权本身在 `src/app/api/auth/*` 与 `src/lib/auth.ts`、`src/lib/session.ts` 里,基于 cookie 的会话。

会话界面的实时性靠 `src/hooks/useConversation.ts`。它用 TanStack Query 拉取会话快照做引导,再开一个 `EventSource` 订阅 `/api/bff/conversations/<id>/events`,把账本消息、成员变更、系统通知等事件喂给 `src/lib/conversation-reducer.ts` 的 reducer;reducer 维护消息列表、当前 run 的草稿/阶段、连接状态与待审批的工具调用等 UI 状态。渲染层由 `ConversationCanvas`、`Timeline`、`MessageBubble`、`Composer`(含 @mention)、`ReasoningTrace`、`ToolApprovalCard`、`TodoPanel` 等组件组成。ops 观测面的展示组件集中在 `src/components/ops/`(如 `RunOpsTable`、`TraceWaterfall`、`CostBreakdownChart`、`HealthSummary` 等),数据同样走 TanStack Query 并定期 refetch。

## 怎么跑起来

开发模式(监听 127.0.0.1:3001):

```
bun run dev
```

其它脚本:`bun run build`(next build)、`bun run start`(next start)、`bun run test`(bun test)、`bun run typecheck`。

运行需要两个环境变量供 BFF 连接后端:`BACKEND_URL`(后端基址,如 `http://127.0.0.1:3000`)和 `BACKEND_TOKEN`(BFF 注入的后端鉴权 token,需与后端的 `BACKEND_AUTH_TOKEN` 一致);二者缺失时代理会直接报错。登录所用的口令与用户可由 `MOCK_PASSWORD`、`MOCK_USER_ID` 配置(默认 `admin` / `user-001`)。

## 数据取数边界

- **首屏不需要 SEO 或服务端直读**：一律用客户端 React Query（`features/*/hooks.ts` + `queries.ts`），通过 BFF 的 `/api/bff/...` 取数。
- **需要服务端直读 backend**：用 Server Component + `createServerClient`（见 `workflows/page.tsx`）。
- **mutation 一律客户端**：写操作永远在 client 组件里触发，服务端组件只做读。

## 依赖与对接

应用不依赖任何工作区内部包,是一个独立前端。它构建在 Next.js 15 / React 19 之上,UI 用 Tailwind CSS 4、shadcn 与 `@base-ui/react`,数据层用 `@tanstack/react-query`,Markdown 渲染用 `react-markdown` + `remark-gfm`,图表用 `recharts`,另有 `sonner`(toast)、`next-themes`(主题)、`lucide-react`(图标)。对接对象只有一个:经由 BFF 代理访问的 backend 服务。
