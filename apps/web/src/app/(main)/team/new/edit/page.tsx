"use client";

import { AgentForm } from "@/components/AgentForm";
import { Page, PageHeader } from "@/components/page";
import { ChatPanel } from "@/components/workflow/ChatPanel";

/** Create-agent page: a persistent create form on the left and a chat on the
 *  right. Before the agent exists, the chat is a "config assistant" bound to
 *  the default agent (agent:chat:new) — you can discuss how to shape the new
 *  agent while filling the form. Submitting the form navigates to
 *  /team/<id>/edit, where the chat targets the real agent config. */
export default function NewAgentEditPage() {
  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: "Team", href: "/team" },
          { label: "Agents", href: "/team" },
          { label: "New Agent" },
        ]}
        title="Create Agent"
      />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* Left: the create form */}
        <div className="min-h-0 min-w-0 flex-1 border-(--hairline) p-4 md:border-r">
          <AgentForm alwaysOpen />
        </div>
        {/* Right: chat (create-state assistant; becomes the agent config chat on edit) */}
        <div className="flex w-[320px] shrink-0 flex-col border-l border-(--hairline)">
          <ChatPanel
            conversationId="agent:chat:new"
            title="Chat"
            contextBlock={[
              "<agent-context>",
              "<agentId>new</agentId>",
              "<name>New Agent</name>",
              "<state>creating</state>",
              "</agent-context>",
            ]
              .filter(Boolean)
              .join("\n")}
            placeholder="Discuss how to configure the new agent…"
            suggestions={[
              "Pick a model for code review work",
              "Should this agent allow auto-approve?",
              "Which knowledge pack should it use?",
            ]}
          />
        </div>
      </div>
    </Page>
  );
}
