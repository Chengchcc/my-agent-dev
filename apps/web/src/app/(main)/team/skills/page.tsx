"use client";

import { useQueries, useQueryClient } from "@tanstack/react-query";
import { Download, GitBranch, Package, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AssignToAgentSelect } from "@/components/AssignToAgentSelect";
import { InstallPackForm } from "@/components/InstallPackForm";
import { PackFileSearch } from "@/components/PackFileSearch";
import { PackFileViewer } from "@/components/PackFileViewer";
import { Page, PageBody, PageHeader } from "@/components/page";
import { FileTree } from "@/components/SkillPackManager";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import {
  InfoBanner,
  ListToolbar,
  SectionKicker,
  StatCard,
  SubTabs,
  statusBadge,
} from "@/components/ui/polish";
import { ResourceCard } from "@/components/ui/resource-card";
import { ResourceDetailSheet } from "@/components/ui/resource-detail-sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { useAgentList } from "@/features/agents/hooks";
import {
  useDeletePack,
  useSkillPackList,
  useSkillPackSkills,
  useSyncPack,
} from "@/features/skill-packs/hooks";
import { agentSkillPacksQuery } from "@/features/skill-packs/queries";
import { skillPackKeys } from "@/features/skill-packs/query-keys";
import { type AgentRow, type ApiReturn, api } from "@/lib/api";

type PackEntry = ApiReturn<typeof api.listSkillPacks>[number];

type SkillSummary = { name: string; description: string; dir: string };

function toDateString(value: number): string {
  const ms = value > 1e12 ? value : value * 1000;
  return new Date(ms).toLocaleDateString();
}

function statusTone(status: string): "ok" | "warn" | "err" {
  if (status === "ready") return "ok";
  if (status === "failed") return "err";
  return "warn";
}

function PackDrawer({
  pack,
  usedBy,
  agents,
  isAssigned,
  onAssign,
  onSync,
  onClose,
}: {
  pack: PackEntry;
  usedBy: string[];
  agents: AgentRow[];
  isAssigned: (agentId: string) => boolean;
  onAssign: (agentId: string) => void;
  onSync: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"overview" | "files" | "agents">("overview");
  const [selectedSkill, setSelectedSkill] = useState<SkillSummary | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const { data: skills } = useSkillPackSkills(pack.id);

  const root = selectedSkill ? selectedSkill.dir : "";
  const badge = statusBadge(pack.status);

  return (
    <ResourceDetailSheet
      open
      onClose={onClose}
      icon={<Package className="size-5 text-(--mute)" />}
      title={pack.name}
      subtitle={pack.sourceKind === "git" ? "Git" : pack.sourceKind}
      badge={{ label: badge.label, tone: badge.tone === "err" ? "err" : statusTone(pack.status) }}
      tabs={[
        { key: "overview", label: "Overview" },
        { key: "files", label: "Files" },
        { key: "agents", label: "Agents" },
      ]}
      tab={tab}
      onTabChange={(key) => {
        setTab(key as "overview" | "files" | "agents");
        if (key !== "files") setSelectedFile(null);
      }}
      breadcrumb={[
        { label: pack.name, onClick: () => setTab("overview") },
        ...(tab === "files"
          ? [
              {
                label: selectedSkill?.name ?? "All files",
                onClick: selectedSkill ? () => setSelectedSkill(null) : undefined,
              },
              ...(selectedFile ? [{ label: selectedFile.split("/").pop() ?? selectedFile }] : []),
            ]
          : []),
      ]}
      footer={
        <>
          {usedBy.length > 0 && (
            <Text as="p" className="mr-auto text-xs text-(--mute)">
              Used by {usedBy.length} agent{usedBy.length > 1 ? "s" : ""}
            </Text>
          )}
          {pack.sourceKind === "git" && (
            <Button variant="outline" size="sm" onClick={onSync}>
              Sync from Git
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {tab === "overview" && (
        <div className="space-y-4">
          <Text as="p" className="text-sm text-(--mute)">
            {pack.description || "No description."}
          </Text>
          <div className="flex flex-wrap gap-1">
            <span className="rounded bg-(--panel2) px-1.5 py-0.5 text-xs text-(--mute)">
              {pack.sourceKind}
            </span>
            {pack.keepSynced === true && (
              <span className="rounded bg-(--ok)/12 px-1.5 py-0.5 text-xs text-(--ok)">
                auto-sync
              </span>
            )}
          </div>
          <dl className="space-y-1 text-sm">
            <DetailRow label="Type" value={pack.sourceKind === "git" ? "Git" : pack.sourceKind} />
            <DetailRow label="Source" value={pack.sourceUrl ?? pack.installedRef ?? "—"} />
            <DetailRow label="Status" value={badge.label} />
            <DetailRow label="Latest revision" value={pack.installedRef?.slice(0, 8) ?? "—"} />
            <DetailRow label="Installed" value={`${usedBy.length} agents`} />
            <DetailRow label="Updated" value={toDateString(pack.createdAt)} />
          </dl>
        </div>
      )}

      {tab === "files" && (
        <div className="flex flex-col gap-4 md:flex-row">
          <div className="space-y-3 md:w-[280px] md:shrink-0">
            <Text as="p" className="text-sm font-semibold">
              Files
            </Text>
            {skills && skills.length > 0 && (
              <Select
                value={selectedSkill?.dir ?? ""}
                onValueChange={(v) => {
                  const s = skills.find((x) => x.dir === v);
                  setSelectedSkill(s ?? null);
                  setSelectedFile(null);
                }}
              >
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue placeholder="All files" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">All files</SelectItem>
                  {skills.map((s) => (
                    <SelectItem key={s.dir} value={s.dir}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <PackFileSearch packId={pack.id} onOpen={(p) => setSelectedFile(p)} />
            <div className="rounded-md border border-(--hairline) p-2">
              <FileTree
                packId={pack.id}
                path={root}
                onSelectFile={setSelectedFile}
                selectedPath={selectedFile ?? undefined}
              />
            </div>
          </div>
          <div className="min-w-0 flex-1">
            {selectedFile ? (
              <PackFileViewer packId={pack.id} path={selectedFile} />
            ) : (
              <div className="rounded-lg border border-dashed border-(--hairline) p-8 text-center">
                <Text as="p" className="text-sm text-(--mute)">
                  Select a file to view its contents.
                </Text>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === "agents" && (
        <div className="space-y-3">
          <AssignToAgentSelect agents={agents} assigned={isAssigned} onAssign={onAssign} />
          <div className="space-y-1">
            {usedBy.length === 0 ? (
              <Text as="p" className="text-sm text-(--mute)">
                Not assigned to any agent yet.
              </Text>
            ) : (
              usedBy.map((name) => (
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

export default function SkillPacksPage() {
  const { data: packs, isLoading, refetch } = useSkillPackList();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showInstall, setShowInstall] = useState(false);
  const syncMutation = useSyncPack();
  const deleteMutation = useDeletePack();
  const qc = useQueryClient();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const { data: agentsData } = useAgentList();

  const agentPackQueries = useQueries({
    queries: (agentsData ?? []).map((a) => agentSkillPacksQuery(a.id)),
  });
  const usedByMap: Record<string, string[]> = {};
  (agentsData ?? []).forEach((a, i) => {
    const agentPacks = agentPackQueries[i]?.data;
    if (!Array.isArray(agentPacks)) return;
    for (const p of agentPacks) {
      usedByMap[p.id] = [...(usedByMap[p.id] ?? []), a.name];
    }
  });

  const list = useMemo(() => packs ?? [], [packs]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return list.filter((p) => {
      if (statusFilter === "ready" && p.status !== "ready") return false;
      if (
        statusFilter === "syncing" &&
        p.status !== "syncing" &&
        p.status !== "installing" &&
        p.status !== "pending"
      )
        return false;
      if (statusFilter === "error" && p.status !== "failed") return false;
      if (!q) return true;
      return p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q);
    });
  }, [list, query, statusFilter]);

  const hasPending = list.some((p) => p.status === "installing" || p.status === "syncing");
  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(() => refetch(), 3000);
    return () => clearInterval(timer);
  }, [hasPending, refetch]);

  const selectedPack = list.find((p) => p.id === selectedId) ?? null;
  const ready = list.filter((p) => p.status === "ready").length;
  const syncing = list.filter(
    (p) => p.status === "syncing" || p.status === "installing" || p.status === "pending",
  ).length;
  const errors = list.filter((p) => p.status === "failed").length;

  const statusTabs = [
    { key: "all", label: "All" },
    { key: "ready", label: "Ready" },
    { key: "syncing", label: "Syncing" },
    { key: "error", label: "Error" },
  ].map((t) => ({
    ...t,
    count: statusCount(t.key),
  }));

  function statusCount(key: string): number {
    if (key === "all") return list.length;
    if (key === "ready") return ready;
    if (key === "syncing") return syncing;
    return errors;
  }

  const handleSync = async (packId: string) => {
    syncMutation.mutate(
      { id: packId },
      {
        onError: async (err) => {
          const e = err as { status?: number; message?: string };
          if (e?.status !== 409) return;
          let change: { from?: string; to?: string } = {};
          try {
            change = JSON.parse(e.message ?? "{}");
          } catch {
            /* keep empty */
          }
          const ok = await confirm({
            title: "Upstream changed",
            description: `Sync skill pack from ${change.from?.slice(0, 8) ?? "unknown"} to ${change.to?.slice(0, 8) ?? "unknown"}?`,
            confirmText: "Sync",
          });
          if (ok) syncMutation.mutate({ id: packId, confirm: true });
        },
      },
    );
  };

  const handleDelete = async (pack: PackEntry) => {
    const ok = await confirm({
      title: `Delete pack "${pack.name}"?`,
      description: "This cannot be undone.",
      confirmText: "Delete",
      destructive: true,
    });
    if (ok) deleteMutation.mutate(pack.id);
  };

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: "Team", href: "/team" },
          { label: "Skills", href: "/team/skills" },
        ]}
        title="Skills"
        subtitle="Manage re-usable skill packs for agents."
        actions={
          <Button onClick={() => setShowInstall(true)}>
            <Download className="size-4" />
            Import Skill Pack
          </Button>
        }
      />
      <PageBody>
        <div className="space-y-6">
          <InfoBanner
            id="ib:skills-help"
            title="How this page works"
            body="Install a pack from git or a zip upload, then assign it per agent from the agent's Skills tab. Click a card to browse its skills and files."
          />

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Packs" value={list.length} />
            <StatCard label="Ready" value={ready} />
            <StatCard label="Syncing" value={syncing} />
            <StatCard label="Errors" value={errors} tone={errors > 0 ? "err" : undefined} />
          </div>

          <SubTabs items={statusTabs} active={statusFilter} onChange={setStatusFilter} />

          <ListToolbar
            searchValue={query}
            onSearch={setQuery}
            placeholder="Search skill packs by name or description"
          />

          <div>
            <SectionKicker hint="Sync pulls the latest revision of git packs.">
              Installed packs
            </SectionKicker>
            {isLoading ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Skeleton className="h-40" />
                <Skeleton className="h-40" />
                <Skeleton className="h-40" />
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {filtered.map((p) => {
                  const usedBy = usedByMap[p.id] ?? [];
                  const isAssigned = (agentId: string) => {
                    const idx = (agentsData ?? []).findIndex((a) => a.id === agentId);
                    const agentPacks = agentPackQueries[idx]?.data;
                    return Array.isArray(agentPacks) && agentPacks.some((pack) => pack.id === p.id);
                  };
                  const onAssign = (agentId: string) => {
                    const idx = (agentsData ?? []).findIndex((a) => a.id === agentId);
                    const current = agentPackQueries[idx]?.data;
                    const currentIds = Array.isArray(current) ? current.map((x) => x.id) : [];
                    const next = currentIds.includes(p.id) ? currentIds : [...currentIds, p.id];
                    void api.setAgentSkillPacks(agentId, { packIds: next });
                    void qc.invalidateQueries({ queryKey: skillPackKeys.agentPacks(agentId) });
                  };
                  const badge = statusBadge(p.status);
                  return (
                    <ResourceCard
                      key={p.id}
                      icon={<Package className="size-4 text-(--mute)" />}
                      title={p.name}
                      badge={{
                        label: badge.label,
                        tone: badge.tone === "err" ? "err" : statusTone(p.status),
                      }}
                      description={p.error ?? p.description}
                      tags={[{ label: p.sourceKind }]}
                      lint={[
                        ...(usedBy.length
                          ? [
                              {
                                label: `${usedBy.length} agent${usedBy.length > 1 ? "s" : ""}`,
                                tone: "ok" as const,
                              },
                            ]
                          : [{ label: "not assigned", tone: "warn" as const }]),
                        ...(p.keepSynced === true
                          ? [{ label: "auto-sync", tone: "info" as const }]
                          : []),
                      ]}
                      meta={`${toDateString(p.createdAt)}${p.installedRef ? ` · @${p.installedRef.slice(0, 8)}` : ""}`}
                      footer={
                        <>
                          <AssignToAgentSelect
                            agents={agentsData ?? []}
                            assigned={isAssigned}
                            onAssign={onAssign}
                          />
                          {p.sourceKind === "git" && p.status === "ready" && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={syncMutation.isPending}
                              onClick={() => void handleSync(p.id)}
                            >
                              <RefreshCw
                                className={`size-3 ${syncMutation.isPending ? "animate-spin" : ""}`}
                              />
                              Sync
                            </Button>
                          )}
                          <Button variant="outline" size="sm" onClick={() => setSelectedId(p.id)}>
                            View
                          </Button>
                          {p.sourceKind !== "builtin" && (
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => void handleDelete(p)}
                            >
                              <Trash2 className="size-3" />
                              Delete
                            </Button>
                          )}
                        </>
                      }
                      onClick={() => setSelectedId(p.id)}
                    />
                  );
                })}
                {filtered.length === 0 && (
                  <div data-testid="empty-state" className="col-span-full">
                    <EmptyState
                      icon={GitBranch}
                      title="No skill packs installed"
                      description="Install your first pack to give agents reusable skills."
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </PageBody>

      <Dialog open={showInstall} onOpenChange={setShowInstall}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Import Skill Pack</DialogTitle>
          </DialogHeader>
          <InstallPackForm
            onDone={() => {
              setShowInstall(false);
              refetch();
            }}
            onCancel={() => setShowInstall(false)}
          />
        </DialogContent>
      </Dialog>

      {selectedPack && (
        <PackDrawer
          pack={selectedPack}
          usedBy={usedByMap[selectedPack.id] ?? []}
          agents={agentsData ?? []}
          isAssigned={(agentId) => {
            const idx = (agentsData ?? []).findIndex((a) => a.id === agentId);
            const agentPacks = agentPackQueries[idx]?.data;
            return (
              Array.isArray(agentPacks) && agentPacks.some((pack) => pack.id === selectedPack.id)
            );
          }}
          onAssign={(agentId) => {
            const idx = (agentsData ?? []).findIndex((a) => a.id === agentId);
            const current = agentPackQueries[idx]?.data;
            const currentIds = Array.isArray(current) ? current.map((x) => x.id) : [];
            const next = currentIds.includes(selectedPack.id)
              ? currentIds
              : [...currentIds, selectedPack.id];
            void api.setAgentSkillPacks(agentId, { packIds: next });
            void qc.invalidateQueries({ queryKey: skillPackKeys.agentPacks(agentId) });
          }}
          onSync={() => void handleSync(selectedPack.id)}
          onClose={() => setSelectedId(null)}
        />
      )}

      {confirmDialog}
    </Page>
  );
}
