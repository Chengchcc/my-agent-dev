/**
 * e2e-contract-rules.md §3 — executable contract audit.
 *
 * F1: the inline-query and raw-EventSource debt baselines are fully
 * digested, so those checks are now zero-tolerance hard rules. Remaining
 * baselines (lark casts, env bridges) stay tracked until their follow-ups.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** Inline query definitions must live in features/<x>/queries.ts — zero
 *  tolerance (F1 digested the previous 15-file baseline). */
const QUERY_FN_DEBT = new Set<string>();

/** Direct EventSource bypassing typedSource — zero tolerance (F1 wired the
 *  run events through the api-contract registry). */
const EVENT_SOURCE_DEBT = new Set<string>();

/** Known lark-bot bare casts. ingest.ts needs api-contract response schemas;
 *  bindings-sqlite.ts / render.ts are local type narrowings, not contract
 *  casts — kept here only because the §3 grep is intentionally crude. */
const LARK_CAST_DEBT = new Set([
  "apps/lark-bot/src/ingest.ts",
  "apps/lark-bot/src/bootstrap.ts",
  "apps/lark-bot/src/bindings-sqlite.ts",
  "apps/lark-bot/src/render.ts",
]);

/** Bare process.env readers that are deliberate bridges, not config parsing:
 *  config.ts is the shared parseEnv entry; oma-command.ts forwards provider
 *  keys to the child CLI (T2 env whitelist). */
const ENV_BRIDGE = new Set(["apps/backend/src/config.ts", "apps/backend/src/infra/oma-command.ts"]);

const failures: string[] = [];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p);
  }
  return out;
}

function checkFiles(
  root: string,
  allow: Set<string>,
  test: (src: string) => boolean,
  label: string,
) {
  for (const f of walk(join(ROOT, root))) {
    const rel = relative(ROOT, f);
    if (allow.has(rel) || rel.endsWith(".test.ts")) continue;
    if (test(readFileSync(f, "utf8"))) failures.push(`${label}: ${rel}`);
  }
}

// SSE only inside typedSource (one impl + tracked debt).
checkFiles(
  "apps/web/src",
  new Set(["apps/web/src/lib/typed-source.ts", ...EVENT_SOURCE_DEBT]),
  (src) => src.includes("new EventSource"),
  "new EventSource outside typedSource",
);

// No hand-rolled API casts in web.
checkFiles(
  "apps/web/src",
  new Set(),
  (src) => src.includes("apiFetch<") || src.includes("as AgentRow"),
  "hand-rolled API cast (apiFetch</as AgentRow)",
);

// No bare cross-process assertions in lark-bot (baseline debt).
checkFiles(
  "apps/lark-bot/src",
  LARK_CAST_DEBT,
  (src) => src.includes("as {") || src.includes("as Record<"),
  "bare cross-process assertion (as {/as Record<)",
);

// Env vars only via parseEnv/config.ts or the documented child-env bridge.
checkFiles(
  "apps/backend/src",
  ENV_BRIDGE,
  (src) => src.includes("process.env."),
  "bare process.env read (backend)",
);
checkFiles(
  "apps/web/src",
  new Set(),
  (src) => src.includes("process.env."),
  "bare process.env read (web)",
);
checkFiles(
  "apps/lark-bot/src",
  new Set(),
  (src) => src.includes("process.env."),
  "bare process.env read (lark-bot)",
);

// Inline query definitions belong in features/<x>/queries.ts (baseline debt).
const queryFnFiles = new Set<string>();
for (const root of ["apps/web/src/app", "apps/web/src/components"]) {
  for (const f of walk(join(ROOT, root))) {
    const rel = relative(ROOT, f);
    if (QUERY_FN_DEBT.has(rel)) continue;
    if (readFileSync(f, "utf8").includes("queryFn:")) queryFnFiles.add(rel);
  }
}
for (const rel of queryFnFiles)
  failures.push(`inline queryFn outside features/*/queries.ts: ${rel}`);

if (failures.length > 0) {
  console.error(`audit:contracts FAILED (${failures.length})`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    `audit:contracts FAILED — fix the violations above (queryFn/EventSource are zero-tolerance).`,
  );
  process.exit(1);
}
console.log(
  "audit:contracts OK (queryFn/EventSource zero-tolerance; lark casts + env bridges still tracked)",
);
