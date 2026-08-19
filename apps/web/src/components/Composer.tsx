"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  AtSign,
  Bot,
  Check,
  CornerDownLeft,
  ListChecks,
  Pencil,
  Send,
  Terminal,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { type ChatModelOverride, ModelPicker } from "@/components/ModelPicker";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, type PendingInput } from "@/lib/api";
import type { SenderRef } from "@/lib/conversation-reducer";
import { slashCommands } from "@/lib/slash-commands";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Composer metrics (§3): auto height 40–160px, panel bg, radius 8. */
const COMPOSER_MIN_H = 40;
const COMPOSER_MAX_H = 160;

interface ComposerProps {
  conversationId: string;
  onSend: (
    message: string,
    addressedTo: string[],
    model?: ChatModelOverride,
    attachments?: readonly { type: "image"; mediaType: string; base64: string }[],
  ) => void;
  onSlashCommand: (input: string) => void;
  disabled?: boolean;
  placeholder?: string;
  roster?: Record<string, SenderRef>;
  autoAgentCount: number;
  /** A run is live: the send button becomes the red-dot Stop. */
  isBusy?: boolean;
  onStop?: () => void;
}
export function Composer({
  conversationId,
  onSend,
  onSlashCommand,
  disabled,
  placeholder = "Type a message…  Ctrl+Enter to send",
  roster,
  isBusy,
  onStop,
}: ComposerProps) {
  const [model, setModel] = useState<ChatModelOverride | null>(() => {
    try {
      const raw = localStorage.getItem(`oma.chat.model:${conversationId}`);
      return raw ? (JSON.parse(raw) as ChatModelOverride) : null;
    } catch {
      return null;
    }
  });
  const pickModel = useCallback(
    (m: ChatModelOverride | null) => {
      setModel(m);
      try {
        if (m) localStorage.setItem(`oma.chat.model:${conversationId}`, JSON.stringify(m));
        else localStorage.removeItem(`oma.chat.model:${conversationId}`);
      } catch {
        /* storage unavailable — selection stays per-mount */
      }
    },
    [conversationId],
  );
  const [value, setValue] = useState("");
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const [mentionIndex, setMentionIndex] = useState(0);
  const [showSlash, setShowSlash] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [attachments, setAttachments] = useState<
    readonly { type: "image"; mediaType: string; base64: string }[]
  >([]);

  // Pending input queue: backend branch_input_queue for this conversation.
  // Polls only while something is waiting; mutations refetch immediately.
  const qc = useQueryClient();
  const inputsQuery = useQuery({
    queryKey: ["conversation-inputs", conversationId],
    queryFn: () => api.listConversationInputs(conversationId),
    refetchInterval: (query) => (query.state.data?.inputs.length ? 2000 : false),
  });
  const invalidateQueue = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["conversation-inputs", conversationId] });
  }, [qc, conversationId]);
  const steerMut = useMutation({
    mutationFn: (inputId: string) => api.steerConversationInput(conversationId, inputId),
    onSuccess: invalidateQueue,
    onError: () => toast.error("Send now failed — the run may have settled"),
  });
  const editMut = useMutation({
    mutationFn: (args: { inputId: string; text: string }) =>
      api.updateConversationInput(conversationId, args.inputId, args.text),
    onSuccess: invalidateQueue,
    onError: () => toast.error("Edit failed — the input was already processed"),
  });
  const cancelMut = useMutation({
    mutationFn: (inputId: string) => api.cancelConversationInput(conversationId, inputId),
    onSuccess: invalidateQueue,
    onError: () => toast.error("Cancel failed"),
  });

  const agentMembers = useMemo(() => {
    if (!roster) return [];
    return Object.values(roster).filter((m) => m.kind === "agent");
  }, [roster]);

  const filteredMentions = useMemo(() => {
    const q = mentionFilter.toLowerCase();
    return agentMembers.filter(
      (m) =>
        (m.displayName ?? m.memberId).toLowerCase().includes(q) ||
        m.memberId.toLowerCase().includes(q),
    );
  }, [agentMembers, mentionFilter]);

  const filteredSlash = useMemo(() => {
    const q = value.trim().toLowerCase();
    return slashCommands.filter((c) => c.command.startsWith(q));
  }, [value]);

  // Reset selection when filter changes (including on filter input)
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional - must reset when filter narrows options
  useEffect(() => {
    setMentionIndex(0);
  }, [mentionFilter]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional - must reset when filter narrows options
  useEffect(() => {
    setSlashIndex(0);
  }, [showSlash]);
  const readImageFile = useCallback((file: File) => {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") return;
      const comma = result.indexOf(",");
      if (comma < 0) return;
      setAttachments((prev) => [
        ...prev,
        { type: "image" as const, mediaType: file.type, base64: result.slice(comma + 1) },
      ]);
    };
    reader.readAsDataURL(file);
  }, []);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      for (const item of Array.from(e.clipboardData.items)) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) readImageFile(file);
        }
      }
    },
    [readImageFile],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      for (const file of Array.from(e.dataTransfer.files)) readImageFile(file);
    },
    [readImageFile],
  );

  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = `${COMPOSER_MIN_H}px`;
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_H)}px`;
  }, []);

  const resolveAddressedTo = useCallback(
    (text: string): string[] => {
      if (!roster || agentMembers.length === 0) return [];
      if (agentMembers.length === 1) return [agentMembers[0]!.memberId];
      const mentioned = new Set<string>();
      for (const m of agentMembers) {
        const label = m.displayName ?? m.memberId;
        // @label must be followed by whitespace/punctuation/EOS —
        // avoids prefix false-matches (e.g. token "1" hitting agent-11)
        const re = new RegExp(`@${escapeRegExp(label)}(?=\\s|[,.!?;:]|$)`);
        if (re.test(text) || text.includes(`@${m.memberId}`)) {
          mentioned.add(m.memberId);
        }
      }
      return [...mentioned];
    },
    [roster, agentMembers],
  );

  const insertMention = useCallback(
    (member: SenderRef) => {
      const el = textareaRef.current;
      if (!el) return;
      const name = member.displayName ?? member.memberId;
      const before = value.slice(0, el.selectionStart);
      const atPos = before.lastIndexOf("@");
      const after = value.slice(el.selectionEnd);
      const newText =
        atPos >= 0 ? `${before.slice(0, atPos)}@${name} ${after}` : `@${name} ${value}`;
      setValue(newText);
      setShowMentions(false);
      setMentionFilter("");
      setTimeout(() => {
        el.focus();
        const cursor = atPos >= 0 ? atPos + name.length + 2 : name.length + 2;
        el.setSelectionRange(cursor, cursor);
      }, 0);
    },
    [value],
  );

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const text = e.target.value;
      setValue(text);
      autoGrow();
      const el = textareaRef.current;
      if (el) {
        const before = text.slice(0, el.selectionStart);
        const atMatch = before.match(/@(\S*)$/);
        if (atMatch && agentMembers.length > 1) {
          setShowMentions(true);
          setMentionFilter(atMatch[1] ?? "");
        } else {
          setShowMentions(false);
          setMentionFilter("");
        }
      }
      // Slash command popover: only while the input is a single token starting with "/"
      // (no spaces yet). Once args begin, the popover closes so typing continues freely.
      setShowSlash(text.startsWith("/") && !/\s/.test(text.trim()));
    },
    [autoGrow, agentMembers.length],
  );

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    // Slash command: route to onSlashCommand instead of sending as a message.
    if (trimmed.startsWith("/")) {
      onSlashCommand(trimmed);
      setValue("");
      setShowSlash(false);
      if (textareaRef.current) {
        textareaRef.current.style.height = `${COMPOSER_MIN_H}px`;
        textareaRef.current.focus();
      }
      return;
    }
    const addressedTo = resolveAddressedTo(trimmed);
    if (agentMembers.length > 1 && addressedTo.length === 0) {
      toast.error("Use @ to specify which agent to send to");
      setShowMentions(true);
      return;
    }
    onSend(trimmed, addressedTo, model ?? undefined, attachments);
    setValue("");
    setAttachments([]);
    // Give the backend a beat to persist the queued input, then show it.
    setTimeout(() => void inputsQuery.refetch(), 400);
    if (textareaRef.current) {
      textareaRef.current.style.height = `${COMPOSER_MIN_H}px`;
    }
  }, [
    value,
    disabled,
    onSend,
    onSlashCommand,
    resolveAddressedTo,
    agentMembers.length,
    model,
    attachments,
    inputsQuery,
  ]);

  const navigateMention = useCallback(
    (dir: -1 | 1) => {
      if (!showMentions || filteredMentions.length === 0) return;
      setMentionIndex((prev) => {
        const next = prev + dir;
        if (next < 0) return filteredMentions.length - 1;
        if (next >= filteredMentions.length) return 0;
        return next;
      });
    },
    [showMentions, filteredMentions.length],
  );

  const navigateSlash = useCallback(
    (dir: -1 | 1) => {
      if (!showSlash || filteredSlash.length === 0) return;
      setSlashIndex((prev) => {
        const next = prev + dir;
        if (next < 0) return filteredSlash.length - 1;
        if (next >= filteredSlash.length) return 0;
        return next;
      });
    },
    [showSlash, filteredSlash.length],
  );

  const completeSlash = useCallback(() => {
    const idx = Math.min(slashIndex, filteredSlash.length - 1);
    const cmd = filteredSlash[idx];
    if (!cmd) return;
    // Complete to the command name + trailing space so the user can type args.
    setValue(`${cmd.command} `);
    setShowSlash(false);
    setTimeout(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const cursor = cmd.command.length + 1;
      el.setSelectionRange(cursor, cursor);
    }, 0);
  }, [slashIndex, filteredSlash]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showMentions && filteredMentions.length > 0) {
      if (e.key === "Escape") {
        e.preventDefault();
        setShowMentions(false);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        navigateMention(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        navigateMention(-1);
        return;
      }
      if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const idx = Math.min(mentionIndex, filteredMentions.length - 1);
        if (filteredMentions[idx]) insertMention(filteredMentions[idx]);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const idx = Math.min(mentionIndex, filteredMentions.length - 1);
        if (filteredMentions[idx]) insertMention(filteredMentions[idx]);
        return;
      }
    }
    if (showSlash && filteredSlash.length > 0) {
      if (e.key === "Escape") {
        e.preventDefault();
        setShowSlash(false);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        navigateSlash(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        navigateSlash(-1);
        return;
      }
      if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        completeSlash();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        completeSlash();
        return;
      }
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  const showMentionButton = agentMembers.length > 1;
  const effectivePlaceholder =
    agentMembers.length === 1 ? placeholder : "@agent to address…  Ctrl+Enter to send";

  return (
    <div className="bg-(--canvas) px-6 py-4">
      {inputsQuery.data && inputsQuery.data.inputs.length > 0 && (
        <div className="mx-auto mb-3 max-w-[72ch] rounded-lg border border-(--hairline) bg-(--panel)">
          <div className="flex items-center gap-1.5 border-b border-(--hairline) px-3 py-1.5">
            <ListChecks size={12} className="shrink-0 text-(--mute)" />
            <span className="text-[10px] tracking-widest uppercase text-(--mute) font-semibold">
              Queue ({inputsQuery.data.inputs.length})
            </span>
            <span className="ml-auto text-[10px] text-(--faint)">
              sent while running — executes after the current run
            </span>
          </div>
          <ul className="max-h-40 overflow-y-auto">
            {inputsQuery.data.inputs.map((input) => (
              <QueueItem
                key={input.inputId}
                input={input}
                agentName={roster?.[input.agentMemberId]?.displayName ?? input.agentMemberId}
                busy={steerMut.isPending || editMut.isPending || cancelMut.isPending}
                onSteer={() => steerMut.mutate(input.inputId)}
                onSave={(text) => editMut.mutate({ inputId: input.inputId, text })}
                onCancel={() => cancelMut.mutate(input.inputId)}
              />
            ))}
          </ul>
        </div>
      )}
      <div className="mx-auto flex gap-2 items-end relative" style={{ maxWidth: "72ch" }}>
        <div className="flex-1 relative">
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pb-1.5">
              {attachments.map((a, i) => (
                <div
                  key={i}
                  className="relative size-12 rounded-md border border-(--hairline) overflow-hidden"
                  title="Attached image"
                >
                  <img
                    src={`data:${a.mediaType};base64,${a.base64}`}
                    alt="attached"
                    className="size-full  object-cover"
                  />
                  <button
                    type="button"
                    aria-label="Remove image"
                    onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                    className="absolute top-0 right-0 bg-black/60 text-white text-[10px]/4 px-1 "
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <div onDragOver={(e) => e.preventDefault()} onDrop={handleDrop}>
            <Textarea
              ref={textareaRef}
              value={value}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={disabled ? "Agent is responding…" : effectivePlaceholder}
              rows={1}
              disabled={disabled}
              className="w-full resize-none bg-(--panel) border border-(--hairline)
                       rounded-lg p-3  text-sm text-(--ink)
                       placeholder:text-(--mute)
                       focus:outline-none focus:border-(--primary)
                       disabled:opacity-40 disabled:cursor-not-allowed
                       transition-colors duration-200"
              style={{ minHeight: `${COMPOSER_MIN_H}px`, maxHeight: `${COMPOSER_MAX_H}px` }}
            />
          </div>
          {/* @mention popover */}
          {showMentions && (
            <div
              ref={popoverRef}
              className="absolute bottom-full left-0 mb-1 w-72 bg-(--canvas) border border-(--hairline) rounded-lg z-50 overflow-hidden"
            >
              <div className="flex items-center justify-between px-3 py-2 border-b border-(--hairline) bg-(--canvas-soft)">
                <span className="text-[10px] tracking-widest uppercase text-(--mute) font-semibold">
                  Mention an agent
                </span>
                <span className="text-[10px] text-(--mute) flex items-center gap-1">
                  <CornerDownLeft size={10} /> to select
                </span>
              </div>
              <div className="max-h-48 overflow-y-auto">
                {filteredMentions.length === 0 ? (
                  <p className="text-xs text-(--mute) p-3 ">No matching agents</p>
                ) : (
                  filteredMentions.map((m, i) => (
                    <Button
                      key={m.memberId}
                      onClick={() => insertMention(m)}
                      onMouseEnter={() => setMentionIndex(i)}
                      className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${
                        i === mentionIndex ? "bg-(--primary)/10" : "hover:bg-(--canvas-soft)"
                      }`}
                    >
                      <Bot size={15} className="text-(--primary) shrink-0" />
                      <span className="text-sm text-(--body) truncate flex-1">
                        {m.displayName ?? m.memberId}
                      </span>
                      <span className="text-[10px] font-mono text-(--mute) shrink-0">agent</span>
                    </Button>
                  ))
                )}
              </div>
            </div>
          )}

          {/* Slash command popover */}
          {showSlash && (
            <div className="absolute bottom-full left-0 mb-1 w-80 bg-(--canvas) border border-(--hairline) rounded-lg z-50 overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 border-b border-(--hairline) bg-(--canvas-soft)">
                <span className="text-[10px] tracking-widest uppercase text-(--mute) font-semibold">
                  Commands
                </span>
                <span className="text-[10px] text-(--mute) flex items-center gap-1">
                  <CornerDownLeft size={10} /> to complete
                </span>
              </div>
              <div className="max-h-56 overflow-y-auto">
                {filteredSlash.length === 0 ? (
                  <p className="text-xs text-(--mute) p-3 ">No matching commands</p>
                ) : (
                  filteredSlash.map((c, i) => (
                    <Button
                      key={c.command}
                      onClick={completeSlash}
                      onMouseEnter={() => setSlashIndex(i)}
                      className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${
                        i === slashIndex ? "bg-(--primary)/10" : "hover:bg-(--canvas-soft)"
                      }`}
                    >
                      <Terminal size={15} className="text-(--primary) shrink-0" />
                      <div className="flex flex-col min-w-0 flex-1">
                        <span className="text-sm text-(--body) truncate font-mono">
                          {c.command}{" "}
                          {c.argsHint && (
                            <span className="text-(--mute) font-sans">{c.argsHint}</span>
                          )}
                        </span>
                        <span className="text-[11px] text-(--mute) truncate">{c.description}</span>
                      </div>
                    </Button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        <ModelPicker value={model} onChange={pickModel} />

        {showMentionButton && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  onClick={() => {
                    setShowMentions(!showMentions);
                    setMentionFilter("");
                    setMentionIndex(0);
                  }}
                  className="shrink-0 p-2 text-(--mute) hover:text-(--body) transition-colors mb-0.5"
                >
                  <AtSign size={16} />
                </Button>
              }
            />
            <TooltipContent>Mention an agent</TooltipContent>
          </Tooltip>
        )}

        {isBusy && onStop ? (
          <Button
            onClick={onStop}
            size="icon"
            className="shrink-0 mb-0.5 size-8  bg-(--err)/15 hover:bg-(--err)/25"
            title="Stop the run"
            aria-label="Stop"
          >
            <span className="size-2.5 rounded-full bg-(--err) animate-pulse" />
          </Button>
        ) : (
          <Button
            onClick={handleSend}
            disabled={disabled || !value.trim()}
            size="icon"
            className="shrink-0 mb-0.5 size-8 "
            aria-label="Send"
          >
            <ArrowUp size={16} className="shrink-0" />
          </Button>
        )}
      </div>
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
          <TooltipContent>Send now (steer into the live run)</TooltipContent>
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
