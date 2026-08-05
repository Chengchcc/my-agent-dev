"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useSettings, useSystemInfo, useUpdateSetting } from "@/features/settings/hooks";
import type { SettingsMap, SystemInfo } from "@/lib/api";

// ── Field definitions ──

interface NumberField {
  key: string;
  label: string;
  type: "number";
  unit?: string;
}
interface BooleanField {
  key: string;
  label: string;
  type: "boolean";
}
interface StringField {
  key: string;
  label: string;
  type: "string";
}
interface ArrayField {
  key: string;
  label: string;
  type: "array";
}
type Field = NumberField | BooleanField | StringField | ArrayField;

interface Section {
  id: string;
  title: string;
  description?: string;
  needsRestart?: boolean;
  fields: Field[];
}

const SECTIONS: Section[] = [
  {
    id: "agent",
    title: "Agent Session",
    description: "Per-run execution parameters for agent sessions.",
    fields: [
      { key: "agent.maxSteps", label: "Max Steps", type: "number" },
      { key: "agent.retryMaxAttempts", label: "Retry Max Attempts", type: "number" },
      { key: "agent.retryBackoffMs", label: "Retry Backoff", type: "number", unit: "ms" },
      { key: "agent.retryMaxBackoffMs", label: "Retry Max Backoff", type: "number", unit: "ms" },
      { key: "agent.compactionAutoCompact", label: "Auto Compact", type: "boolean" },
      { key: "agent.compactionKeepRecent", label: "Keep Recent", type: "number" },
    ],
  },
  {
    id: "conversation",
    title: "Conversation",
    description: "Conversation flow control.",
    fields: [{ key: "conversation.maxHops", label: "Max Agent Hops", type: "number" }],
  },
  {
    id: "context",
    title: "Context Manager",
    description: "Context window management and summarization.",
    fields: [
      {
        key: "context.toolResultMaxChars",
        label: "Tool Result Max",
        type: "number",
        unit: "chars",
      },
      {
        key: "context.summarizeTriggerAt",
        label: "Summarize Trigger",
        type: "number",
        unit: "tokens",
      },
      { key: "context.summarizeKeepRecent", label: "Keep Recent", type: "number" },
    ],
  },
  {
    id: "runtime",
    title: "Runtime",
    description: "Supervisor and reaper timing parameters.",
    needsRestart: true,
    fields: [
      {
        key: "runtime.heartbeatIntervalMs",
        label: "Heartbeat Interval",
        type: "number",
        unit: "ms",
      },
      { key: "runtime.heartbeatTimeoutMs", label: "Heartbeat Timeout", type: "number", unit: "ms" },
      { key: "runtime.cancelGraceMs", label: "Cancel Grace", type: "number", unit: "ms" },
      { key: "runtime.reaperIntervalMs", label: "Reaper Interval", type: "number", unit: "ms" },
      {
        key: "runtime.stepStallTimeoutMs",
        label: "Step Stall Timeout",
        type: "number",
        unit: "ms",
      },
      { key: "runtime.maxConcurrentRuns", label: "Max Concurrent Runs", type: "number" },
    ],
  },
  {
    id: "loop",
    title: "Loop Defaults",
    description: "Default template values for new Loops.",
    fields: [
      { key: "loop.generatorModel", label: "Generator Model", type: "string" },
      { key: "loop.evaluatorModel", label: "Evaluator Model", type: "string" },
      { key: "loop.defaultAcceptance", label: "Default Acceptance", type: "string" },
      { key: "loop.defaultDailyCap", label: "Daily Cap", type: "number", unit: "tokens" },
      { key: "loop.defaultDenylist", label: "Denylist (comma-separated)", type: "array" },
    ],
  },
  {
    id: "memory",
    title: "Memory",
    description: "Autonomous memory extraction and search configuration.",
    fields: [
      { key: "memory.autoExtract", label: "Auto Extract", type: "boolean" },
      { key: "memory.extractProvider", label: "Extract Provider", type: "string" },
      { key: "memory.extractModel", label: "Extract Model", type: "string" },
      { key: "memory.consolidateProvider", label: "Consolidate Provider", type: "string" },
      { key: "memory.consolidateModel", label: "Consolidate Model", type: "string" },
      { key: "memory.minMessagesForExtraction", label: "Min Msgs for Extract", type: "number" },
      { key: "memory.consolidateThreshold", label: "Consolidate Threshold", type: "number" },
    ],
  },
];

// ── Default values (used when settings KV is empty) ──

const DEFAULTS: Record<string, unknown> = {
  "agent.maxSteps": 50,
  "agent.retryMaxAttempts": 3,
  "agent.retryBackoffMs": 2000,
  "agent.retryMaxBackoffMs": 30000,
  "agent.compactionAutoCompact": true,
  "agent.compactionKeepRecent": 10,
  "conversation.maxHops": 8,
  "context.toolResultMaxChars": 50000,
  "context.summarizeTriggerAt": 100000,
  "context.summarizeKeepRecent": 10,
  "runtime.heartbeatIntervalMs": 5000,
  "runtime.heartbeatTimeoutMs": 120000,
  "runtime.cancelGraceMs": 5000,
  "runtime.reaperIntervalMs": 60000,
  "runtime.stepStallTimeoutMs": 300000,
  "runtime.maxConcurrentRuns": 10,
  "loop.generatorModel": "claude-sonnet-4",
  "loop.evaluatorModel": "claude-opus-4",
  "loop.defaultAcceptance": "",
  "loop.defaultDailyCap": 200000,
  "loop.defaultDenylist": [".env", "auth/", "payments/", "secrets/"],
  "memory.autoExtract": true,
  "memory.extractProvider": "anthropic",
  "memory.extractModel": "claude-haiku-3-5",
  "memory.consolidateProvider": "anthropic",
  "memory.consolidateModel": "claude-sonnet-4-6",
  "memory.minMessagesForExtraction": 5,
  "memory.consolidateThreshold": 10,
};

// ── Helpers ──

function getValue(settings: SettingsMap | undefined, key: string): unknown {
  return settings?.[key] ?? DEFAULTS[key];
}

function formatValue(value: unknown, type: Field["type"]): string {
  if (type === "array" && Array.isArray(value)) return (value as string[]).join(", ");
  if (typeof value === "boolean") return "";
  return String(value ?? "");
}

function parseValue(raw: string, type: Field["type"]): unknown {
  if (type === "number") return Number(raw) || 0;
  if (type === "boolean") return raw === "true";
  if (type === "array")
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return raw;
}

// ── Section card ──

function SettingsSection({
  section,
  settings,
  onSave,
  saving,
}: {
  section: Section;
  settings: SettingsMap | undefined;
  onSave: (key: string, value: unknown) => void;
  saving: boolean;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  // Reset drafts when settings query refetches (e.g. after save).
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on settings change
  useEffect(() => {
    setDrafts({});
  }, [settings]);

  const getDraft = (key: string) =>
    drafts[key] ??
    formatValue(getValue(settings, key), section.fields.find((f) => f.key === key)!.type);

  const hasChanges = section.fields.some((f) => {
    const draft = drafts[f.key];
    if (draft === undefined) return false;
    const current = formatValue(getValue(settings, f.key), f.type);
    return draft !== current;
  });

  const handleSave = () => {
    for (const f of section.fields) {
      const draft = drafts[f.key];
      if (draft === undefined) continue;
      onSave(f.key, parseValue(draft, f.type));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {section.title}
          {section.needsRestart && (
            <Badge variant="secondary" className="text-xs">
              需重启生效
            </Badge>
          )}
        </CardTitle>
        {section.description && <CardDescription>{section.description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4">
        {section.fields.map((f) => (
          <div key={f.key} className="grid grid-cols-[180px_1fr] items-center gap-3">
            <Label htmlFor={f.key} className="text-sm text-muted-foreground">
              {f.label}
            </Label>
            {f.type === "boolean" ? (
              <div className="flex items-center gap-2">
                <Switch
                  id={f.key}
                  checked={
                    drafts[f.key] === "true" ||
                    (drafts[f.key] === undefined && getValue(settings, f.key) === true)
                  }
                  onCheckedChange={(checked) =>
                    setDrafts((d) => ({ ...d, [f.key]: String(checked) }))
                  }
                />
                <span className="text-xs text-muted-foreground">
                  {drafts[f.key] === "true" ||
                  (drafts[f.key] === undefined && getValue(settings, f.key) === true)
                    ? "Enabled"
                    : "Disabled"}
                </span>
              </div>
            ) : f.type === "array" ? (
              <Textarea
                id={f.key}
                value={getDraft(f.key)}
                onChange={(e) => setDrafts((d) => ({ ...d, [f.key]: e.target.value }))}
                className="min-h-[60px] font-mono text-xs"
                placeholder=".env, auth/, payments/"
              />
            ) : f.type === "string" && f.key === "loop.defaultAcceptance" ? (
              <Textarea
                id={f.key}
                value={getDraft(f.key)}
                onChange={(e) => setDrafts((d) => ({ ...d, [f.key]: e.target.value }))}
                className="min-h-[60px]"
                placeholder="Acceptance criteria..."
              />
            ) : (
              <div className="flex items-center gap-2">
                <Input
                  id={f.key}
                  type={f.type === "number" ? "number" : "text"}
                  value={getDraft(f.key)}
                  onChange={(e) => setDrafts((d) => ({ ...d, [f.key]: e.target.value }))}
                  className="max-w-[200px]"
                />
                {"unit" in f && f.unit && (
                  <span className="text-xs text-muted-foreground">{f.unit}</span>
                )}
              </div>
            )}
          </div>
        ))}
        {hasChanges && (
          <div className="flex justify-end pt-2">
            <Button size="sm" onClick={handleSave} disabled={saving}>
              Save {section.title}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── System info section (read-only) ──

function SystemInfoSection({ info }: { info: SystemInfo | undefined }) {
  if (!info) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>System Info</CardTitle>
        <CardDescription>Environment variables and paths (read-only).</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <h4 className="mb-2 text-sm font-medium text-muted-foreground">Environment</h4>
          <div className="space-y-1">
            {Object.entries(info.env).map(([k, v]) => (
              <div key={k} className="grid grid-cols-[240px_1fr] gap-2 font-mono text-xs">
                <span className="text-muted-foreground">{k}</span>
                <span className="break-all">{v}</span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <h4 className="mb-2 text-sm font-medium text-muted-foreground">Paths</h4>
          <div className="space-y-1">
            {Object.entries(info.paths).map(([k, v]) => (
              <div key={k} className="grid grid-cols-[240px_1fr] gap-2 font-mono text-xs">
                <span className="text-muted-foreground">{k}</span>
                <span className="break-all">{v}</span>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Page ──

export default function SettingsPage() {
  const settingsQuery = useSettings();
  const systemQuery = useSystemInfo();
  const updateMu = useUpdateSetting();

  const handleSave = (key: string, value: unknown) => {
    updateMu.mutate(
      { key, value },
      {
        onSuccess: () => toast.success(`Saved ${key}`),
        onError: (e) => toast.error(`Failed to save: ${String(e)}`),
      },
    );
  };

  return (
    <div className="container mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Runtime configuration and system information.
        </p>
      </div>

      {SECTIONS.map((section) => (
        <SettingsSection
          key={section.id}
          section={section}
          settings={settingsQuery.data?.settings}
          onSave={handleSave}
          saving={updateMu.isPending}
        />
      ))}

      <SystemInfoSection info={systemQuery.data} />
    </div>
  );
}
