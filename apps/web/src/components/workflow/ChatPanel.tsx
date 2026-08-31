"use client";

import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Timeline } from "@/components/Timeline";
import { useConversation } from "@/hooks/useConversation";
import { api } from "@/lib/api";
import type { SenderRef } from "@/lib/conversation-reducer";

/** Workflow-editor chat: a real conversation (same as the /chat page)
 *  bound to a stable workflow id. The agent answers through the injected
 *  workflow MCP tools (read/write the DSL); the editor refreshes via the
 *  workflow-definition SSE. This panel is intentionally decoupled from the
 *  editor's onApply — it only sends messages and shows the transcript. */
export function ChatPanel({ workflowId, goal }: { workflowId: string; goal?: string }) {
  const conversationId = `workflow:chat:${workflowId}`;
  const { state, send, transients, transientTools } = useConversation(conversationId);
  const [instruction, setInstruction] = useState("");
  const [ready, setReady] = useState(false);

  // Ensure the stable conversation exists (idempotent; a page reload reuses
  // it because the id derives from the workflow id).
  useEffect(() => {
    void api
      .createConversation({ conversationId, agentId: "default" })
      .catch(() => undefined)
      .finally(() => setReady(true));
  }, [conversationId]);

  const agent = state.agent;
  const bubbles = Object.entries(transients).map(([runId, t]) => {
    const sender: SenderRef = agent
      ? { kind: "agent", memberId: agent.memberId, agentId: agent.agentId }
      : { kind: "agent", memberId: t.agentId, agentId: t.agentId };
    const tools = Object.values(transientTools).filter(
      (tool) => tool.runId === runId && tool.name !== "todo_write",
    );
    return {
      runId,
      text: t.text,
      thinking: t.thinking,
      sender,
      tools,
      error: t.error,
      notices: t.notices,
      ordered: t.ordered,
    };
  });

  function submit() {
    const text = instruction.trim();
    if (!text || !ready) return;
    // The agent needs to know WHICH workflow it is editing and WHAT the
    // current goal is, or it cannot decide what to modify. Inject this as a
    // leading XML context block in the sent message (send() has no separate
    // system channel, so it rides the user message).
    const ctx = [
      "<workflow-context>",
      `<workflowId>${workflowId}</workflowId>`,
      goal ? `<goal>${goal}</goal>` : "",
      "</workflow-context>",
    ]
      .filter(Boolean)
      .join("\n");
    const payload = ctx ? `${ctx}\n\n${text}` : text;
    send(payload);
    setInstruction("");
  }

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex items-center gap-2 px-3 pt-3 text-sm font-semibold">
        <Sparkles className="size-4 text-(--primary)" />
        Chat
        <span className="text-[10px] font-normal text-(--mute)">
          (MCP tools edit the DSL; the editor refreshes live)
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Timeline messages={state.items} conversationId={conversationId} transients={bubbles} />
      </div>
      <div className="flex gap-2 border-t border-(--hairline) p-2">
        <textarea
          className="min-h-8 flex-1 resize-none rounded-md border border-(--hairline) bg-(--canvas) px-2 py-1.5 text-xs outline-none focus:border-(--primary)"
          placeholder="Ask the agent to edit the workflow…"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button
          className="shrink-0 rounded-md bg-(--primary) px-3 py-1.5 text-xs text-(--ink) disabled:opacity-50"
          onClick={submit}
          disabled={!ready || !instruction.trim()}
        >
          Send
        </button>
      </div>
    </div>
  );
}
