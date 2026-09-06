"use client";

import { AgentForm } from "@/components/AgentForm";
import { AgentEditorLayout } from "@/components/agent-editor-layout";
import { PageHeader } from "@/components/page";
import { ChatPanel } from "@/components/workflow/ChatPanel";

/** Create-agent page: a persistent create form on the left and a chat on the
 *  right. Before the agent exists, the chat is a "config assistant" bound to
 *  the default agent (agent:chat:new) — you can discuss how to shape the new
 *  agent while filling the form. Submitting the form navigates to
 *  /team/<id>/edit, where the chat targets the real agent config. */
export default function NewAgentEditPage() {
  return (
    <AgentEditorLayout
      header={
        <PageHeader
          breadcrumb={[
            { label: "Team", href: "/team" },
            { label: "Agents", href: "/team" },
            { label: "New Agent" },
          ]}
          title="Create Agent"
        />
      }
      left={<AgentForm alwaysOpen />}
      chat={
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
      }
    />
  );
}
