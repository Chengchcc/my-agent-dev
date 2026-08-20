"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { FileContentViewer } from "@/components/FileContentViewer";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useActivateLoop, useCreateLoop, useRunLoop } from "@/features/loop/hooks";

type Stage = "form" | "preview";

const TEMPLATES = [
  {
    label: "CI 失败自动修",
    goal: "修复 CI 失败",
    action: "自动修简单失败,复杂转人工",
    acceptance: "相关测试全绿",
  },
  {
    label: "每日变更汇总",
    goal: "汇总每日代码变更",
    action: "生成报告,不改代码",
    acceptance: "报告包含新增/进行中/阻塞三节",
  },
  {
    label: "PR review 提醒",
    goal: "提醒待 review 的 PR",
    action: "只通知,不自动处理",
    acceptance: "列出所有待 review PR 及作者",
  },
  {
    label: "依赖升级检查",
    goal: "检查依赖可升级项",
    action: "生成升级建议,不自动改",
    acceptance: "报告含当前版本/最新版本/风险",
  },
  {
    label: "文档同步",
    goal: "同步文档与代码",
    action: "检测不一致并修复文档",
    acceptance: "无过时引用",
  },
] as const;

const ELEMENTS = [
  { key: "goal", label: "Goal" },
  { key: "action", label: "Action" },
  { key: "acceptance", label: "Acceptance" },
] as const;

interface LoopForm {
  name: string;
  goal: string;
  action: string;
  acceptance: string;
  verifyCommands: string;
  cronExpr: string;
}

const EMPTY: LoopForm = {
  name: "",
  goal: "",
  action: "",
  acceptance: "",
  verifyCommands: "",
  cronExpr: "",
};

export default function NewLoopPage() {
  const router = useRouter();
  const createLoop = useCreateLoop();
  const activateLoop = useActivateLoop();
  const [stage, setStage] = useState<Stage>("form");
  const [form, setForm] = useState<LoopForm>(EMPTY);
  const [questions, setQuestions] = useState<string[]>([]);
  const [loopId, setLoopId] = useState<string | null>(null);
  const [preview, setPreview] = useState("");
  const runLoop = useRunLoop();

  const set = (key: keyof LoopForm, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (key === "goal" && !form.name) {
      setForm((prev) => ({ ...prev, goal: value, name: value.slice(0, 30) || "new-loop" }));
    }
  };
  const applyTemplate = (t: (typeof TEMPLATES)[number]) => {
    setForm({ ...EMPTY, name: t.label, goal: t.goal, action: t.action, acceptance: t.acceptance });
    setQuestions([]);
  };

  const complete = useMemo(() => ELEMENTS.filter((e) => form[e.key].trim()).length, [form]);

  function handleCreate() {
    const missing = ELEMENTS.filter((e) => !form[e.key].trim()).map((e) => e.label);
    if (missing.length > 0) {
      setQuestions(missing.map((m) => `缺少 ${m} 要素`));
      return;
    }
    setQuestions([]);
    createLoop.mutate(
      {
        name: form.name || form.goal.slice(0, 30),
        goal: form.goal,
        action: form.action,
        acceptance: form.acceptance,
        verifyCommands: form.verifyCommands
          .split("\n")
          .map((c) => c.trim())
          .filter(Boolean),
        cronExpr: form.cronExpr || undefined,
      },
      {
        onSuccess: (result) => {
          if (result.status === "needs_clarification") {
            setQuestions(result.questions);
            return;
          }
          setLoopId(result.loop.id);
          setPreview(result.loop.preview);
          setStage("preview");
        },
        onError: (e) => toast.error(`创建失败: ${String(e)}`),
      },
    );
  }

  function handleActivate() {
    if (!loopId) return;
    activateLoop.mutate(loopId, {
      onSuccess: () => {
        toast.success("Loop enabled");
        router.push(`/work/${loopId}`);
      },
    });
  }

  function reset() {
    setStage("form");
    setForm(EMPTY);
    setQuestions([]);
    setLoopId(null);
    setPreview("");
  }

  return (
    <Page>
      <PageHeader
        breadcrumb="Work / New"
        title="New Loop"
        description="Pick a template or define the four elements — then try it once before enabling the schedule."
      />
      <PageBody size="reading">
        {stage === "form" && (
          <Card>
            <CardHeader>
              <CardTitle>What do you want to automate?</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-1.5">
                {TEMPLATES.map((t) => (
                  <Button
                    key={t.label}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="text-xs"
                    onClick={() => applyTemplate(t)}
                  >
                    {t.label}
                  </Button>
                ))}
              </div>

              <div className="flex items-center gap-1.5">
                {ELEMENTS.map((e) => {
                  const done = form[e.key].trim().length > 0;
                  return (
                    <span
                      key={e.key}
                      className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${
                        done
                          ? "border-emerald-500/30 text-emerald-600"
                          : "border-(--hairline) text-(--mute)"
                      }`}
                    >
                      {done ? "✓ " : ""}
                      {e.label}
                    </span>
                  );
                })}
                <span className="ml-auto text-[10px] text-(--mute)">
                  {complete}/{ELEMENTS.length}
                </span>
              </div>

              <div className="space-y-1">
                <label className="text-sm font-medium">Name</label>
                <Input value={form.name} onChange={(e) => set("name", e.target.value)} />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">Goal — 要自动化什么</label>
                <Textarea
                  value={form.goal}
                  onChange={(e) => set("goal", e.target.value)}
                  rows={2}
                  placeholder="e.g. 修复 CI 失败"
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">Action — 做什么 + 边界</label>
                <Textarea
                  value={form.action}
                  onChange={(e) => set("action", e.target.value)}
                  rows={2}
                  placeholder="e.g. 自动修简单失败,复杂转人工"
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">Acceptance — 怎么算做好</label>
                <Textarea
                  value={form.acceptance}
                  onChange={(e) => set("acceptance", e.target.value)}
                  rows={2}
                  placeholder="e.g. 相关测试全绿(会被渲染进 verify 步骤并真实执行)"
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">
                  Verify commands(每行一条,verify 必须执行并把输出作为 evidence)
                </label>
                <Textarea
                  value={form.verifyCommands}
                  onChange={(e) => set("verifyCommands", e.target.value)}
                  rows={3}
                  placeholder={"bun test\nbun run typecheck"}
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">Schedule(cron,留空 = 手动)</label>
                <Input
                  value={form.cronExpr}
                  onChange={(e) => set("cronExpr", e.target.value)}
                  placeholder="0 9 * * *"
                />
              </div>

              {questions.length > 0 && (
                <div className="rounded border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
                  {questions.map((q) => (
                    <p key={q}>• {q}</p>
                  ))}
                </div>
              )}

              <Button onClick={handleCreate} disabled={createLoop.isPending}>
                {createLoop.isPending ? "Creating…" : "Create draft"}
              </Button>
            </CardContent>
          </Card>
        )}

        {stage === "preview" && (
          <Card>
            <CardHeader>
              <CardTitle>Preview LOOP.md</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {preview ? (
                <FileContentViewer value={preview} path="LOOP.md" />
              ) : (
                <p className="text-sm text-(--muted)">(no preview)</p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={reset}>
                  Regenerate
                </Button>
                <Button
                  variant="outline"
                  disabled={runLoop.isPending}
                  onClick={() => {
                    if (!loopId) return;
                    // Run Once: 先验证再上线
                    runLoop.mutate(loopId, {
                      onSuccess: () => toast.success("试跑已触发,可在 Loop 详情页查看结果"),
                    });
                  }}
                >
                  {runLoop.isPending ? "Running…" : "Run once (试跑)"}
                </Button>
                <Button onClick={handleActivate} disabled={activateLoop.isPending}>
                  {activateLoop.isPending ? "Activating…" : "Confirm and enable"}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </PageBody>
    </Page>
  );
}
