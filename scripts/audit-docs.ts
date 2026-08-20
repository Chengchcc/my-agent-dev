/**
 * AGENTS.md single-source audit — gateable checks against the code truth:
 *  - CLAUDE.md must be a symlink to AGENTS.md (no second copy to drift);
 *  - no references to deleted packages/files;
 *  - every path in the "Important Files" table must exist;
 *  - plugin list/count and schema table count must match the repo.
 */
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const failures: string[] = [];
const fail = (msg: string) => failures.push(msg);

// 1. CLAUDE.md is a symlink to AGENTS.md.
try {
  const target = readlinkSync(join(ROOT, "CLAUDE.md"));
  if (target !== "AGENTS.md") fail(`CLAUDE.md symlinks to "${target}", expected "AGENTS.md"`);
} catch {
  fail("CLAUDE.md is not a symlink to AGENTS.md");
}

const agents = readFileSync(join(ROOT, "AGENTS.md"), "utf8");

// 2. No references to deleted paths.
for (const dead of ["packages/framework", "packages/core/src/run.ts", "features/span/"]) {
  if (agents.includes(dead)) fail(`AGENTS.md references deleted path: ${dead}`);
}

// 3. Important Files table paths exist.
const section = agents.split("## Important Files")[1]?.split(/\n## /)[0] ?? "";
for (const m of section.matchAll(/`([^`]+)`/g)) {
  const p = m[1]!;
  if (p.startsWith("apps/") || p.startsWith("packages/") || p.startsWith("docs/")) {
    if (!existsSync(join(ROOT, p))) fail(`AGENTS.md Important Files path missing: ${p}`);
  }
}

// 4. Plugin count and names match packages/plugin-*.
const pluginDirs = readdirSync(join(ROOT, "packages")).filter((n) => n.startsWith("plugin-"));
const pluginCount = agents.match(/(\d+) plugins?/);
if (!pluginCount || Number(pluginCount[1]) !== pluginDirs.length) {
  fail(
    `AGENTS.md says "${pluginCount?.[0] ?? "?"}", actual plugins: ${pluginDirs.length} (${pluginDirs.join(", ")})`,
  );
}
for (const ref of new Set(agents.matchAll(/plugin-[a-z-]+/g).map((m) => m[0]))) {
  if (!existsSync(join(ROOT, "packages", ref)))
    fail(`AGENTS.md references missing plugin package: ${ref}`);
}

// 5. Schema table count matches apps/backend/src/infra/db/schema.ts.
const schema = readFileSync(join(ROOT, "apps/backend/src/infra/db/schema.ts"), "utf8");
const tables = (schema.match(/sqliteTable\(/g) ?? []).length;
const tableClaim = agents.match(/(\d+) tables?/);
if (!tableClaim || Number(tableClaim[1]) !== tables) {
  fail(`AGENTS.md says "${tableClaim?.[0] ?? "?"}", actual tables: ${tables}`);
}

if (failures.length > 0) {
  console.error(`audit:docs FAILED (${failures.length})`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`audit:docs OK (${pluginDirs.length} plugins, ${tables} tables, CLAUDE.md symlinked)`);
