---
id: plugins.progressive-skill
title: 渐进式技能插件
status: current
owners: architecture
last_verified_against_code: 2026-07-28
summary: "渐进式技能插件（progressiveSkillPlugin）解决「技能很多但上下文有限」的矛盾。它不把所有技能正文一股脑塞进提示，而是先通过 beforeModel 只注入一份技能索引（元数据），等 Agent 判断需要某个技能时，再用 skill_load 工具按需把那一个技能的正文加载进来。M22 起支持双域发现（global + project 双 roots）、/skill:name 显式调用、以及 disableModelInvocation 关闭模型自动触发。"
depends_on:
  - runtime.plugin
used_by:
---

# 渐进式技能插件

渐进式技能插件（progressiveSkillPlugin）解决「技能很多但上下文有限」的矛盾。它不把所有技能正文一股脑塞进提示，而是先通过 beforeModel 只注入一份技能索引（元数据），等 Agent 判断需要某个技能时，再用 skill_load 工具按需把那一个技能的正文加载进来。技能存在 AgentFS 的 /skills/ 下，归 private 域。

## 为什么「渐进式」

如果把每个技能的完整说明都写进系统提示，技能一多，提示就爆了，而且大部分技能这一轮根本用不上。渐进式加载的思路是**两段式**：

1. 先给一份「目录」——只放技能的名字和简介（索引/元数据）；
2. Agent 看目录决定要用哪个，再去取那一个的「正文」。

这样提示里常驻的只有轻量索引，重的正文按需才进上下文。

## 索引注入：beforeModel

插件用 `beforeModel` 钩子，在每次模型调用前把技能索引拼进系统提示。Agent 因此始终知道「有哪些技能可用」，但不被它们的完整内容淹没。

索引以 `<available-skills>` XML 块的形式注入系统提示（`progressive-skill.ts` 第 62-68 行），每条技能显示 `name` 和 `description`，末尾附指令：`Call skill_load(name) to load the full instructions for a skill before using it.`

## 按需加载：skill_load

当 Agent 决定使用某个技能，它调用 `skill_load` 工具，把那个技能的正文加载进来。触发完全由 Agent 自己的判断驱动——不是预先全量，也不是规则硬编码，而是「需要时才取」。

`skill_load` 支持 `offset` 参数用于分页续读：技能正文一次加载有字符上限（默认 8000），超出时在段落边界截断，并返回 `[Truncated. Call skill_load('name', offset=N) to continue.]` 提示。Agent 可以传 `offset` 继续读取剩余内容（`skill-load.ts` 第 44-63 行）。

## 技能放在哪：双域发现（M22）

M22 之前插件仅扫描 `/skills/`（别名 `/private/skills/*`），即 single-domain。M22 起支持双域发现，通过 `roots` 配置数组定义多个技能根目录：

- **global 域**：全局共享技能，通常落在系统级路径（如 `/global/skills/`），所有 Agent 可见。
- **project 域**：项目级技能，落在项目工作区（如 `/workspace/.claude/skills/`），仅当前项目 Agent 可见。

插件扫描所有 `roots` 下的 `SKILL.md` 文件，合并索引后注入 `beforeModel`。两个域的技能按 `name` 去重：project 域的同名技能覆盖 global 域（就近优先）。

## 显式调用与模型调用控制（M22）

### /skill:name 显式调用

M22 新增 `findSkillByName` 能力，允许用户通过 `/skill:name` 语法显式触发某个技能，不依赖模型自动判断。Human 消息中的 `/skill:name` 被解析后，对应技能正文自动注入上下文，无需走 `skill_load` 工具。这解决了模型在长对话中「忘记调用技能」的问题——用户可直接点名。

### disableModelInvocation

`disableModelInvocation` 选项可将技能标记为「仅显式调用」。设为 `true` 的技能不会出现在索引中（即模型看不到它），只能通过 `/skill:name` 显式触发。适用于需要执行但不应由模型自主决策触发的技能（如敏感操作、确定性脚本）。

## 关联页面

- [Oma Runtime](../runtime/oma.md)
