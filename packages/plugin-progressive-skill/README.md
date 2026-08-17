# @chengchenccc/plugin-progressive-skill

一个 agent 插件，实现 Claude Code 风格的渐进式技能加载。它先把所有可用技能的名字和简介塞进系统提示，让模型知道有哪些能力；只有模型真正要用某个技能时，才通过工具把完整说明按需读进来。

## 为什么需要它 / 解决什么问题

技能（每个是一份 `SKILL.md`）的完整说明可能很长。如果一上来就把所有技能的全文都灌进上下文，token 会被迅速吃光，而且大部分内容本轮根本用不到。

渐进式加载解决的就是这个「想让模型知道、又不想付全文代价」的矛盾。它把信息分两层：常驻的只是一份轻量索引（名字 + 一句话简介），随时提醒模型有哪些技能可调；完整指令则放在工具背后，按需、可分页地取用。这样上下文成本和技能数量解耦，技能再多也只多几行索引。

职责边界：它只负责把技能索引注入提示、以及在被调用时从文件系统读出技能正文，不执行技能里的步骤，也不管理技能文件本身。文件读写交给传入的 `AgentFsLike`。

## 核心概念

插件接收一个 `AgentFsLike` 工作区和技能根目录（`root`，默认 `/skills/`），通过 Agent 的 `beforeModel` 钩子工作：每一轮模型调用前，它扫描根目录下的技能、构造一个 `<available-skills>` 块（每行 `- **名字**: 简介`，并附一句「调用 `skill_load(name)` 加载完整说明」），追加到系统提示后面。索引带 mtime 缓存，文件没变就不重复读盘；读取失败会记日志并跳过注入（fail-open）。

插件贡献的工具是 `skill_load`。它的入参是 `{ name, offset? }`，分页契约如下：

- 找不到该技能时返回 `isError: true`。
- 读出技能正文（跳过 frontmatter），把其中的 `${SKILL_DIR}` 占位符替换成可用路径（设置了 `posixSkillRoot` 时替换为真实 POSIX 路径，否则用逻辑路径）。
- 从 `offset` 处开始，按 `maxCharsPerLoad`（默认 8000）在段落边界附近截断。
- 如果还有剩余，返回内容末尾会附上一行 `[Truncated. Call skill_load('名字', offset=下一个偏移) to continue.]`，模型据此用新的 `offset` 继续读。
- 当 `offset` 已超出正文长度，返回 `Skill 名字 fully loaded.`。

模型先在索引里看到技能，再用 `skill_load(name)` 把全文一页页拉进来。

## 怎么用

```ts
import { progressiveSkillPlugin } from "@chengchenccc/plugin-progressive-skill";
import type { AgentFsLike } from "@chengchenccc/tools-common";

declare const ws: AgentFsLike;

const plugin = progressiveSkillPlugin({
  ws,
  root: "/skills/",        // 技能根目录，默认 /skills/
  maxCharsPerLoad: 8000,   // 每次 skill_load 返回的最大字符数
  // posixSkillRoot: "/var/agents/abc/private/skills",  // 让 ${SKILL_DIR} 解析为真实路径
});

// 把 plugin 注册进 Agent 配置即可
```

依赖关系：依赖 `@chengchenccc/core`、`@chengchenccc/agent`、`@chengchenccc/tools-common`（`AgentFsLike`），以及 `gray-matter`（解析 SKILL.md frontmatter）。
