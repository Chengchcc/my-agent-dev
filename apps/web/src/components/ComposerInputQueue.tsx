"use client";

import { Check, ListChecks, Pencil, Send, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { PendingInput } from "@/lib/api";

interface ComposerInputQueueProps {
  inputs: PendingInput[];
  busy: boolean;
  onSteer: (inputId: string) => void;
  onSave: (inputId: string, text: string) => void;
  onCancel: (inputId: string) => void;
}

export function ComposerInputQueue({
  inputs,
  busy,
  onSteer,
  onSave,
  onCancel,
}: ComposerInputQueueProps) {
  if (inputs.length === 0) return null;

  return (
    <div className="mx-auto mb-3 max-w-[72ch] rounded-lg border border-(--hairline) bg-(--panel)">
      <div className="flex items-center gap-1.5 border-b border-(--hairline) px-3 py-1.5">
        <ListChecks size={12} className="shrink-0 text-(--mute)" />
        <span className="text-[10px] tracking-widest uppercase text-(--mute) font-semibold">
          Queue ({inputs.length})
        </span>
        <span className="ml-auto text-[10px] text-(--faint)">
          sent while running — executes after the current run
        </span>
      </div>
      <ul className="max-h-40 overflow-y-auto">
        {inputs.map((input) => (
          <QueueItem
            key={input.inputId}
            input={input}
            agentName={input.agentId}
            busy={busy}
            onSteer={() => onSteer(input.inputId)}
            onSave={(text) => onSave(input.inputId, text)}
            onCancel={() => onCancel(input.inputId)}
          />
        ))}
      </ul>
    </div>
  );
}

function QueueItem({
  input,
  agentName,
  busy,
  onSteer,
  onSave,
  onCancel,
}: {
  input: PendingInput;
  agentName: string;
  busy: boolean;
  onSteer: () => void;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(input.text);

  if (editing) {
    return (
      <li className="flex flex-col gap-1.5 border-b border-(--hairline) px-3 py-2 last:border-b-0">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          autoFocus
          className="w-full resize-none bg-(--canvas) border border-(--hairline) rounded-md p-2 text-sm text-(--ink) focus:outline-none focus:border-(--primary)"
        />
        <div className="flex items-center justify-end gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => {
              setEditing(false);
              setDraft(input.text);
            }}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={busy || !draft.trim()}
            onClick={() => {
              onSave(draft.trim());
              setEditing(false);
            }}
          >
            <Check size={12} className="mr-1" /> Save
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li className="flex items-center gap-2 border-b border-(--hairline) px-3 py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs text-(--mute)">{agentName}</span>
          <span className="shrink-0 rounded bg-(--canvas-soft) px-1 py-px text-[9px] uppercase tracking-wider text-(--faint)">
            {input.mode}
          </span>
        </div>
        <p className="truncate text-sm text-(--ink)">{input.text}</p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="size-7 p-0 text-(--mute) hover:text-(--body)"
                disabled={busy}
                onClick={onSteer}
                aria-label="Send now"
              >
                <Send size={13} />
              </Button>
            }
          />
          <TooltipContent>Send now (insert into current run)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="size-7 p-0 text-(--mute) hover:text-(--body)"
                disabled={busy}
                onClick={() => {
                  setDraft(input.text);
                  setEditing(true);
                }}
                aria-label="Edit"
              >
                <Pencil size={13} />
              </Button>
            }
          />
          <TooltipContent>Edit</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="size-7 p-0 text-(--mute) hover:text-(--err)"
                disabled={busy}
                onClick={onCancel}
                aria-label="Cancel"
              >
                <X size={13} />
              </Button>
            }
          />
          <TooltipContent>Cancel</TooltipContent>
        </Tooltip>
      </div>
    </li>
  );
}
