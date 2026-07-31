import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSkillIndex, createProgressiveSkillPlugin } from "./progressive-skill.js";

function tmpDir(label: string): string {
  return `/tmp/skill-test-${label}-${Math.random().toString(36).slice(2, 8)}`;
}

describe("progressive skill index", () => {
  test("buildSkillIndex finds SKILL.md files with frontmatter", () => {
    const root = tmpDir("index");
    mkdirSync(join(root, "math"), { recursive: true });
    writeFileSync(join(root, "math", "SKILL.md"), "---\nname: math\n---\n\nDo math.");
    const entries = buildSkillIndex([root]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("math");
    expect(entries[0]?.relativePath).toBe("math/SKILL.md");
    rmSync(root, { recursive: true, force: true });
  });

  test("buildSkillIndex skips symlinked dirs escaping the root", () => {
    const root = tmpDir("escape");
    const outside = tmpDir("outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(join(outside, "secret"), { recursive: true });
    writeFileSync(join(outside, "secret", "SKILL.md"), "---\nname: secret-skill\n---\n\nHidden.");
    symlinkSync(outside, join(root, "link-out"));
    const entries = buildSkillIndex([root]);
    expect(entries).toHaveLength(0);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test("buildSkillIndex canonicalizes a symlinked root (macOS /tmp case)", () => {
    const realDir = tmpDir("real");
    const linkRoot = tmpDir("link");
    mkdirSync(join(realDir, "math"), { recursive: true });
    writeFileSync(join(realDir, "math", "SKILL.md"), "---\nname: math\n---\n\nDo math.");
    symlinkSync(realDir, linkRoot);
    const entries = buildSkillIndex([linkRoot]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("math");
    expect(entries[0]?.relativePath).toBe("math/SKILL.md");
    rmSync(linkRoot, { recursive: true, force: true });
    rmSync(realDir, { recursive: true, force: true });
  });

  test("skill_load works through a symlinked root", async () => {
    const realDir = tmpDir("real-load");
    const linkRoot = tmpDir("link-load");
    mkdirSync(join(realDir, "doc"), { recursive: true });
    writeFileSync(
      join(realDir, "doc", "SKILL.md"),
      "---\nname: doc\n---\n\nRead ${SKILL_DIR}/notes.md",
    );
    symlinkSync(realDir, linkRoot);
    const plugin = createProgressiveSkillPlugin({ roots: [linkRoot] });
    const tool = plugin.tools?.find((t) => t.name === "skill_load");
    const result = (await tool!.execute({ name: "doc" })) as { body: string };
    expect(result.body).toContain("Read ");
    expect(result.body).toContain("notes.md");
    rmSync(linkRoot, { recursive: true, force: true });
    rmSync(realDir, { recursive: true, force: true });
  });

  test("later root overrides earlier root on name collision", async () => {
    const first = tmpDir("first");
    const second = tmpDir("second");
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    writeFileSync(join(first, "SKILL.md"), "---\nname: same\n---\n\nFIRST body");
    writeFileSync(join(second, "SKILL.md"), "---\nname: same\n---\n\nSECOND body");

    // [first, second]: second (later) wins for name "same". Entries store the
    // canonical (realpath) root for containment; compare against realpath.
    const entries = buildSkillIndex([first, second]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.root).toBe(realpathSync(second));
    // skill_load serves the overriding body
    const plugin = createProgressiveSkillPlugin({ roots: [first, second] });
    const tool = plugin.tools?.find((t) => t.name === "skill_load");
    const result = (await tool!.execute({ name: "same" })) as { body: string };
    expect(result.body).toContain("SECOND body");

    // Reverse order: first (now later) wins
    const entriesRev = buildSkillIndex([second, first]);
    expect(entriesRev[0]?.root).toBe(realpathSync(first));
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  });
});
