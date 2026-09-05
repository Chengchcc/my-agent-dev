"use client";

import { useQuery } from "@tanstack/react-query";
import { runEventsQuery } from "@/features/ops/queries";

type RunEvent = { seq: number; type: string; data: Record<string, unknown>; ts: number };

type Phase = {
  kind: "tool" | "model";
  name: string;
  start: number;
  end: number;
};

const MIN_SEGMENT_MS = 50;
const MAX_ROWS = 50;

const PHASE_COLOR: Record<string, string> = {
  tool: "var(--primary)",
  model: "var(--accent-violet)",
};

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Derive phase segments from the durable run-event log: closed
 *  tool_call spans (start/complete pairs by callId) plus the model-turn
 *  gaps between them. No adapter instrumentation needed. */
function buildPhases(events: RunEvent[], startTs: number, endTs: number): Phase[] {
  const open = new Map<string, { name: string; start: number }>();
  const spans: Phase[] = [];
  for (const e of events) {
    if (e.type === "native_tool_started" || e.type === "tool_started") {
      const callId = String(e.data.callId ?? "");
      if (callId) open.set(callId, { name: String(e.data.toolName ?? "tool"), start: e.ts });
    } else if (e.type === "native_tool_completed" || e.type === "tool_completed") {
      const callId = String(e.data.callId ?? "");
      const opened = open.get(callId);
      if (!opened) continue;
      open.delete(callId);
      spans.push({ kind: "tool", name: opened.name, start: opened.start, end: e.ts });
    }
  }
  spans.sort((a, b) => a.start - b.start);

  // Gaps between spans (and before the first / after the last) are the
  // model's turns: thinking + generation.
  const phases: Phase[] = [];
  let cursor = startTs;
  for (const span of spans) {
    if (span.start - cursor >= MIN_SEGMENT_MS) {
      phases.push({ kind: "model", name: "model turn", start: cursor, end: span.start });
    }
    phases.push(span);
    cursor = Math.max(cursor, span.end);
  }
  if (endTs - cursor >= MIN_SEGMENT_MS) {
    phases.push({ kind: "model", name: "model turn", start: cursor, end: endTs });
  }
  return phases;
}

export function RunWaterfall({
  runId,
  startTs,
  endTs,
}: {
  runId: string;
  startTs: number;
  endTs: number | null;
}) {
  const telemetry = useQuery(runEventsQuery(runId));
  const events = (telemetry.data?.events ?? []) as RunEvent[];
  if (events.length === 0) {
    return (
      <p className="text-sm text-(--mute)">
        No telemetry events for this run — the waterfall appears after the run emits tool activity.
      </p>
    );
  }

  const lastEventTs = events.at(-1)?.ts ?? startTs;
  const totalEnd = endTs ?? lastEventTs;
  const total = Math.max(1, totalEnd - startTs);
  const phases = buildPhases(events, startTs, totalEnd);
  const toolTime = phases
    .filter((p) => p.kind === "tool")
    .reduce((sum, p) => sum + (p.end - p.start), 0);
  const modelTime = total - toolTime;

  return (
    <div className="space-y-3">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-(--panel2)">
        {phases.map((phase, i) => {
          const width = ((phase.end - phase.start) / total) * 100;
          if (width < 0.2) return null;
          return (
            <div
              key={i}
              className="h-full"
              style={{
                width: `${width}%`,
                backgroundColor: PHASE_COLOR[phase.kind],
                opacity: 0.85,
              }}
              title={`${phase.name} ${fmtDuration(phase.end - phase.start)}`}
            />
          );
        })}
      </div>
      <div className="flex items-center gap-4 font-mono text-[10px] uppercase tracking-kicker text-(--mute)">
        <span className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-(--primary)" /> tools {fmtDuration(toolTime)}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-(--accent-violet)" /> model{" "}
          {fmtDuration(modelTime)}
        </span>
        <span className="ml-auto text-(--faint)">total {fmtDuration(total)}</span>
      </div>
      <div className="divide-y divide-(--hairline)">
        {phases.slice(0, MAX_ROWS).map((phase, i) => {
          const duration = phase.end - phase.start;
          const pct = Math.round((duration / total) * 100);
          return (
            <div key={i} className="flex items-center gap-2 py-1 font-mono text-[11px]">
              <span
                className="size-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: PHASE_COLOR[phase.kind] }}
              />
              <span className="w-40 shrink-0 truncate text-(--ink)">{phase.name}</span>
              <span className="w-16 shrink-0 text-right text-(--mute) tabular-nums">
                {fmtDuration(duration)}
              </span>
              <span className="w-10 shrink-0 text-right text-(--faint) tabular-nums">{pct}%</span>
              <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-(--panel2)">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.max(1, (duration / total) * 100)}%`,
                    backgroundColor: PHASE_COLOR[phase.kind],
                  }}
                />
              </div>
            </div>
          );
        })}
        {phases.length > MAX_ROWS && (
          <p className="pt-1 text-[10px] text-(--faint)">
            +{phases.length - MAX_ROWS} more segments
          </p>
        )}
      </div>
    </div>
  );
}
