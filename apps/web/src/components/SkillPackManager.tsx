"use client";

import { Download, FolderSync, GitBranch, RefreshCw, Trash2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useDeletePack,
  useSkillPackFiles,
  useSkillPackList,
  useSkillPackSkills,
  useSyncPack,
} from "@/features/skill-packs/hooks";
import { InstallPackForm } from "./InstallPackForm";

type PackStatus = "pending" | "installing" | "ready" | "failed" | "syncing";

/** Skill summary as returned by GET /api/skill-packs/:id/skills. */
type SkillSummary = { name: string; description: string; dir: string };

/** Parent directory of a relative path ("" for top-level files). */
function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function statusVariant(status: PackStatus): "default" | "destructive" | "secondary" | "outline" {
  if (status === "ready") return "default";
  if (status === "failed") return "destructive";
  if (status === "installing" || status === "syncing") return "secondary";
  return "outline";
}

function statusLabel(status: PackStatus): string {
  if (status === "pending") return "Pending";
  if (status === "installing") return "Installing…";
  if (status === "syncing") return "Syncing…";
  if (status === "ready") return "Ready";
  if (status === "failed") return "Failed";
  return status;
}

function FileTree({
  packId,
  path,
  onSelectFile,
}: {
  packId: string;
  path: string;
  onSelectFile: (p: string) => void;
}) {
  const { data, isLoading } = useSkillPackFiles(packId, path || undefined);

  if (isLoading) return <Skeleton className="h-8 w-full" />;
  if (!data) return null;

  if (data.type === "file") {
    return (
      <button
        type="button"
        className="text-sm hover:text-primary text-left w-full py-1 px-2"
        onClick={() => onSelectFile(path)}
      >
        📄 {path.split("/").pop()}
      </button>
    );
  }
  // Error responses arrive as { error } without a type — render nothing
  // instead of crashing on a missing entries array.
  if (data.type !== "dir") return null;

  const entries = data.entries ?? [];
  return (
    <ul className="pl-2 space-y-0.5">
      {entries.map((e) => {
        const entryPath = path ? `${path}/${e.name}` : e.name;
        return (
          <li key={entryPath}>
            {e.type === "dir" ? (
              <details>
                <summary className="cursor-pointer text-sm hover:text-primary py-1">
                  📁 {e.name}
                </summary>
                <FileTree packId={packId} path={entryPath} onSelectFile={onSelectFile} />
              </details>
            ) : (
              <button
                className="text-sm hover:text-primary text-left w-full py-1 px-2"
                onClick={() => onSelectFile(entryPath)}
              >
                📄 {e.name}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const MonacoViewer = dynamic(
  () => import("@/components/MonacoViewer").then((m) => m.MonacoViewer),
  {
    ssr: false,
    loading: () => <Skeleton className="h-96 w-full" />,
  },
);

function FileContent({ packId, path }: { packId: string; path: string }) {
  const { data, isLoading } = useSkillPackFiles(packId, path);

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  if (data?.type !== "file") return null;

  return <MonacoViewer value={data.content ?? ""} path={data.path} />;
}

export function SkillPackManager() {
  // treaty can't derive skill-packs types due to Elysia intersection type limits
  const { data: packs, isLoading, refetch } = useSkillPackList();
  const [selectedPack, setSelectedPack] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<SkillSummary | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [showInstall, setShowInstall] = useState(false);

  const syncMutation = useSyncPack();
  const deleteMutation = useDeletePack();
  const { data: skills } = useSkillPackSkills(selectedPack ?? "");

  // Auto-refetch while installing/syncing (in useEffect, not render body)
  const hasPending = packs?.some((p) => p.status === "installing" || p.status === "syncing");
  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(() => refetch(), 3000);
    return () => clearInterval(timer);
  }, [hasPending, refetch]);

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <Button onClick={() => setShowInstall(true)}>
          <Download className="mr-2 size-4 " />
          Install Pack
        </Button>
      </div>

      <Sheet open={showInstall} onOpenChange={setShowInstall}>
        <SheetContent className="w-[500px] sm:max-w-[600px] overflow-y-auto">
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

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {packs?.map((pack) => {
            const p = pack as {
              id: string;
              name: string;
              description: string;
              sourceKind: string;
              sourceUrl?: string;
              status: PackStatus;
              installedRef?: string;
              error?: string;
              createdAt: number;
            };
            return (
              <Card
                key={p.id}
                className="cursor-pointer hover:shadow-md transition-shadow"
                onClick={() => setSelectedPack(p.id)}
              >
                <CardHeader>
                  <CardTitle className="flex justify-between items-start gap-2">
                    <span className="truncate">{p.name}</span>
                    <Badge variant={statusVariant(p.status)}>{statusLabel(p.status)}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground line-clamp-2">{p.description}</p>
                  <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                    {p.sourceKind === "git" ? (
                      <GitBranch className="size-3 " />
                    ) : p.sourceKind === "builtin" ? (
                      <FolderSync className="size-3 " />
                    ) : null}
                    <span>{p.sourceKind}</span>
                    {p.installedRef && (
                      <span className="font-mono">@{p.installedRef.slice(0, 8)}</span>
                    )}
                  </div>
                  {p.error && <p className="text-xs text-destructive mt-1">{p.error}</p>}
                </CardContent>
                <CardFooter className="gap-1">
                  {p.sourceKind === "git" && p.status === "ready" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        syncMutation.mutate(p.id);
                      }}
                      disabled={syncMutation.isPending}
                    >
                      <RefreshCw
                        className={`size-3  mr-1 ${syncMutation.isPending ? "animate-spin" : ""}`}
                      />
                      Sync
                    </Button>
                  )}
                  {p.sourceKind !== "builtin" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`Delete pack "${p.name}"?`)) deleteMutation.mutate(p.id);
                      }}
                    >
                      <Trash2 className="size-3 mr-1" />
                      Delete
                    </Button>
                  )}
                </CardFooter>
              </Card>
            );
          })}
        </div>
      )}

      {/* Drawer */}
      <Sheet
        open={!!selectedPack}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedPack(null);
            setSelectedSkill(null);
            setSelectedFile(null);
          }
        }}
      >
        <SheetContent className="w-[500px] sm:max-w-[600px] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>
              {packs?.find((p: { id: string }) => p.id === selectedPack)?.name ?? "Pack Details"}
            </SheetTitle>
          </SheetHeader>

          <div className="mt-4 flex flex-col md:flex-row gap-4">
            {/* Left pane: skills + pack files */}
            <div className="md:w-[240px] md:shrink-0 space-y-4">
              <details open className="group">
                <summary className="flex items-center justify-between text-sm font-semibold cursor-pointer select-none">
                  Skills
                  <span className="text-[10px] text-(--mute) group-open:hidden">expand</span>
                </summary>
                <div className="mt-2">
                  {skills ? (
                    <div className="space-y-1">
                      {skills.map((s: SkillSummary) => (
                        <Card
                          key={s.dir}
                          className={`cursor-pointer p-2.5 ${selectedSkill?.dir === s.dir ? "border-primary" : ""}`}
                          onClick={() => {
                            setSelectedSkill(s);
                            setSelectedFile(null);
                          }}
                        >
                          <div className="font-medium text-sm truncate">{s.name}</div>
                          <div className="text-xs text-muted-foreground line-clamp-2">
                            {s.description}
                          </div>
                        </Card>
                      ))}
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <Skeleton className="h-12 w-full" />
                      <Skeleton className="h-12 w-full" />
                    </div>
                  )}
                </div>
              </details>

              {/* Pack files — roots at the pack; selecting a skill jumps to its
                  directory (SKILL.md lives one level under the skill dir). */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold">
                    {selectedSkill ? selectedSkill.name : "Pack files"}
                  </h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-[10px]"
                    onClick={() => setSelectedSkill(null)}
                  >
                    All pack files
                  </Button>
                </div>
                <Card className="p-3">
                  <FileTree
                    packId={selectedPack!}
                    path={selectedSkill ? dirname(selectedSkill.dir) : ""}
                    onSelectFile={(p) => setSelectedFile(p)}
                  />
                </Card>
              </div>
            </div>

            {/* Right pane: viewer */}
            <div className="flex-1 min-w-0">
              {selectedFile && selectedPack ? (
                <div>
                  <h3 className="text-sm font-semibold mb-2 truncate">{selectedFile}</h3>
                  <FileContent packId={selectedPack} path={selectedFile} />
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
    </div>
  );
}
