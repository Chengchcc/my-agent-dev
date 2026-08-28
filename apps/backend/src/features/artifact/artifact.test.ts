import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactFsAdapter } from "./adapter-fs.js";
import { parseArtifactUrl, splitPath } from "./domain.js";
import { createArtifactService } from "./service.js";

test("parse artifact url and path safety", () => {
  expect(parseArtifactUrl("artifacts://report/2026/detail.md")).toEqual({
    folder: "report/2026",
    filename: "detail.md",
  });
  expect(() => splitPath("../evil/x.txt")).toThrow(/unsafe/);
  expect(() => splitPath("/abs/x.txt")).toThrow(/unsafe/);
  expect(() => splitPath("a/../../x.txt")).toThrow(/unsafe/);
});

test("upload and download utf8 + base64", async () => {
  const dir = mkdtempSync(join(tmpdir(), "art-"));
  const svc = createArtifactService(createArtifactFsAdapter(dir));
  const m = await svc.upload({
    folder: "report/2026",
    filename: "q.md",
    content: "# hi",
    source: { runId: "r1", conversationId: "c1", agentId: "a1" },
  });
  expect(m.url).toBe("artifacts://report/2026/q.md");
  const got = await svc.download(m.url);
  expect(got.content).toBe("# hi");
  expect(got.mimeType).toBe("text/markdown");
  expect(await svc.exists(m.url)).toBe(true);

  const bin = await svc.upload({
    folder: "img",
    filename: "p.png",
    content: Buffer.from([1, 2, 3]).toString("base64"),
    encoding: "base64",
  });
  const bg = await svc.download(bin.url);
  expect(bg.encoding).toBe("base64");
  expect(Buffer.from(bg.content, "base64")).toEqual(Buffer.from([1, 2, 3]));
});

test("list and delete", async () => {
  const dir = mkdtempSync(join(tmpdir(), "art-"));
  const svc = createArtifactService(createArtifactFsAdapter(dir));
  await svc.upload({ folder: "a", filename: "x.txt", content: "x" });
  await svc.upload({ folder: "a/b", filename: "y.json", content: "{}" });
  const all = await svc.list();
  expect(all.length).toBe(2);
  const a = await svc.list("a");
  expect(a.length).toBe(2);
  const ab = await svc.list("a/b");
  expect(ab.length).toBe(1);
  await svc.delete("artifacts://a/x.txt");
  expect(await svc.exists("artifacts://a/x.txt")).toBe(false);
});
