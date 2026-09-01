"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useClearProvider, useProviders, useSetProvider } from "@/features/providers/hooks";

export function ProviderSetupInline() {
  const { data } = useProviders();
  const setProvider = useSetProvider();
  const clearProvider = useClearProvider();
  const providers = data?.providers ?? [];
  const [selected, setSelected] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const current = providers.find((p) => p.id === selected);

  async function save() {
    if (!selected) {
      toast.error("Pick a provider first");
      return;
    }
    if (!apiKey.trim() && !baseUrl.trim()) {
      toast.error("Enter an API key (or base URL)");
      return;
    }
    await setProvider.mutateAsync({
      id: selected,
      body: { apiKey: apiKey.trim() || undefined, baseUrl: baseUrl.trim() || undefined },
    });
    setApiKey("");
    setBaseUrl("");
  }

  function clear(id: string) {
    void clearProvider.mutateAsync(id);
    if (selected === id) {
      setSelected("");
      setApiKey("");
      setBaseUrl("");
    }
  }

  return (
    <div className="rounded-md border border-(--hairline) bg-(--canvas-soft) p-4 space-y-3">
      <p className="text-xs text-(--mute)">
        No reachable provider yet. Add a provider API key to enable model selection.
      </p>
      <div className="space-y-1.5">
        <label className="text-[10px] uppercase tracking-kicker text-(--mute)">Provider</label>
        <Select value={selected} onValueChange={(v) => setSelected(v ?? "")}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Choose provider…" />
          </SelectTrigger>
          <SelectContent>
            {providers.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name} {p.configured ? "(configured)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {current && (
        <Input
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={`${current.apiKeyEnv} value`}
          type="password"
          autoComplete="off"
        />
      )}
      {current?.apiKeyEnv === "ANTHROPIC_API_KEY" && (
        <Input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="Base URL (optional, for proxy)"
          autoComplete="off"
        />
      )}
      <div className="flex gap-2">
        <Button size="sm" onClick={save} disabled={!selected || setProvider.isPending}>
          Save key
        </Button>
        {current?.configured && (
          <Button size="sm" variant="ghost" onClick={() => clear(current.id)}>
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}
