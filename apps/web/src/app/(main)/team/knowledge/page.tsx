"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";

/** Knowledge pack pool (ADR 0022): install builtin/git packs here; agent
 *  switches live on the agent pages (knowledge checkboxes). */

interface PackRow {
  id: string;
  name: string;
  description: string;
  sourceKind: "builtin" | "git" | "zip";
  status: "pending" | "installing" | "ready" | "failed" | "syncing";
  error: string | null;
}

function statusVariant(status: string): "default" | "destructive" | "secondary" | "outline" {
  if (status === "ready") return "default";
  if (status === "failed") return "destructive";
  return "secondary";
}

export default function KnowledgePackPage() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["knowledge-packs"],
    queryFn: () => api.listKnowledgePacks() as Promise<{ packs: PackRow[] }>,
  });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [sourceKind, setSourceKind] = useState<"builtin" | "git">("git");
  const [sourceUrl, setSourceUrl] = useState("");

  const install = useMutation({
    mutationFn: () =>
      api.installKnowledgePack({
        name,
        ...(description ? { description } : {}),
        sourceKind,
        ...(sourceKind === "git" ? { sourceUrl } : {}),
      }),
    onSuccess: () => {
      setName("");
      setDescription("");
      setSourceUrl("");
      void qc.invalidateQueries({ queryKey: ["knowledge-packs"] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteKnowledgePack(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["knowledge-packs"] }),
  });

  return (
    <Page>
      <PageHeader breadcrumb="Team" title="Knowledge Packs" />
      <PageBody>
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-3 border border-(--hairline) rounded p-4">
            <div className="space-y-1">
              <Label>Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-docs-pack"
              />
            </div>
            <div className="space-y-1">
              <Label>Description</Label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="what it covers"
              />
            </div>
            <div className="space-y-1">
              <Label>Source</Label>
              <select
                className="h-9 rounded border border-(--hairline) bg-transparent px-2"
                value={sourceKind}
                onChange={(e) => setSourceKind(e.target.value as "builtin" | "git")}
              >
                <option value="git">git</option>
                <option value="builtin">builtin</option>
              </select>
            </div>
            {sourceKind === "git" && (
              <div className="space-y-1">
                <Label>Repo URL</Label>
                <Input
                  value={sourceUrl}
                  onChange={(e) => setSourceUrl(e.target.value)}
                  placeholder="e.g. https://github.com/org/repo.git or a local path"
                />
              </div>
            )}
            <Button
              onClick={() => void install.mutate()}
              disabled={!name || (sourceKind === "git" && !sourceUrl)}
            >
              Install
            </Button>
          </div>

          <ul className="space-y-2">
            {(data?.packs ?? []).map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between gap-3 border border-(--hairline) rounded px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{p.name}</div>
                  <div className="text-xs text-(--mute) truncate">{p.description}</div>
                  {p.status === "failed" && p.error && (
                    <div className="text-xs text-destructive truncate">{p.error}</div>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <Badge variant={statusVariant(p.status)} className="text-xs">
                    {p.status}
                  </Badge>
                  <Button variant="destructive" size="sm" onClick={() => void remove.mutate(p.id)}>
                    Delete
                  </Button>
                </div>
              </li>
            ))}
            {(data?.packs ?? []).length === 0 && (
              <p className="text-sm text-(--mute)">No knowledge packs installed.</p>
            )}
          </ul>
        </div>
      </PageBody>
    </Page>
  );
}
