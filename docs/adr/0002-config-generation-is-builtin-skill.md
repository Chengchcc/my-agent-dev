# ADR 0002: Loop 配置生成是内置 Skill

## 状态

Accepted

## 上下文

用户用自然语言描述意图（"每天早上检查 CI 失败，自动修简单的"），系统需要把它翻译成 `.loop/config.yml` + `constraints.md` + 复制对应 SKILL.md。

原设计（loop-pattern.md）描述为"翻译器是一个 prompt 调用"。但在 grilling 中被指出：这件事有明确的角色、固定的知识（7 个 Pattern 模板、config.yml schema、安全约束默认值），装在一个 AgentSession 里跑，它就是 Skill。

## 决策

**创建时意图→配置翻译做成内置 Skill `loop-config-generator/SKILL.md`**。与 Loop 运行时三天 Skill（loop-triage、loop-generator、loop-verifier）平级，区别在于它**只在创建时跑一次**。

归属：
- `loop-config-generator`：系统内置，随 progressive-skill plugin 的 builtin skills 分发
- `loop-triage` / `loop-generator` / `loop-verifier`：从内置模板库复制到 `.loop/skills/`，Loop 每轮运行使用

## 后果

- loop-pattern.md "意图→配置翻译"小节需从"prompt 调用"改为"内置 Skill"
- 内置 Skill 的注册方式待定：放在 progressive-skill plugin 的 builtin 目录，还是独立的 global skills 目录
- 创建 Loop 时 `.loop/` 还不存在，所以 `loop-config-generator` 不能放在 `.loop/skills/` 里

## 关联

- [Loop Pattern](../architecture/foundations/loop-pattern.md)
- [Loop](../architecture/foundations/loop.md)
- [渐进式技能](../architecture/plugins/progressive-skill.md)
