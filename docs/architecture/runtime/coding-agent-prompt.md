---
id: runtime.coding-agent-prompt
title: Coding Agent Prompt 与 Context
status: design
owners: architecture
summary: "Coding Agent 每个 Agent Run 使用渲染后的 XML+Markdown System Prompt，以及两条连续 user messages：Adapter 构建的 `<system-reminder>` Meta User Message 和真实 Prompt。System 不入 Coding Session Tree，渲染后的 Meta 入 Tree 并在同一 loop retry 中复用。"
depends_on:
  - runtime.coding-agent
  - runtime.coding-agent-session
used_by:
---

# Coding Agent Prompt 与 Context

Coding Agent Prompt 分为结构稳定的 System Prompt Template 与动态 Meta User Message。Adapter 在每个 Agent Run 开始时渲染 System Prompt；这个分层同时服务模型优先级、prompt cache、可复现性和配置热更新。

## 模型每次会收到什么

```text
Coding Session active context
+ Meta User Message
+ Actual User Prompt
→ Agent Loop
```

Meta 与 Prompt 是两条连续 `user` Message。Coding Session Tree 保留两条独立 Message；Provider conversion 层在某协议不接受连续同 role messages 时可以合并 wire payload，但不能改写 Coding Session Tree。

## System Prompt 如何生成

Template 结构参考 llm-space general agent，以 XML 分区、Markdown 正文表达：

```xml
<agent role="..." name="...">
SOUL and stable identity instructions.
</agent>

<knowledge-cut-off>
Model knowledge cutoff and current-information policy.
</knowledge-cut-off>

<response-style>
- Markdown rules...
</response-style>

<behaviors>
  <behavior-name activate-when="...">
  Workflow in Markdown...
  </behavior-name>
</behaviors>

<skill-system>
Progressive skill loading contract...
</skill-system>

<critical-reminder>
Stable safety and execution rules...
</critical-reminder>
```

渲染后的 System Prompt 包含：

- Product Agent SOUL 与稳定身份；
- response style；
- 通用 behaviors；
- skill progressive-loading contract；
- critical execution/safety rules；
- 从 model metadata 渲染的 knowledge cutoff policy。

Adapter 在 Agent Run 开始时渲染 `AgentRunSnapshot.systemPrompt`。SOUL 或稳定规则变化从下一个 Agent Run 生效，不重建 Coding Session。Loop metadata 记录 `systemPromptHash`，用于诊断；完整 System Prompt 不写 Coding Session Tree。

## Meta User Message 放什么

格式参考 llm-space 的约定：

```xml
<system-reminder>
# Runtime Context

...

# Memory

...

# Available Skills

...

# Product Context

...

# Workspace

...
</system-reminder>
```

XML 只标识整条消息是 runtime-injected meta；内部使用 Markdown，不设计深层 XML schema。空 section 省略。

Meta 包含动态内容：

- 当前日期、workspace 与运行环境；
- Product Agent Memory 摘要/索引；
- 当前 Skill roots manifest 生成的 skill index；
- 当前 Context Branch/Conversation context；
- Product Tool/MCP 使用说明；
- 当前 model、todo reminder 和本轮约束。

Meta 不包含实际用户 Prompt、完整历史、全部 Skill 正文或大段 Memory facts。

## 哪些内容写入 Coding Session Tree

```text
System Prompt       不写 Coding Session Tree
Meta User Message   写 Coding Session Tree，source=meta
Actual Prompt       写 Coding Session Tree，source=prompt
```

每个 Agent Loop 恰好一条 Meta。相同 loop 的 provider retry 复用原 Meta，不重新渲染。Steer 不生成新 Meta。Follow-up 开启新 Agent Run/Agent Loop，因此重新读取最新 Memory/Skills/SOUL 并生成 Meta。

## Product Agent 配置变化何时生效

参考 Solo 的配置 ownership：Product Backend 保存 Product Agent 的 SOUL、Memory、Skill Packs、backend kind、默认 model 和 workspace 配置。CodingAgentBackend 在 Agent Run 开始时读取当前配置，构建 `AgentRunSnapshot`、System Prompt 和 Meta。

变化策略：

- SOUL、Memory、Skill 内容变化：下一个 Agent Run 热更新 prompt/meta；
- Plugin/tool manifest 结构变化：execution session state stale，重建 Coding Session；
- Context Branch ModelChangeEntry：下一个 Agent Run 使用新 model；
- Runtime 支持 loop-boundary model switch 时复用 session，否则同 backendKind 重建 session。

## Skills 如何渐进加载

Adapter 传入 Skill roots manifest。Runtime 扫描 `SKILL.md` frontmatter，Meta 只注入可用 skill 名称、描述和加载规则。`skill_load` 按需加载正文。

Skill 目录约定属于 Coding Agent，不复用 `.claude/skills`、`.codex/skills` 等外部 Runtime 私有目录。Adapter 可以从 Product Skill Packs 物化成统一 roots。

## Memory 由谁保存

Memory 由 Product Backend 拥有。Adapter 将高价值摘要和索引渲染到 Meta；详细事实通过 Product Memory MCP 或 Runtime-local memory tools 渐进读取。

Coding Agent 不自行成为 Product Memory canonical store。Runtime-local todo 与 cache 可写内置 Coding Session entries，但不反向修改 Product Memory。

## 每次 Model Turn 如何构建 Context

每次 Model Turn 前：

```text
Runtime active branch
→ apply latest Runtime CompactionEntry
→ add current loop messages
→ Plugin beforeModel transforms
→ tool-result truncation / token budget shaping
→ Provider message conversion
→ model stream
```

Context shaping 只生成本次 model payload，不改 Coding Session Tree。Compaction 是显式 session operation，不由 ContextPipeline 在 `shape()` 中隐式写 store。

## 如何识别 Meta Message

Coding Session Tree entry 显式记录 `source=meta`，不需要依赖文本启发式。导出到通用 Message 或第三方工具时，也可通过以下内容约定识别：

```text
第一条 role=user
第二条 role=user
第一条以 <system-reminder> 开头并结束
```

## 不变量

1. System Prompt Template 结构稳定；每个 Agent Run 渲染最新值且不写 Tree。
2. 每 loop 恰好一条 Meta User Message。
3. Meta 与 Prompt 是两条连续 user messages。
4. Meta 在 Prompt 之前。
5. Retry 不重复生成 Meta。
6. Steer 不生成 Meta；Follow-up 生成新 Meta。
7. Adapter 构建 System/Meta，Runtime 不访问 Product DB。
8. Skill 正文渐进加载，不整包塞入 Meta。
9. Context shaping 无持久化副作用。
10. Provider conversion 可合并 wire messages，但 Coding Session Tree 保留原语义。

## 关联页面

- [Coding Agent](./coding-agent.md)
- [Coding Agent Session](./coding-agent-session.md)
- [Coding Agent Provider 与 ModelRuntime](./coding-agent-models.md)
- [Agent Backend](../execution/agent-backend.md)
