"use client";

import type { WorkflowDefinition } from "@chengchenccc/workflow";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatNextRun, nextCronRun } from "./cron-next";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

type Mode = "daily" | "hourly" | "weekly" | "weekdays" | "custom";

/** Human sentence for a 5-field cron expression; falls back to the raw expr. */
export function describeCron(expr: string): string {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return expr;
  const [min, hour, , , dow] = f;
  const hm = `${String(Number(hour)).padStart(2, "0")}:${String(Number(min)).padStart(2, "0")}`;
  if (dow === "1-5") return `工作日 ${hm}`;
  if (/^[0-6]$/.test(dow ?? "")) return `每${WEEKDAYS[Number(dow)] ?? ""} ${hm}`;
  if (hour === "*") return `每小时的 ${String(Number(min)).padStart(2, "0")} 分`;
  return `每天 ${hm}`;
}

function buildCron(mode: Mode, time: string, weekday: number): string {
  const [h, m] = time.split(":").map(Number);
  const hh = Number.isInteger(h) ? h : 2;
  const mm = Number.isInteger(m) ? m : 0;
  switch (mode) {
    case "daily":
      return `${mm} ${hh} * * *`;
    case "hourly":
      return `${mm} * * * *`;
    case "weekly":
      return `${mm} ${hh} * * ${weekday}`;
    case "weekdays":
      return `${mm} ${hh} * * 1-5`;
    default:
      return "";
  }
}

export function TriggerPanel({
  definition,
  onChange,
}: {
  definition: WorkflowDefinition;
  onChange: (def: WorkflowDefinition) => void;
}) {
  const [mode, setMode] = useState<Mode>("daily");
  const [time, setTime] = useState("02:00");
  const [weekday, setWeekday] = useState(1);
  const [custom, setCustom] = useState("");
  const triggers = definition.triggers ?? [];

  function setTriggers(next: WorkflowDefinition["triggers"]) {
    onChange({ ...definition, triggers: next });
  }

  const pendingCron = mode === "custom" ? custom.trim() : buildCron(mode, time, weekday);
  const preview = pendingCron ? nextCronRun(pendingCron) : null;

  function add() {
    if (!pendingCron) return;
    if (triggers.some((t) => t.cron === pendingCron)) return;
    // Only ONE cron trigger is meaningful — a workflow has a single
    // schedule. Adding replaces the existing one (or sets the first).
    setTriggers([{ type: "cron", cron: pendingCron }]);
    setCustom("");
  }

  function remove(index: number) {
    setTriggers(triggers.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-4 p-4">
      <div className="space-y-2.5 rounded-lg border border-(--hairline) bg-(--canvas)/50 p-3">
        <Label className="text-xs text-(--mute)">添加定时触发（可选，仅一个）</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={mode} onValueChange={(v) => setMode((v ?? "daily") as Mode)}>
            <SelectTrigger className="h-8 w-26 min-w-0 shrink-0 border-(--hairline) bg-(--canvas) text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">每天</SelectItem>
              <SelectItem value="hourly">每小时</SelectItem>
              <SelectItem value="weekly">每周</SelectItem>
              <SelectItem value="weekdays">工作日</SelectItem>
              <SelectItem value="custom">自定义</SelectItem>
            </SelectContent>
          </Select>
          {mode === "hourly" ? (
            <Input
              type="number"
              min={0}
              max={59}
              className="h-8 min-w-28 flex-1 border-(--hairline) bg-(--canvas) text-xs"
              value={time.split(":")[1] ?? "0"}
              onChange={(e) =>
                setTime(
                  `00:${String(Math.min(59, Math.max(0, Number(e.target.value) || 0))).padStart(2, "0")}`,
                )
              }
            />
          ) : mode === "weekly" ? (
            <>
              <Select value={String(weekday)} onValueChange={(v) => setWeekday(Number(v ?? 1))}>
                <SelectTrigger className="h-8 w-18 min-w-0 shrink-0 border-(--hairline) bg-(--canvas) text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WEEKDAYS.map((d, i) => (
                    <SelectItem key={d} value={String(i)}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                type="time"
                className="h-8 min-w-28 flex-1 border-(--hairline) bg-(--canvas) text-xs"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </>
          ) : mode === "custom" ? (
            <Input
              className="h-8 min-w-28 flex-1 border-(--hairline) bg-(--canvas) font-mono text-xs"
              placeholder="分 时 日 月 周"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") add();
              }}
            />
          ) : (
            <Input
              type="time"
              className="h-8 min-w-28 flex-1 border-(--hairline) bg-(--canvas) text-xs"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          )}
          <Button size="sm" className="shrink-0" onClick={add}>
            添加
          </Button>
        </div>
        {pendingCron && (
          <div className={`text-[10px] ${preview ? "text-(--mute)" : "text-(--err)"}`}>
            {preview
              ? `${describeCron(pendingCron)}（${pendingCron}）· 下次运行：${formatNextRun(preview)}`
              : "cron 表达式无效（需 5 段：分 时 日 月 周）"}
          </div>
        )}
      </div>
      <div className="space-y-2 rounded-lg border border-(--hairline) bg-(--canvas)/30 p-3 text-[11px] leading-relaxed text-(--mute)">
        <div>
          <span className="mr-1 font-medium text-(--body)">手动</span>
          <span>画布或列表点 Run，或在 executions 页触发，无需配置。</span>
        </div>
        <div>
          <span className="mr-1 font-medium text-(--body)">API</span>
          <span>POST</span>
          <code className="mx-1 block w-fit rounded bg-(--panel2) px-1.5 py-0.5 font-mono text-[10px]">
            /api/workflow-executions
          </code>
          <span className="mt-1 block">传入</span>
          <code className="mx-1 block w-fit rounded bg-(--panel2) px-1.5 py-0.5 font-mono text-[10px]">
            {'{ workflowRef: { path: "<id>.workflow.json" }, input }'}
          </code>
          <span className="mt-1 block">即可触发，无需声明。</span>
        </div>
        {triggers.length === 0 && (
          <p className="text-[10px]">未配置定时触发——手动/API 随时可用。</p>
        )}
      </div>
      {triggers.length > 0 && (
        <div className="space-y-2">
          {triggers.map((t, i) => (
            <div
              key={`${i}-${t.cron}`}
              className="flex items-center gap-2 rounded-lg border border-(--hairline) px-2.5 py-2 text-xs"
            >
              <div className="min-w-0 flex-1">
                <div>{describeCron(t.cron)}</div>
                <div className="font-mono text-[9px] text-(--faint)">
                  {t.cron} · 下次 {formatNextRun(nextCronRun(t.cron))}
                </div>
              </div>
              <button onClick={() => remove(i)} className="shrink-0 text-(--err) hover:underline">
                删除
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
