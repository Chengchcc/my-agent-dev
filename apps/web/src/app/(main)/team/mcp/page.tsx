"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plug, RefreshCw, Server } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  InfoBanner,
  ListRowCard,
  ListToolbar,
  SectionKicker,
  StatCard,
  SubTabs,
} from "@/components/ui/polish";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";

/** Global MCP catalog (ADR 0022): server definitions live in
 *  <dataDir>/mcp-servers.json (file-first). Agent switches live on the
 *  agent pages (MCP tab). */
interface CatalogRow {
  serverId: string;
  name: string;
  transport: "stdio" | "sse";
  command: string | null;
  url: string | null;
  status?: string;
  toolsCount?: number;
}

type EditMcpRow = CatalogRow & {
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

export default function McpCatalogPage() {
  const qc = useQueryClient();
  const { data, refetch } = useQuery({
    queryKey: ["mcp-catalog"],
    queryFn: () => api.listMcpServers() as Promise<{ mcpServers: CatalogRow[] }>,
  });
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"form" | "json">("form");
  const [editingId, setEditingId] = useState<string | null>(null);
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
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["mcp-catalog"] }),
  });

  const test = useMutation({
    mutationFn: (serverId: string) =>
      api.testMcpServer(serverId) as Promise<{ status: string; toolsCount: number }>,
    onSuccess: (result, serverId) => {
      toast.success(`Test complete: ${result.status} (${result.toolsCount} tools)`, {
        description: serverId,
      });
      void qc.invalidateQueries({ queryKey: ["mcp-catalog"] });
    },
    onError: (err) => {
      toast.error("Test failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    },
  });
  const resetForm = () => {
    setCommand("");
    setArgsText("");
    setEnvText("");
    setJsonText("");
    setJsonError(null);
    setEditingId(null);
  };

  const create = useMutation({
    mutationFn: (body: CreateMcpBody) => api.createMcpServer(body),
    onSuccess: () => {
      resetForm();
      void qc.invalidateQueries({ queryKey: ["mcp-catalog"] });
    },
    onError: (err) => {
      setJsonError(err instanceof Error ? err.message : "Failed to add server");
    },
  });

  const beginEdit = async (serverId: string) => {
    const data = (await api.getMcpServer(serverId)) as { mcpServer?: EditMcpRow };
    const row = data.mcpServer;
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
      void qc.invalidateQueries({ queryKey: ["mcp-catalog"] });
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

  const connected = servers.filter((s) => mcpStatus(s.status) === "ok").length;
  const errors = servers.filter((s) => mcpStatus(s.status) === "err").length;
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
    create.mutate(body);
  };

  const submit = () => {
    if (mode === "json") {
      try {
        const parsed = JSON.parse(jsonText) as CreateMcpBody;
        if (!parsed.name || !parsed.transport) {
          setJsonError("JSON must include name and transport");
          return;
        }
        save(parsed);
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
        breadcrumb="Team"
        title="MCP Servers"
        subtitle="Global catalog shared by all agents; per-agent switches live on agent pages."
        actions={
          <Button variant="ghost" size="sm" onClick={() => void refetch()}>
            <RefreshCw className="size-3.5" />
            Refresh
          </Button>
        }
      />
      <PageBody>
        <div className="space-y-6">
          <InfoBanner
            id="ib:mcp-help"
            title="How this page works"
            body="Server definitions persist in mcp-servers.json (file-first). Add a server here once, then enable it per agent from the agent's MCP tab. Status is a manager-side probe, not the runtime's live call result."
          />

          <div data-testid="stat-cards" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Servers" value={servers.length} />
            <StatCard label="Connected" value={connected} />
            <StatCard label="Errors" value={errors} tone={errors > 0 ? "err" : undefined} />
            <StatCard label="Tools" value={tools} />
          </div>

          <ListToolbar
            searchValue={query}
            onSearch={setQuery}
            placeholder="Search by name, command or URL"
          />

          <div className="space-y-3 rounded-(--radius-card) border border-(--hairline) bg-(--panel) p-4">
            <SubTabs
              items={[
                { key: "form", label: "Form" },
                { key: "json", label: "JSON" },
              ]}
              active={mode}
              onChange={(k) => setMode(k as "form" | "json")}
            />

            {mode === "form" ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-end gap-3">
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
                  {transport === "stdio" ? (
                    <div className="space-y-1">
                      <Label>Command</Label>
                      <Input
                        value={command}
                        onChange={(e) => setCommand(e.target.value)}
                        placeholder="npx"
                      />
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <Label>URL</Label>
                      <Input
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        placeholder="https://host/sse"
                      />
                    </div>
                  )}
                </div>

                {transport === "stdio" ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-1">
                      <Label>Args (comma separated)</Label>
                      <Input
                        value={argsText}
                        onChange={(e) => setArgsText(e.target.value)}
                        placeholder="-y, @modelcontextprotocol/server-filesystem"
                      />
                    </div>
                    <div className="space-y-1">
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
                  <div className="space-y-1">
                    <Label>Headers (KEY=VALUE per line)</Label>
                    <Textarea
                      value={headersText}
                      onChange={(e) => setHeadersText(e.target.value)}
                      placeholder={"Authorization=Bearer token"}
                      rows={3}
                    />
                  </div>
                )}
              </div>
            ) : (
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
                  placeholder={`{\n  "name": "filesystem",\n  "transport": "stdio",\n  "command": "npx",\n  "args": ["-y", "@modelcontextprotocol/server-filesystem"],\n  "env": { "ROOT": "/tmp/workspace" }\n}`}
                  rows={8}
                  className="font-mono text-xs"
                />
              </div>
            )}

            {jsonError && <p className="text-xs text-(--err)">{jsonError}</p>}

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
            {editingId && (
              <Button variant="ghost" size="sm" onClick={resetForm}>
                Cancel edit
              </Button>
            )}
          </div>

          <div>
            <SectionKicker hint="Click the mono id to copy the server id.">Servers</SectionKicker>
            <div className="space-y-2">
              {filtered.map((s) => (
                <ListRowCard
                  key={s.serverId}
                  icon={<Server className="size-4 text-(--mute)" />}
                  title={s.name}
                  tag={{ label: s.transport }}
                  idChip={s.serverId}
                  desc={s.transport === "sse" ? (s.url ?? undefined) : (s.command ?? undefined)}
                  status={mcpStatus(s.status)}
                  actions={
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void beginEdit(s.serverId)}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={test.isPending}
                        onClick={() => void test.mutate(s.serverId)}
                      >
                        {test.isPending ? "Testing…" : "Test"}
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => void remove.mutate(s.serverId)}
                      >
                        Delete
                      </Button>
                    </div>
                  }
                />
              ))}
              {filtered.length === 0 && (
                <div data-testid="empty-state">
                  <EmptyState
                    icon={Plug}
                    title="No servers yet"
                    description="Add your first MCP server with the form or JSON editor above."
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      </PageBody>
    </Page>
  );
}
