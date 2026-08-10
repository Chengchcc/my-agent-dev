---
id: foundations.loop-pattern
title: Loop Pattern（内部模板）
status: design
owners: architecture
last_verified_against_code: 2026-07-01
summary: "Loop Pattern 不是用户可见的概念——它是意图→配置翻译器的内部模板。用户用自然语言表达意图，系统匹配合适的内部模板来生成 Loop 配置（schedule、discovery skill、generator/evaluator model、safety constraints）。7 种内置模板覆盖最常见的自动化场景。"
depends_on:
  - foundations.loop
used_by: []
---

# Loop Pattern（内部模板）

> 本页 `status: design`：Pattern 是系统内部的配置模板，用户不可见。用户不选 pattern——用户用自然语言表达意图。

用户输入"每天早上检查 CI 失败，自动修简单的"，系统内部匹配合适的模板（Daily Triage），填入 schedule="0 8 * * *"、discovery skill="loop-triage"、safety constraints 默认值，返回预览。用户不选 pattern，用户只说意图。

## 7 种内置模板

| 模板 | 匹配意图示例 | 默认 schedule | discovery skill |
|---|---|---|---|
| Daily Triage | "检查 CI"、"早上 triage" | 1d | loop-triage |
| PR Babysitter | "提醒 reviewer"、"监控 PR" | 15m | pr-watcher |
| CI Sweeper | "修 CI"、"修测试失败" | 15m | ci-sweeper |
| Changelog Drafter | "写 changelog"、"发版笔记" | 1d | changelog-scan |
| Dependency Sweeper | "升级依赖"、"检查 CVE" | 6h | dep-scanner |
| Issue Triage | "分类 issue"、"打标签" | 2h | issue-triage |
| Post-Merge Cleanup | "清理合并后"、"删 dead code" | 1d | post-merge-scan |

每种模板定义了默认的：
- discovery skill 和 generator/evaluator model
- safety constraints（denylist、auto-merge 策略、max retries）
- budget cap

## 意图 → 配置翻译

翻译由系统内置 Skill `loop-config-generator/SKILL.md` 完成——它装在 Agent 里，输入用户意图 + 7 种模板描述，输出匹配的模板名 + 参数。然后 scaffold `.loop/` 目录：

1. 写 `config.yml`（填入匹配模板的默认值 + 从意图提取的参数）
2. 从内置模板库复制对应 skill 的 `SKILL.md` 到 `.loop/skills/`
3. 生成 `constraints.md`（默认 denylist + budget cap）
4. 生成空 `STATE.md`（首轮运行时由 discovery 填充）
5. 创建 CronJob（`loop_config_path` 指向 `.loop/`）

> `loop-config-generator` 是**系统内置 Skill**，不同于 `.loop/skills/` 下的三种运行时 Skill。它只在创建 Loop 时跑一次；创建完成后 `.loop/` 目录里没有它的副本。参见 [ADR 0002](../../adr/0002-config-generation-is-builtin-skill.md)。
用户预览生成结果，可手动调整任何参数，然后确认激活。

## L1 / L2 / L3 信任层级

创建时默认 L1（report-only，不启动 generator）。用户需要积累足够信任（evaluator 稳定拒绝错误产出）才能升到 L2（assisted，有人审批）和 L3（unattended，严格约束下自动 resolve）。

## 关联页面

- [Loop](./loop.md) — 模板生成的目标配置
- [LoopRunner](../backend/loop-runner.md) — 配置决定 loopStep 的行为
