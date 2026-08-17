# Token-per-run 硬绑定(product-tools MCP)

- 日期:2026-08-14
- 状态:已批准(brainstorming 完成,取舍:全部 per-run 实测驱动;**不保留静态 token 兼容**)
- 分支:`feat/token-per-run`
- 来源:security-debt-backlog.md D5;替代 workspace `.mcp.json` 明文 token

## 1. 问题

Product Tools MCP(ledger 读写、审批)现在用单一静态 token(`PRODUCT_TOOLS_SERVICE_TOKEN`):

1. **落盘泄漏**:workspace-bridge 把 `Authorization: Bearer <token>` 明文写进每个 agent workspace 的 `.mcp.json`(features.ts:528-536)。workspace 里任何文件读取都拿得到。
2. **无归属**:所有 agent、所有 run 共享一个 token,product-tools 审计无法回答「这次调用是哪个 run 发起的」。
3. **无撤销**:token 泄漏只能改 env 重启全栈。

oma 后端已经走 per-run env(`OMA_PRODUCT_TOOL_TOKEN`),但值仍是静态 token;三家 CLI(claude_code/pi/omp)完全依赖 `.mcp.json` 明文。

## 2. 目标与非目标

**目标**
- 每个 Agent Run 一个独立 token:run 结束(任何路径)即刻失效。
- `.mcp.json` 永不含真实密文——静态占位符 + per-run env 注入。
- product-tools 审计可归属到 runId。
- 静态 `PRODUCT_TOOLS_SERVICE_TOKEN` **废除**:MCP server 拒绝一切注册表之外的 token,env 配置项删除。

**非目标**
- 不做 token 加密存储(注册表是进程内 Map,哈希为键)。
- 不改 MCP 传输层(SSE 不动)。
- 不做跨进程/多实例 backend 的共享注册表(当前单进程;升级路径见 §8)。

## 3. 设计

### 3.1 Token 注册表(product-tools 新文件 `run-token-registry.ts`)

```typescript
export interface RunTokenContext {
  readonly runId: string;
  readonly agentId: string;
  readonly exp: number; // epoch ms
}

export function createRunTokenRegistry(opts?: { ttlMs?: number }): RunTokenRegistry;

export interface RunTokenRegistry {
  /** Mint a fresh random token bound to (runId, agentId). */
  mint(ctx: RunTokenContext): string;
  /** Constant-time membership check; returns the bound context or null. */
  validate(token: string): RunTokenContext | null;
  /** Invalidate exactly one run's token (idempotent). */
  revoke(runId: string): void;
}
```

- token = `crypto.randomBytes(32).toString("base64url")`(256-bit)。
- Map 键 = token 的 SHA-256(注册表内存里也不留明文,防 core dump / heap snapshot 泄漏);查找前先哈希再 `timingSafeEqual` 逐候选比对——直接 `Map.has(sha256hex)` 即可,SHA-256 输入是高熵随机值,不需要额外常时措施。
- ~~TTL 兜底~~(B2 修订,2026-08-16 移除):run 生命周期 = mint-at-dispatch / revoke-at-settle,进程内存为弱状态;墙钟 TTL 会静默 401 长于它的合法 run(BACKEND_RUN_TIMEOUT_MS 可配置更长)。
- 容量上限(默认 10_000):超限 mint 抛错。这是防泄漏护栏,不是正常路径。

### 3.2 MCP server 只认注册表(`mcp.ts` 改造)
- `createProductToolsMcpServer` 的 `serviceToken: string` 参数删除,换成
  `tokenRegistry: RunTokenRegistry`。
- 审计盖章:product-tools service 现有审计写点在 callPort 侧;`authorize` 成功后把 `runId` 挂到请求上下文,tools/call 处理器透传给 service 的 audit 字段(一行接线,不新表)。
- 启动即无静态 token 概念;`config.productToolsServiceToken` 与 env `PRODUCT_TOOLS_SERVICE_TOKEN` 删除(见 §3.5)。

### 3.3 铸造与撤销时机(`agent-run/execution.ts`)

- **mint**:`deliverInput` 内、backend execute 之前——`registry.mint({ runId, agentId: run.agentId, exp: now + ttl })`。产物放进 `BackendRunInput.productToolsToken`(新字段,见 §3.4)。
- 一个 run 恒等于一个 input(ADR 005 one-Run-one-input;follow-up 链成新 Run),
  mint/revoke 严格成对:每 run 一次 mint、finally 一次 revoke;follow-up 新 Run
  铸自己的 token,与前任无重叠。

### 3.4 送达路径(四家)

`BackendRunInput`(packages/agent-backend)加可选字段:

```typescript
/** Per-run product-tools bearer. Backends deliver it to their child;
 *  empty = no product tools for this run. */
readonly productToolsToken?: string;
```

| backend | 送达方式 | 实现 |
|---|---|---|
| oma | env `OMA_PRODUCT_TOOL_TOKEN`(现有通道) | `oma-command.ts` 的静态注入删除,改从 run input 取值 |
| claude_code | spawn env `PRODUCT_TOOLS_RUN_TOKEN` + `.mcp.json` 占位符 | adapter `execute()` 把 token 合进 per-run env |
| pi | 同 claude 形态 | 同上 |
| omp | 同 claude 形态 | 同上 |

`.mcp.json` 的 product-tools 条目(bridge 侧,features.ts:528-536)改为:

```json
{
  "name": "product-tools",
  "transport": "sse",
  "url": "…",
  "headers": { "Authorization": "Bearer ${PRODUCT_TOOLS_RUN_TOKEN}" }
}
```

**实测矩阵结果(2026-08-14,真机)**:

| backend | 送达路径 | 结论 |
|---|---|---|
| oma | env `OMA_PRODUCT_TOOL_TOKEN` per-execute(adapter 覆盖 command env) | ✓ 集成测试覆盖 |
| claude_code | `.mcp.json` headers 内 `${PRODUCT_TOOLS_RUN_TOKEN}` 占位符展开 + spawn env | ✓ 真机:claude 2.1.229 对 SSE 连接发送 `Authorization: Bearer <env值>`(首个无凭据探测后全部带 token) |
| pi | `bearerTokenEnv: "PRODUCT_TOOLS_RUN_TOKEN"` 字段(pi-mcp-adapter `resolveBearerToken` → `process.env[name]`) | ✓ 源码级验证(adapter utils.ts:198) |
| omp | `bearer_token_env_var: "PRODUCT_TOOLS_RUN_TOKEN"` 字段(cli.js 读 `Bun.env[name]` → Authorization) | ✓ 源码级验证 |

实现修正:实测发现 pi/omp **不支持** `${VAR}` 字符串展开,改用各自的 env-name 字段。bridge 的 product-tools 条目同时写三种形态(`bearerTokenEnv` + `bearer_token_env_var` 字段 + headers 占位符),各 CLI 读各的;文件完全静态、无密。

**原计划矩阵**(供对照,已由上表取代):
1. CLI 是否展开配置文件里的 `${VAR}`(claude 官方支持;pi/omp 实测)。
2. 展开/env 是否覆盖 SSE headers 的 Authorization。
3. 退路 A:per-invocation 配置覆写(claude `--mcp-config` 内联 JSON;pi `--tools`/adapter 参数;omp 等价 flag)。
4. 退路 B:该家暂保 per-run token 直传 CLI flag(如 omp `--header`)。

### 3.5 配置清理

- `apps/backend/src/config.ts`:`productToolsServiceToken` 字段删除。
- `PRODUCT_TOOLS_SERVICE_TOKEN` env:删除读取。残留 env 不报警——静默忽略即正确(它不再是任何东西的钥匙)。
- `agent-backend/redact.ts` / `adapter-oma-agent/stderr-tail.ts` 的 secret 名单加 `PRODUCT_TOOLS_RUN_TOKEN`(redact 列表保留 `OMA_PRODUCT_TOOL_TOKEN`,两名字都要——oma 通道名不变)。
- bootstrap(features.ts)MCP server 启动条件:`config.productToolsMcpUrl` 单独决定;不再需要静态 token 才起 server。

### 3.6 Bridge(`workspace-bridge.ts`)

`writeMcpConfig` 本身不动(它只写传入的 entry);改动在调用方(features.ts reconcile):product-tools entry 的 headers 换占位符,条件里删掉 `productToolsServiceToken`。

## 4. 数据流(run 起到死)

```text
deliverInput
  → registry.mint(runId, agentId, exp)
  → BackendRunInput.productToolsToken
  → adapter spawn:env PRODUCT_TOOLS_RUN_TOKEN(或 oma 专用名)
  → CLI 读 .mcp.json 占位符 → 展开 → Bearer <per-run token>
  → MCP server authorize:registry.validate → 401/放行(+runId 归属)
dispatchFn finally
  → registry.revoke(runId)  ← complete/abort/timeout/crash 全覆盖
  → 后续同 token 请求 401
```

TTL 已移除(B2):安全边界是 run settle + 进程内存,不是墙钟。
(送达形态按 §3.4 实测矩阵:claude 展开 headers 占位符;pi/omp 读 env-name 字段。)

## 5. 错误处理
- mint 失败(容量满):deliverInput 抛错 → 既有 dispatch catch(run failed + input cancelled + status event)。不静默降级成无 token run。
- CLI 拿不到 env:该家 product-tools 调用 401(显式失败),按 §7 处理,不 fallback 静态 token。
- registry 进程重启:所有活 token 失效;可接受——backend 是单进程真理源,重启 = 所有 run 终结。

## 7. 实测驱动的降级决策(唯一预留的弹性)

若某家 CLI 四条路全不通(不展开 `${VAR}`、env 不达、无 per-invocation 覆写、无 header flag):该家**禁用 product-tools**(reconcile 时不合并 product-tools entry),并在 bootstrap 打一行明确告警。**绝不**回退静态 token——用户已裁决不兼容。

## 8. 升级路径(本期不做)

- 多实例 backend:注册表换 SQLite 表或共享缓存(接口已隔离在 `RunTokenRegistry`)。
- 跨 run 复用(会话级 token):TTL 语义改会话;非本期。

## 9. 验收清单

- [ ] `grep -rn "productToolsServiceToken" apps/backend/src` 零命中(测试除外)
- [ ] `.mcp.json` 内容无任何真实 token(grep 工作区文件只有占位符)
- [ ] registry 单测 + MCP 401 矩阵绿
- [ ] execution 集成:per-run 唯一性 + settle 后 401
- [ ] 四家实测矩阵结论写回本文档 §3.4 表格
- [ ] 全仓 typecheck/lint/test + audit 14/14 绿
