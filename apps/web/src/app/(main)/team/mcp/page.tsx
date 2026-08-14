"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

export default function McpCatalogPage() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["mcp-catalog"],
    queryFn: () => api.listMcpServers() as Promise<{ mcpServers: CatalogRow[] }>,
  });
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "sse">("stdio");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");

  const create = useMutation({
    mutationFn: () =>
      api.createMcpServer({
        name,
        transport,
        ...(transport === "stdio" && command ? { command } : {}),
        ...(transport === "sse" && url ? { url } : {}),
      }),
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

  return (
    <Page>
      <PageHeader breadcrumb="Team" title="MCP Servers" />
      <PageBody>
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-3 border border-(--hairline) rounded p-4">
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
            <Button onClick={() => void create.mutate()} disabled={!name}>
              Add server
            </Button>
          </div>

          <ul className="space-y-2">
            {(data?.mcpServers ?? []).map((s) => (
              <li
                key={s.serverId}
                className="flex items-center justify-between gap-3 border border-(--hairline) rounded px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{s.name}</div>
                  <div className="text-xs text-(--mute) truncate">
                    {s.transport === "sse" ? s.url : s.command}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <Badge variant="outline" className="text-xs">
                    {s.status ?? "unknown"}
                  </Badge>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => void remove.mutate(s.serverId)}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ))}
            {(data?.mcpServers ?? []).length === 0 && (
              <p className="text-sm text-(--mute)">No servers yet.</p>
            )}
          </ul>
        </div>
      </PageBody>
    </Page>
  );
}
