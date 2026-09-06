"use client";

import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Timeline } from "@/components/Timeline";
import { Button } from "@/components/ui/button";
import { useConversation } from "@/hooks/useConversation";
import { api } from "@/lib/api";
import type { SenderRef } from "@/lib/conversation-reducer";

/** Editor chat: a real conversation (same as the /chat page) bound to a
 *  stable resource id. The agent answers through the injected MCP tools
 *  (workflow raw DSL, or agent-config), and the editor refreshes via the
 *  matching SSE. Intentionally decoupled from the form/canvas onApply — it
 *  only sends messages and shows the transcript.
 *
 *  `contextBlock` is injected as a leading XML context in the sent message so
 *  the agent knows WHICH resource it is editing and its current goal. */
export function ChatPanel({
  conversationId,
  title = "Chat",
  contextBlock,
  placeholder = "Ask the agent to edit…",
}: {
  conversationId: string;
  title?: string;
  contextBlock?: string;
  placeholder?: string;
}) {
  const { state, send, transients, transientTools } = useConversation(conversationId);
  const [instruction, setInstruction] = useState("");
  const [ready, setReady] = useState(false);

  // Ensure the stable conversation exists (idempotent; a page reload reuses
  // it because the id derives from the resource id).
  useEffect(() => {
    void api
      .createConversation({ conversationId, agentId: "default", origin: "workflow" })
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
    const payload = contextBlock ? `${contextBlock}\n\n${text}` : text;
    send(payload);
    setInstruction("");
  }

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex items-center gap-2 px-3 pt-3 text-sm font-semibold">
        <Sparkles className="size-4 text-(--primary)" />
        {title}
        <span className="text-[10px] font-normal text-(--mute)">
          (MCP tools edit; the editor refreshes live)
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Timeline messages={state.items} conversationId={conversationId} transients={bubbles} />
      </div>
      <div className="flex gap-2 border-t border-(--hairline) p-2">
        <textarea
          className="min-h-8 flex-1 resize-none rounded-md border border-(--hairline) bg-(--canvas) px-2 py-1.5 text-xs outline-none focus:border-(--primary)"
          placeholder={placeholder}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <Button size="sm" onClick={submit} disabled={!ready || !instruction.trim()}>
          Send
        </Button>
      </div>
    </div>
  );
}
