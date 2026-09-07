import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  type ArtifactMeta,
  type ArtifactRef,
  type ArtifactUploadInput,
  artifactUrl,
  parseArtifactUrl,
  splitPath,
} from "./domain.js";
import type { ArtifactPort } from "./ports.js";

function detectMime(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    md: "text/markdown",
    json: "application/json",
    txt: "text/plain",
    csv: "text/csv",
    html: "text/html",
    yml: "text/yaml",
    yaml: "text/yaml",
    js: "text/javascript",
    ts: "text/typescript",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    pdf: "application/pdf",
    zip: "application/zip",
    tar: "application/x-tar",
    gz: "application/gzip",
  };
  return map[ext] ?? "application/octet-stream";
}

export function createArtifactFsAdapter(root: string): ArtifactPort {
  const rootResolved = resolve(root);
  mkdirSync(rootResolved, { recursive: true });

  function safePath(folder: string, filename: string): string {
    const p = resolve(rootResolved, join(folder, filename));
    // Separator matters: without it, "../artifacts-evil" resolves to a
    // sibling whose name shares the prefix and passes a bare startsWith.
    if (p !== rootResolved && !p.startsWith(rootResolved + sep)) {
      throw new Error("artifact path escapes root");
    }
    return p;
  }

  function toMeta(
    ref: ArtifactRef,
    size: number,
    encoding: "utf8" | "base64",
    updatedAt: number,
    source?: ArtifactUploadInput["source"],
  ): ArtifactMeta {
    return {
      url: artifactUrl(ref),
      folder: ref.folder,
      filename: ref.filename,
      size,
      mimeType: detectMime(ref.filename),
      encoding,
      updatedAt,
      source,
    };
  }

  return {
    async put(input) {
      const [folder, filename] = splitPath(`${input.folder}/${input.filename}`);
      const p = safePath(folder, filename);
      mkdirSync(join(rootResolved, folder), { recursive: true });
      const enc = input.encoding === "base64" ? "base64" : "utf8";
      // Validate base64 before writing.
      if (enc === "base64") Buffer.from(input.content, "base64");
      writeFileSync(p, input.content, enc === "base64" ? "base64" : "utf8");
      writeFileSync(
        `${p}.meta.json`,
        JSON.stringify({ encoding: enc, source: input.source ?? null, updatedAt: Date.now() }),
      );
      const stat = statSync(p);
      return toMeta({ folder, filename }, stat.size, enc, Date.now(), input.source);
    },
    async get(ref) {
      const p = safePath(ref.folder, ref.filename);
      try {
        const buf = readFileSync(p);
        let encoding: "utf8" | "base64" = "utf8";
        try {
          const meta = JSON.parse(readFileSync(`${p}.meta.json`, "utf8")) as { encoding?: string };
          if (meta.encoding === "base64") encoding = "base64";
        } catch {
          encoding = isTextBuf(buf) ? "utf8" : "base64";
        }
        return {
          ...toMeta(ref, buf.length, encoding, statSync(p).mtimeMs, undefined),
          content: encoding === "utf8" ? buf.toString("utf8") : buf.toString("base64"),
        };
      } catch {
        return null;
      }
    },
    async list(folder) {
      const dir = folder ? join(rootResolved, folder) : rootResolved;
      const base = dir;
      if (folder && resolve(dir).startsWith(rootResolved) && resolve(dir) !== rootResolved) {
        if (!existsSyncSafe(base)) return [];
      }
      if (!existsSyncSafe(base)) return [];
      const out: ArtifactMeta[] = [];
      const walk = (d: string, prefix: string) => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
          if (entry.name.endsWith(".meta.json")) continue;
          const full = join(d, entry.name);
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(full, rel);
          else {
            const st = statSync(full);
            const [f, fn] = splitPath(rel);
            // Surface the recorded upload source (run/conversation/agent)
            // so consumers can filter by provenance.
            let source: ArtifactUploadInput["source"];
            try {
              const meta = JSON.parse(readFileSync(`${full}.meta.json`, "utf8")) as {
                source?: ArtifactUploadInput["source"];
              };
              source = meta.source ?? undefined;
            } catch {
              /* no sidecar — uploaded before provenance existed */
            }
            out.push(toMeta({ folder: f, filename: fn }, st.size, "utf8", st.mtimeMs, source));
          }
        }
      };
      walk(base, folder ?? "");
      return out;
    },
    async delete(url) {
      const ref = parseArtifactUrl(url);
      const p = safePath(ref.folder, ref.filename);
      try {
        rmSync(p, { force: true });
        return true;
      } catch {
        return false;
      }
    },
    async exists(url) {
      const ref = parseArtifactUrl(url);
      const p = safePath(ref.folder, ref.filename);
      return existsSyncSafe(p);
    },
  };
}

function existsSyncSafe(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function isTextBuf(buf: Buffer): boolean {
  // Heuristic: no null bytes in the first 8KB → treat as UTF-8 text.
  const sample = buf.subarray(0, 8192);
  return !sample.includes(0);
}
