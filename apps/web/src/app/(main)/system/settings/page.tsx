"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useModelList } from "@/features/models/hooks";
import { useSettings, useSystemInfo, useUpdateSetting } from "@/features/settings/hooks";
import type { SettingsMap, SystemInfo } from "@/lib/api";

/** Model picker backed by the runtime catalog. The current value is kept as
 *  an option even if it drifts from the catalog, so stored settings never
 *  become uneditable. */
function ModelSelectField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const { data } = useModelList();
  const options = useMemo(() => {
    const groups = (data?.providers ?? []).flatMap((p) =>
      p.models.map((m) => ({ id: `${p.id}/${m.id}`, label: `${p.name} / ${m.name ?? m.id}` })),
    );
    return groups.some((g) => g.id === value) ? groups : [{ id: value, label: value }, ...groups];
  }, [data, value]);
  return (
    <Select value={value} onValueChange={(v) => onChange(v ?? value)}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.id} value={o.id}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ── Field definitions ──
// Only keys with real Product Backend readers are surfaced (verified against
// apps/backend/src: conversation.maxHops in conversation-compose.ts, loop.*
// defaults in loop-service.ts). Keys without a reader are ghost knobs.

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
  fields: Field[];
}

const SECTIONS: Section[] = [
  {
    id: "conversation",
    title: "Conversation",
    description: "Conversation flow control.",
    fields: [{ key: "conversation.maxHops", label: "Max Agent Hops", type: "number" }],
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
];

// ── Default values (used when settings KV is empty) ──

const DEFAULTS: Record<string, unknown> = {
  "conversation.maxHops": 8,
  // Canonical provider/model IDs matching the backend runtime defaults
  // (loop-service.ts); the model fields render as catalog selects.
  "loop.generatorModel": "anthropic/claude-sonnet-4-20250514",
  "loop.evaluatorModel": "anthropic/claude-opus-4-20250514",
  "loop.defaultAcceptance": "",
  "loop.defaultDailyCap": 200000,
  "loop.defaultDenylist": [".env", "auth/", "payments/", "secrets/"],
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
        <CardTitle>{section.title}</CardTitle>
        {section.description && <CardDescription>{section.description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4">
        {section.fields.map((f) => (
          <div
            key={f.key}
            className="grid gap-2 sm:grid-cols-[180px_minmax(0,1fr)] sm:items-center"
          >
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
            ) : f.type === "string" &&
              (f.key === "loop.generatorModel" || f.key === "loop.evaluatorModel") ? (
              <ModelSelectField
                id={f.key}
                value={getDraft(f.key)}
                onChange={(v) => setDrafts((d) => ({ ...d, [f.key]: v }))}
              />
            ) : (
              <div className="flex items-center gap-2 w-full">
                <Input
                  id={f.key}
                  type={f.type === "number" ? "number" : "text"}
                  value={getDraft(f.key)}
                  onChange={(e) => setDrafts((d) => ({ ...d, [f.key]: e.target.value }))}
                  className="w-full sm:max-w-sm"
                />
                {"unit" in f && f.unit && (
                  <span className="shrink-0 text-xs text-muted-foreground">{f.unit}</span>
                )}
              </div>
            )}
          </div>
        ))}
        {/* Always-reserved row: no layout shift when edits appear. */}
        <div className="flex justify-end gap-2 pt-2">
          <Button size="sm" variant="ghost" disabled={!hasChanges} onClick={() => setDrafts({})}>
            Reset
          </Button>
          <Button size="sm" onClick={handleSave} disabled={!hasChanges || saving}>
            Save changes
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── System info section (read-only, collapsed by default) ──

function SystemInfoSection({ info }: { info: SystemInfo | undefined }) {
  const [open, setOpen] = useState(false);
  if (!info) return null;
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>System Info</CardTitle>
          <CardDescription>Environment variables and paths (read-only).</CardDescription>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Show"}
        </Button>
      </CardHeader>
      {open && (
        <CardContent className="space-y-4">
          <div>
            <h4 className="mb-2 text-sm font-medium text-muted-foreground">Environment</h4>
            <dl className="space-y-1">
              {Object.entries(info.env).map(([k, v]) => (
                <div
                  key={k}
                  className="grid gap-0.5 sm:grid-cols-[240px_1fr] sm:gap-2 font-mono text-xs"
                >
                  <dt className="text-muted-foreground break-all">{k}</dt>
                  <dd className="break-all">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div>
            <h4 className="mb-2 text-sm font-medium text-muted-foreground">Paths</h4>
            <dl className="space-y-1">
              {Object.entries(info.paths).map(([k, v]) => (
                <div
                  key={k}
                  className="grid gap-0.5 sm:grid-cols-[240px_1fr] sm:gap-2 font-mono text-xs"
                >
                  <dt className="text-muted-foreground break-all">{k}</dt>
                  <dd className="break-all">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </CardContent>
      )}
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
    <Page>
      <PageHeader
        breadcrumb="System / Settings"
        title="Settings"
        description="Runtime defaults and deployment information."
      />
      <PageBody size="reading" className="space-y-6">
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
      </PageBody>
    </Page>
  );
}
