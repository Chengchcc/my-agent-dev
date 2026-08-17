"use client";

import { useUsageSummary } from "@/features/ops/hooks";

type Totals = {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
};

const EMPTY: Totals = {
  runs: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
};

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function UsageRow({ label, t }: { label: string; t: Totals }) {
  return (
    <div className="py-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-kicker text-(--mute)">
          {label}
        </span>
        <span className="text-xs font-medium text-(--ink-strong) tabular-nums">
          {fmtTokens(t.inputTokens + t.outputTokens)} tok · ≈${t.costUsd.toFixed(2)}
        </span>
      </div>
      <p className="text-[10px] text-(--mute) tabular-nums">
        in {fmtTokens(t.inputTokens)} · out {fmtTokens(t.outputTokens)}
        {t.cacheReadTokens + t.cacheWriteTokens > 0 &&
          ` · cache ${fmtTokens(t.cacheReadTokens + t.cacheWriteTokens)}`}
        {` · ${t.runs} run${t.runs !== 1 ? "s" : ""}`}
      </p>
    </div>
  );
}

/** Token spend for the current chat session plus today's fleet-wide total. */
export function UsagePanel({ conversationId }: { conversationId: string }) {
  const { data } = useUsageSummary(conversationId);

  return (
    <div className="mt-4 border-t border-(--hairline) pt-3">
      <UsageRow label="This chat" t={data?.conversation ?? EMPTY} />
      <UsageRow label="Today" t={data?.today ?? EMPTY} />
    </div>
  );
}
