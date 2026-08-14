"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plug, RefreshCw, Server } from "lucide-react";
import { useMemo, useState } from "react";
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
} from "@/components/ui/polish";
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

function mcpStatus(status: string | undefined): "ok" | "err" | "idle" {
  if (status === "connected" || status === "ready") return "ok";
  if (status === "error" || status === "failed") return "err";
  return "idle";
}

export default function McpCatalogPage() {
  const qc = useQueryClient();
  const { data, refetch } = useQuery({
    queryKey: ["mcp-catalog"],
    queryFn: () => api.listMcpServers() as Promise<{ mcpServers: CatalogRow[] }>,
  });
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "sse">("stdio");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");

  const create = useMutation({
    mutationFn: () => {
      const body: {
        name: string;
        transport: "stdio" | "sse";
        command?: string;
        url?: string;
      } = { name, transport };
      if (transport === "stdio" && command) body.command = command;
      if (transport === "sse" && url) body.url = url;
      return api.createMcpServer(body);
    },
    onSuccess: () => {
      setName("");
      setCommand("");
      setUrl("");
      void qc.invalidateQueries({ queryKey: ["mcp-catalog"] });
    },
  });

  const remove = useMutation({
    mutationFn: (serverId: string) => api.deleteMcpServer(serverId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["mcp-catalog"] }),
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
            body="Server definitions persist in mcp-servers.json (file-first). Add a server here once, then enable it per agent from the agent's MCP tab."
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

          <div className="flex flex-wrap items-end gap-3 rounded-(--radius-card) border border-(--hairline) bg-(--panel) p-4">
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
                  placeholder="npx -y @modelcontextprotocol/server-filesystem"
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
            <Button onClick={() => void create.mutate()} disabled={create.isPending || !name}>
              {create.isPending ? "Adding…" : "Add server"}
            </Button>
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
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => void remove.mutate(s.serverId)}
                    >
                      Delete
                    </Button>
                  }
                />
              ))}
              {filtered.length === 0 && (
                <div data-testid="empty-state">
                  <EmptyState
                    icon={Plug}
                    title="No servers yet"
                    description="Add your first MCP server with the form above."
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
