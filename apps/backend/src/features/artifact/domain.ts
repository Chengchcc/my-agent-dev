/** Artifact domain model: single-file artifacts addressed by
 *  `artifacts://<folder>/<filename>` URLs, stored under backend dataDir. */

export interface ArtifactRef {
  folder: string;
  filename: string;
}

export interface ArtifactUploadInput {
  folder: string;
  filename: string;
  content: string;
  /** utf8 = text; base64 = binary. Default utf8. */
  encoding?: "utf8" | "base64";
  /** Optional run provenance (audit only; download is globally available). */
  source?: { runId?: string; conversationId?: string; agentId?: string };
}

export interface ArtifactMeta {
  url: string;
  folder: string;
  filename: string;
  size: number;
  mimeType: string;
  encoding: "utf8" | "base64";
  updatedAt: number;
  source?: ArtifactUploadInput["source"];
}

export interface ArtifactContent {
  content: string;
  encoding: "utf8" | "base64";
  mimeType: string;
  size: number;
}

/** Parse `artifacts://<folder>/<filename>` into a safe ref. Throws on
 *  malformed URLs / path escapes. */
export function parseArtifactUrl(url: string): ArtifactRef {
  const m = /^artifacts:\/\/([^?]+)$/.exec(url.trim());
  if (!m) throw new Error(`invalid artifact URL: ${url}`);
  const [folder, filename] = splitPath(m[1]!);
  return { folder, filename };
}

/** Split a `folder/filename` path, rejecting `../` / absolute / drive prefixes. */
export function splitPath(path: string): [string, string] {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`unsafe artifact path: ${path}`);
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error(`artifact path must be folder/filename: ${path}`);
  const filename = parts.pop()!;
  const folder = parts.join("/");
  for (const p of parts) {
    if (p === ".." || p === "." || p.startsWith("/") || /^[a-zA-Z]:/.test(p)) {
      throw new Error(`unsafe artifact folder segment: ${p}`);
    }
  }
  if (filename === ".." || filename === "." || filename.includes("/") || filename === "*") {
    throw new Error(`unsafe artifact filename: ${filename}`);
  }
  return [folder, filename];
}

export function artifactUrl(ref: ArtifactRef): string {
  return `artifacts://${ref.folder}/${ref.filename}`;
}
