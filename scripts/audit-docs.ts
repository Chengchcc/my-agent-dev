/**
 * Docs audit — gateable checks against the code truth:
 *  - CLAUDE.md must be a symlink to AGENTS.md (no second copy to drift);
 *  - no references to deleted packages/files;
 *  - every path in the "Important Files" table must exist;
 *  - plugin list/count and schema table count must match the repo;
 *  - architecture/MANIFEST.md every entry must exist on disk (W4);
 *  - active-zone (architecture + prd) relative links must resolve; links
 *    inside `status: deprecated` tombstones and superpowers/ are exempt (W1);
 *  - active-zone narrative vocabulary must not teach deleted concepts
 *    (Generator/Evaluator roles, file-only state, "no DB tables"); the
 *    phrase list is maintained alongside ADR 0025 "delete-architecture"
 *    decisions (W7).
 */
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

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

// 6. W4: every file listed in architecture/MANIFEST.md must exist.
const manifestPath = join(ROOT, "docs/architecture/MANIFEST.md");
let manifestEntries = 0;
if (existsSync(manifestPath)) {
  const manifest = readFileSync(manifestPath, "utf8");
  for (const line of manifest.split("\n")) {
    const m = line.match(/^-\s+`([^`]+)`/);
    if (!m) continue;
    manifestEntries++;
    const p = m[1]!;
    const resolved = p.startsWith("docs/") ? join(ROOT, p) : join(ROOT, "docs/architecture", p);
    if (!existsSync(resolved)) fail(`MANIFEST entry missing on disk: ${p}`);
  }
}

// ── active-zone helpers (architecture + prd; adr is decision archive) ──
const ACTIVE_ROOTS = ["docs/architecture", "docs/prd"];
function walkDocs(dir: string): string[] {
  // Git does not track empty directories: a root like docs/prd disappears
  // from a fresh clone after its last file is moved away.
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkDocs(p));
    else if (p.endsWith(".md")) out.push(p);
  }
  return out;
}
/** Tombstone pages (`status: deprecated` in frontmatter) keep historical
 *  dead links and stale vocabulary by design — exempt both checks. */
function isTombstone(file: string): boolean {
  const head = readFileSync(file, "utf8").slice(0, 600);
  return /status:\s*deprecated/.test(head);
}

// 7. W1: active-zone relative links must resolve.
for (const root of ACTIVE_ROOTS) {
  for (const file of walkDocs(join(ROOT, root))) {
    if (isTombstone(file)) continue;
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const link = m[1]!;
      if (link.startsWith("http") || link.startsWith("#") || link.startsWith("mailto:")) continue;
      const target = normalize(join(dirname(file), link.split("#")[0]!.trim()));
      if (!existsSync(target)) {
        fail(`dead link in ${file.replace(`${ROOT}/`, "")}: ${m[1]}`);
      }
    }
  }
}

// 8. W7: active-zone must not teach deleted architecture concepts. Phrase
// list maintained alongside ADR 0025 ("delete generator/evaluator roles,
// DB is the state source"). Tombstones + adr/ are exempt (decision archive).
const STALE_NARRATIVES = [
  "Generator Agent",
  "Evaluator Agent",
  "Loop 不需要新数据库表",
  "状态在 STATE.md",
  "Generator -> Evaluator",
  "Generator → Evaluator",
  "generator/evaluator 两段",
] as const;
for (const root of ACTIVE_ROOTS) {
  for (const file of walkDocs(join(ROOT, root))) {
    if (isTombstone(file)) continue;
    const src = readFileSync(file, "utf8");
    for (const phrase of STALE_NARRATIVES) {
      if (src.includes(phrase)) {
        fail(`stale narrative "${phrase}" in ${file.replace(`${ROOT}/`, "")}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`audit:docs FAILED (${failures.length})`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `audit:docs OK (${pluginDirs.length} plugins, ${tables} tables, CLAUDE.md symlinked, ` +
    `${manifestEntries ?? 0} MANIFEST entries, active-zone links + vocabulary clean)`,
);
