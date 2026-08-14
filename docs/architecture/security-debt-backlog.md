# Security & Debt Backlog (multi-backend landing review)

阶段 D 与债务项——排期清单。已修项见分支提交;本文件登记待办。

## D2-D5 安全(出了 demo 期必须排期)

- **D2 knowledge MCP 路径归一**:`knowledge/mcp-server.ts` 的 `inside()` 是纯词法 + `statSync` 跟 symlink——zip/pack 带 symlink 时模型可读宿主文件。修法:realpath 归一再前缀判(与 workspace/file 同构)。
- **D3 workspace/file realpath 对未归一 root**:`agent/http.ts` 的 root 未 realpath(macOS `/tmp` 下合法文件全 403)+ entries 路径缺 realpath 防线。修法:root 也 realpath 再前缀判。
- **D4 workspace 路径任意写**:`agent/service.ts` HTTP-create 接受任意绝对路径。修法:白名单 `BACKEND_WORKSPACE_ROOT` 之下 + 可配 allowlist。
- **D5 product-tools 身份降级 + .mcp.json 明文 token**:身份四元组仅防误不防恶(注释标明);token 短期编译期 token-per-run。

## 债务(打包一次清)

- drizzle meta 断档(快照停 0022):决定弃用 drizzle-kit、删 package script(团队已走手写迁移),或补 generate 恢复。
- ~15 处注释把 cliSessionRef/agent.yml 引用到错误 ADR(0002/0003):批量改到 0019/0020。
- knowledge zip 死路(`install.ts` throws 且 http 无入口):接 route 或删 sourceKind。
- web 死簇:api.ts 的 useMcp*/update* 无调用方、forkSource 过期注释、`['agent', id]` invalidate 键 prefix 错——删。
