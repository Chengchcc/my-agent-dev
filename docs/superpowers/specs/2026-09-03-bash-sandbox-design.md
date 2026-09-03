# 设计提案:Bash 工具沙箱化(`BashSandbox` 注入式接口)

日期:2026-09-03 | 状态:**提案,未实施**(实施时点:网络化部署准入,见
[oma 内核安全面 §网络化准入门槛](../../architecture/security/oma-kernel.md))

## 目标

让 `bash` 工具从「只校验 cwd」升级为「OS 层强制执行的文件系统 + 网络隔离」,
对齐 Claude Code 的 sandbox 设计,按 oma 内核规模裁剪。

诊断前提(bash.ts 现状):`Bun.spawn(["bash","-c",command], { cwd: validatedCwd })`
只约束 cwd,不约束命令语义,也不约束网络。单人本地(ADR 0026)下是正确的残余
风险;网络化部署下是「读任意文件 + 内网横向移动 + 外泄数据」的真实攻击面。

## 设计

### 注入式接口(对齐 oma 已有注入点风格:ApprovalHandler / permissionGate / WebFetchPort)

```typescript
// apps/oh-my-agent/src/core/tools/bash-sandbox.ts (新文件)

/** A bash command launch strategy. The sandbox wraps the actual spawn so the
 * OS enforces filesystem + network boundaries on the running process and its
 * children. Implementations: Null (current behavior), Seatbelt (macOS),
 * Bwrap (Linux). */
export interface BashSandbox {
  readonly workspaceRoot: string;
  spawn(
    command: string,
    opts: { cwd: string; env?: Readonly<Record<string, string>> },
  ): BashSpawn;
}

export interface BashSpawn {
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly exited: Promise<{ exitCode: number; signal?: string }>;
  kill(): void;
}
```

- `BashSpawn` 形状对齐 Bun spawn 流式接口,`bash.ts` 的 `onOutput` 逻辑不改;
- `kill()` 语义对齐现有 killGroup(超时/abort 杀整组)。

### 三个实现

1. **NullBashSandbox**(默认,零依赖):现状显式化,`Bun.spawn(["bash","-c",...])`;
2. **SeatbeltBashSandbox**(macOS,`sandbox-exec` 内置):
   `Bun.spawn(["sandbox-exec","-f",profile,"bash","-c",command])`;
3. **BwrapBashSandbox**(Linux,bubblewrap 需安装):
   `bwrap --ro-bind / / --bind <ws> <ws> --dev /dev --proc /proc --tmpfs /tmp
   --unshare-net bash -c <command>`。

### 工厂

```typescript
export function resolveBashSandbox(opts: {
  workspaceRoot: string;
  enabled: boolean;           // 从 run config 读(见未决)
  platform?: NodeJS.Platform; // 默认 process.platform
}): BashSandbox
```

### 接线(最小 diff:1 新文件 + 2 处改动)

- `createBashTool(opts: { workspaceRoot; sandbox?: BashSandbox })`——缺省
  NullBashSandbox,签名向后兼容,`PluginTool` 不动;
- `run-runtime.ts` 唯一调用点传 `resolveBashSandbox({ ..., enabled })`。

### macOS Seatbelt profile 草稿(未实测,实施时迭代)

```scheme
(version 1)
(deny default)
(allow process*)
(allow file-read* (subpath "/usr/lib") (subpath "/System/Library")
  (subpath "/bin") (subpath "/usr/bin") (subpath "/usr/local/bin")
  (home-subpath "/.bun") (subpath WORKSPACE_ROOT))
(allow file-write* (subpath WORKSPACE_ROOT) (subpath SESSION_TMP))
(deny network*)
(allow network-outbound (literal "registry.npmjs.org") (literal "github.com"))
(deny file-read* (home-subpath "/.ssh") (home-subpath "/.aws")
  (home-subpath "/.config/gh"))
```

WORKSPACE_ROOT/SESSION_TMP 由 `writeProfile()` 运行时替换;网络白名单占位,
未来从 run config 注入。这是「能跑编译/测试/npm install」的最小集,完整集
实施时用真实任务迭代。

## 网络层是必须的,不是可选的

文件系统隔离防「读不该读的」,网络隔离防「把读到的送出去」——**没有网络
隔离,文件沙箱拦不住 exfiltration**。oma 现状:url-guard 只管 `web_fetch`
(进程内),bash 里的 `curl`/`git clone` 完全不受控。

- Seatbelt:`(deny network*)` + 白名单;
- bwrap:`--unshare-net`(+ 可选 slirp4netns/socat 白名单 egress,对齐 CC)。

url-guard 继续管 web_fetch,BashSandbox network 层管 bash 子进程——不同进程
边界,不合并。**纪律:凡注入式 fetch port 必须逐 hop 过 assertSafeUrl**
(默认 `createStdWebFetchPort` 已是此形态,见 oma-kernel.md §URL guard)。

## 与审批 pipeline 的协作

```
bash 命令进入
  ├─ 能进沙箱 → 直接跑(OS 已兜住边界,取代逐条审批)
  └─ 进不了沙箱(excluded/沙箱失败/白名单外网络)
        → 回退 normal spawn(unsandboxed)
        → permissionGate → approval pipeline(denyAllApprovals 兜底)
```

对齐 CC「auto-allow sandboxed, prompt unsandboxed」。oma 的 native gate
已是内核强制(2026-08-26,见 oma-kernel.md 修正记录),所以两道防线的第二道
已就位,只差第一道(OS 沙箱)和 unsandboxed 回退信号(在 permissionGate
input 或 approval_request 事件上加 `sandboxed: boolean`)。

## 实施分阶段

| 阶段 | 内容 | 准入门槛 |
|---|---|---|
| P0(现在) | 本设计定稿;网络化五项准入门槛登记(见 oma-kernel.md) | — |
| P1 | 接口 + NullBashSandbox(行为不变)+ 接线 | 全量测试零回归 |
| P2 | macOS Seatbelt + 最小 profile | build/test/npm install 可跑通 |
| P3 | Linux bwrap(+ egress) | 基线任务可跑通 |
| P4 | 白名单入 run config + unsandboxed 回退接 gate | 沙箱内自动放行、沙箱外走审批 |
| P5 | 网络化部署时 `enabled=true` | 全部任务沙箱内可跑 or 明确 excluded |

## 非目标

- ❌ 用户态正则黑名单(`rm -rf` 字符串判断)——可绕过,CC 也不做;
- ❌ 凭据 mask/proxy/重签名(CC 的 SigV4 那套)——oma 的 credential sentinel
  测试 + childEnv allowlist 对单人本地已够;
- ❌ managed-settings 组织级锁定——无多管理员场景;
- ❌ 100% 封死 bash——OS 沙箱是「显著降险 + OS 层可信边界」,非数学完备
  (domain fronting / Unix socket / $PATH 提权仍是残余风险,CC 文档同此标注)。

## 可信度与未决

| 项 | 状态 |
|---|---|
| 注入式接口形态 | 高置信(对齐 oma 既有注入点,签名已核实) |
| Seatbelt profile 草稿 | **未实测**(scheme 语法需实施时验证) |
| bwrap 参数 | 高置信(CC 官方文档同款) |
| enabled 开关注入点 | 未决(见下) |

未决需 owner 拍板:

1. `enabled` 进 agent.yml 还是 run config?倾向 **run config**(沙箱是「每次
   Run 的执行策略」,不是 agent 身份);
2. unsandboxed 回退默认值:单人本地建议默认允许回退 + 提示;网络化时锁死
   为 `allowUnsandboxedCommands: false`(对齐 CC 僵化部署位)。
