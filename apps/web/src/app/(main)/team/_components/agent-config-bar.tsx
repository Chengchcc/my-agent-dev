"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { agentKeys } from "@/features/agents/query-keys";
import { useModelList } from "@/features/models/hooks";
import { type AgentRow, api } from "@/lib/api";

const BACKEND_ORDER = ["coding_agent", "claude_code", "pi", "omp"];

const labelClass = "text-(--text-cap) uppercase tracking-kicker font-semibold text-(--mute)";

/** Inline config bar (spec §4): Backend / Model / Reasoning effort
 *  dropdowns + a Fallback switch. Each change autosaves via PATCH with a
 *  500ms debounce; failures toast and roll the field back to its prior
 *  value. The payloads never carry an `anthropic:` prefix — the backend
 *  persists `{model:{provider,model}}` / `{backendKind}` / `{reasoningEffort}`
 *  verbatim. */
export function AgentConfigBar({ agent }: { agent: AgentRow }) {
  const qc = useQueryClient();
  const { data: modelData } = useModelList();
  const providers = modelData?.providers ?? [];

  const groups = useMemo(
    () =>
      providers.flatMap((p) =>
        p.models.map((m) => ({
          id: `${p.id}/${m.id}`,
          name: m.name ?? m.id,
          provider: p.id,
          backendKind: m.backendKind ?? "coding_agent",
          available: m.available !== false,
        })),
      ),
    [providers],
  );

  const backendKinds = useMemo(() => {
    const seen = new Set(groups.map((g) => g.backendKind));
    return BACKEND_ORDER.filter((k) => seen.has(k));
  }, [groups]);

  const [backendKind, setBackendKind] = useState(agent.backendKind ?? "coding_agent");
  const [model, setModel] = useState(`${agent.modelProvider}/${agent.modelName}`);
  const [effort, setEffort] = useState(agent.reasoningEffort ?? "");
  const [enabled, setEnabled] = useState(agent.enabled ?? true);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const filteredModels = useMemo(
    () => groups.filter((g) => g.backendKind === backendKind),
    [groups, backendKind],
  );

  const commit = (body: Record<string, unknown>, rollback: () => void) => {
    if (timer.current) clearTimeout(timer.current);
    setSavedAt(null);
    timer.current = setTimeout(async () => {
      try {
        console.debug("agent-config PATCH", agent.id, body);
        await api.updateAgent(agent.id, body);
        setSavedAt(new Date().toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" }));
        void qc.invalidateQueries({ queryKey: agentKeys.detail(agent.id) });
        void qc.invalidateQueries({ queryKey: agentKeys.lists() });
      } catch (err) {
        rollback();
        toast.error("Failed to save agent config", {
          description: err instanceof Error ? err.message : undefined,
        });
      }
    }, 500);
  };

  const onBackend = (v: string | null) => {
    const next = v ?? "coding_agent";
    const prev = backendKind;
    setBackendKind(next);
    commit({ backendKind: next }, () => setBackendKind(prev));
  };

  const onModel = (v: string | null) => {
    const next = v ?? "";
    const prev = model;
    setModel(next);
    const slash = next.indexOf("/");
    const provider = slash > 0 ? next.slice(0, slash) : "";
    const name = slash > 0 ? next.slice(slash + 1) : next;
    commit({ model: { provider, model: name } }, () => setModel(prev));
  };

  const onEffort = (v: string | null) => {
    const next = v ?? "";
    const prev = effort;
    setEffort(next);
    commit({ reasoningEffort: next || null }, () => setEffort(prev));
  };

  const onEnabled = (next: boolean) => {
    const prev = enabled;
    setEnabled(next);
    commit({ enabled: next }, () => setEnabled(prev));
  };

  return (
    <section className="rounded-(--radius-card) border border-(--hairline) bg-(--panel) px-4 py-3">
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Backend</span>
          <Select value={backendKind} onValueChange={onBackend}>
            <SelectTrigger size="sm" className="min-w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {backendKinds.map((k) => (
                <SelectItem key={k} value={k}>
                  {k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <label className="flex flex-col gap-1">
          <span className={labelClass}>Model</span>
          <Select value={model} onValueChange={onModel}>
            <SelectTrigger size="sm" className="min-w-48">
              <SelectValue placeholder="Select model…" />
            </SelectTrigger>
            <SelectContent>
              {filteredModels.map((m) => (
                <SelectItem key={m.id} value={m.id} disabled={!m.available}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <label className="flex flex-col gap-1">
          <span className={labelClass}>Reasoning effort</span>
          <Select value={effort} onValueChange={onEffort}>
            <SelectTrigger size="sm" className="min-w-36">
              <SelectValue placeholder="Provider default" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Provider default</SelectItem>
              <SelectItem value="none">None (thinking off)</SelectItem>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="max">Max</SelectItem>
            </SelectContent>
          </Select>
        </label>

        <label className="flex items-center gap-2 pb-1.5">
          <Switch
            checked={enabled}
            onCheckedChange={onEnabled}
            aria-label="Agent enabled"
            title={enabled ? "Agent enabled" : "Agent disabled"}
          />
          <span className={labelClass}>{enabled ? "Enabled" : "Disabled"}</span>
        </label>

        <span className="ml-auto pb-1.5 text-(--text-cap) text-(--mute)">
          {savedAt ? `Auto-saved · ${savedAt}` : ""}
        </span>
      </div>
    </section>
  );
}
