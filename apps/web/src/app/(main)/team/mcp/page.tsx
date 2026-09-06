"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, Plug, RefreshCw, Server, Trash2, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { PackAgentsTab } from "@/components/pack-agents-tab";
import { Page, PageBody, PageHeader } from "@/components/page";
import { KpiTile, MonoLabel, StatusPill } from "@/components/patterns";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InfoBanner, ListToolbar, SubTabs } from "@/components/ui/polish";
import {
  ResourceCard,
  ResourceCardContent,
  ResourceCardFooter,
  ResourceCardHeader,
  ResourceTag,
  type ResourceTone,
} from "@/components/ui/resource-card";
import { ResourceDetailSheet } from "@/components/ui/resource-detail-sheet";
import { Text } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { useAgentList } from "@/features/agents/hooks";
import { agentKeys } from "@/features/agents/query-keys";
import { useMcpCatalog } from "@/features/mcp/hooks";
import type { McpCatalogRow } from "@/features/mcp/queries";
import { mcpKeys } from "@/features/mcp/query-keys";
import { type AgentRow, api } from "@/lib/api";

function hhmm(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

type EditMcpRow = McpCatalogRow & {
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
};

type CreateMcpBody = Parameters<typeof api.createMcpServer>[0];

function mcpStatus(status: string | undefined): "ok" | "err" | "idle" {
  if (status === "connected" || status === "ready") return "ok";
  if (status === "error" || status === "failed") return "err";
  return "idle";
}

function displayStatus(s: McpCatalogRow): "ok" | "err" | "idle" {
  if (s.runtimeStatus === "mounted") return "ok";
  if (s.runtimeStatus === "failed") return "err";
  return mcpStatus(s.status);
}

function statusLabel(s: "ok" | "err" | "idle"): string {
  if (s === "ok") return "Reachable";
  if (s === "err") return "Unreachable";
  return "Offline";
}

function statusTone(s: "ok" | "err" | "idle"): "ok" | "err" | "default" {
  if (s === "ok") return "ok";
  if (s === "err") return "err";
  return "default";
}

function serverMeta(s: McpCatalogRow): string {
  if (s.runtimeStatus === "mounted") return `runtime: ${s.runtimeToolsCount ?? 0} tools`;
  if (s.runtimeStatus === "failed")
    return `runtime: failed${s.runtimeError ? ` (${s.runtimeError})` : ""}`;
  return "";
}

function parseArgs(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function parsePairs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

function normalizeMcpJson(raw: string): CreateMcpBody[] {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid JSON");
  const obj = parsed as Record<string, unknown>;
  const wrap = obj.mcpServers;
  const entries: Array<[string, Record<string, unknown>]> =
    wrap && typeof wrap === "object" && !Array.isArray(wrap)
      ? Object.entries(wrap as Record<string, unknown>).map(([name, s]) => [
          name,
          s as Record<string, unknown>,
        ])
      : [["", obj]];
  return entries.map(([name, s]) => {
    const body: CreateMcpBody = {
      name: name || (s.name as string) || "",
      transport: (s.transport as "stdio" | "sse") ?? (s.type as "stdio" | "sse") ?? "stdio",
    };
    if (typeof s.command === "string") body.command = s.command;
    if (Array.isArray(s.args)) body.args = s.args as string[];
    if (s.env && typeof s.env === "object") body.env = s.env as Record<string, string>;
    if (typeof s.url === "string") body.url = s.url;
    if (s.headers && typeof s.headers === "object")
      body.headers = s.headers as Record<string, string>;
    return body;
  });
}

function McpDetailSheet({
  server,
  agents,
  isAssigned,
  onAssign,
  onRemove,
  onEdit,
  onTest,
  onDelete,
  onClose,
}: {
  server: McpCatalogRow;
  agents: AgentRow[];
  isAssigned: (agentId: string) => boolean;
  onAssign: (agentId: string) => void;
  onRemove: (agentId: string) => void;
  onEdit: (serverId: string) => void;
  onTest: (serverId: string) => void;
  onDelete: (serverId: string) => void;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<EditMcpRow | null>(null);
  const [tab, setTab] = useState<"overview" | "tools" | "agents">("overview");
  const [catalog, setCatalog] = useState<{
    status: string;
    tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
    schemaHash?: string;
    latencyMs?: number;
  } | null>(null);
  const [invoking, setInvoking] = useState<string | null>(null);
  const [invokeArgs, setInvokedArgs] = useState<Record<string, string>>({});
  const [invokeResult, setInvokeResult] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    setDetail(null);
    setCatalog(null);
    setInvokeResult(null);
    api
      .getMcpServer(server.serverId)
      .then((r) => setDetail((r.mcpServer ?? null) as EditMcpRow | null))
      .catch(() => setDetail(null));
  }, [server.serverId]);

  function loadCatalog() {
    api
      .getMcpToolCatalog(server.serverId)
      .then((r) => setCatalog(r as typeof catalog))
      .catch(() => setCatalog(null));
  }

  function invokeTool(toolName: string) {
    let args: Record<string, unknown> = {};
    const raw = invokeArgs[toolName]?.trim();
    if (raw) {
      try {
        args = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        toast.error("Args must be valid JSON");
        return;
      }
    }
    setInvoking(toolName);
    setInvokeResult(null);
    api
      .invokeMcpTool(server.serverId, { tool: toolName, args })
      .then((r) =>
        setInvokeResult(JSON.stringify((r as { result?: unknown }).result ?? null, null, 2)),
      )
      .catch((err) => setInvokeResult(`Error: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setInvoking(null));
  }

  function restartServer() {
    setRestarting(true);
    api
      .restartMcpServer(server.serverId)
      .then(() => {
        toast.success("Server restarted");
        loadCatalog();
      })
      .catch(() => toast.error("Restart failed"))
      .finally(() => setRestarting(false));
  }

  const usedBy = agents.filter((a) =>
    a.mcpServers?.some((m) => m.serverId === server.serverId && m.enabled),
  );
  const tools = server.runtimeToolsCount ?? server.toolsCount ?? 0;
  const row = detail ?? server;
  const st = displayStatus(server);

  return (
    <ResourceDetailSheet
      open
      onClose={onClose}
      icon={<Server className="size-5 text-(--mute)" />}
      title={server.name}
      subtitle={server.serverId}
      badge={{ label: statusLabel(st), tone: statusTone(st) }}
      tabs={[
        { key: "overview", label: "Overview" },
        { key: "tools", label: "Tools" },
        { key: "agents", label: "Agents" },
      ]}
      tab={tab}
      onTabChange={(key) => {
        setTab(key as "overview" | "tools" | "agents");
        if (key === "tools" && !catalog) loadCatalog();
      }}
      breadcrumb={[
        { label: server.name, onClick: () => setTab("overview") },
        { label: "Capabilities" },
      ]}
      footer={
        <>
          <Text as="p" className="mr-auto text-xs text-(--mute)">
            {tools} tools
          </Text>
          <Button variant="outline" size="sm" onClick={() => onEdit(server.serverId)}>
            Edit
          </Button>
          <Button variant="outline" size="sm" onClick={() => onTest(server.serverId)}>
            Test
          </Button>
          <Button variant="outline" size="sm" disabled={restarting} onClick={() => restartServer()}>
            {restarting ? "Restarting…" : "Restart"}
          </Button>
          <Button variant="destructive" size="sm" onClick={() => onDelete(server.serverId)}>
            Delete
          </Button>
        </>
      }
    >
      {tab === "overview" && (
        <div className="space-y-4">
          <Text as="p" className="text-sm text-(--mute)">
            {server.transport === "sse" ? (row.url ?? "") : (row.command ?? "")}
          </Text>
          <dl className="divide-y divide-(--hairline) rounded-md border border-(--hairline) bg-(--canvas-soft) px-3 py-1">
            <DetailRow label="Transport" value={row.transport} />
            <DetailRow label="Command" value={row.command ?? "—"} />
            <DetailRow label="Args" value={(row.args ?? []).join(", ") || "—"} />
            <DetailRow label="Env" value={Object.keys(row.env ?? {}).join(", ") || "—"} />
            <DetailRow label="URL" value={row.url ?? "—"} />
            <DetailRow label="Headers" value={Object.keys(row.headers ?? {}).join(", ") || "—"} />
            <DetailRow label="Status" value={displayStatus(server)} />
            <DetailRow label="Tools" value={`${tools}`} />
            <DetailRow label="Installed" value={`${usedBy.length} agents`} />
          </dl>
        </div>
      )}
      {tab === "tools" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-kicker text-(--mute)">
            <span>status: {catalog?.status ?? "probing…"}</span>
            {catalog?.latencyMs != null && <span>probe {catalog.latencyMs}ms</span>}
            {catalog?.schemaHash && (
              <span className="truncate">hash {catalog.schemaHash.slice(0, 16)}…</span>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-6 px-2 text-[11px]"
              onClick={loadCatalog}
            >
              Refresh
            </Button>
          </div>
          {(!catalog || catalog.tools.length === 0) && (
            <Text as="p" className="text-sm text-(--mute)">
              {catalog ? "No tools exposed." : "Probe the server to load its tool catalog."}
            </Text>
          )}
          {catalog?.tools.map((t) => (
            <div key={t.name} className="rounded-lg border border-(--hairline) p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-xs font-medium text-(--ink)">
                  {t.name}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={invoking === t.name}
                  onClick={() => invokeTool(t.name)}
                >
                  {invoking === t.name ? "Running…" : "Invoke"}
                </Button>
              </div>
              {t.description && <p className="mt-1 text-xs text-(--mute)">{t.description}</p>}
              {t.inputSchema && (
                <details className="mt-1">
                  <summary className="cursor-pointer font-mono text-[10px] text-(--faint)">
                    input schema
                  </summary>
                  <pre className="mt-1 overflow-x-auto rounded bg-(--canvas) p-2 font-mono text-[10px] text-(--mute)">
                    {JSON.stringify(t.inputSchema, null, 2)}
                  </pre>
                </details>
              )}
              <textarea
                value={invokeArgs[t.name] ?? ""}
                onChange={(e) => setInvokedArgs((prev) => ({ ...prev, [t.name]: e.target.value }))}
                placeholder="{}  — JSON arguments"
                rows={2}
                className="mt-2 w-full rounded border border-(--hairline) bg-(--canvas) px-2 py-1 font-mono text-[11px] text-(--ink) placeholder:text-(--faint) focus:border-(--primary) focus:outline-none"
              />
              {invokeResult && invoking === null && (
                <pre className="mt-2 max-h-48 overflow-auto rounded bg-(--canvas) p-2 font-mono text-[10px] text-(--ok)">
                  {invokeResult}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
      {tab === "agents" && (
        <PackAgentsTab
          agents={agents}
          usedBy={usedBy}
          isAssigned={isAssigned}
          onAssign={onAssign}
          onRemove={onRemove}
        />
      )}
    </ResourceDetailSheet>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[160px_1fr] items-baseline gap-4 py-1.5">
      <dt className="font-label-caps text-label-caps uppercase tracking-wider text-(--faint)">
        {label}
      </dt>
      <dd className="truncate text-right font-mono text-xs text-(--body) tabular-nums">{value}</dd>
    </div>
  );
}

export default function McpCatalogPage() {
  const qc = useQueryClient();
  const { data, refetch } = useMcpCatalog();
  const { data: agentsData } = useAgentList();
  const [query, setQuery] = useState("");
  const [transportFilter, setTransportFilter] = useState<"all" | "stdio" | "sse">("all");
  const [mode, setMode] = useState<"form" | "json">("form");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmServerId, setConfirmServerId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "sse">("stdio");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("");
  const [url, setUrl] = useState("");
  const [headersText, setHeadersText] = useState("");
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);

  const remove = useMutation({
    mutationFn: (serverId: string) => api.deleteMcpServer(serverId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: mcpKeys.all }),
  });

  const test = useMutation({
    mutationFn: (serverId: string) =>
      api.testMcpServer(serverId) as Promise<{ status: string; toolsCount: number }>,
    onSuccess: (result, serverId) => {
      toast.success(`Test complete: ${result.status} (${result.toolsCount} tools)`, {
        description: serverId,
      });
      void qc.invalidateQueries({ queryKey: mcpKeys.all });
    },
    onError: (err) => {
      toast.error("Test failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    },
  });

  const resetForm = () => {
    setName("");
    setTransport("stdio");
    setCommand("");
    setArgsText("");
    setEnvText("");
    setUrl("");
    setHeadersText("");
    setJsonText("");
    setJsonError(null);
    setEditingId(null);
  };

  const create = useMutation({
    mutationFn: (body: CreateMcpBody) => api.createMcpServer(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: mcpKeys.all });
    },
    onError: (err) => {
      setJsonError(err instanceof Error ? err.message : "Failed to add server");
    },
  });

  const beginEdit = async (serverId: string) => {
    const row = (await api.getMcpServer(serverId)).mcpServer as EditMcpRow | undefined;
    if (!row) return;
    setEditingId(row.serverId);
    setName(row.name);
    setTransport(row.transport);
    setCommand(row.command ?? "");
    setArgsText((row.args ?? []).join(", "));
    setEnvText(
      Object.entries(row.env ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join("\n"),
    );
    setUrl(row.url ?? "");
    setHeadersText(
      Object.entries(row.headers ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join("\n"),
    );
    setJsonText(
      JSON.stringify(
        {
          name: row.name,
          transport: row.transport,
          command: row.command ?? undefined,
          args: row.args ?? [],
          env: row.env ?? {},
          url: row.url ?? undefined,
          headers: row.headers ?? {},
        },
        null,
        2,
      ),
    );
    setJsonError(null);
    setMode("form");
    setShowForm(true);
  };

  const update = useMutation({
    mutationFn: (input: {
      serverId: string;
      name?: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      headers?: Record<string, string>;
      url?: string;
    }) => {
      const { serverId, ...body } = input;
      return api.updateMcpServer(serverId, body);
    },
    onSuccess: () => {
      resetForm();
      setShowForm(false);
      void qc.invalidateQueries({ queryKey: mcpKeys.all });
    },
    onError: (err) => {
      setJsonError(err instanceof Error ? err.message : "Failed to save server");
    },
  });

  const servers = useMemo(() => data?.mcpServers ?? [], [data]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return servers.filter((s) => {
      if (transportFilter !== "all" && s.transport !== transportFilter) return false;
      if (!q) return true;
      return [s.name, s.command ?? "", s.url ?? ""].some((v) => v.toLowerCase().includes(q));
    });
  }, [servers, query, transportFilter]);

  const selectedServer = servers.find((s) => s.serverId === selectedId) ?? null;
  const connected = servers.filter((s) => mcpStatus(s.status) === "ok").length;
  const runtimeMounted = servers.filter((s) => s.runtimeStatus === "mounted").length;
  const tools = servers.reduce((sum, s) => sum + (s.toolsCount ?? 0), 0);
  const transportSummary = `${servers.filter((x) => x.transport === "stdio").length} stdio · ${servers.filter((x) => x.transport === "sse").length} sse`;

  const buildFormBody = (): CreateMcpBody => {
    const body: CreateMcpBody = { name, transport };
    if (transport === "stdio") {
      if (command) body.command = command;
      body.args = parseArgs(argsText);
      body.env = parsePairs(envText);
    } else {
      if (url) body.url = url;
      body.headers = parsePairs(headersText);
    }
    return body;
  };

  const save = (body: CreateMcpBody) => {
    if (editingId) {
      update.mutate({
        serverId: editingId,
        name: body.name,
        command: body.command,
        args: body.args,
        env: body.env,
        headers: body.headers,
        url: body.url,
      });
      return;
    }
    create.mutate(body, {
      onSuccess: () => {
        resetForm();
        setShowForm(false);
      },
    });
  };

  const submit = () => {
    if (mode === "json") {
      try {
        const bodies = normalizeMcpJson(jsonText);
        if (bodies.length === 0) {
          setJsonError("No servers found");
          return;
        }
        if (editingId) {
          const body = bodies[0]!;
          if (!body.name || !body.transport) {
            setJsonError("JSON must include name and transport");
            return;
          }
          save(body);
          return;
        }
        void (async () => {
          let ok = 0;
          for (const body of bodies) {
            try {
              await create.mutateAsync(body);
              ok++;
            } catch (err) {
              toast.error(`Failed to add ${body.name || "server"}`, {
                description: err instanceof Error ? err.message : "Unknown error",
              });
            }
          }
          if (ok > 0) {
            resetForm();
            setShowForm(false);
            toast.success(`Added ${ok} server${ok > 1 ? "s" : ""}`);
          }
        })();
      } catch {
        setJsonError("Invalid JSON");
      }
      return;
    }
    if (!name) return;
    save(buildFormBody());
  };

  return (
    <Page>
      <PageHeader
        breadcrumb="Team / Capabilities / MCP hub"
        title="MCP Servers & Tool Bindings"
        pill={
          servers.length > 0 ? (
            <StatusPill tone={runtimeMounted > 0 ? "success" : "idle"}>
              {runtimeMounted}/{servers.length} mounted
            </StatusPill>
          ) : undefined
        }
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => void refetch()}>
              <RefreshCw className="size-3.5" />
              Refresh
            </Button>
            <Button
              onClick={() => {
                resetForm();
                setShowForm(true);
              }}
            >
              <Plug className="size-4" />
              Connect Server
            </Button>
          </>
        }
      />
      <PageBody>
        <div className="space-y-6">
          <InfoBanner
            id="ib:mcp-help"
            title="How this page works"
            body="Server definitions persist in mcp-servers.json (file-first). Add a server here once, then enable it per agent from the agent's MCP tab. Status prefers the latest REAL runtime mount result reported by the agent child; before any Run it falls back to the backend manager probe."
          />

          <div data-testid="stat-cards" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <KpiTile
              label="Servers"
              value={servers.length}
              icon={Server}
              detail={transportSummary}
              bar={servers.length === 0 ? 0 : (runtimeMounted / servers.length) * 100}
              barTone="primary"
            />
            <KpiTile
              label="Runtime mounted"
              value={runtimeMounted}
              icon={Plug}
              detail="live probe"
            />
            <KpiTile
              label="Probe OK"
              value={connected}
              icon={CircleCheck}
              detail="manager reachable"
            />
            <KpiTile label="Tools" value={tools} icon={Wrench} detail="exposed methods" />
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {(["all", "stdio", "sse"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTransportFilter(t)}
                className={`rounded px-2 py-0.5 font-mono text-[11px] transition-colors ${
                  transportFilter === t
                    ? "bg-(--panel2) font-medium text-(--primary)"
                    : "bg-(--canvas-soft) text-(--mute) hover:text-(--ink)"
                }`}
              >
                {t === "all"
                  ? `All protocols (${servers.length})`
                  : `${t} (${servers.filter((x) => x.transport === t).length})`}
              </button>
            ))}
          </div>

          <ListToolbar
            searchValue={query}
            onSearch={setQuery}
            placeholder="Search by name, command or URL"
          />
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="font-display text-lg font-semibold tracking-tight text-(--ink-strong)">
                Active MCP Servers
              </h2>
              <StatusPill tone="idle">{servers.length} total</StatusPill>
              <MonoLabel className="text-(--faint)">click mono id to copy</MonoLabel>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((s) => {
                const status = displayStatus(s);
                const resourceTone: ResourceTone =
                  status === "ok" ? "ok" : status === "err" ? "err" : "default";
                const iconTone = s.transport === "sse" ? "var(--accent-violet)" : "var(--primary)";
                const endpoint = s.transport === "sse" ? (s.url ?? "") : (s.command ?? "");
                return (
                  <ResourceCard key={s.serverId} tone={resourceTone}>
                    <ResourceCardHeader
                      icon={
                        <span
                          className="flex size-full items-center justify-center rounded"
                          style={{
                            backgroundColor: `color-mix(in srgb, ${iconTone} 10%, transparent)`,
                            color: iconTone,
                          }}
                        >
                          <Server className="size-5" />
                        </span>
                      }
                      title={s.name}
                      idChip={endpoint || undefined}
                      badge={{ label: statusLabel(status), tone: resourceTone }}
                    />
                    <ResourceCardContent>
                      <p className="line-clamp-2 text-sm text-(--mute)">
                        {s.runtimeError ?? serverMeta(s) ?? "No runtime probe yet."}
                      </p>
                      <div className="flex flex-wrap items-center gap-1">
                        <ResourceTag
                          label={s.transport}
                          tone={s.transport === "sse" ? "info" : "default"}
                        />
                        <ResourceTag label={`${s.runtimeToolsCount ?? s.toolsCount ?? 0} tools`} />
                        {s.runtimeCheckedAt && (
                          <ResourceTag label={`checked ${hhmm(s.runtimeCheckedAt)}`} />
                        )}
                      </div>
                    </ResourceCardContent>
                    <ResourceCardFooter
                      meta={`● ${statusLabel(status)}${s.runtimeError ? " · error" : ""}`}
                      action={{ label: "Inspect", onClick: () => setSelectedId(s.serverId) }}
                    >
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={test.isPending}
                        onClick={() => void test.mutate(s.serverId)}
                      >
                        {test.isPending ? "Testing…" : "Test"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-(--err) hover:bg-(--err)/10"
                        aria-label={`Delete ${s.name}`}
                        onClick={() => setConfirmServerId(s.serverId)}
                      >
                        <Trash2 className="size-3" />
                      </Button>
                    </ResourceCardFooter>
                  </ResourceCard>
                );
              })}
              {filtered.length === 0 && (
                <div data-testid="empty-state" className="col-span-full">
                  <EmptyState
                    icon={Plug}
                    title="No servers yet"
                    description="Add your first MCP server with the Add Server button above."
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      </PageBody>

      <Dialog
        open={showForm}
        onOpenChange={(o) => {
          if (!o) {
            resetForm();
            setShowForm(false);
          }
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit MCP Server" : "Add MCP Server"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <SubTabs
              items={[
                { key: "form", label: "Form" },
                { key: "json", label: "JSON Config" },
              ]}
              active={mode}
              onChange={(k) => setMode(k as "form" | "json")}
            />
            {mode === "form" ? (
              <div className="space-y-3">
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-1">
                    <Label>Name</Label>
                    <Input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="filesystem"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Transport</Label>
                    <select
                      className="h-9 rounded border border-(--hairline) bg-transparent px-2"
                      value={transport}
                      onChange={(e) => setTransport(e.target.value as "stdio" | "sse")}
                    >
                      <option value="stdio">stdio</option>
                      <option value="sse">sse</option>
                    </select>
                  </div>
                </div>
                {transport === "stdio" ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-1">
                      <Label>Command</Label>
                      <Input
                        value={command}
                        onChange={(e) => setCommand(e.target.value)}
                        placeholder="npx"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>Args (comma separated)</Label>
                      <Input
                        value={argsText}
                        onChange={(e) => setArgsText(e.target.value)}
                        placeholder="-y, @modelcontextprotocol/server-filesystem"
                      />
                    </div>
                    <div className="space-y-1 md:col-span-2">
                      <Label>Env (KEY=VALUE per line)</Label>
                      <Textarea
                        value={envText}
                        onChange={(e) => setEnvText(e.target.value)}
                        placeholder={"ROOT=/tmp/workspace"}
                        rows={3}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-1">
                      <Label>URL</Label>
                      <Input
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        placeholder="https://host/sse"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>Headers (KEY=VALUE per line)</Label>
                      <Textarea
                        value={headersText}
                        onChange={(e) => setHeadersText(e.target.value)}
                        placeholder={"Authorization=Bearer token"}
                        rows={3}
                      />
                    </div>
                  </div>
                )}
                <p className="text-xs text-(--mute)">
                  On the JSON tab you can paste a standard MCP config and add multiple servers at
                  once.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-3">
                  <Text as="p" className="text-sm font-medium">
                    Paste JSON Config
                  </Text>
                  <Text as="p" className="mt-1 text-xs text-(--mute)">
                    Supports the standard MCP format. A {"{mcpServers:{…}}"} wrapper adds every
                    server in one action; a single object is also accepted.
                  </Text>
                </div>
                <div className="space-y-1">
                  <Label>Server JSON</Label>
                  <Textarea
                    value={jsonText}
                    onChange={(e) => {
                      setJsonText(e.target.value);
                      setJsonError(null);
                    }}
                    onBlur={() => {
                      try {
                        JSON.parse(jsonText);
                        setJsonError(null);
                      } catch {
                        setJsonError("Invalid JSON");
                      }
                    }}
                    placeholder={`{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem"],
      "env": { "ROOT": "/tmp/workspace" }
    }
  }
}`}
                    rows={10}
                    className="font-mono text-xs"
                  />
                </div>
              </div>
            )}
            {jsonError && <p className="text-xs text-(--err)">{jsonError}</p>}
            <DialogFooter>
              <Button
                variant="ghost"
                onClick={() => {
                  resetForm();
                  setShowForm(false);
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={submit}
                disabled={
                  create.isPending ||
                  update.isPending ||
                  (mode === "form" ? !name : jsonText.trim() === "")
                }
              >
                {create.isPending || update.isPending
                  ? "Saving…"
                  : editingId
                    ? "Save changes"
                    : "Add server"}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {selectedServer && (
        <McpDetailSheet
          server={selectedServer}
          agents={agentsData ?? []}
          isAssigned={(agentId) =>
            Boolean(
              (agentsData ?? [])
                .find((ag) => ag.id === agentId)
                ?.mcpServers?.some((m) => m.serverId === selectedServer.serverId && m.enabled),
            )
          }
          onAssign={(agentId) => {
            const agent = (agentsData ?? []).find((ag) => ag.id === agentId);
            const next = [
              ...(agent?.mcpServers ?? []),
              { serverId: selectedServer.serverId, enabled: true },
            ];
            void api.updateAgent(agentId, { mcpServers: next });
            void qc.invalidateQueries({ queryKey: agentKeys.lists() });
          }}
          onRemove={(agentId) => {
            const agent = (agentsData ?? []).find((ag) => ag.id === agentId);
            const next = (agent?.mcpServers ?? []).filter(
              (m) => m.serverId !== selectedServer.serverId,
            );
            void api.updateAgent(agentId, { mcpServers: next });
            void qc.invalidateQueries({ queryKey: agentKeys.lists() });
          }}
          onEdit={(serverId) => void beginEdit(serverId)}
          onTest={(serverId) => void test.mutate(serverId)}
          onDelete={(serverId) => setConfirmServerId(serverId)}
          onClose={() => setSelectedId(null)}
        />
      )}

      <Dialog
        open={confirmServerId !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmServerId(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete MCP server {confirmServerId}?</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmServerId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (confirmServerId) void remove.mutate(confirmServerId);
                setConfirmServerId(null);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
