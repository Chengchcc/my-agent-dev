import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSkillIndex } from "@chengchenccc/tools-common";
import { createSkill } from "./skill.js";

function tmpDir(label: string): string {
  return `/tmp/oma-skill-${label}-${Math.random().toString(36).slice(2, 8)}`;
}

describe("skill", () => {
  test("buildSkillIndex later root overrides earlier root on name collision", async () => {
    const first = tmpDir("first");
    const second = tmpDir("second");
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    writeFileSync(join(first, "SKILL.md"), "---\nname: same\n---\n\nFIRST body");
    writeFileSync(join(second, "SKILL.md"), "---\nname: same\n---\n\nSECOND body");

    const entries = buildSkillIndex([first, second]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.root).toBe(realpathSync(second));

    const skill = createSkill({ roots: [first, second] });
    const tool = skill.tools?.find((t) => t.name === "skill_load");
    expect(tool).toBeDefined();
    const result = await tool!.execute({ name: "same" });
    if ("body" in result && typeof result.body === "string") {
      expect(result.body).toContain("SECOND body");
    }
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
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
    const skill = createSkill({ roots: [linkRoot] });
    const tool = skill.tools?.find((t) => t.name === "skill_load");
    const result = await tool!.execute({ name: "doc" });
    if ("body" in result && typeof result.body === "string") {
      expect(result.body).toContain("Read ");
      expect(result.body).toContain("notes.md");
    }
    rmSync(linkRoot, { recursive: true, force: true });
    rmSync(realDir, { recursive: true, force: true });
  });
});
