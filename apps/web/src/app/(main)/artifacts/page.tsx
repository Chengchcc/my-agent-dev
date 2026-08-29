"use client";

import { useCallback, useEffect, useState } from "react";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type ArtifactMeta, api } from "@/lib/api";

export const dynamic = "force-dynamic";

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

export default function ArtifactsPage() {
  const [artifacts, setArtifacts] = useState<ArtifactMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<{ url: string; content: string; encoding: string } | null>(
    null,
  );
  const [folder, setFolder] = useState("");
  const [filename, setFilename] = useState("");
  const [content, setContent] = useState("");
  const [uploading, setUploading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.listArtifacts();
      setArtifacts(r.artifacts ?? []);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function openPreview(url: string) {
    try {
      const r = await api.downloadArtifact(url);
      setPreview({ url, content: r.content, encoding: r.encoding });
    } catch {
      alert(`下载失败: ${url}`);
    }
  }

  async function remove(url: string) {
    if (!confirm(`删除 ${url}?`)) return;
    await api.deleteArtifact(url);
    onRefresh();
  }
  function onRefresh() {
    void refresh();
  }

  async function upload() {
    if (!folder.trim() || !filename.trim() || !content) return;
    setUploading(true);
    try {
      await api.uploadArtifact({ folder: folder.trim(), filename: filename.trim(), content });
      setFolder("");
      setFilename("");
      setContent("");
      await refresh();
    } catch (err) {
      alert(`上传失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUploading(false);
    }
  }

  return (
    <Page>
      <PageHeader breadcrumb="Artifacts" title="Artifacts" description="agent 之间共享的产物存储" />
      <PageBody size="reading" className="space-y-6">
        <div className="rounded-xl border border-(--hairline) bg-(--panel)/70 p-4">
          <div className="mb-2 text-sm font-medium">上传产物</div>
          <div className="grid gap-2 sm:grid-cols-3">
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
              <Label className="text-[11px] text-(--mute)">filename</Label>
              <Input
                className="h-8"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                placeholder="quality.md"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-[11px] text-(--mute)">content</Label>
              <Input
                className="h-8"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="# report"
              />
            </div>
          </div>
          <Button className="mt-2" size="sm" onClick={upload} disabled={uploading}>
            {uploading ? "上传中…" : "上传"}
          </Button>
        </div>

        <div>
          <div className="mb-2 text-sm font-medium">已存产物 ({artifacts.length})</div>
          {loading ? (
            <div className="text-xs text-(--mute)">加载中…</div>
          ) : artifacts.length === 0 ? (
            <div className="text-xs text-(--mute)">暂无产物。</div>
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
                    删除
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {preview && (
          <div className="rounded-xl border border-(--hairline) bg-(--panel)/70 p-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium">
              <span className="truncate font-mono text-(--info)">{preview.url}</span>
              <button
                className="ml-auto text-(--mute) hover:text-(--ink)"
                onClick={() => setPreview(null)}
              >
                关闭
              </button>
            </div>
            {preview.encoding === "utf8" ? (
              <pre className="max-h-96 overflow-auto rounded bg-(--canvas)/60 p-2 text-[11px]">
                {preview.content}
              </pre>
            ) : (
              <div className="text-xs text-(--mute)">
                二进制产物，不支持文本预览 (base64 {preview.content.length} chars)
              </div>
            )}
          </div>
        )}
      </PageBody>
    </Page>
  );
}
