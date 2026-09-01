"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useClearProvider, useProviders, useSetProvider } from "@/features/providers/hooks";

export function ProviderSettingsSection() {
  const { data, isLoading } = useProviders();
  const setProvider = useSetProvider();
  const clearProvider = useClearProvider();
  const providers = data?.providers ?? [];
  const [selected, setSelected] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const current = providers.find((p) => p.id === selected);

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
    <Card>
      <CardHeader>
        <CardTitle>Provider Keys</CardTitle>
        <CardDescription>
          Store API keys in-product so agents can run without deployment env vars.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <p className="text-xs text-(--mute)">Loading providers…</p>
        ) : providers.length === 0 ? (
          <p className="text-xs text-(--mute)">No known providers.</p>
        ) : (
          <div className="space-y-3">
            {providers.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between rounded-md border border-(--hairline) px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-(--ink-strong)">{p.name}</span>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded ${
                        p.configured
                          ? "bg-(--primary)/10 text-(--primary)"
                          : "bg-(--mute)/10 text-(--mute)"
                      }`}
                    >
                      {p.configured ? "configured" : "not configured"}
                    </span>
                  </div>
                  <p className="text-[11px] text-(--mute)">{p.apiKeyEnv}</p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
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
          <div className="space-y-2 rounded-md border border-(--hairline) p-3">
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
                />
              </div>
            )}
            <div className="flex gap-2">
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
                  onClick={() => {
                    void clearProvider.mutateAsync(current.id);
                    setSelected("");
                  }}
                >
                  Clear
                </Button>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
