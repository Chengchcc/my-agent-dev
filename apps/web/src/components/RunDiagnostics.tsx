"use client";

import { useMemo } from "react";
import { useAgentWorkspaceEntries } from "@/features/agents/hooks";
import { useMcpCatalog } from "@/features/mcp/hooks";
import { useModelList } from "@/features/models/hooks";
import { useAgentRuns, useSystemMetrics } from "@/features/ops/hooks";

/* ── Run Diagnostics rail (Obsidian chat run-console) ──
 * Live-run "Run Diagnostics" panel from the design mockup. Composes REAL
 * data: accrued cost + tokens (usage summary), context-window allocation
 * (usage vs the model's contextWindow), resident MEM (system metrics),
 * active MCP tool suite (catalog), workspace config bundle (agent root). */

function fmtCost(n: number | undefined): string {
  if (n == null) return "—";
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function RunDiagnostics({
  conversationId,
  agentId,
}: {
  conversationId: string;
  agentId?: string;
}) {
  const { data: runs } = useAgentRuns({ conversationId });
  const { data: models } = useModelList();
  const { data: mcp } = useMcpCatalog();
  const { data: metrics } = useSystemMetrics();
  const { data: ws } = useAgentWorkspaceEntries(agentId ?? "", "");

  // The conversation's most recent run is the one this console describes.
  const lastRun = useMemo(() => {
    const rr = runs?.runs ?? [];
    if (rr.length === 0) return null;
    return [...rr].sort((a, b) => b.createdAt - a.createdAt)[0]!;
  }, [runs]);

  const modelId = lastRun?.model?.modelId;
  const contextWindow = useMemo(() => {
    if (!modelId) return undefined;
    // Run modelId is qualified (`provider/model`) but the catalog id is bare.
    const bare = modelId.slice(modelId.indexOf("/") + 1);
    for (const prov of models?.providers ?? []) {
      const m = prov.models.find((x) => x.id === bare || x.id === modelId);
      if (m) return m.contextWindow;
    }
    return undefined;
  }, [models, modelId]);

  const usage = lastRun?.usage;
  const tokensUsed = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  const allocationPct =
    contextWindow && contextWindow > 0 ? Math.min(100, (tokensUsed / contextWindow) * 100) : null;

  const mcpServers = mcp?.mcpServers ?? [];
  const activeMcp = mcpServers.filter(
    (s) => s.runtimeStatus === "mounted" || s.status === "running",
  );
  const mcpOnline = activeMcp.length;

  // Workspace config bundle: the agent's root manifest files.
  const bundleFiles = (ws?.entries ?? []).filter(
    (e) =>
      e.kind === "file" && /^(AGENTS|SOUL|.*\.mcp\.json|.*\.yaml|.*\.yml|.*agent.*)/i.test(e.name),
  );

  const pid = metrics?.subprocesses?.[0]?.pid;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] tracking-kicker uppercase text-(--mute) font-semibold">
          Run Diagnostics
        </span>
        {pid && <span className="font-mono text-[9px] text-(--faint)">PID {pid}</span>}
      </div>

      {/* Resident MEM + Accrued cost */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-(--hairline) bg-(--panel) p-2.5">
          <span className="font-mono text-[9px] font-semibold uppercase tracking-kicker text-(--mute)">
            Resident MEM
          </span>
          <p className="mt-0.5 font-display text-lg font-semibold tracking-tight text-(--ink-strong) tabular-nums">
            {metrics ? `${Math.round(metrics.rssMb)}M` : "—"}
          </p>
          <p className="font-mono text-[9px] text-(--mute)">server rss</p>
        </div>
        <div className="rounded-lg border border-(--hairline) bg-(--panel) p-2.5">
          <span className="font-mono text-[9px] font-semibold uppercase tracking-kicker text-(--mute)">
            Accrued cost
          </span>
          <p className="mt-0.5 font-display text-lg font-semibold tracking-tight text-(--ink-strong) tabular-nums">
            {fmtCost(lastRun?.usage?.costUsd)}
          </p>
          <p className="font-mono text-[9px] text-(--mute)">{modelId?.split("/").at(-1) ?? "—"}</p>
        </div>
      </div>

      {/* Context window allocation */}
      <div className="rounded-lg border border-(--hairline) bg-(--panel) p-2.5">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[9px] font-semibold uppercase tracking-kicker text-(--mute)">
            Context window allocation
          </span>
          {allocationPct != null && (
            <span className="font-mono text-[9px] text-(--primary) tabular-nums">
              {allocationPct.toFixed(0)}%
            </span>
          )}
        </div>
        <div className="mt-2 h-1.5 w-full rounded-full bg-(--panel2) overflow-hidden">
          <div
            className="h-full rounded-full bg-(--primary)"
            style={{ width: `${allocationPct ?? 0}%` }}
          />
        </div>
        <p className="mt-1.5 font-mono text-[9px] text-(--mute) tabular-nums">
          {fmtTokens(tokensUsed)} tok / {fmtTokens(contextWindow ?? 0)} max
          {lastRun && <span className="ml-1.5 text-(--ok)">· {lastRun.status}</span>}
        </p>
      </div>

      {/* Active MCP tool suite */}
      <div className="rounded-lg border border-(--hairline) bg-(--panel) p-2.5">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[9px] font-semibold uppercase tracking-kicker text-(--mute)">
            Active MCP tool suite
          </span>
          <span className="font-mono text-[9px] text-(--ok) tabular-nums">{mcpOnline} online</span>
        </div>
        <ul className="mt-2 divide-y divide-(--hairline)">
          {(activeMcp.length ? activeMcp : mcpServers.slice(0, 4)).map((s) => (
            <li key={s.serverId} className="flex items-center gap-2 py-1.5 first:pt-0 last:pb-0">
              <span className="size-1.5 shrink-0 rounded-full bg-(--ok)" />
              <span className="min-w-0 flex-1 truncate text-[10px] text-(--body)">{s.name}</span>
              <span className="shrink-0 font-mono text-[9px] text-(--faint)">{s.transport}</span>
            </li>
          ))}
          {activeMcp.length === 0 && (
            <li className="py-1 font-mono text-[9px] text-(--faint)">No MCP servers mounted</li>
          )}
        </ul>
      </div>

      {/* Workspace config bundle */}
      {bundleFiles.length > 0 && (
        <div className="rounded-lg border border-(--hairline) bg-(--panel) p-2.5">
          <span className="font-mono text-[9px] font-semibold uppercase tracking-kicker text-(--mute)">
            Workspace config bundle
          </span>
          <ul className="mt-2 space-y-1">
            {bundleFiles.slice(0, 4).map((f) => (
              <li key={f.name} className="flex items-center gap-2">
                <span className="size-1 shrink-0 rounded-full bg-(--accent-violet)" />
                <span className="truncate font-mono text-[10px] text-(--body)">{f.name}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
