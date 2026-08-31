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
/** Pages that keep stale content by design: tombstones (`status: deprecated`),
 *  direction archives (`status: future`, e.g. the roadmap page), and gate0
 *  point-in-time measurement records. Content checks (code-path existence,
 *  vocabulary) skip all three; link checks still run. */
function isExemptFromContent(file: string): boolean {
  const head = readFileSync(file, "utf8").slice(0, 600);
  return /status:\s*(deprecated|future)/.test(head) || file.includes("-gate0.md");
}

// 7. W1: active-zone relative links must resolve.
for (const root of ACTIVE_ROOTS) {
  for (const file of walkDocs(join(ROOT, root))) {
    if (isExemptFromContent(file)) continue;
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
  // Deleted/renamed modules that text phrases catch better than path tokens.
  // Trailing slashes keep "packages/agent" from matching "packages/agent-contract".
  "createAgentSession(",
  "ContextPipeline",
  "InterruptSignal",
  "fireLoop(",
  "loopStep(",
  "loopReducer",
  "packages/agent/",
  "packages/core/",
  "packages/loop/",
  "packages/tools-common/",
  "packages/conversation/",
  "packages/plugin-",
  "packages/agent-backend/",
  "cron/scheduler.ts",
  "providers/anthropic.ts",
  "providers/openai-compat.ts",
  "src/core/workspace-context.ts",
] as const;
for (const root of ACTIVE_ROOTS) {
  for (const file of walkDocs(join(ROOT, root))) {
    if (isExemptFromContent(file)) continue;
    const src = readFileSync(file, "utf8");
    for (const phrase of STALE_NARRATIVES) {
      if (src.includes(phrase)) {
        fail(`stale narrative "${phrase}" in ${file.replace(`${ROOT}/`, "")}`);
      }
    }
  }
}

// 11. W7 content check: repo-rooted code-path mentions in active-zone pages
// must exist. `packages/agent/src/...` teaches a deleted module even when
// every link resolves. Workspace/runtime files (`.oma/...`, `agentDir/...`)
// and bare relative names are NOT checked here — they are not repo paths;
// conceptual rot is covered by the STALE_NARRATIVES phrase list.
const CODE_FILE_TOKEN = /(?:packages|apps)\/[\w@.-]+(?:\/[\w@.-]+)*\.(?:ts|tsx|mjs|json)\b/g;
let codePathTokens = 0;
for (const root of ACTIVE_ROOTS) {
  for (const file of walkDocs(join(ROOT, root))) {
    if (isExemptFromContent(file)) continue;
    const src = readFileSync(file, "utf8");
    for (const raw of new Set(src.match(CODE_FILE_TOKEN) ?? [])) {
      codePathTokens++;
      if (!existsSync(join(ROOT, raw.replace(/[:),;]+$/, "")))) {
        fail(`dead code path "${raw}" in ${file.replace(`${ROOT}/`, "")}`);
      }
    }
  }
}

// 12. Obsidian-style graph check: active-zone pages with zero inbound links
// are orphans - invisible in the wiki graph, i.e. either dead concepts or
// missing wiring. Entry points (hub/index/map/MANIFEST) count as wired;
// archives (future/deprecated/gate0) are allowed to be unlinked.
const ENTRY_PAGES = new Set([
  "docs/architecture/README.md",
  "docs/architecture/index.llm.md",
  "docs/architecture/map.md",
  "docs/architecture/MANIFEST.md",
]);
const activeFiles: string[] = [];
for (const root of ACTIVE_ROOTS)
  for (const f of walkDocs(join(ROOT, root))) activeFiles.push(f.replace(`${ROOT}/`, ""));
const inlinked = new Set<string>();
for (const rel of activeFiles) {
  const abs = join(ROOT, rel);
  if (isExemptFromContent(abs)) continue;
  const src = readFileSync(abs, "utf8");
  for (const m of src.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const link = m[1]!;
    if (link.startsWith("http") || link.startsWith("#") || link.startsWith("mailto:")) continue;
    inlinked.add(normalize(join(dirname(abs), link.split("#")[0]!.trim())).replace(`${ROOT}/`, ""));
  }
  // Backticked relative paths are how index.llm.md wires the routing lists;
  // count them as inbound references too (agents navigate by them).
  for (const m of src.matchAll(/`([^`]+\.md)`/g)) {
    inlinked.add(normalize(join(dirname(abs), m[1]!.trim())).replace(`${ROOT}/`, ""));
  }
}
let orphans = 0;
for (const rel of activeFiles) {
  if (ENTRY_PAGES.has(rel) || isExemptFromContent(join(ROOT, rel))) continue;
  if (!inlinked.has(rel)) {
    orphans++;
    fail(`orphan page (no inbound links): ${rel}`);
  }
}

// 9. W3 (docs/insights.md I3): repo-rooted paths and @chengchenccc/<pkg>
// names in the agent must-read docs must exist on disk. Word-split scan
// (not backtick pairs — an unclosed fence swallows those); glob family
// references (packages/adapter-*) fail the strict token shape and are
// skipped. CONTEXT.md's Tombstones section intentionally names dead paths.
const PATH_TOKEN =
  /^(?:packages|apps|docs|skills|scripts|knowledge-packs)(?:\/[A-Za-z0-9._-]+)+\/?$/;
const PKG_TOKEN = /^@chengchenccc\/([a-z0-9-]+)$/;
const DOC_FILES = [
  "AGENTS.md",
  "README.md",
  "CONTEXT.md",
  "docs/insights.md",
  ...readdirSync(join(ROOT, "knowledge-packs/my-agent-team"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `knowledge-packs/my-agent-team/${f}`),
] as const;
let pathTokens = 0;
for (const rel of DOC_FILES) {
  let text = readFileSync(join(ROOT, rel), "utf8");
  if (rel === "CONTEXT.md") text = text.split("## Tombstones")[0] ?? text;
  const words = text.split(/[`\s|(),;:[\]"'"“”‘’（）：]+/).map((w) => w.replace(/[.,;。、]+$/, ""));
  const tokens = new Set(words.filter((w) => PATH_TOKEN.test(w) || PKG_TOKEN.test(w)));
  // README's repo-structure block lists bare dir names under an apps/ or
  // packages/ section header — resolve them against the active section.
  if (rel === "README.md") {
    const block = text.split("## 📦 仓库结构")[1]?.split(/\n## /)[0] ?? "";
    let section = "";
    for (const line of block.split("\n")) {
      const header = /^(apps|packages)\/$/.exec(line.trim());
      if (header) {
        section = `${header[1]}/`;
        continue;
      }
      const entry = section && /^ {2}([a-z0-9-]+)\/\s/.exec(line);
      if (entry?.[1]) tokens.add(`${section}${entry[1]}`);
    }
  }
  for (const token of tokens) {
    pathTokens++;
    const pkg = PKG_TOKEN.exec(token);
    const name = pkg?.[1];
    const ok = name
      ? existsSync(join(ROOT, "packages", name)) || existsSync(join(ROOT, "apps", name))
      : existsSync(join(ROOT, token));
    if (!ok) fail(`${rel} references missing path: ${token}`);
  }
}

// 10. W3: code fences must balance — an unclosed ``` swallows every
// following section on the rendered page (bit us in AGENTS.md 2026-08).
for (const rel of DOC_FILES) {
  const text = readFileSync(join(ROOT, rel), "utf8");
  const fences = (text.match(/^```/gm) ?? []).length;
  if (fences % 2 === 1) fail(`${rel} has ${fences} fence markers (unclosed code block)`);
}

if (failures.length > 0) {
  console.error(`audit:docs FAILED (${failures.length})`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `audit:docs OK (${pluginDirs.length} plugins, ${tables} tables, CLAUDE.md symlinked, ` +
    `${manifestEntries ?? 0} MANIFEST entries, active-zone links + vocabulary clean, ` +
    `${pathTokens} doc path tokens exist, ${codePathTokens} code paths exist, ` +
    `fences balanced, 0 orphan pages)`,
);
