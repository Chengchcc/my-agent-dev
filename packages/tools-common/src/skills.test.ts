import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSkillIndex } from "./skills.js";

function tmpDir(label: string): string {
  return `/tmp/tc-skill-${label}-${Math.random().toString(36).slice(2, 8)}`;
}

describe("tools-common skill index", () => {
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

  test("buildSkillIndex finds nested skills with full relative path", () => {
    const root = tmpDir("nested");
    mkdirSync(join(root, "loop-engine", "loop-generator"), { recursive: true });
    writeFileSync(
      join(root, "loop-engine", "loop-generator", "SKILL.md"),
      "---\nname: loop-generator\n---\n\nGenerate.",
    );
    const entries = buildSkillIndex([root]);
    expect(entries[0]?.relativePath).toBe("loop-engine/loop-generator/SKILL.md");
    rmSync(root, { recursive: true, force: true });
  });

  test("folded description is joined into one line", () => {
    const root = tmpDir("folded");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "SKILL.md"),
      "---\nname: folded-skill\ndescription: >\n  first line\n  second line\n---\n\nBody.",
    );
    const entries = buildSkillIndex([root]);
    expect(entries[0]?.description).toBe("first line second line");
    rmSync(root, { recursive: true, force: true });
  });
});
