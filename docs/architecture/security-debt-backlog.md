# Security & Debt Backlog (multi-backend landing review)

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
