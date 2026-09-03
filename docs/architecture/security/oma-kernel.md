---
id: security.oma-kernel
title: oma 内核安全面（洞察）
status: current
owners: architecture
last_verified_against_code: 2026-09-03
summary: "oma 安全模型的特征是纵深极深、边界有意识留白：路径逃逸防到中间目录 symlink、插件信任防到内容哈希、审批防到超时 deny、SSRF 防到云元数据地址——但 bash 只约束 cwd 不约束命令语义、URL guard 不校验解析后 IP。这不是疏漏,是 ADR 0026『single-user local / agents semi-trusted』定位下的正确残余风险;网络化部署会系统性推翻该前提。"
depends_on:
  - ADR 0026
used_by:
  - security.overview
---

# oma 内核安全面（洞察）

> 定位:oma 运行时内核的安全面——工具沙箱、URL guard、审批 pipeline、插件信任链、
> 凭据防泄漏。以 ADR 0026 的「single-user local / agents semi-trusted」为基准定位。
> 本页是决策支持(为什么),不是现状清单(见 [security/overview](./overview.md)),
> 也不是实施方案(见 [superpowers/specs/2026-09-03-bash-sandbox-design.md](../../superpowers/specs/2026-09-03-bash-sandbox-design.md))。
> 所有判断于 2026-09-03 对照代码核实;两处与早先分析的差异已修正(见 §2 修正记录)。

## 一句话结论

**oma 的安全模型是「设计上克制、且已有清晰防线」的——但所有防线都默认
「semi-trusted、本地、单人」这个前提。** 安全投入已覆盖「提示注入外泄」
「跨进程凭据泄漏」「路径逃逸」三类核心威胁;但「网络化部署(LAN/hosted)」
会把三处「可接受的残余风险」升级成「真实攻击面」。

## 安全面全景(代码里实际存在的防线)

### WorkspaceSandbox——强,教科书级路径逃逸防护

`apps/oh-my-agent/src/core/tools/workspace-sandbox.ts`:

- `validate()`:路径在 root 内 + 已存在文件做 realpath 检查(防 symlink 逃逸);
- `validateNew()`:创建新路径时向上走到最近已存在父目录查 realpath(防中间目录 symlink);
- `validateCwd()`:bash 的 cwd 必须在沙箱内。

**边界(来自 bash.ts)**:`bash` 只校验 cwd 在沙箱内,不约束命令语义——
`Bun.spawn(["bash","-c",command])` 的 cwd 受限,但命令可以 `cat /etc/passwd`、
`curl 内网`。ADR 0026 明确将其列为 LAN/hosted follow-up:
"bash tool command constraints beyond cwd checks"。

判断:WorkspaceSandbox 保护**文件工具**的路径逃逸,保护不了 **bash 的任意命令执行**。
单人本地(自己攻击自己的机器)成立时这是 OK 的;网络化后是被提示注入的 agent
摸到宿主机文件系统的通道。

### URL guard——强,两处已知缺口

`apps/oh-my-agent/src/core/tools/url-guard.ts`:

- 只允许 `http:`/`https:`(挡 `file:`/`data:`/`gopher:` 等 SSRF 协议);
- 阻止私有主机:`localhost`/`127.0.0.0/8`/`10.0.0.0/8`/`192.168.0.0/16`/
  全量 `172.16.0.0/12`(逐前缀枚举)/`169.254.169.254`(云元数据)/IPv6 `fc`/`fd`/`::1`。

缺口 1(**DNS rebinding,已验证存在**):`assertSafeUrl` 校验的是解析前的
hostname 字符串,不校验实际连接的 IP——公网域名可以在校验后解析到内网地址。

缺口 2(**redirect——半缺口,已验证**):guard 本身不校验 redirect 链
(web-ports.ts 注释:redirect 归注入的 port 实现),**但默认注入的
`createStdWebFetchPort()` 在 redirect walk 里对每一跳重新过 `assertSafeUrl`**
(web-ports-std.ts,manual redirect + 逐 hop 校验)。所以默认配置是安全的;
风险只在「替换 port 实现且不逐 hop 校验」时存在。未来网络白名单进入 BashSandbox
设计时,同样的「逐 hop 校验」纪律必须写进 port 契约。

### 审批 pipeline——设计正确,fail-closed 一致

`apps/oh-my-agent/src/core/runtime/approval.ts`:

- `ApprovalRequest.source` 三种:`"permission"`(ask-mode gate)/`"tool"`
  (工具 options.request)/`"classifier"`(auto-mode block 升级给人);
- print/json 无交互 → `denyAllApprovals` 一律 deny;
- 静默超时 → `withApprovalDeadline` deny;
- rpc 走 wire(backend 转发 approval_request → resolve_approval)。

任何「人不在场」的情况都 fail 到 deny,无默认放行漏洞。

### native 工具 permission gate——内核已强制(2026-08-26 起更新)

**修正**:早先分析称「native 工具 permission gate 依赖后端注入,oma 内核不强制」
——这在 2026-08-26(4633e9af)之前成立,现在已过时。当前内核
(`run-runtime.ts` 的 `makeSessionPermissionGate`):

- `HIGH_RISK_NATIVE_TOOLS = {bash, write, edit, create_file, mcp__*}` 在
  ask/deny 模式下走 gate;ask 无 approval pipeline 时 fail-closed 阻断;
- auto 模式:`classifierGated`(bash/eval/mcp__*/plugin code tools)过分类器,
  且 fail-closed 端到端(600afddf);
- 2026-09-03(46c574cd)gate 已穿透到 workflow subagent。

`docs/future-work.md` 中「native tools are unaffected」的表述是同一过时来源。
仍未做的是「allow-rules 级别的细粒度 native 权限系统」(仍是 follow-up)。

### 插件信任链——最成熟的块

`apps/oh-my-agent/src/core/plugins/plugin-trust.ts` + `plugin-resolve.ts`:

- `computePluginHash`:插件目录递归 sha256(跳过 node_modules);
- `isPluginTrusted`:记录 hash === 当前内容 hash 才可信——任何文件改动即回到 untrusted
  (TOFU 的正确深化,防「信任后被篡改」的供应链攻击);
- 损坏的 trust 文件 = 全部 untrusted(fail-closed,不抛异常);
- scope×mode 信任矩阵:project-scope 代码在 rpc 模式**永不加载**(即使 trusted)。

### 凭据防泄漏——双层

- `coding-agent-harness.test.ts` 测试 16:凭据 sentinel(`sk-sentinel-123456`)
  不得出现在 store/events/errors 任何一处;
- backend 侧 `childEnv` allowlist(ADR 0026):child 不继承父进程完整 env,
  token 走 env 不走 argv。

## 核心 Insight:纵深与边界不匹配,是定位的直接投影

> **纵深极深**(超过业界平均),但**边界有硬缺口**——而两者指向同一个根:
> ADR 0026 的 semi-trusted 本地定位。

| 纵深深 | 边界留白 |
|---|---|
| WorkspaceSandbox.validateNew 向上查 realpath | bash 只约束 cwd,不约束命令语义、不约束网络 |
| plugin-trust 内容哈希 + 改动即失效 | URL guard 不校验解析后 IP(DNS rebinding) |
| approval 超时/无交互一律 deny | redirect 校验依赖 port 实现(默认实现已逐 hop 校验) |
| url-guard 想到 169.254.169.254 | native allow-rules 细粒度权限未做(gate 本身已内核强制) |

这些缺口**在当前定位下是「正确的残余风险接受」**,不是疏忽——ADR 0026 明确
「不防恶意本地用户攻击自己的机器」,并把 bash 约束/MCP env 加密/移除 mock login
列为 LAN/hosted 前置升级项。

**但网络化(多租户数据/暴露 LAN/hosted/run 他人插件)会系统性推翻前提**:
路径逃逸从「自己攻击自己」变成跨空间数据访问;SSRF 从「自己的内网」变成横向
移动面;插件信任从「自己 trust 自己」变成多租户 trust 隔离。

## 网络化准入门槛(五项)

ADR 0026 follow-up 三项 + 本洞察补充两项,应作为网络化部署第一版的**准入门槛**
而非事后补丁:

1. bash 命令约束(OS 层文件+网络沙箱)——设计已定稿:
   [BashSandbox 注入式接口](../../superpowers/specs/2026-09-03-bash-sandbox-design.md);
2. MCP env/headers 加密存储;
3. 移除 mock login 表面;
4. URL guard 校验解析后 IP(补 DNS rebinding);
5. (原第 5 项「native gate 内核强制」已于 2026-08-26 交付,不再列为门槛;
   剩余 native follow-up 是 allow-rules 细粒度权限系统)。

## 修正记录(2026-09-03 核实)

本页两处判断与最初的洞察稿不同,均为代码核实后修正:

1. **redirect 缺口是「半缺口」**:guard 不查 redirect 是真的,但默认
   `createStdWebFetchPort()` 逐 hop 重新校验——默认配置闭环;风险仅存在于
   自定义 port 实现不遵守该纪律。原始稿「第二次 redirect 到内网就漏了」
   对默认配置不成立。
2. **native permission gate 已是内核强制**:`makeSessionPermissionGate`
   (4633e9af,2026-08-26)+ fail-closed auto gate(600afddf)+ subagent 穿透
   (46c574cd,2026-09-03)。`docs/future-work.md` 的「native tools are
   unaffected」表述已过时,同理本系列文档不再引用该结论。

教训与 [insights.md I5](../../insights.md) 一致:洞察文档自身必须与代码对账——
两个「已验证」标签的判断在真核实中被修正,其中 native gate 一条正是
「文档滞后于最近三天的 rapid 迭代」的实例。

## 关联

- [隔离与安全模型](./overview.md)(系统级边界正交视图)
- [ADR 0026: Agent trust model](../../adr/0026-agent-threat-model.md)(定位基准)
- [BashSandbox 设计提案](../../superpowers/specs/2026-09-03-bash-sandbox-design.md)(bash 缺口的实施方案)
- [Security & Debt Backlog](../security-debt-backlog.md)(已修/待办台账)
