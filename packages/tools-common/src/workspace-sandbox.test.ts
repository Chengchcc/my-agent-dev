import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceEscapeError, WorkspaceSandbox } from "./workspace-sandbox.js";

const tmpRoot = `/tmp/sandbox-test-${Math.random().toString(36).slice(2, 8)}`;
const outsideFile = `/tmp/sandbox-outside-${Math.random().toString(36).slice(2, 8)}.txt`;

beforeAll(() => {
  mkdirSync(join(tmpRoot, "subdir"), { recursive: true });
  writeFileSync(join(tmpRoot, "inside.txt"), "hello");
  writeFileSync(join(tmpRoot, "subdir", "nested.txt"), "nested");
  writeFileSync(outsideFile, "secret");
  // Create symlink pointing outside
  try {
    symlinkSync(outsideFile, join(tmpRoot, "escape-link"));
  } catch {
    /* may not have permissions */
  }
});

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true });
  } catch {
    /* */
  }
  try {
    rmSync(outsideFile);
  } catch {
    /* */
  }
});

describe("WorkspaceSandbox", () => {
  test("accepts contained paths", () => {
    const sandbox = new WorkspaceSandbox(tmpRoot);
    expect(sandbox.validate("inside.txt")).toContain("inside.txt");
    expect(sandbox.validate("subdir/nested.txt")).toContain("nested.txt");
  });

  test("rejects parent traversal", () => {
    const sandbox = new WorkspaceSandbox(tmpRoot);
    expect(() => sandbox.validate("../../../etc/passwd")).toThrow(WorkspaceEscapeError);
    expect(() => sandbox.validate("../../outside")).toThrow(WorkspaceEscapeError);
  });

  test("rejects absolute paths outside root", () => {
    const sandbox = new WorkspaceSandbox(tmpRoot);
    expect(() => sandbox.validate(outsideFile)).toThrow(WorkspaceEscapeError);
    expect(() => sandbox.validate("/etc/passwd")).toThrow(WorkspaceEscapeError);
  });

  test("rejects prefix collision", () => {
    const sandbox = new WorkspaceSandbox(tmpRoot);
    // A directory named like tmpRoot + "-evil" should not match
    const evilPath = `${tmpRoot}-evil/secret`;
    expect(() => sandbox.validate(evilPath)).toThrow(WorkspaceEscapeError);
  });

  test("validateCwd accepts contained directory", () => {
    const sandbox = new WorkspaceSandbox(tmpRoot);
    expect(sandbox.validateCwd("subdir")).toContain("subdir");
  });

  test("validateCwd rejects outside directory", () => {
    const sandbox = new WorkspaceSandbox(tmpRoot);
    expect(() => sandbox.validateCwd("/tmp")).toThrow(WorkspaceEscapeError);
  });

  test("rejects symlink escape if symlink exists", () => {
    if (!existsSync(join(tmpRoot, "escape-link"))) return;
    const sandbox = new WorkspaceSandbox(tmpRoot);
    expect(() => sandbox.validate("escape-link")).toThrow(WorkspaceEscapeError);
  });
});
