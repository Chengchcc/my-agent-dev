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
    <div className="rounded-lg border border-(--hairline) bg-(--panel) p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[9px] font-semibold uppercase tracking-kicker text-(--mute)">
          {label}
        </span>
        <span className="font-mono text-[9px] text-(--ok) tabular-nums">
          ≈${t.costUsd.toFixed(2)}
        </span>
      </div>
      <p className="mt-0.5 font-display text-xl font-semibold tracking-tight text-(--ink-strong) tabular-nums">
        {fmtTokens(t.inputTokens + t.outputTokens)}
        <span className="ml-1 font-mono text-[9px] font-normal text-(--mute)">tok</span>
      </p>
      <p className="mt-0.5 font-mono text-[9px] text-(--mute) tabular-nums">
        in {fmtTokens(t.inputTokens)} · out {fmtTokens(t.outputTokens)}
        {t.cacheReadTokens + t.cacheWriteTokens > 0 &&
          ` · cache ${fmtTokens(t.cacheReadTokens + t.cacheWriteTokens)}`}
        {` · ${t.runs} run${t.runs !== 1 ? "s" : ""}`}
      </p>
    </div>
  );
}

/** Token spend for a scope (chat session or agent) plus today's fleet total. */
export function UsagePanel({
  conversationId,
  agentId,
}: {
  conversationId?: string;
  agentId?: string;
}) {
  const { data } = useUsageSummary({ conversationId, agentId });

  return (
    <div className="mt-4 space-y-2">
      {conversationId && <UsageRow label="This chat" t={data?.conversation ?? EMPTY} />}
      {agentId && <UsageRow label="This agent" t={data?.agent ?? EMPTY} />}
      <UsageRow label="Today" t={data?.today ?? EMPTY} />
    </div>
  );
}
