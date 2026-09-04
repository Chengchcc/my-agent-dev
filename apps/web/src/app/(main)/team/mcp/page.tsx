"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plug, RefreshCw, Server } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AssignToAgentSelect } from "@/components/AssignToAgentSelect";
import { Page, PageBody, PageHeader } from "@/components/page";
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
import { InfoBanner, ListToolbar, SectionKicker, StatCard, SubTabs } from "@/components/ui/polish";
import { ResourceCard } from "@/components/ui/resource-card";
import { ResourceDetailSheet } from "@/components/ui/resource-detail-sheet";
import { Text } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { useAgentList } from "@/features/agents/hooks";
import { agentKeys } from "@/features/agents/query-keys";
import { useMcpCatalog } from "@/features/mcp/hooks";
import type { McpCatalogRow } from "@/features/mcp/queries";
import { mcpKeys } from "@/features/mcp/query-keys";
import { type AgentRow, api } from "@/lib/api";

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
  onEdit,
  onTest,
  onDelete,
  onClose,
}: {
  server: McpCatalogRow;
  agents: AgentRow[];
  onEdit: (serverId: string) => void;
  onTest: (serverId: string) => void;
  onDelete: (serverId: string) => void;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<EditMcpRow | null>(null);
  const [tab, setTab] = useState<"overview" | "agents">("overview");

  useEffect(() => {
    setDetail(null);
    api
      .getMcpServer(server.serverId)
      .then((r) => setDetail((r.mcpServer ?? null) as EditMcpRow | null))
      .catch(() => setDetail(null));
  }, [server.serverId]);

  const usedByNames = agents
    .filter((a) => a.mcpServers?.some((m) => m.serverId === server.serverId && m.enabled))
    .map((a) => a.name);
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
        { key: "agents", label: "Agents" },
      ]}
      tab={tab}
      onTabChange={(key) => setTab(key as "overview" | "agents")}
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
          <dl className="space-y-1 text-sm">
            <DetailRow label="Transport" value={row.transport} />
            <DetailRow label="Command" value={row.command ?? "—"} />
            <DetailRow label="Args" value={(row.args ?? []).join(", ") || "—"} />
            <DetailRow label="Env" value={Object.keys(row.env ?? {}).join(", ") || "—"} />
            <DetailRow label="URL" value={row.url ?? "—"} />
            <DetailRow label="Headers" value={Object.keys(row.headers ?? {}).join(", ") || "—"} />
            <DetailRow label="Status" value={displayStatus(server)} />
            <DetailRow label="Tools" value={`${tools}`} />
            <DetailRow label="Installed" value={`${usedByNames.length} agents`} />
          </dl>
        </div>
      )}
      {tab === "agents" && (
        <div className="space-y-3">
          {usedByNames.length === 0 ? (
            <Text as="p" className="text-sm text-(--mute)">
              Not assigned to any agent yet.
            </Text>
          ) : (
            usedByNames.map((name) => (
              <div
                key={name}
                className="flex items-center justify-between rounded-md border border-(--hairline) px-3 py-2"
              >
                <Text as="span" className="text-sm">
                  {name}
                </Text>
                <span className="rounded bg-(--ok)/12 px-1.5 py-0.5 text-xs text-(--ok)">
                  Active
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </ResourceDetailSheet>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <Text as="dt" className="text-(--mute)">
        {label}
      </Text>
      <Text as="dd" className="truncate text-right">
        {value}
      </Text>
    </div>
  );
}

export default function McpCatalogPage() {
  const qc = useQueryClient();
  const { data, refetch } = useMcpCatalog();
  const { data: agentsData } = useAgentList();
  const [query, setQuery] = useState("");
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
    if (!q) return servers;
    return servers.filter((s) =>
      [s.name, s.command ?? "", s.url ?? ""].some((v) => v.toLowerCase().includes(q)),
    );
  }, [servers, query]);

  const selectedServer = servers.find((s) => s.serverId === selectedId) ?? null;
  const connected = servers.filter((s) => mcpStatus(s.status) === "ok").length;
  const runtimeMounted = servers.filter((s) => s.runtimeStatus === "mounted").length;
  const tools = servers.reduce((sum, s) => sum + (s.toolsCount ?? 0), 0);

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
        breadcrumb={[{ label: "Team", href: "/team" }, { label: "MCP" }]}
        title="MCP"
        subtitle="Global catalog shared by all agents; per-agent switches live on agent pages."
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
              Add Server
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

          <div data-testid="stat-cards" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Servers" value={servers.length} />
            <StatCard label="Probe OK" value={connected} />
            <StatCard label="Runtime Mounted" value={runtimeMounted} />
            <StatCard label="Tools" value={tools} />
          </div>

          <SubTabs
            items={[
              { key: "all", label: "All" },
              { key: "ready", label: "Reachable" },
              { key: "failed", label: "Failed" },
            ]}
            active="all"
            onChange={() => {}}
          />

          <ListToolbar
            searchValue={query}
            onSearch={setQuery}
            placeholder="Search by name, command or URL"
          />

          <div>
            <SectionKicker hint="Click the mono id to copy the server id.">Servers</SectionKicker>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((s) => {
                const usedByNames = (agentsData ?? [])
                  .filter((a) => a.mcpServers?.some((m) => m.serverId === s.serverId && m.enabled))
                  .map((a) => a.name);
                const status = displayStatus(s);
                const lint: Array<{ label: string; tone: "ok" | "warn" | "err" }> = [];
                if (usedByNames.length) {
                  lint.push({
                    label: `${usedByNames.length} agent${usedByNames.length > 1 ? "s" : ""}`,
                    tone: "ok",
                  });
                } else {
                  lint.push({ label: "not assigned", tone: "warn" });
                }
                if (s.runtimeStatus === "mounted") {
                  lint.push({
                    label: `${s.runtimeToolsCount ?? s.toolsCount ?? 0} tools`,
                    tone: "ok",
                  });
                } else if (s.runtimeStatus === "failed") {
                  lint.push({ label: "runtime failed", tone: "err" });
                }
                return (
                  <ResourceCard
                    key={s.serverId}
                    icon={<Server className="size-4 text-(--mute)" />}
                    title={s.name}
                    idChip={s.serverId}
                    badge={{ label: statusLabel(status), tone: statusTone(status) }}
                    description={s.transport === "sse" ? (s.url ?? "") : (s.command ?? "")}
                    tags={[{ label: s.transport }]}
                    lint={lint}
                    meta={serverMeta(s)}
                    footer={
                      <>
                        <AssignToAgentSelect
                          agents={agentsData ?? []}
                          assigned={(agentId) =>
                            (agentsData ?? []).some(
                              (ag) =>
                                ag.id === agentId &&
                                Boolean(
                                  ag.mcpServers?.some(
                                    (m) => m.serverId === s.serverId && m.enabled,
                                  ),
                                ),
                            )
                          }
                          onAssign={(agentId) => {
                            const agent = (agentsData ?? []).find((ag) => ag.id === agentId);
                            const next = [
                              ...(agent?.mcpServers ?? []),
                              { serverId: s.serverId, enabled: true },
                            ];
                            void api.updateAgent(agentId, { mcpServers: next });
                            void qc.invalidateQueries({ queryKey: agentKeys.lists() });
                          }}
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void beginEdit(s.serverId)}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={test.isPending}
                          onClick={() => void test.mutate(s.serverId)}
                        >
                          {test.isPending ? "Testing…" : "Test"}
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => setConfirmServerId(s.serverId)}
                        >
                          Delete
                        </Button>
                      </>
                    }
                    onClick={() => setSelectedId(s.serverId)}
                  />
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
