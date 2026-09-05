"use client";

import { FileText, FolderOpen, HardDrive, Search, Trash2, Upload } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ArtifactPreview } from "@/components/ArtifactPreview";
import { CopyButton } from "@/components/ops/CopyButton";
import { Page, PageBody, PageHeader } from "@/components/page";
import { KpiTile, MonoLabel, StatusPill } from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useArtifacts, useDeleteArtifact, useUploadArtifact } from "@/features/artifacts/hooks";
import { api } from "@/lib/api";

export const dynamic = "force-dynamic";

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

export default function ArtifactsPage() {
  const [uploadOpen, setUploadOpen] = useState(false);
  const [preview, setPreview] = useState<{
    url: string;
    content: string;
    encoding: string;
    mimeType: string;
  } | null>(null);
  const [folder, setFolder] = useState("");
  const [filename, setFilename] = useState("");
  const [content, setContent] = useState("");
  const [encoding, setEncoding] = useState<"utf8" | "base64">("utf8");
  const { confirm, dialog: confirmDialog } = useConfirm();
  const { data: artifactsData, isLoading: loading } = useArtifacts();
  const artifacts = artifactsData?.artifacts ?? [];
  const uploadArtifact = useUploadArtifact();
  const deleteArtifact = useDeleteArtifact();
  const uploading = uploadArtifact.isPending;
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<"date" | "size" | "name">("date");
  const [folderFilter, setFolderFilter] = useState("all");

  const folders = useMemo(
    () => [...new Set(artifacts.map((a) => a.url.split("/")[1] ?? "").filter(Boolean))].sort(),
    [artifacts],
  );
  const totalBytes = artifacts.reduce((sum, a) => sum + a.size, 0);
  const visible = artifacts
    .filter((a) => {
      if (folderFilter !== "all" && !a.url.startsWith(`artifacts://${folderFilter}/`)) return false;
      if (query && !a.url.toLowerCase().includes(query.toLowerCase())) return false;
      return true;
    })
    .sort((a, b) => {
      if (sortBy === "size") return b.size - a.size;
      if (sortBy === "name") return a.url.localeCompare(b.url);
      return b.updatedAt - a.updatedAt;
    });

  async function openPreview(url: string) {
    try {
      const r = await api.downloadArtifact(url);
      setPreview({ url, content: r.content, encoding: r.encoding, mimeType: r.mimeType });
    } catch {
      toast.error(`Download failed: ${url}`);
    }
  }

  async function remove(url: string) {
    const ok = await confirm({
      title: `Delete ${url}?`,
      description: "This cannot be undone.",
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    await deleteArtifact.mutateAsync(url);
  }

  function pickFile(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result ?? "");
      const comma = raw.indexOf(",");
      setFilename(file.name);
      setContent(comma >= 0 ? raw.slice(comma + 1) : raw);
      setEncoding("base64");
    };
    reader.readAsDataURL(file);
  }

  async function upload() {
    if (!folder.trim() || !filename.trim() || !content) {
      toast.error("Please enter folder / filename and choose or type content");
      return;
    }
    try {
      await uploadArtifact.mutateAsync({
        folder: folder.trim(),
        filename: filename.trim(),
        content,
        encoding,
      });
      setFolder("");
      setFilename("");
      setContent("");
      setEncoding("utf8");
      setUploadOpen(false);
    } catch (err) {
      toast.error(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const urlPreview =
    folder.trim() && filename.trim() ? `artifacts://${folder.trim()}/${filename.trim()}` : "";

  return (
    <Page>
      <PageHeader
        breadcrumb="Work / Artifacts registry"
        title="Artifacts"
        pill={
          artifacts.length > 0 ? (
            <StatusPill tone="success">{artifacts.length} stored</StatusPill>
          ) : undefined
        }
        actions={
          <Button
            size="sm"
            className="bg-(--primary-soft) text-(--on-primary) hover:bg-(--primary)"
            onClick={() => setUploadOpen(true)}
          >
            <Upload className="mr-1 size-3.5" />
            Upload
          </Button>
        }
      />
      <PageBody size="wide" className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <KpiTile
            label="Total stored"
            value={artifacts.length}
            icon={FileText}
            detail="artifacts"
          />
          <KpiTile
            label="Storage"
            value={fmtSize(totalBytes)}
            icon={HardDrive}
            detail="across buckets"
          />
          <KpiTile
            label="Buckets"
            value={folders.length}
            icon={FolderOpen}
            detail={folders.slice(0, 2).join(" · ") || "none"}
          />
        </div>

        <div className="flex flex-col justify-between gap-2 rounded-lg border border-(--hairline) bg-(--panel) px-4 py-2.5 md:flex-row md:items-center">
          <div className="flex flex-wrap items-center gap-1.5">
            <MonoLabel className="mr-1">Bucket:</MonoLabel>
            {["all", ...folders].map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFolderFilter(f)}
                className={`rounded px-2 py-0.5 font-mono text-[11px] transition-colors ${
                  folderFilter === f
                    ? "bg-(--panel2) font-medium text-(--primary)"
                    : "bg-(--canvas-soft) text-(--mute) hover:text-(--ink)"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as "date" | "size" | "name")}
              className="rounded border border-(--hairline) bg-(--canvas-soft) px-2 py-1 font-mono text-[11px] text-(--mute)"
              aria-label="Sort artifacts"
            >
              <option value="date">Sort: newest</option>
              <option value="size">Sort: size</option>
              <option value="name">Sort: name</option>
            </select>
            <div className="flex items-center gap-2 rounded-sm border border-(--hairline) bg-(--canvas-soft) px-2 py-1 md:w-64">
              <Search className="size-3.5 text-(--faint)" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="filter by url…"
                className="w-full bg-transparent font-mono text-[11px] text-(--ink) placeholder:text-(--faint) focus:outline-none"
                aria-label="Filter artifacts by url"
              />
            </div>
          </div>
        </div>

        <div>
          <MonoLabel className="text-(--faint)">Stored artifacts ({visible.length})</MonoLabel>
          {loading ? (
            <div className="mt-3 text-xs text-(--mute)">Loading…</div>
          ) : artifacts.length === 0 ? (
            <div className="mt-3 text-xs text-(--mute)">
              No artifacts yet. Artifacts are produced by workflow runs —{" "}
              <Link href="/workflows" className="text-(--primary) hover:underline">
                run a workflow
              </Link>{" "}
              to create one.
            </div>
          ) : visible.length === 0 ? (
            <div className="mt-3 text-xs text-(--mute)">No artifacts match the filters.</div>
          ) : (
            <div className="mt-3 space-y-2">
              {visible.map((a) => {
                const segments = a.url.split("/");
                const filename = segments[segments.length - 1] ?? a.url;
                const bucket = segments[1] ?? "";
                const ext = filename.includes(".") ? filename.split(".").pop() : "bin";
                return (
                  <div
                    key={a.url}
                    className="flex items-center gap-3 rounded-lg border border-(--hairline) bg-(--panel) px-3 py-2.5 transition-colors hover:bg-(--canvas-soft)"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded bg-(--primary)/10 text-(--primary)">
                      <FileText className="size-4.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-(--ink)">
                          {filename}
                        </span>
                        <span className="shrink-0 rounded bg-(--canvas-soft) px-1.5 py-0.5 font-mono text-[10px] uppercase text-(--primary)">
                          {ext}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-(--mute)">
                        <span className="truncate">{a.url}</span>
                        <span className="shrink-0">· {bucket || "root"}</span>
                        <span className="shrink-0">· {a.mimeType}</span>
                        <span className="shrink-0 tabular-nums">· {fmtSize(a.size)}</span>
                        {a.source?.runId && (
                          <span className="shrink-0 text-(--accent-violet)">
                            · run {a.source.runId.slice(0, 8)}
                          </span>
                        )}
                        {a.source?.agentId && (
                          <span className="shrink-0">· {a.source.agentId}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button variant="outline" size="sm" onClick={() => openPreview(a.url)}>
                        Preview
                      </Button>
                      <CopyButton text={a.url} label="artifact URL" />
                      <button
                        className="rounded p-1.5 text-(--err) transition-colors hover:bg-(--err)/10"
                        aria-label={`Delete ${a.url}`}
                        onClick={() => remove(a.url)}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <p className="pt-1 text-right font-mono text-[10px] text-(--faint)">
            showing {visible.length} of {artifacts.length}
          </p>
        </div>
      </PageBody>

      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">Upload artifact</DialogTitle>
            <DialogDescription className="text-xs">
              Pick a file and choose a bucket folder. The full URL is shown below.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex flex-col gap-1">
              <Label className="text-[11px] text-(--mute)">folder</Label>
              <Input
                className="h-8"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                placeholder="report/2026"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-[11px] text-(--mute)">file</Label>
              <label className="flex h-8 cursor-pointer items-center gap-2 rounded-md border border-(--hairline) bg-(--panel) px-3 text-xs text-(--body) hover:bg-(--panel2)">
                <Upload className="size-3.5" />
                <span className="truncate">{filename || "Choose a file"}</span>
                <input
                  type="file"
                  className="hidden"
                  onChange={(e) => pickFile(e.target.files?.[0])}
                />
              </label>
            </div>
            {urlPreview && (
              <div className="text-[10px] text-(--mute)">
                URL: <span className="font-mono text-(--info)">{urlPreview}</span>
              </div>
            )}
            <Button className="w-full" size="sm" onClick={() => void upload()} disabled={uploading}>
              {uploading ? "Uploading…" : "Upload"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!preview} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="truncate font-mono text-[12px] text-(--info)">
              {preview?.url}
            </DialogTitle>
          </DialogHeader>
          {preview && (
            <ArtifactPreview
              mimeType={preview.mimeType}
              content={preview.content}
              encoding={preview.encoding === "base64" ? "base64" : "utf8"}
            />
          )}
        </DialogContent>
      </Dialog>

      {confirmDialog}
    </Page>
  );
}
