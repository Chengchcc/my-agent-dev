"use client";

import { KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";
import { MonoLabel, StatusPill } from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useClearProvider, useProviders, useSetProvider } from "@/features/providers/hooks";

/** Provider key management in the Agent OS card language: a list of provider
 *  rows with a configured status pill and an inline Set/Update form. */
export function ProviderSettingsSection() {
  const { data, isLoading } = useProviders();
  const setProvider = useSetProvider();
  const clearProvider = useClearProvider();
  const providers = data?.providers ?? [];
  const [selected, setSelected] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const current = providers.find((p) => p.id === selected);
  const configuredCount = providers.filter((p) => p.configured).length;

  async function save() {
    if (!selected) return;
    await setProvider.mutateAsync({
      id: selected,
      body: { apiKey: apiKey.trim() || undefined, baseUrl: baseUrl.trim() || undefined },
    });
    setApiKey("");
    setBaseUrl("");
  }

  return (
    <section className="rounded-lg border border-(--hairline) bg-(--panel) shadow-sm">
      <div className="flex items-center justify-between border-b border-(--hairline) px-4 py-3">
        <div className="flex items-center gap-2">
          <KeyRound className="size-4 text-(--primary)" />
          <MonoLabel>Provider keys</MonoLabel>
        </div>
        <StatusPill tone={configuredCount > 0 ? "success" : "idle"}>
          {configuredCount}/{providers.length} configured
        </StatusPill>
      </div>
      <div className="p-4">
        {isLoading ? (
          <p className="text-xs text-(--mute)">Loading providers…</p>
        ) : providers.length === 0 ? (
          <p className="text-xs text-(--mute)">No known providers.</p>
        ) : (
          <div className="divide-y divide-(--hairline)">
            {providers.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-(--ink-strong)">{p.name}</span>
                    <StatusPill tone={p.configured ? "success" : "idle"}>
                      {p.configured ? "configured" : "not configured"}
                    </StatusPill>
                  </div>
                  <p className="mt-0.5 font-mono text-[10px] text-(--mute)">{p.apiKeyEnv}</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setSelected(p.id);
                    setApiKey("");
                    setBaseUrl("");
                  }}
                >
                  {p.configured ? "Update" : "Set"}
                </Button>
              </div>
            ))}
          </div>
        )}

        {selected && current && (
          <div className="mt-4 space-y-2 rounded-md border border-(--hairline) bg-(--canvas-soft) p-3">
            <div>
              <Label className="text-[10px] uppercase tracking-kicker text-(--mute)">
                {current.name} API key
              </Label>
              <Input
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={`${current.apiKeyEnv} value`}
                type="password"
                autoComplete="off"
                className="mt-1"
              />
            </div>
            {current.apiKeyEnv === "ANTHROPIC_API_KEY" && (
              <div>
                <Label className="text-[10px] uppercase tracking-kicker text-(--mute)">
                  Base URL
                </Label>
                <Input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="Optional proxy base URL"
                  autoComplete="off"
                  className="mt-1"
                />
              </div>
            )}
            <div className="flex gap-2 pt-1">
              <Button size="sm" onClick={save} disabled={setProvider.isPending}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected("")}>
                Cancel
              </Button>
              {current.configured && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-(--err)"
                  onClick={() => {
                    void clearProvider.mutateAsync(current.id);
                    setSelected("");
                  }}
                >
                  <Trash2 className="size-3" />
                  Clear
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
