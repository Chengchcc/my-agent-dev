import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { NotFoundError, ValidationError } from "../../infra/domain-errors.js";
import type { KnowledgePackRow } from "./entities.js";
import { installKnowledgePack, knowledgeInstallRoot } from "./install.js";
import type { KnowledgePackPort } from "./ports.js";

export class KnowledgePackNotFoundError extends NotFoundError {
  constructor(id: string) {
    super("Knowledge pack", id);
  }
}

export class KnowledgeValidationError extends ValidationError {}

/** Knowledge pack install pool (ADR 0022). Per-agent switches live in
 *  agent.yml — this service owns the pool only. */
export interface KnowledgePackStats {
  packId: string;
  status: string;
  files: number;
  totalBytes: number;
  /** Rough token estimate (bytes/4) — an approximation, not a tokenizer. */
  estTokens: number;
  newestFileAt: number | null;
}

export interface KnowledgeService {
  list(): KnowledgePackRow[];
  stats(packId: string): KnowledgePackStats;
  allStats(): KnowledgePackStats[];
  getById(id: string): KnowledgePackRow | null;
  /** Read one pack file or list a directory, rooted at the pack's install
   *  dir. Mirrors the skill-pack files surface so knowledge packs can reuse
   *  the same read-only viewer + file tree. */
  files(
    packId: string,
    subpath?: string,
  ):
    | { type: "file"; path: string; content: string }
    | { type: "dir"; path: string; entries: Array<{ name: string; type: "dir" | "file" }> };
  /** Full-text search over the pack's files (subset: files ≤512k, ≤50 hits). */
  search(packId: string, q: string): Array<{ path: string; line: number; snippet: string }>;
  install(input: {
    name: string;
    description?: string;
    sourceKind: "builtin" | "git" | "zip";
    sourceUrl?: string;
    versionRef?: string;
  }): Promise<KnowledgePackRow>;
  delete(id: string): Promise<void>;
}

export function createKnowledgeService(deps: {
  port: KnowledgePackPort;
  dataDir: string;
  idGen: () => string;
  builtinRoot?: string;
  zipBuffer?: Buffer;
}): KnowledgeService {
  return {
    list(): KnowledgePackRow[] {
      return deps.port.list();
    },

    stats(packId: string): KnowledgePackStats {
      const row = deps.port.getById(packId);
      if (!row) throw new KnowledgePackNotFoundError(packId);
      let files = 0;
      let totalBytes = 0;
      let newestFileAt: number | null = null;
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(p);
            continue;
          }
          const st = statSync(p);
          files += 1;
          totalBytes += st.size;
          newestFileAt = newestFileAt == null ? st.mtimeMs : Math.max(newestFileAt, st.mtimeMs);
        }
      };
      try {
        walk(knowledgeInstallRoot(deps.dataDir, packId));
      } catch {
        /* materialized dir missing — zero stats */
      }
      return {
        packId,
        status: row.status,
        files,
        totalBytes,
        estTokens: Math.round(totalBytes / 4),
        newestFileAt,
      };
    },

    allStats(): KnowledgePackStats[] {
      return deps.port.list().map((row) => {
        try {
          return this.stats(row.id);
        } catch {
          return {
            packId: row.id,
            status: row.status,
            files: 0,
            totalBytes: 0,
            estTokens: 0,
            newestFileAt: null,
          };
        }
      });
    },

    getById(id: string): KnowledgePackRow | null {
      return deps.port.getById(id);
    },

    files(packId, subpath) {
      const row = deps.port.getById(packId);
      if (!row) throw new KnowledgePackNotFoundError(packId);
      const root = knowledgeInstallRoot(deps.dataDir, packId);
      // Traversal-safe: reject any path segment that isn't a plain name.
      const segments = (subpath ?? "").split("/").filter(Boolean);
      for (const seg of segments) {
        if (!/^[^/\\]+$/.test(seg) || seg === "..") {
          throw new KnowledgeValidationError("Invalid path segment");
        }
      }
      const target = resolve(root, ...segments);
      const rel = segments.join("/");
      if (!target.startsWith(resolve(root))) {
        throw new KnowledgeValidationError("Path escapes pack root");
      }
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(target);
      } catch {
        throw new KnowledgePackNotFoundError(packId);
      }
      if (st.isFile()) {
        return { type: "file", path: rel, content: readFileSync(target, "utf8") };
      }
      const names = readdirSync(target, { withFileTypes: true })
        .filter((d) => d.name !== ".git")
        .map((d) => ({
          name: d.name,
          type: d.isDirectory() ? ("dir" as const) : ("file" as const),
        }));
      return { type: "dir", path: rel, entries: names };
    },

    search(packId, q) {
      const row = deps.port.getById(packId);
      if (!row) throw new KnowledgePackNotFoundError(packId);
      const root = knowledgeInstallRoot(deps.dataDir, packId);
      const needle = q.toLowerCase();
      const results: Array<{ path: string; line: number; snippet: string }> = [];
      const walk = (dir: string, rel: string) => {
        if (results.length >= 50) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (results.length >= 50) return;
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
          const full = join(dir, entry.name);
          const relPath = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            walk(full, relPath);
          } else if (entry.isFile() && statSync(full).size <= 512_000) {
            const lines = readFileSync(full, "utf8").split("\n");
            for (let i = 0; i < lines.length && results.length < 50; i++) {
              const line = lines[i] ?? "";
              if (line.toLowerCase().includes(needle)) {
                results.push({
                  path: relPath,
                  line: i + 1,
                  snippet: line.trim().slice(0, 160),
                });
              }
            }
          }
        }
      };
      try {
        walk(root, "");
      } catch {
        /* materialized dir missing — no hits */
      }
      return results;
    },

    async install(input): Promise<KnowledgePackRow> {
      if (input.sourceKind !== "builtin" && !input.sourceUrl && !deps.zipBuffer) {
        throw new KnowledgeValidationError(
          "sourceUrl required for git packs; zip upload required for zip packs",
        );
      }
      const id = deps.idGen();
      return installKnowledgePack(deps, {
        id,
        name: input.name,
        description: input.description ?? "",
        sourceKind: input.sourceKind,
        sourceUrl: input.sourceUrl ?? null,
        versionRef: input.versionRef ?? null,
      });
    },

    async delete(id: string): Promise<void> {
      const existing = deps.port.getById(id);
      if (!existing) throw new KnowledgePackNotFoundError(id);
      deps.port.delete(id);
      rmSync(knowledgeInstallRoot(deps.dataDir, id), { recursive: true, force: true });
    },
  };
}
