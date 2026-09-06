"use client";

import { agentConfigEvents } from "@chengchenccc/api-contract";
import { useEffect, useRef } from "react";
import type { AgentRow } from "@/lib/api";
import { typedSource } from "@/lib/typed-source";

/** Map an agent.yml-shaped config (what the agent-config MCP agent_write
 *  proposes / the backend PATCH emits) to the AgentRow shape that AgentForm's
 *  form.reset() consumes. The proposed config doesn't carry workspacePath or
 *  lark credential/status — those ride the base agent the form was opened on. */
export function agentConfigToRow(config: unknown, base: AgentRow): AgentRow {
  const c = (config ?? {}) as Record<string, unknown>;
  const rc = (c.runtime_config ?? {}) as Record<string, unknown>;
  const lk = (c.lark ?? {}) as Record<string, unknown>;
  const modelId = String(rc.model_id ?? "");
  const slash = modelId.indexOf("/");
  const mcpServers = Array.isArray(rc.mcp_servers)
    ? (rc.mcp_servers as Array<{ server_id: string; enabled: boolean }>).map((s) => ({
        serverId: s.server_id,
        enabled: s.enabled,
      }))
    : [];
  const maxSteps = typeof rc.max_steps === "number" && rc.max_steps > 0 ? rc.max_steps : null;

  return {
    ...base,
    name: String(c.name ?? base.name),
    enabled: Boolean(c.enabled ?? base.enabled),
    modelProvider: slash > 0 ? modelId.slice(0, slash) : "unknown",
    modelName: slash > 0 ? modelId.slice(slash + 1) : modelId,
    backendKind: String(rc.runtime ?? base.backendKind),
    reasoningEffort:
      rc.reasoning_effort && rc.reasoning_effort !== ""
        ? (rc.reasoning_effort as "none" | "low" | "high" | "max")
        : null,
    permissionMode: (rc.permission_mode as AgentRow["permissionMode"]) ?? base.permissionMode,
    maxSteps: maxSteps as number | null,
    mcpServers,
    knowledgePacks: Array.isArray(rc.knowledge_packs) ? (rc.knowledge_packs as string[]) : [],
    projects: Array.isArray(rc.projects) ? (rc.projects as string[]) : [],
    lark: {
      ...base.lark,
      enabled: Boolean(lk.enabled ?? base.lark?.enabled),
      botDisplayName: String(lk.bot_display_name ?? base.lark?.botDisplayName ?? ""),
    },
  };
}

/** Subscribe to an agent's config SSE. `onProposed` fires when the chat
 *  agent proposes a new config (trigger="mcp"); `onSaved` when the config is
 *  saved via HTTP PATCH (trigger="save"). Resubscribes only when agentId or a
 *  callback identity changes. */
export function useAgentConfigEvents(
  agentId: string | undefined,
  handlers: { onProposed: (config: unknown) => void; onSaved?: (config: unknown) => void },
) {
  // Keep the latest handlers in a ref so the effect (keyed only on agentId)
  // never resubscribes per render yet always calls the current callbacks.
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

  useEffect(() => {
    if (!agentId) return;
    const url = `/api/bff/api/agents/${encodeURIComponent(agentId)}/events`;
    const ts = typedSource(url, agentConfigEvents);
    ts.on("changed", (ev) => {
      if (ev.data?.trigger === "mcp" && ev.data.config !== undefined) {
        handlersRef.current.onProposed(ev.data.config);
      } else if (ev.data?.trigger === "save" && ev.data.config !== undefined) {
        handlersRef.current.onSaved?.(ev.data.config);
      }
    });
    return () => ts.close();
  }, [agentId]);
}
