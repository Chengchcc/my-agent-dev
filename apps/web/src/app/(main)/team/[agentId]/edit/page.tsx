"use client";

import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AgentForm } from "@/components/AgentForm";
import { Page, PageHeader } from "@/components/page";
import { ChatPanel } from "@/components/workflow/ChatPanel";
import { agentConfigToRow, useAgentConfigEvents } from "@/features/agents/config-mcp";
import { useAgentDetail } from "@/features/agents/hooks";
import type { AgentRow } from "@/lib/api";

/** Agent edit page: left form (the full AgentForm) + right chat. The chat
 *  agent proposes config changes via the mounted agent-config MCP tools
 *  (agent_write); a "changed" SSE event surfaces the proposed config, and the
 *  form adopts it as an unsaved edit for the user to review and save. */
export default function AgentEditPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const { data: agent, isLoading } = useAgentDetail(agentId);
  const [proposed, setProposed] = useState<AgentRow | null>(null);

  // Keep the latest agent readable from the SSE callback (which is captured
  // once per agentId) without resubscribing on every agent re-fetch.
  const agentRef = useRef<AgentRow | null>(null);
  useEffect(() => {
    agentRef.current = agent ?? null;
  }, [agent]);

  // Subscribe once the agent id is known. A chat-proposed config is mapped to
  // the AgentRow shape and passed to AgentForm, which resets to it as an
  // unsaved edit. The current live agent is the base for fields the proposed
  // config doesn't carry (workspacePath, lark credentials/status).
  useAgentConfigEvents(agentId, {
    onProposed: (config) => {
      const base = agentRef.current;
      if (!base) return;
      setProposed(agentConfigToRow(config, base));
    },
  });

  if (isLoading) {
    return (
      <Page>
        <PageHeader
          breadcrumb={[
            { label: "Team", href: "/team" },
            { label: "Agents", href: "/team" },
          ]}
          title="Agent"
        />
        <div className="animate-pulse space-y-3 px-4 sm:px-6 lg:px-8 py-6">
          <div className="h-6 w-48 bg-(--panel2)" />
          <div className="h-4 w-32 bg-(--panel2)" />
        </div>
      </Page>
    );
  }

  const editAgent = proposed ?? agent;

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: "Team", href: "/team" },
          { label: "Agents", href: "/team" },
          { label: agent?.name ?? "Agent", href: `/team/${agentId}` },
          { label: "Edit" },
        ]}
        title={`Edit ${agent?.name ?? "Agent"}`}
      />
      {!editAgent ? (
        <div className="px-4 py-6 text-(--mute)">Agent not found.</div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* Left: the form */}
          <div className="min-h-0 min-w-0 flex-1 border-(--hairline) p-4 md:border-r">
            <AgentForm editAgent={editAgent} alwaysOpen onSuccess={() => setProposed(null)} />
          </div>
          {/* Right: chat */}
          <div className="flex w-[320px] shrink-0 flex-col border-l border-(--hairline)">
            <ChatPanel
              conversationId={`agent:chat:${agentId}`}
              title="Agent Chat"
              contextBlock={[
                "<agent-context>",
                `<agentId>${agentId}</agentId>`,
                `<name>${agent?.name ?? ""}</name>`,
                "</agent-context>",
              ]
                .filter(Boolean)
                .join("\n")}
              placeholder="Ask the agent to change its config…"
              suggestions={[
                "Switch the model to deepseek/deepseek-v4-flash",
                "Set permission mode to auto (approval off)",
                "Attach the my-agent-team knowledge pack",
                "Raise max steps to 40",
                "Enable non-determinism / reasoning effort high",
              ]}
            />
          </div>
        </div>
      )}
    </Page>
  );
}
