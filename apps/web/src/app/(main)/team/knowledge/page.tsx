"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, RefreshCw } from "lucide-react";
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

function statusLabel(status: PackRow["status"]): string {
  if (status === "pending") return "Pending";
  if (status === "installing") return "Installing…";
  if (status === "syncing") return "Syncing…";
  if (status === "ready") return "Ready";
  if (status === "failed") return "Failed";
  return status;
}

export default function KnowledgePackPage() {
  const qc = useQueryClient();
  const { data, refetch } = useQuery({
    queryKey: ["knowledge-packs"],
    queryFn: () => api.listKnowledgePacks() as Promise<{ packs: PackRow[] }>,
  });
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [sourceKind, setSourceKind] = useState<"builtin" | "git">("git");
  const [sourceUrl, setSourceUrl] = useState("");

  const install = useMutation({
    mutationFn: () => {
      const body: {
        name: string;
        description?: string;
        sourceKind: "builtin" | "git";
        sourceUrl?: string;
      } = { name, sourceKind };
      if (description) body.description = description;
      if (sourceKind === "git") body.sourceUrl = sourceUrl;
      return api.installKnowledgePack(body);
    },
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

  const packs = useMemo(() => data?.packs ?? [], [data]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return packs;
    return packs.filter(
      (p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q),
    );
  }, [packs, query]);

  const ready = packs.filter((p) => p.status === "ready").length;
  const failed = packs.filter((p) => p.status === "failed").length;
  const installing = packs.filter(
    (p) => p.status === "installing" || p.status === "syncing" || p.status === "pending",
  ).length;

  return (
    <Page>
      <PageHeader
        breadcrumb="Team"
        title="Knowledge Packs"
        subtitle="Install shared knowledge packs here; attach them per agent from the agent's Knowledge tab."
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
            id="ib:knowledge-help"
            title="How this page works"
            body="Packs are installed from a git repo or the builtin library, then referenced by agents. Example: https://github.com/org/repo.git or a local path."
          />

          <div data-testid="stat-cards" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Packs" value={packs.length} />
            <StatCard label="Ready" value={ready} />
            <StatCard label="Failed" value={failed} tone={failed > 0 ? "err" : undefined} />
            <StatCard
              label="Installing"
              value={installing}
              tone={installing > 0 ? "warn" : undefined}
            />
          </div>

          <ListToolbar
            searchValue={query}
            onSearch={setQuery}
            placeholder="Search packs by name or description"
          />

          <div className="flex flex-wrap items-end gap-3 rounded-(--radius-card) border border-(--hairline) bg-(--panel) p-4">
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
              disabled={install.isPending || !name || (sourceKind === "git" && !sourceUrl)}
            >
              {install.isPending ? "Installing…" : "Install"}
            </Button>
          </div>

          <div>
            <SectionKicker hint="Installed packs are available to every agent.">
              Installed packs
            </SectionKicker>
            <div className="space-y-2">
              {filtered.map((p) => (
                <ListRowCard
                  key={p.id}
                  icon={<BookOpen className="size-4 text-(--mute)" />}
                  title={p.name}
                  tag={{ label: p.sourceKind }}
                  badges={[statusLabel(p.status)]}
                  desc={p.status === "failed" && p.error ? p.error : p.description}
                  actions={
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => void remove.mutate(p.id)}
                    >
                      Delete
                    </Button>
                  }
                />
              ))}
              {filtered.length === 0 && (
                <div data-testid="empty-state">
                  <EmptyState
                    icon={BookOpen}
                    title="No knowledge packs installed"
                    description="Install your first pack with the form above."
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
