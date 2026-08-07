"use client";

import { Download, FolderSync, GitBranch, RefreshCw, Trash2 } from "lucide-react";
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
    return <div className="text-sm text-muted-foreground py-1 px-2">{path.split("/").pop()}</div>;
  }
  // Error responses arrive as { error } without a type — render nothing
  // instead of crashing on a missing entries array.
  if (data.type !== "dir") return null;

  const entries = data.entries ?? [];
  return (
    <ul className="pl-2 space-y-0.5">
      {entries.map((e) => (
        <li key={e.name}>
          {e.type === "dir" ? (
            <details>
              <summary className="cursor-pointer text-sm hover:text-primary py-1">
                📁 {e.name}
              </summary>
              <FileTree
                packId={packId}
                path={path ? `${path}/${e.name}` : e.name}
                onSelectFile={onSelectFile}
              />
            </details>
          ) : (
            <button
              className="text-sm hover:text-primary text-left w-full py-1 px-2"
              onClick={() => onSelectFile(path ? `${path}/${e.name}` : e.name)}
            >
              📄 {e.name}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function FileContent({ packId, path }: { packId: string; path: string }) {
  const { data, isLoading } = useSkillPackFiles(packId, path);

  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (data?.type !== "file") return null;

  const content = (data as { content: string }).content;
  return (
    <pre className="bg-muted rounded-md p-3 text-xs overflow-auto max-h-96 whitespace-pre-wrap">
      {content}
    </pre>
  );
}

export function SkillPackManager() {
  // treaty can't derive skill-packs types due to Elysia intersection type limits
  const { data: packs, isLoading, refetch } = useSkillPackList();
  const [selectedPack, setSelectedPack] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
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
          <Download className="mr-2 h-4 w-4" />
          Install Pack
        </Button>
      </div>

      {showInstall && (
        <Card>
          <CardHeader>
            <CardTitle className="flex justify-between items-center">
              Install New Pack
              <Button variant="ghost" size="sm" onClick={() => setShowInstall(false)}>
                ✕
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <InstallPackForm
              onDone={() => {
                setShowInstall(false);
                refetch();
              }}
            />
          </CardContent>
        </Card>
      )}

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
                      <GitBranch className="h-3 w-3" />
                    ) : p.sourceKind === "builtin" ? (
                      <FolderSync className="h-3 w-3" />
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
                        className={`h-3 w-3 mr-1 ${syncMutation.isPending ? "animate-spin" : ""}`}
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
                      <Trash2 className="h-3 w-3 mr-1" />
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

          <div className="mt-4 space-y-4">
            {/* Skills list */}
            <div>
              <h3 className="text-sm font-semibold mb-2">Skills</h3>
              {skills ? (
                <div className="space-y-1">
                  {skills.map((s: { name: string; description: string; dir: string }) => (
                    <Card
                      key={s.name}
                      className={`cursor-pointer p-3 ${selectedSkill === s.name ? "border-primary" : ""}`}
                      onClick={() => {
                        setSelectedSkill(s.name);
                        setSelectedFile(null);
                      }}
                    >
                      <div className="font-medium text-sm">{s.name}</div>
                      <div className="text-xs text-muted-foreground">{s.description}</div>
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

            {/* File tree for selected skill */}
            {selectedSkill && (
              <div>
                <h3 className="text-sm font-semibold mb-2">Files</h3>
                <Card className="p-3">
                  <FileTree
                    packId={selectedPack!}
                    path={selectedSkill}
                    onSelectFile={(p) => setSelectedFile(p)}
                  />
                </Card>
              </div>
            )}

            {/* File content */}
            {selectedFile && selectedPack && (
              <div>
                <h3 className="text-sm font-semibold mb-2">{selectedFile}</h3>
                <FileContent packId={selectedPack} path={selectedFile} />
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
