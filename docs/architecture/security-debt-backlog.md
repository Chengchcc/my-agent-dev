# Security & Debt Backlog (multi-backend landing review)


登记状态更新至 2026-09-07(全仓安全审计,5 分区并行,全部 P0/P1 修复)。

## 已修(2026-09-07 安全审计)

| ID | 洞 | 修复 |
|---|---|---|
| AUTH-001 (P0) | Elysia 插件作用域 onBeforeHandle 不作用于父实例路由,后端全部 API 无鉴权裸奔(运行时实证) | auth 钩子改为主实例 onBeforeHandle;新增 apps/backend/src/app.test.ts 门禁测试 |
| OMA-MCP-ENVEXPAND (P0) | .mcp.json headers/env 的 ${VAR} 展开任意进程 env,注入 agent 写文件即把 provider key 发往任意 SSE URL | expandEnvVars 改白名单(仅 PRODUCT_TOOLS_RUN_TOKEN) |
| ext:: RCE (P0) | git 安装 URL 直达 git clone,ext:: 传输器 = 安装即 RCE;- 开头 option 注入 | source-fetch assertSafeGitUrl:仅 https/ssh/git@host/绝对路径 |
| OMA-GREP-ARGV (P1) | grep pattern 裸 argv 注入,--pre=cmd 经 ripgrep 执行任意命令且 grep 不进任何门 | rg -e pattern -- path |
| WEB-SSR-AUTH-BYPASS (P1) | 5 个 SSR 直连后端的页面只靠 middleware cookie 存在性检查,伪造 cookie 读全部数据(运行时实证) | (main)/layout.tsx 真实 HMAC/exp 校验;start 绑 -H 127.0.0.1 |
| OMA-MCP-GATEPREFIX (P1) | 挂载 MCP 工具裸名注册,永不匹配 mcp__ 前缀门控,全模式免审批 | 统一注册 mcp__<server>__<tool>;product-tools/knowledge 前缀豁免(产品自主只读面) |
| OMA-EVAL-ASKGATE (P1) | ask 模式高危清单漏 eval;approvalHandler 异常穿透外层 catch 变放行 | HIGH_RISK 加入 eval;ask 分支异常改 fail-closed(对齐 auto 分支) |
| WEB-SSR-AUTH-BYPASS (P1) | 5 个 SSR 直连后端的页面只靠 middleware cookie 存在性检查,伪造 cookie 读全部数据(运行时实证) | middleware 升级为真实 HMAC/exp 校验(readSession edge 安全)+ (main)/layout 兜底;start 绑 -H 127.0.0.1。运行时复测:伪造/畸形/缺失 cookie 全 307,正常登录 200 |
| WF-SAVE-NO-VALIDATION (P1) | PUT 定义不校验即落盘,坏 cron/坏文件清空全部 trigger 且 await sync 卡死启动 | save 前 parseWorkflow;sync 按文件隔离;Bun.cron 逐 trigger try/catch |
| skillpack-sync-fetch (P1) | sync 信任包内 .git/config 的 origin(remote 可改写为 ext::);versionRef 可作 fetch 选项注入 | fetch 固定用 DB 存储 sourceUrl;versionRef 白名单;reset 前复核确认 rev |
| knowledge-builtin (P1) | builtin 安装 name 裸 join,../ 把任意目录拷进知识包再经 files API 读出 | name 段白名单 |
| SYM-004 (P1) | git 克隆不扫 symlink(zip 有);zip 第一层 -Z1 失败 fail-open;symlink 条目解压时先写穿后校验;zip 无配额 | clone 后 validateExtractedEntries;-Z1/-Zl 失败即拒;预检拒 symlink 条目;50k 文件/1GB 配额 |
| plugin-hash (P1) | 插件信任 hash 跳过 symlink 与 node_modules,import 目标不受 hash 约束,批准后可换代码 | hash 覆盖全部条目(symlink 记 link target);loadPluginCode realpath 须落 root 内 |
| marketplace-traversal (P2) | marketplace.json 的 entry.path/pluginName 裸 join,恶意清单 = 任意 cpSync/rmSync | 段白名单 + resolve 包含性(适配 claude catalog 的 /demo 归一化) |
| OMA-WEBFETCH-SSRF (P1) | url-guard 纯 hostname 字符串过滤:尾点/映射 IPv6/CGNAT/0 段/解析到私网均绕过 | IPv4/IPv6 数值区间 + 尾点归一 + assertSafeUrlDeep 逐 hop 解析复查 |
| P2 批次 | artifact safePath 前缀缺分隔符;human-task resolve 竞态(双 drive loop);mergeInputs __proto__ 污染;eval timeout 无上限;sandbox 单发 SIGTERM 不杀树不封顶 stdout;bash 继承全量 env;agent update 跳过 allowed-roots;登录限流信任 XFF;两处 fs catch 回显绝对路径 | 全部就地修复(条件 UPDATE/键过滤/setsid 组杀+SIGKILL 升级+10MB 上限/env 剥离凭据/全局限流桶/泛化错误) |

## 已知保留(威胁模型内接受或需产品决策)

- MCP catalog command 无验证即 spawn(OMA-MCP-SPAWN):等价已接受的 bash 任意执行;增量=持久化+绕过 oma 权限门。修复需产品决策,见 ADR 0026 未决项。
- MCP 凭据明文落盘 workspace/.mcp.json(OMA-MCP-SECRETFILE):完整修复需 backend 侧 secret 注入链路,ADR 0026 网络化准入未决项。
- Monaco 从 jsdelivr CDN 加载:修复需自托管 min/vs 资产,待定;AMD loader 不支持 SRI。
- GET /api/settings 与 /api/mcp-servers/:id 返回明文凭据:单用户配置 UI 设计使然(edit form source of truth);由 token 门把守。
- 后端无 Host/Origin 校验:auth 修复后 rebinding 拿不到 token,风险大幅降级;可加 Host allowlist 作深度防御。
- human answer 不校验 node.form + nextNode 路由覆盖:语义设计问题,待产品梳理。
- workflow script 节点为完整 Bun 进程(非 fs/net jail):文档明示设计;OS 级沙箱按 2026-09-03 BashSandbox 设计 P2-P5 分阶段实施。
登记状态更新至 2026-08-14(分支 `feat/multi-backend-fixes`,13 commits;D5 关闭于 `feat/token-per-run`)。

## 已修(multi-backend-fixes 分支)

- D1 vm codeGeneration 关闭(constructor 逃逸)
- D2 knowledge MCP realpath 归一(根 + 逐文件)
- D3 workspace 路由 root realpath(entries + file 两处)
- D4 workspace override 白名单(workspaceRoot + 托管 agents 目录)
- D5 注释:身份仅防误不防恶(硬绑定留 token-per-run)
- 债务:drizzle-kit 脚本删除(手写迁移唯一)、ADR 注释批量修正(0019/0020)、并发 knob 删除
- knowledge zip 链路核实:features.ts 已接 base64 解码,**非死路**,保留

## 已修(feat/token-per-run 分支,2026-08-14)

- **D5 硬绑定关闭**:per-run token 注册表(SHA-256 键)取代静态 `PRODUCT_TOOLS_SERVICE_TOKEN`;MCP server 只认注册表;静态 token 配置/env 全链删除。`.mcp.json` 仅含 env 名(pi `bearerTokenEnv` / omp `bearer_token_env_var`)+ `${VAR}` 占位符(claude 实测展开),文件零密文。四家送达路径实测矩阵见 spec §3.4。

## 已关闭

- ~~web 死簇清理~~(2026-08-14):P3 落地后 updateAgent/agentKeys/forkSource 均有真实调用方;删除死码 `api.getProject`(零调用方)、修正 `getForkSourceId` 过时的 defensive 注释。

## 待办

(无)
