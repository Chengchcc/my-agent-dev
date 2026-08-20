"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api, type ChatModelOverride } from "@/lib/api";

export type { ChatModelOverride };

const EFFORTS: Array<ChatModelOverride["reasoningEffort"]> = ["none", "low", "high", "max"];

/** Short label: strip the `<provider>/` prefix from composite model ids. */
function shortName(modelId: string): string {
  const idx = modelId.indexOf("/");
  return idx >= 0 ? modelId.slice(idx + 1) : modelId;
}

/** Per-conversation model override picker for the chat composer.
 *  Selection persists in localStorage; null = agent default. */
export function ModelPicker({
  value,
  onChange,
}: {
  value: ChatModelOverride | null;
  onChange: (v: ChatModelOverride | null) => void;
}) {
  const { data } = useQuery({ queryKey: ["models"], queryFn: () => api.listModels() });

  const providers = data?.providers ?? [];
  const selectedModel = providers
    .flatMap((p) => p.models)
    .find((m) => value && m.id === value.modelId && m.backendKind === value.backendKind);
  const reasoning = selectedModel?.reasoning === true;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="h-8 shrink-0 px-2 text-[11px] text-(--mute) hover:text-(--body) mb-0.5"
            title="Model for the next run (default: agent config)"
          >
            {value ? shortName(value.modelId) : "Auto"}
            {reasoning && value?.reasoningEffort ? ` · ${value.reasoningEffort}` : ""}
            <ChevronDown size={12} />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="max-h-96 w-64 overflow-y-auto">
        <DropdownMenuItem
          onClick={() => onChange(null)}
          className={value ? "" : "bg-(--canvas-soft)"}
        >
          Agent default
        </DropdownMenuItem>
        {providers.length === 0 && (
          <div className="px-3 py-2 text-xs/relaxed text-(--mute)">
            No models configured. Add a provider key in{" "}
            <Link href="/system/settings" className="text-(--primary) underline">
              Settings
            </Link>
            .
          </div>
        )}
        {providers.map((p) => (
          <div key={p.id}>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] uppercase tracking-kicker">
              {p.name}
            </DropdownMenuLabel>
            {p.models.map((m) => (
              <DropdownMenuItem
                key={`${m.backendKind}/${m.id}`}
                disabled={m.available === false}
                className={
                  value?.modelId === m.id && value?.backendKind === m.backendKind
                    ? "bg-(--canvas-soft)"
                    : ""
                }
                onClick={() =>
                  onChange({
                    backendKind: m.backendKind,
                    modelId: m.id,
                    reasoningEffort: undefined,
                  })
                }
              >
                <div className="flex w-full items-center justify-between gap-2">
                  <span className="truncate">{shortName(m.id)}</span>
                  <span className="shrink-0 text-[10px] text-(--mute)">
                    ${m.cost.input}/${m.cost.output}
                  </span>
                </div>
              </DropdownMenuItem>
            ))}
          </div>
        ))}
        {reasoning && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] uppercase tracking-kicker">
              Reasoning effort
            </DropdownMenuLabel>
            <div className="flex gap-1 px-2 pb-1">
              {EFFORTS.map((e) => (
                <Button
                  key={e}
                  size="sm"
                  variant={value?.reasoningEffort === e ? "default" : "outline"}
                  className="h-6 flex-1 px-1 text-[10px]"
                  onClick={() =>
                    value &&
                    onChange({
                      backendKind: value.backendKind,
                      modelId: value.modelId,
                      reasoningEffort: e,
                    })
                  }
                >
                  {e}
                </Button>
              ))}
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
