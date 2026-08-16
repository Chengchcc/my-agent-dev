import { describe, expect, test } from "bun:test";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteProjectAdapter } from "./adapter-sqlite.js";
import { createProjectService, ProjectNotFoundError, ValidationError } from "./service.js";

const db = openDb(":memory:");

const port = sqliteProjectAdapter(db);

let idCount = 0;
function testIdGen(): string {
  return `test-prj-${idCount++}`;
}

const svc = createProjectService({ port, idGen: testIdGen });

describe("ProjectService", () => {
  test("create project", () => {
    const p = svc.createProject({ name: "my-project" });
    expect(p.name).toBe("my-project");
    expect(p.projectId).toStartWith("test-prj-");
    expect(p.repoUrl).toBeNull();
    expect(p.defaultBranch).toBeNull();
    expect(p.createdAt).toBeGreaterThan(0);
  });

  test("create project with git metadata", () => {
    const p = svc.createProject({
      name: "with-git",
      repoUrl: "https://github.com/org/repo.git",
      defaultBranch: "main",
    });
    expect(p.repoUrl).toBe("https://github.com/org/repo.git");
    expect(p.defaultBranch).toBe("main");
  });

  test("create project with empty name throws", () => {
    expect(() => svc.createProject({ name: "" })).toThrow(ValidationError);
    expect(() => svc.createProject({ name: "  " })).toThrow(ValidationError);
  });

  test("duplicate name throws ValidationError", () => {
    const name = `dup-${Date.now()}`;
    svc.createProject({ name });
    expect(() => svc.createProject({ name })).toThrow(ValidationError);
  });

  test("getById returns project", () => {
    const created = svc.createProject({ name: `get-${Date.now()}` });
    const found = svc.getById(created.projectId);
    expect(found.projectId).toBe(created.projectId);
    expect(found.name).toBe(created.name);
  });

  test("getById throws ProjectNotFoundError for missing", () => {
    expect(() => svc.getById("nonexistent")).toThrow(ProjectNotFoundError);
  });

  test("list returns projects ordered by created_at DESC", async () => {
    const p1 = svc.createProject({ name: `list-1-${Date.now()}` });
    // Ensure distinct timestamps for deterministic ordering
    await new Promise((r) => setTimeout(r, 1));
    const p2 = svc.createProject({ name: `list-2-${Date.now()}` });
    const all = svc.list();
    const idx1 = all.findIndex((p) => p.projectId === p1.projectId);
    const idx2 = all.findIndex((p) => p.projectId === p2.projectId);
    expect(idx1).not.toBe(-1);
    expect(idx2).not.toBe(-1);
    // p2 created later — should appear before p1 in DESC order
    expect(idx2).toBeLessThan(idx1);
  });

  test("exists returns true/false", () => {
    const p = svc.createProject({ name: `exists-${Date.now()}` });
    expect(svc.exists(p.projectId)).toBe(true);
    expect(svc.exists("nonexistent")).toBe(false);
  });

  test("update changes fields", () => {
    const p = svc.createProject({ name: `update-${Date.now()}` });
    const updated = svc.update(p.projectId, { name: "renamed", defaultBranch: "develop" });
    expect(updated.name).toBe("renamed");
    expect(updated.defaultBranch).toBe("develop");
    // Verify persistence
    const reloaded = svc.getById(p.projectId);
    expect(reloaded.name).toBe("renamed");
  });

  test("update with empty name throws", () => {
    const p = svc.createProject({ name: `update-err-${Date.now()}` });
    expect(() => svc.update(p.projectId, { name: "" })).toThrow(ValidationError);
  });

  test("update non-existent throws ProjectNotFoundError", () => {
    expect(() => svc.update("nonexistent", { name: "x" })).toThrow(ProjectNotFoundError);
  });

  test("update to duplicate name throws ValidationError", () => {
    const p1 = svc.createProject({ name: `dup-update-1-${Date.now()}` });
    const p2 = svc.createProject({ name: `dup-update-2-${Date.now()}` });
    expect(() => svc.update(p2.projectId, { name: p1.name })).toThrow(ValidationError);
  });

  test("remove succeeds", async () => {
    const p = svc.createProject({ name: `remove-${Date.now()}` });
    await svc.remove(p.projectId);
    expect(svc.exists(p.projectId)).toBe(false);
  });

  test("remove throws ProjectNotFoundError for missing", async () => {
    await expect(svc.remove("nonexistent")).rejects.toThrow(ProjectNotFoundError);
  });

  test("port is exposed", () => {
    expect(svc.port).toBe(port);
  });
});
