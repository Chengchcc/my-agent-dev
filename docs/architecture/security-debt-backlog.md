# Security & Debt Backlog (multi-backend landing review)

登记状态更新至 2026-08-14(分支 `feat/multi-backend-fixes`,13 commits)。

## 已修(本分支)

- D1 vm codeGeneration 关闭(constructor 逃逸)
- D2 knowledge MCP realpath 归一(根 + 逐文件)
- D3 workspace 路由 root realpath(entries + file 两处)
- D4 workspace override 白名单(workspaceRoot + 托管 agents 目录)
- D5 注释:身份仅防误不防恶(硬绑定留 token-per-run)
- 债务:drizzle-kit 脚本删除(手写迁移唯一)、ADR 注释批量修正(0019/0020)、并发 knob 删除
- knowledge zip 链路核实:features.ts 已接 base64 解码,**非死路**,保留

## 待办

- **D5 硬绑定**:product-tools 的 token-per-run 注入(编译期),替代 workspace 广播的 `.mcp.json` 明文 token。设计级,独立分支。
- ~~web 死簇清理~~(2026-08-14 关闭):P3 落地后 updateAgent/agentKeys/forkSource 均有真实调用方;删除死码 `api.getProject`(零调用方)、修正 `getForkSourceId` 过时的 defensive 注释。
