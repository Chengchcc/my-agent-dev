"use client";

import { Upload } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { ArtifactPreview } from "@/components/ArtifactPreview";
import { Page, PageBody, PageHeader } from "@/components/page";
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
        breadcrumb={[{ label: "Work", href: "/today" }, { label: "Artifacts" }]}
        title="Artifacts"
        description="Artifacts shared between agents"
        action={
          <Button size="sm" onClick={() => setUploadOpen(true)}>
            <Upload className="mr-1 size-3.5" />
            Upload
          </Button>
        }
      />
      <PageBody className="space-y-4">
        <div>
          <div className="mb-2 text-sm font-medium">Stored artifacts ({artifacts.length})</div>
          {loading ? (
            <div className="text-xs text-(--mute)">Loading…</div>
          ) : artifacts.length === 0 ? (
            <div className="text-xs text-(--mute)">
              No artifacts yet. Artifacts are produced by workflow runs —{" "}
              <Link href="/workflows" className="text-(--info) hover:underline">
                run a workflow
              </Link>{" "}
              to create one.
            </div>
          ) : (
            <div className="space-y-1">
              {artifacts.map((a) => (
                <div
                  key={a.url}
                  className="flex items-center gap-2 rounded-lg border border-(--hairline) px-3 py-2 text-xs"
                >
                  <button
                    className="min-w-0 flex-1 truncate text-left font-mono text-(--info) hover:underline"
                    onClick={() => openPreview(a.url)}
                  >
                    {a.url}
                  </button>
                  <span className="shrink-0 text-(--mute)">{fmtSize(a.size)}</span>
                  <span className="shrink-0 text-(--mute)">{a.mimeType}</span>
                  <button
                    className="shrink-0 text-(--err) hover:underline"
                    onClick={() => remove(a.url)}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}
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
