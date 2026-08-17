"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAgentDetail } from "@/features/agents/hooks";
import { agentKeys } from "@/features/agents/query-keys";
import { type AgentRow, api, type LarkSetupSession } from "@/lib/api";

/** Agent-level Lark bot setup (M15.1): initialize a profile for this agent
 *  and start the bot. The setup session is created server-side and resolves
 *  to an external Lark setup URL. */
export function LarkBotPanel({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const { data: agent } = useAgentDetail(agentId) as { data?: AgentRow };
  const [botName, setBotName] = useState(agent?.lark?.botDisplayName ?? "");
  const [session, setSession] = useState<LarkSetupSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (agent) setBotName(agent.lark?.botDisplayName ?? "");
  }, [agent]);

  useEffect(() => {
    if (session?.status !== "pending") return;
    const timer = setInterval(async () => {
      try {
        const next = await api.larkSetupStatus(agentId, session.setupId);
        setSession(next);
        if (next.status !== "pending") {
          clearInterval(timer);
          void qc.invalidateQueries({ queryKey: agentKeys.detail(agentId) });
          void qc.invalidateQueries({ queryKey: agentKeys.lists() });
        }
      } catch {
        clearInterval(timer);
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [agentId, qc, session?.setupId, session?.status]);

  const startSetup = async () => {
    setLoading(true);
    setError("");
    try {
      setSession(
        await api.larkSetup(agentId, {
          botDisplayName: botName.trim() || undefined,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start Lark setup");
    } finally {
      setLoading(false);
    }
  };

  const cancelSetup = async () => {
    try {
      await api.larkSetupCancel(agentId, session!.setupId);
    } catch {
      /* already settled */
    }
    setSession(null);
  };

  const status = agent?.lark?.status ?? "not_configured";
  const hasProfile = !!agent?.lark?.profileRef;

  return (
    <div className="space-y-4 rounded-(--radius-card) border border-(--hairline) bg-(--panel) p-4">
      <div className="flex items-center gap-2">
        <span className="text-(--text-emph) font-medium text-(--ink)">Lark Bot</span>
        <Badge
          variant={
            status === "running" ? "default" : status === "error" ? "destructive" : "secondary"
          }
        >
          {status}
        </Badge>
      </div>

      {!hasProfile ? (
        <>
          <p className="text-sm text-(--mute)">
            This agent has no Lark profile yet. Initialize one to bind a Lark bot.
          </p>
          <div className="space-y-1">
            <Label>Bot display name</Label>
            <Input
              value={botName}
              onChange={(e) => setBotName(e.target.value)}
              placeholder="Optional - must match Lark app settings"
            />
          </div>

          {session?.status === "pending" ? (
            <div className="space-y-2">
              <p className="text-sm text-(--body)">Open this link to finish setup:</p>
              {session.url ? (
                <a
                  href={session.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-(--chart-2) underline break-all"
                >
                  {session.url}
                </a>
              ) : (
                <p className="text-sm text-amber-600">Waiting for setup URL…</p>
              )}
              <Button variant="ghost" size="sm" onClick={() => void cancelSetup()}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button onClick={() => void startSetup()} disabled={loading}>
              {loading ? "Starting…" : "Initialize Lark Bot"}
            </Button>
          )}

          {error && <p className="text-sm text-(--err)">{error}</p>}
        </>
      ) : (
        <p className="text-sm text-(--mute)">
          Lark profile is configured. Manage the bot from the System → Surfaces page.
        </p>
      )}
    </div>
  );
}
