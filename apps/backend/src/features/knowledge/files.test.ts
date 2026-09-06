import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnowledgePackRow } from "./entities.js";
import type { KnowledgePackPort } from "./ports.js";
import { createKnowledgeService } from "./service.js";

function memoryPort(seed: KnowledgePackRow | null): KnowledgePackPort {
  const rows = new Map<string, KnowledgePackRow>();
  if (seed) rows.set(seed.id, { ...seed });
  return {
    create(row) {
      rows.set(row.id, { ...row });
      return { ...row };
    },
    list() {
      return [...rows.values()].map((r) => ({ ...r }));
    },
    getById(id) {
      const r = rows.get(id);
      return r ? { ...r } : null;
    },
    update(id, patch) {
      const cur = rows.get(id);
      if (!cur) return null;
      const next = { ...cur, ...patch };
      rows.set(id, next);
      return { ...next };
    },
    delete(id) {
      return rows.delete(id);
    },
  };
}

function readyRow(id: string, installedRef: string): KnowledgePackRow {
  return {
    id,
    name: "Pack",
    description: "",
    sourceKind: "builtin",
    sourceUrl: null,
    versionRef: null,
    sourceRev: null,
    installedRef,
    status: "ready",
    error: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("knowledge service files()", () => {
  test("lists a directory and reads a file at the pack root", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kp-files-"));
    const root = join(dataDir, "knowledge", "kp");
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "index.md"), "# Index");
    writeFileSync(join(root, "docs", "a.md"), "# A");
    const svc = createKnowledgeService({
      dataDir,
      port: memoryPort(readyRow("kp", root)),
      idGen: () => "id",
    });

    const dir = svc.files("kp");
    expect(dir.type).toBe("dir");
    const entries = (dir as { entries: Array<{ name: string; type: string }> }).entries;
    expect(entries).toContainEqual({ name: "docs", type: "dir" });
    expect(entries).toContainEqual({ name: "index.md", type: "file" });

    const file = svc.files("kp", "docs/a.md");
    expect(file).toEqual({ type: "file", path: "docs/a.md", content: "# A" });

    rmSync(dataDir, { recursive: true, force: true });
  });

  test("rejects path traversal outside the pack root", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kp-files-"));
    const root = join(dataDir, "knowledge", "kp");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(dataDir, "secret.txt"), "secret");
    const svc = createKnowledgeService({
      dataDir,
      port: memoryPort(readyRow("kp", root)),
      idGen: () => "id",
    });

    expect(() => svc.files("kp", "../secret.txt")).toThrow(/invalid path/i);
    expect(() => svc.files("kp", "..")).toThrow(/invalid path/i);
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("throws not-found for an unknown pack", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kp-files-"));
    const svc = createKnowledgeService({
      dataDir,
      port: memoryPort(null),
      idGen: () => "id",
    });
    expect(() => svc.files("nope")).toThrow(/not found/i);
    rmSync(dataDir, { recursive: true, force: true });
  });
});
