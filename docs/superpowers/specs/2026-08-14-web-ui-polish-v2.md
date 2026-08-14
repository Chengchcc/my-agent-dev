# 前端打磨方案 v2(实现级,面向无 VLM 的执行 agent)

> **执行约束(本方案的前提)**: 执行 agent 没有视觉能力。因此本方案:
> 1. 每个改动都给出**精确的度量值/色值/类名**,不看图也能实现;
> 2. 每条验收是**机器可断言**(DOM 结构 / computed style / 对比度计算),禁止"看上去对就行";
> 3. 截图对拍从验收里删除,替换为 §7 的 audit 脚本 + 断言清单。

当前实测常量(2026-08-12 Chrome 实测,作为改动基线):
- bg canvas `rgb(16,16,16)` = `#101010`;ink 主文字 `rgb(242,242,242)` = `#F2F2F2`
- accent `rgb(0,217,146)` = `#00D992`(Start/Send 按钮)
- 字体 Inter + system fallback;正文字号 14-16px;hairline 一条 `#3D3A39` 系
- 圆角 8px;按钮高 ~32px

---

## §0 前置修复(打磨前;均带 DOM 验收)

1. **`/system` 404**
   - 定位: `(main)/system/page.tsx` 存在但 404。查 server component 抛错导致的 notFound,或路由 group 层级变化。运行 `curl -s -o /dev/null -w %{http_code} http://127.0.0.1:3001/system` 必须 200。
   - 验收: 浏览器 DOM 断言 `document.querySelector('main h1')` 存在且无 "404" 文本。
2. **NavRail Account 裁切**
   - 定位: 侧栏底部头像绝对定位脱流、与文字同格的头像覆盖文字。改 flex 行: avatar 28px 圆形 + 名称 truncate,min-width:0 保证收缩。
   - 验收: `accountEl.scrollWidth <= accountEl.clientWidth`(无横向溢出),头像 getBoundingClientRect 不与文字 rect 相交。
3. **Knowledge placeholder 是 fixture**
   - 定位: `KnowledgePackPanel.tsx` placeholder 写死 "kb-fixture"/"https://github.com/org/k…"。换成引导文案("例: https://github.com/org/repo 或本地路径")。仓库 URL 校验: 必须是 http(s):// 或绝对路径,非法输入按钮 disabled 不闪红。
   - 验收: 源文件 grep 无 "kb-fixture";DOM 断言空态含 CTA(§4)。

## §1 设计 Tokens(`apps/web/src/app/globals.css`,Tailwind v4 `@theme`)

**只允许以下值,全部命名,页面里禁止出现裸 hex/裸 px 字体:**

```css
@theme {
  /* surface 三层 */
  --color-canvas: #101010;      /* 实测现状,保留 */
  --color-panel:  #171717;      /* 卡片/侧栏,比 canvas 亮一阶 */
  --color-panel2: #1F1F1F;      /* hover/active */
  /* 文字三层 */
  --color-ink:   #F2F2F2;       /* 实测现状 */
  --color-mute:  #A3A3A3;
  --color-faint: #5F5F5F;
  /* 线 */
  --color-hairline: #262626;
  /* 状态(不刷块,只用于 dot+text) */
  --color-ok:   #00D992;   /* 实测 accent,保留 */
  --color-warn: #F5B849;
  --color-err:  #F5565B;
  --color-info: #5B9BF5;
  /* 字号阶梯(本案用 rem 数值断言) */
  --text-cap: 0.6875rem;   /* 11px */
  --text-body: 0.8125rem;  /* 13px */
  --text-emph: 0.9375rem;  /* 15px */
  --text-h2: 1.25rem;      /* 20px */
  --text-h1: 1.625rem;     /* 26px */
  /* 间距: 4 的倍数,只许 4/8/12/16/24/32 */
  /* 圆角 */
  --radius-card: 6px;
  --radius-btn: 8px;       /* 实测现状,保留 */
}
```

lint 卡死(无 VLM 时代的等价锁): `apps/web/package.json` 加 script
`"lint:ui": "bun scripts/ui-lint.ts"` —— 极简单文件: 扫 `apps/web/src/**/*.{tsx,css}`,命中裸 hex(除 globals.css)、`tracking-[`、内联 `style={{` 中的 `fontSize|letterSpacing|padding|margin` 即报错。30 行。CI 接进 `bun run lint`。

**对比度验收**(文本 agent 可算): 相对亮度公式 L=0.2126R+0.7152G+0.0722B(sRGB 线性化后), ink-on-canvas = 16.8:1 ✓, mute-on-canvas ≈ 7.0:1 ✓, faint 仅用于非关键文字 ✓。faint 禁止承载按钮文字/错误信息。

## §2 原子组件(`apps/web/src/components/ui/`,TS 接口 + DOM 验收)

**从 AgentBox 参照页直接吸收的模式**(源: gdpa 的 MCP / 知识包 / 技能三页实测;我们的暗色调色板不变,吸收的全是结构与交互模式):

### A. 页面骨架
| AgentBox 模式 | 入我们 | 规格 |
|---|---|---|
| 页头: 主标题+一行说明左置,操作簇右置(ghost/outline/primary 三级) | `PageHeader` 增 `subtitle` | 右簇序: 刷新(ghost)→次操作(outline)→主操作(solid),gap 8 |
| 页头下二级 tab 条(技能包(15) / Market / 评测),active 带计数 | 新 `SubTabs` | items: `{key,label,count?}`;active: ink 字+底 2px ok 绿;非 active mute;高一点击区 40px |
| ⓘ Info banner(讲"这页怎么用",可多段,可关) | 新 `InfoBanner` | info 色 8% 底+30% 边,radius 8,padding 12 16;localStorage `ib:<id>` 记住关闭 |
| 指标卡行(服务器 2 / 已连接 2 / 错误 0 / 工具 4) | 新 `StatCard` | label `--text-cap` mute + 值 `--text-h2`;仅越界时 tone=warn/err |

### B. 列表页要素
| AgentBox 模式 | 入我们 | 规格 |
|---|---|---|
| 列表行卡(MCP 页): icon 块 + 标题 + kind 胶囊(stdio/http) + mono id 芯片带 copy + 工具数 ✓ + 状态胶囊 + 行内 icon 操作 + Switch + 删除 | 新 `ListRowCard` | 行高 76,padding 16;icon 块 36² radius 8 bg panel2;kind 胶囊=info 淡底;mono 芯片+点击复制(toast "Copied");右侧操作列宽自适应、icon 钮 28px |
| 技能包行(技能页): 双语标题"名 / title"、徽章行(只读/已停用/本地)、两行 desc 截断、meta 行(vendor · N 个 Skill · v1.0.5 · 最近修改 TimeAgo)、操作行(outline 小钮 同步/查看/复制) | `ListRowCard` 的 `desc/meta/badges/secondaryActions` slot | meta 行全部 `--text-cap` mute,分隔用 `·` 居中点 |
| 全宽搜索行(左放大镜,占位"按名称、标识或说明搜索") | 新 `ListToolbar` | 高 36,radius 8,bg panel,focus 1px ok;过滤纯前端,`debounce 150ms` |
| 批量操作工具条(全选/已选 n/N/主操作,嵌间隔配置) | `ListToolbar` 的 `selection` 变体 | 仅在有可批量操作时出现;未选时主操作 disabled 而非隐藏 |
| 分组小标题("系统与本机技能包" + 一行说明) | `SectionKicker` 带 `hint` | 组间 margin-top 24 |

### C. 侧栏(对应 Account 裁切修复)
active 项 = panel2 胶囊(radius 8),非 active mute;分组标题 faint cap;底部用户条 = 28px 圆形色块 avatar(用户名首字母)+ 名 mute 13px truncate——替换现在绝对定位撞车的写法。

暂**不**吸收: 知识包封面大卡(我们没有封面物料,退化为 ListRowCard)、右栏嵌入式 Copilot("Skill Curator" 那种管理页内嵌助手)——概念记下放后续,本期不加。

```tsx
// PageHeader.tsx
export function PageHeader(p: {
  kicker?: string; title: string; subtitle?: string; actions?: ReactNode;
}): JSX.Element

// SubTabs.tsx
export function SubTabs(p: {
  items: { key: string; label: string; count?: number }[];
  active: string; onChange: (key: string) => void;
}): JSX.Element

// InfoBanner.tsx — closable, persistence `ib:${id}`
export function InfoBanner(p: { id: string; title: string; body: string }): JSX.Element | null

// StatCard.tsx
export function StatCard(p: { label: string; value: number | string; tone?: 'info'|'warn'|'err' }): JSX.Element

// ListRowCard.tsx — 列表页唯一行形态
export function ListRowCard(p: {
  icon: ReactNode; title: string; subtitle?: string;     // 双语标题: subtitle 小型 mute
  tag?: { label: string; tone?: 'info'|'warn'|'err' };
  badges?: string[];                                     // 只读/已停用/本地 这类
  idChip?: string;                                       // mono + copy
  desc?: string; meta?: string[];                        // meta 元素间 ' · '
  status?: ComponentProps<typeof StatusPill>['kind'];
  actions?: ReactNode; secondaryActions?: ReactNode;     // 行内 icon / outline 小钮
  onClick?: () => void;
}): JSX.Element

// ListToolbar.tsx — 搜索 / 批量两种形态
export function ListToolbar(p: {
  searchValue?: string; onSearch?: (v: string) => void; placeholder?: string;
  selection?: { total: number; selected: number; onSelectAll: (v: boolean) => void; action?: ReactNode };
}): JSX.Element

// Card / StatusPill / EmptyState / SectionKicker 定义不变,SectionKicker 加 hint?: string
```

DOM 验收: `main h1` 存在且 `fontSize==26px`;`letterSpacing>1px` 的元素全页仅可命中 SectionKicker;ListRowCard 行高 76±1px(无 secondaryActions 时 64±1);Switch 键盘 focus 显 outline;InfoBanner 关闭后 localStorage `ib:<id>` 有值。

## §3 会话画布(`/chat/[id]`)

**布局**: 侧栏 240px(现 220 左右,以 §1 间距修正);消息列容器 `max-width: 760px; margin: 0 auto; padding: 24px 0 160px;`。消息列底部留白给固定 composer。右 rail(Members)固定 260px,1200px 以下隐藏。

**消息渲染规则**(按 entry type 分支):
| type | 渲染 | 验收断言 |
|---|---|---|
| system | 居中,`--text-cap`,mute,单行 | `textAlign:'center'` 且 color == mute |
| user | 右对齐, bg panel2, radius 8, max-w 85%, `--text-body` | 每条 `justify-content:flex-end` 容器 |
| assistant | 左对齐,无气泡,头像 20px+名 cap mute,正文 body | — |
| thinking | `<details>` 折叠,summary="Thought for ${Ns}" | 默认 `open` 属性不存在 |
| tool_use | 单行卡: 图标+name+耗时+成败 dot,点击展开 input JSON | 折叠态高度 ≤ 36px |
| tool_result | 同上,输出预折叠 3 行(line-clamp-3),"show more" | — |

hover 才出操作(Fork / Edit&Replay): 行 `group`,`group-hover:opacity-100 opacity-0`,默认不渲染 `#N` 序号。删除分隔线序号版式。

**流式/运行态**:
- run 激活时 composer 右钮 = Stop(red dot),disabled=false;
- 首 token 前 assistant 占位 = 三点弹跳(animate-pulse 点阵);
- dispatch_failed/preflight 失败 → 会话内插一条 err pill(后端见 §5.1,前端订阅 runStatus 失败事件渲染 StatusPill kind=err + 错误文本);
- SSE 断开 → 顶部 sticky banner(`role=alert`,不消失直到恢复): "连接已断开,正在重连…"。验收: 断网模拟下 `document.querySelector('[role=alert]')` 非空。

**输入**: Enter 发送、Shift+Enter 换行保持;新增 `/` 开头清空 id 列表的 hack 移除;Cmd+K 命令面板本期不做(单列后续)。

**Composer 度量**: 底边距 16px,高度 auto(min 40/max 160),bg panel,radius 8,1px hairline;发送钮 32×32。

## §4 页面级规格

**`/team` + `/team/[id]`(合并为 master-detail 三段式,源: AgentBox 智能体资料页实测)** — 废掉"列表页/详情页两处跳转",合成一个路由组下的 split view:

- **列1** NavRail(不变)。
- **列2** 智能体列(280px,右 hairline):顶 "我的智能体" + 搜索行(ListToolbar 搜索变体);分组: 已固定(置顶 pin) / 全部。项卡 56px: 28px icon 块 + 名(emph,truncate) + desc 一行 mute truncate + hover 出"⋯"菜单(Pin/Archive);active 项 panel2 胶囊。空态走 EmptyState+CTA。
- **列3** 详情(flex-1,内容 max-width 860): 
  1. 头行: `←` + 名(h2) + 右 StatusPill;
  2. 描述卡: 大 avatar(72px,radius 12)+描述正文(可编,textarea 无边框沉浸)+caption 行("A2A 会用这段描述选择 Agent")+ 右上 ghost 钮"AI 更新"(调 backend 让 Agent 自己改描述——**依赖后端 action**,见 §6.4);
  3. 操作行: 主钮"开始对话"(跳 /chat 绑定该 agent 的会话,**依赖 §0.x/后端选中 agent**)+outline"导出 agent.yml";
  4. 内联配置条(关键吸收): 三个下拉一行——Backend / Model / Reasoning effort,附 Fallback Switch;**autosave**: 变更即 PATCH(debounce 500ms),行右一个 mute 提示"已自动保存 · HH:MM";弃用现有 Edit 弹窗(它同时是已知 PATCH 丢字段 bug 的温床);
  5. Workspace 折叠卡: 路径 mono + copy chip,点开见 WorkspaceExplorer;
  6. Tab 条(SubTabs): Persona / Skills / MCP / Knowledge / Memory / Workspace / Activity;
  7. Persona 内容 = SOUL/AGENTS 双卡并排(各渲染 markdown,非原文!)每卡下 caption 一行说明注入去处;

  **Agent 级工具/MCP(吸收 AgentBox"工具"tab)** — 二列卡栅格的能力开关:每卡 `checkbox 方块 + 标题 + 适用徽标 + 两行 desc`。徽标是**按 backend 适用性**的 cap 胶囊("仅 Codex / Traex"、"仅 Claude")——这正是多 backend 下我们 mcp_servers/product-tools 的呈现方式:不适用当前 kind 的卡淡化+disable+title 说明。MCP 子区:已挂服务器 ListRowCard(icon+name+kind 胶囊+ 工具数+ idChip 可复制 `server_id`+Switch);结构同 §2。

  **Agent 级 Workspace(吸收 AgentBox Workspace tab)** — 三件套纵向:① InfoBanner 变体:icon + "Workspace 路径" + mono 路径 + copy chip;② 可折叠"Git 仓库同步"段(占位,状态行即可);③ 文件浏览器两栏: 左搜索行+树(`FileTree`: 文件夹 chevron + 文件行 icon/名/大小),右 `PreviewPane`: 文件名头 + 保存/删除 + 内容 textarea(mono,>64KB 截断提示)。**文件编辑直接保存到 workspace(取代现在 WorkspaceExplorer 只读)**;删除走 confirm。验收: 打开 agent.yml → 编辑 → 保存 → 重开,内容持久;大小写/编码边界: 非 UTF-8 二进制显示"不可预览"而非乱码。
```

⚠️ 参照系统 agent.yml 头注说"generated projection, 勿手编"——我们 ADR 0020 声称 file-first 唯一真源(但当前代码只写不读,见修复方案 §4)。两边真相打架时,**以 ADR 0020 为准**,文件编辑器的保存路径必须触发 reconcile,不能直接写盘完事。

Autosave 一致性验收: 每次字段 blur/change 后 1s 内发出 PATCH;失败 toast err 且字段回滚旧值。DOM 断言: crud 三下拉切换后 `fetch` mock 收到 `{model:{provider,model}}` 正确载荷(拿下前面发现的 AgentForm 前缀污染)。

**`/work`(Loops)** — 行式列表保持,修: 行高 44px;状态列改 StatusPill;"5 per page" 那行分页器改 mute 13px;页标题经 PageHeader。空态同上。

**`/team/mcp` + `/team/knowledge` + `/team/skills`(同构,AgentBox 三件式)** — 三页共用骨架: `PageHeader(subtitle, actions=[刷新 ghost][次操作 outline][主操作 solid])` → `InfoBanner`(说明"怎么用",各自文案) → `StatCard` 行(MCP: 服务器/已连接/错误/工具;Knowledge: 包数/已启用/文件总量/更新时间;Skills: 包数/skill 总数/来源数/最近同步) → (有多类时)`SubTabs` → `ListToolbar` 搜索行 → 分组 `SectionKicker` + `ListRowCard` 列表。MCP 行: icon+title+tag(stdio/http)+idChip(`mcp_<name>_`)+desc+status+actions(终端/测试/编辑/Switch/删除)。Knowledge 行: icon+title+tag(zip/git/local)+meta(来源 · N 文件 · 更新时间)+Switch。Skills 行: 双语 title+badges(只读/已停用)+desc 两行+meta(vendor · N 个 Skill · 版本 · 最近修改)+secondaryActions(同步/查看/复制)。**加 onSubmit 错误 toast;installing 行 2s 轮询直到 settle;stdio server 的 args/env 字段补全(后端 workspace-bridge 已知丢字段,前后端一起修)**。

**`/system`** — 修 404 后: 三卡栅格(Backend 状态/Telemetry/最近 Runs),卡内表格 six-column to只用 --text-cap/body;事件名 `projection_degraded` 等必须过 person-readable 映射表(单文件常量 map);删 "bad/good 100.0" 这类未解释指标,或加 title tooltip。

**`/settings`** — 分节卡("密码"/"后端连接"/"关于"),每节一 Card;改密表单两个字段 + 报错用 err 色文本,成功 toast "Password updated"。

## §5 文案/语言

- **全站 UI 英文**(menu/按钮/状态/空态/错误);正文内容(模型生成中文等)原样。现存中英混排逐项清除。
- 相对时间统一 `<TimeAgo>`(Intl.RelativeTimeFormat en),禁手写 "21h ago" 与 "Aug 11" 并存;日期完整值放 title tooltip。
- Toast: 只在写操作出现,格式 "<动作> <对象>"(例: "MCP server updated"),err 时 "Failed to …: <后端 message>"。

## §6 跨端依赖(非前端工时,需后端配合)

1. **dispatch_failed → 会话内联事件**: run terminal 状态里 status=failed 的 run,前端现在只能靠轮询;需要 execution 层把失败写一条 system 级 conversation 事件(/api/conversations/:id 已经在增量,加一类 `run_failed` 源)。前端拿到后渲染 §3 的 err pill。
2. **install 进度**: MCP/Knowledge install 加 GET /:id/status 或 SSE,至少给 installing→done/failed 的 settle 信号(现在 install 中不能操作且不可见进度)。
3. **会话列表 preview**: `GET /api/conversations` 每项加 `lastMessagePreview`(≤120字)/`lastActivityAt`——左拦列表现在只有标题,点进才知死活。
4. **智能体资料页三件套**: a) PATCH /api/agents/:id 必须持久化 `model`/`backendKind`(已知丢字段 bug,阻塞内联配置条);b) 新建会话支持选择 agent(替换 chat/page.tsx 硬编码 default);c) "AI 更新描述" 后台 action(让 backend 跑一个小模型生成描述;可后置,先留按钮 disabled)。

## §7 无视觉验收基座(本方案验收方式,新增一次性投入 ~0.5 天)

`apps/web/scripts/ui-audit.ts`(bun 脚本,不走测试框架):
1. 起 dev server(或连既有 127.0.0.1:3001),用 playwright/core 或 puppeteer-core(仓里已经有 puppeteer 类依赖?若无,允许新增 `playwright-core` 开发依赖,它比 puppeteer-core 更稳);
2. 打开每个路由,跑断言集 —— 断言写法与上文 §2-§4 表格中的 DOM 验收一一对应:
   - `cs(sel, prop)` 读 computed style 按 token 表断言;
   - 溢出断言: `el.scrollWidth <= el.clientWidth + 1`(Account 裁切这类永远不回归);
   - 空态断言: 各列表页清空后 `[data-testid=empty-state]` 存在;
   - 对比度抽样: 三个文本色对 canvas 比值算阈值;
3. 输出表格 PASS/FAIL,CI 挂。

**这个脚本就是本方案的"眼睛"替代品。** 全部原子组件和页面规格里的断言落进它;新 PR 不加断言不合入。

## §8 执行顺序与验收

| 阶段 | 内容 | 验收(cut) |
|---|---|---|
| P0 | §0 三个 bug | /system 200;Account 无溢出;fixture 文案 grep 零命中 |
| P1 | §1 tokens + ui-lint + §2 五原子 + §7 audit 骨架 | main 页面 hs 全部来自 PageHeader;lint:ui 绿;audit 首版 6 断言绿 |
| P2 | §3 会话画布 | 消息类型分化的 DOM 断言全绿;err pill 在无后端的 mock 下渲染 |
| P3 | §4 页面级(可并行 2 页/worker) | 各页 audit 断言绿 |
| P4 | §5 静态 + §6 接口约定落地后收尾 | 全 audit 绿 + lint:ui 绿 + bun run lint / typecheck / test 绿 |

**P0+P1 完成即出体感;全量 ≈ 4-5 工作日。**

## §9 已知坑(防执行 agent 撞墙)

- 改 NavRail 时确认每页的 `aside` 选择器仍命中 §7 的旧 DOM 断言 —— 断言跟着 DOM 改。
- 详情页 markdown 渲染引入 react-markdown 时注意它 ESM-only;Next 15 app router 兼容,但 vitest/bun test 里不做渲染断言就行。
- playwright-core 需要指定 executablePath,Mac 上 `/Applications/Google Chrome.app/...`;脚本接受 `CHROME_PATH` env 覆盖。
- §3 消息行 hover 操作要 `group` 类——Tailwind v4 里 group-hover 语法没改,但必须写在同一 JSX 树内,别拆组件拆丢了。
</attachment>
