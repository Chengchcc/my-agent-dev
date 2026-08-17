"use client";

import { Download, GitBranch, Package, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { InstallPackForm } from "@/components/InstallPackForm";
import { PackFileSearch } from "@/components/PackFileSearch";
import { Page, PageBody, PageHeader } from "@/components/page";
import { dirname, FileContent, FileTree, statusLabel } from "@/components/SkillPackManager";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  InfoBanner,
  ListRowCard,
  ListToolbar,
  SectionKicker,
  StatCard,
} from "@/components/ui/polish";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useDeletePack,
  useSkillPackList,
  useSkillPackSkills,
  useSyncPack,
} from "@/features/skill-packs/hooks";

type PackStatus = "pending" | "installing" | "ready" | "failed" | "syncing";

/** treaty can't derive skill-packs types due to Elysia intersection type limits */
type PackEntry = {
  id: string;
  name: string;
  description: string;
  sourceKind: string;
  status: PackStatus;
  installedRef?: string;
  error?: string;
  createdAt: number;
};

type SkillSummary = { name: string; description: string; dir: string };

/** createdAt arrives as epoch ms or s; normalize before Date(). */
function toDateString(value: number): string {
  const ms = value > 1e12 ? value : value * 1000;
  return new Date(ms).toLocaleDateString();
}

/** Pack detail drawer: skills + file tree on the left, viewer on the right. */
function PackDrawer({ pack, onClose }: { pack: PackEntry; onClose: () => void }) {
  const [selectedSkill, setSelectedSkill] = useState<SkillSummary | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const { data: skills } = useSkillPackSkills(pack.id);

  const root = selectedSkill ? dirname(selectedSkill.dir) : "";

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-[92vw] max-w-[1200px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{pack.name}</SheetTitle>
        </SheetHeader>
        <div className="mt-4 flex flex-col gap-4 md:flex-row">
          <div className="space-y-4 md:w-[240px] md:shrink-0">
            <div>
              <h3 className="mb-2 text-sm font-semibold">Skills</h3>
              {skills ? (
                <div className="space-y-1">
                  {skills.map((s: SkillSummary) => (
                    <Card
                      key={s.dir}
                      className={`cursor-pointer p-2.5 ${
                        selectedSkill?.dir === s.dir ? "border-primary" : ""
                      }`}
                      onClick={() => {
                        setSelectedSkill(s);
                        setSelectedFile(null);
                      }}
                    >
                      <div className="truncate text-sm font-medium">{s.name}</div>
                      <div className="line-clamp-2 text-xs text-muted-foreground">
                        {s.description}
                      </div>
                    </Card>
                  ))}
                </div>
              ) : (
                <Skeleton className="h-12 w-full" />
              )}
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">
                  {selectedSkill ? selectedSkill.name : "Pack files"}
                </h3>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-(--text-cap)"
                  onClick={() => setSelectedSkill(null)}
                >
                  All pack files
                </Button>
              </div>
              <Card className="p-3">
                <PackFileSearch packId={pack.id} onOpen={setSelectedFile} />
                <FileTree packId={pack.id} path={root} onSelectFile={setSelectedFile} />
              </Card>
            </div>
          </div>
          <div className="min-w-0 flex-1">
            {selectedFile ? (
              <div>
                <h3 className="mb-2 truncate text-sm font-semibold">{selectedFile}</h3>
                <FileContent packId={pack.id} path={selectedFile} />
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-(--hairline) p-8 text-center">
                <p className="text-sm text-(--mute)">Select a file to view its contents.</p>
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default function SkillPacksPage() {
  const { data: packs, isLoading, refetch } = useSkillPackList();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showInstall, setShowInstall] = useState(false);

  const syncMutation = useSyncPack();
  const deleteMutation = useDeletePack();

  const list = useMemo(() => (packs ?? []).map((p) => p as unknown as PackEntry), [packs]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q),
    );
  }, [list, query]);

  // Auto-refetch while installing/syncing (in useEffect, not render body)
  const hasPending = list.some((p) => p.status === "installing" || p.status === "syncing");
  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(() => refetch(), 3000);
    return () => clearInterval(timer);
  }, [hasPending, refetch]);
  const selectedPack = list.find((p) => p.id === selectedId) ?? null;

  const ready = list.filter((p) => p.status === "ready").length;
  const gitSources = list.filter((p) => p.sourceKind === "git").length;
  const latest = list.reduce((max, p) => Math.max(max, p.createdAt), 0);

  return (
    <Page>
      <PageHeader
        breadcrumb="Team / Skill Packs"
        title="Skill Packs"
        subtitle="Install and manage skill packs for agents."
        actions={
          <Button onClick={() => setShowInstall(true)}>
            <Download className="size-4" />
            Install Pack
          </Button>
        }
      />
      <PageBody>
        <div className="space-y-6">
          <InfoBanner
            id="ib:skills-help"
            title="How this page works"
            body="Install a pack from git or a zip upload, then assign it per agent from the agent's Skills tab. Click a row to browse its skills and files."
          />

          <div data-testid="stat-cards" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Packs" value={list.length} />
            <StatCard label="Ready" value={ready} />
            <StatCard label="Git sources" value={gitSources} />
            <StatCard label="Latest activity" value={latest > 0 ? toDateString(latest) : "—"} />
          </div>

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
              <div className="space-y-2">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            ) : (
              <div className="space-y-2">
                {filtered.map((p) => {
                  const meta: string[] = [];
                  if (p.installedRef) meta.push(`@${p.installedRef.slice(0, 8)}`);
                  meta.push(toDateString(p.createdAt));
                  return (
                    <ListRowCard
                      key={p.id}
                      icon={<Package className="size-4 text-(--mute)" />}
                      title={p.name}
                      tag={{ label: p.sourceKind }}
                      badges={[statusLabel(p.status)]}
                      desc={p.error ?? p.description}
                      meta={meta}
                      onClick={() => setSelectedId(p.id)}
                      secondaryActions={
                        <>
                          {p.sourceKind === "git" && p.status === "ready" && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={syncMutation.isPending}
                              onClick={(e) => {
                                e.stopPropagation();
                                syncMutation.mutate(p.id);
                              }}
                            >
                              <RefreshCw
                                className={`size-3 ${syncMutation.isPending ? "animate-spin" : ""}`}
                              />
                              Sync
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedId(p.id);
                            }}
                          >
                            View
                          </Button>
                          {p.sourceKind !== "builtin" && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (confirm(`Delete pack "${p.name}"?`))
                                  deleteMutation.mutate(p.id);
                              }}
                            >
                              <Trash2 className="size-3" />
                              Delete
                            </Button>
                          )}
                        </>
                      }
                    />
                  );
                })}
                {filtered.length === 0 && (
                  <div data-testid="empty-state">
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

      <Sheet open={showInstall} onOpenChange={setShowInstall}>
        <SheetContent className="w-[500px] overflow-y-auto sm:max-w-[600px]">
          <SheetHeader>
            <SheetTitle>Install Skill Pack</SheetTitle>
          </SheetHeader>
          <InstallPackForm
            onDone={() => {
              setShowInstall(false);
              refetch();
            }}
          />
        </SheetContent>
      </Sheet>

      {selectedPack && <PackDrawer pack={selectedPack} onClose={() => setSelectedId(null)} />}
    </Page>
  );
}
