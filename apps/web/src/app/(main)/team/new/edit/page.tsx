"use client";

import { AgentForm } from "@/components/AgentForm";
import { Page, PageHeader } from "@/components/page";

/** Create-agent page: a persistent create form on the left and the chat
 *  guide on the right. Mirrors the workflow editor — this is the entrypoint
 *  for `+ New Agent`. Once the agent is created the form navigates to
 *  /team/<id>/edit where the chat can propose config changes. */
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
        {/* Right: chat guide (no agent yet — this becomes live on edit) */}
        <div className="flex w-[320px] shrink-0 flex-col border-l border-(--hairline)">
          <div className="flex h-full flex-col px-3 pt-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <span className="text-(--primary)">◆</span> Chat
              <span className="text-[10px] font-normal text-(--mute)">
                (enabled after you create the agent)
              </span>
            </div>
            <div className="rounded-lg border border-dashed border-(--hairline) bg-(--canvas-soft)/40 p-3 text-xs text-(--mute)">
              <p className="mb-1.5">
                Fill in the form on the left and press{" "}
                <span className="font-medium text-(--ink)">Create Agent</span>. You'll land on the
                edit view where this chat can propose config changes — the agent applies them via
                MCP tools and you review &amp; save.
              </p>
              <p className="font-mono text-[11px] text-(--faint)">
                e.g. "switch the model to deepseek/deepseek-v4-flash"
              </p>
            </div>
          </div>
        </div>
      </div>
    </Page>
  );
}
