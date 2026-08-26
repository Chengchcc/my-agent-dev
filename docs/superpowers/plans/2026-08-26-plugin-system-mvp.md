# oma Plugin System MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Installed oma plugins contribute code-backed tools/hooks (oma-native shapes), skills, and MCP servers, with a scope-based trust model and Claude/omp ecosystem manifest compatibility.

**Architecture:** Policy lives in the mode layer (`resolvePluginComponents` + `assemblePluginRuntime` in `core/plugins/`), loading is Bun-native dynamic `import()` with shape validation, the runtime (`assembleRunRuntime`) only mounts what it is handed. Trust = scope boundary: user-scope install-consent, project-scope code components require a content-hash record in `<agentDir>/trusted-plugins.json`, RPC mode never loads project-scope code.

**Tech Stack:** Bun 1.3, TypeScript (ESM/NodeNext), bun:test. All work in `apps/oh-my-agent` (no cross-package dist rebuilds needed).

**Spec:** `docs/superpowers/specs/2026-08-26-plugin-trust-model-design.md`

**MVP deviations from spec (both deliberate):**
- TUI trust ask-once is a `/plugin trust <name>` command + warning status instead of an auto-popup modal. Security property identical (project code never loads without explicit recorded consent); the modal is UX sugar on top of the same record.
- `permissionMode` enforcement is assembly-level (`deny` drops plugin code components with a warning), not loop-level — no native tool is affected, zero HITL dependency.

**Test conventions:** every test file uses `mkdtempSync` workspaces and overrides `process.env.OMA_CODING_AGENT_DIR` with a temp dir (pattern: `core/plugins/plugin-marketplace.test.ts`), always restoring in `finally`.

---

### Task 1: Tool result `content` contract in the loop

**Files:**
- Modify: `apps/oh-my-agent/src/core/runtime/agent-loop.ts` (~line 561)
- Test: `apps/oh-my-agent/src/core/runtime/agent-loop-content.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import type { AIMessageChunk } from "@chengchenccc/core";
import type { Message } from "@chengchenccc/message";
import { createInMemorySessionStore } from "../persistence/in-memory-session-store.js";
import { createOmaSession, type OmaSession } from "./agent-loop.js";

const LOOP_RUN = {
  runId: "r-content",
  model: { backendKind: "oma" as const, modelId: "fake/echo" },
  configRevision: 1,
};

function loopInput(text: string) {
  return {
    input: { inputId: `in-${text}`, message: { role: "user" as const, text } },
    run: LOOP_RUN,
    workspace: { root: "/tmp", access: "read_write" as const },
  };
}

describe("tool result content contract", () => {
  test("a result with string content becomes the tool_result text verbatim", async () => {
    const store = createInMemorySessionStore();
    const calls: string[] = [];
    const tool = {
      name: "fmt",
      description: "formatted tool",
      executionMode: "concurrent" as const,
      async execute(): Promise<Record<string, unknown>> {
        return { content: "SUMMARY ONLY", rows: [1, 2, 3] };
      },
    };
    const unused: string[] = []; void calls; void unused;
    let session: OmaSession;
    let turn = 0;
    session = createOmaSession({
      sessionId: "s-content",
      store,
      plugins: [{ name: "p", tools: [tool] }],
      maxSteps: 2,
      maxForceContinues: 0,
      summarize: async () => "sum",
      modelStream: async function* (): AsyncIterable<AIMessageChunk> {
        turn++;
        if (turn === 1) {
          yield { delta: { type: "tool_use", id: "tc-1", name: "fmt" } };
          yield { stopReason: "tool_use" };
        } else {
          yield { delta: { type: "text", text: "done" } };
        }
      },
    });
    await session.startLoop(loopInput("go") as never);
    const snap = await store.open("s-content");
    const toolMsg = snap.entries.find(
      (e) => (e as { type?: string }).type === "message" &&
        (e as { message?: Message }).message?.role === "tool",
    ) as unknown as { message: Message & { blocks: Array<{ type: string; content?: string }> } };
    const block = toolMsg.message.blocks.find((b) => b.type === "tool_result");
    expect(block?.content).toBe("SUMMARY ONLY");
  });

  test("a result without content stays a JSON dump", async () => {
    const store = createInMemorySessionStore();
    const tool = {
      name: "plain",
      description: "plain tool",
      executionMode: "concurrent" as const,
      async execute(): Promise<Record<string, unknown>> {
        return { rows: [1] };
      },
    };
    let turn = 0;
    const session = createOmaSession({
      sessionId: "s-plain",
      store,
      plugins: [{ name: "p", tools: [tool] }],
      maxSteps: 2,
      maxForceContinues: 0,
      summarize: async () => "sum",
      modelStream: async function* (): AsyncIterable<AIMessageChunk> {
        turn++;
        if (turn === 1) {
          yield { delta: { type: "tool_use", id: "tc-1", name: "plain" } };
          yield { stopReason: "tool_use" };
        } else {
          yield { delta: { type: "text", text: "done" } };
        }
      },
    });
    await session.startLoop(loopInput("go") as never);
    const snap = await store.open("s-plain");
    const toolMsg = snap.entries.find(
      (e) => (e as { type?: string }).type === "message" &&
        (e as { message?: Message }).message?.role === "tool",
    ) as unknown as { message: Message & { blocks: Array<{ type: string; content?: string }> } };
    const block = toolMsg.message.blocks.find((b) => b.type === "tool_result");
    expect(block?.content).toBe(JSON.stringify({ rows: [1] }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/oh-my-agent && bun test src/core/runtime/agent-loop-content.test.ts`
Expected: first test FAILS (`content` is the full JSON dump `{"content":"SUMMARY ONLY","rows":[1,2,3]}`), second PASSES.

- [ ] **Step 3: Implement — in `agent-loop.ts`, find the batch mapping (search `const raw = JSON.stringify(result.result);`) and replace that single line with:**

```typescript
                const res = result.result as { content?: unknown } | null | undefined;
                const raw =
                  typeof res?.content === "string" ? res.content : JSON.stringify(result.result);
```

(Keep everything around it — the `TOOL_FAILURE_REMINDER` prefix logic, `images` passthrough, `text: raw` — unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/oh-my-agent && bun test src/core/runtime/agent-loop-content.test.ts`
Expected: 2 PASS.

- [ ] **Step 5: Run the neighboring loop tests for regressions**

Run: `cd apps/oh-my-agent && bun test src/core/runtime/coding-agent-harness.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/oh-my-agent/src/core/runtime/agent-loop.ts apps/oh-my-agent/src/core/runtime/agent-loop-content.test.ts
git commit -m "feat(oh-my-agent): tool result content contract in loop"
```

---

### Task 2: Multi-source manifest + conflict matrix

**Files:**
- Modify: `apps/oh-my-agent/src/core/plugins/plugin-marketplace.ts` (`PluginManifest`, `loadPluginManifest`, `InstalledPlugin`, `listInstalledPlugins`)
- Test: `apps/oh-my-agent/src/core/plugins/plugin-manifest.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPluginManifest } from "./plugin-marketplace.js";

function ws(): string {
  return mkdtempSync(join(tmpdir(), "oma-manifest-"));
}

describe("multi-source plugin manifest", () => {
  test("oma plugin.json wins and reads tools/hooks entries", () => {
    const root = ws();
    try {
      writeFileSync(join(root, "plugin.json"), JSON.stringify({
        name: "mine", tools: "./tools.ts", hooks: "./hooks.ts",
      }));
      mkdirSync(join(root, ".claude-plugin"));
      writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({
        name: "claude-name", version: "9.9.9",
      }));
      const m = loadPluginManifest(root);
      expect(m?.name).toBe("mine");
      expect(m?.toolsEntry).toBe("./tools.ts");
      expect(m?.hooksEntry).toBe("./hooks.ts");
      // Claude manifest fills only what oma manifest lacks
      expect(m?.version).toBe("9.9.9");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("falls back to .claude-plugin/plugin.json (skills carrier)", () => {
    const root = ws();
    try {
      mkdirSync(join(root, ".claude-plugin"));
      writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({
        name: "claude-plugin", version: "1.0.0", skills: "./custom-skills",
      }));
      const m = loadPluginManifest(root);
      expect(m?.name).toBe("claude-plugin");
      expect(m?.skills).toBe("./custom-skills");
      expect(m?.toolsEntry).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("omp package.json pi/omp code fields are ignored with warnings", () => {
    const root = ws();
    try {
      writeFileSync(join(root, "package.json"), JSON.stringify({
        name: "omp-plugin", version: "2.0.0",
        omp: { tools: "./src/tools.ts", hooks: "./src/hooks.ts", features: {} },
      }));
      const m = loadPluginManifest(root);
      expect(m?.name).toBe("omp-plugin");
      expect(m?.toolsEntry).toBeUndefined();
      expect(m?.warnings).toContain("omp");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("claude inline hooks and commands fields are ignored with warnings", () => {
    const root = ws();
    try {
      mkdirSync(join(root, ".claude-plugin"));
      writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({
        name: "c", hooks: { PostToolUse: [] }, commands: ["./cmd"],
        agents: ["./a.md"],
      }));
      const m = loadPluginManifest(root);
      expect(m?.name).toBe("c");
      expect(m?.warnings.some((w) => w.includes("hooks"))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("no manifest anywhere returns null", () => {
    const root = ws();
    try {
      expect(loadPluginManifest(root)).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/oh-my-agent && bun test src/core/plugins/plugin-manifest.test.ts`
Expected: FAIL (`toolsEntry` does not exist on PluginManifest / warnings missing).

- [ ] **Step 3: Implement in `plugin-marketplace.ts`**

Replace the `PluginManifest` interface (lines 5-13) with:

```typescript
export interface PluginManifest {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  /** Relative directory containing SKILL.md bundles (default "skills"). */
  readonly skills?: string;
  /** Relative directory containing markdown slash commands (reserved). */
  readonly commands?: string;
  /** oma code entry: module exporting PluginTool[] (also accepts default export). */
  readonly toolsEntry?: string;
  /** oma code entry: module exporting PluginHooks (also accepts default export). */
  readonly hooksEntry?: string;
  /** Non-fatal conflict/compat notes surfaced to the user (spec conflict matrix). */
  readonly warnings: readonly string[];
}
```

Replace `loadPluginManifest` (lines 125-148) with:

```typescript
function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === "string" ? v : undefined;
}

/** Multi-source manifest read (spec: oma → Claude → omp) with conflict matrix. */
export function loadPluginManifest(pluginRoot: string): PluginManifest | null {
  const warnings: string[] = [];
  const oma = readJson(join(pluginRoot, "plugin.json"));
  const claude = readJson(join(pluginRoot, ".claude-plugin", "plugin.json"));
  const pkg = readJson(join(pluginRoot, "package.json"));
  const ompField = pkg ? (pkg.omp ?? pkg.pi) : undefined;
  const omp =
    typeof ompField === "object" && ompField !== null ? (ompField as Record<string, unknown>) : null;

  const primary = oma ?? claude ?? (pkg ? { name: str(pkg, "name") } : null);
  if (!primary || typeof primary.name !== "string") return null;

  if (oma && claude) {
    warnings.push("dual manifest: oma plugin.json wins; .claude-plugin/plugin.json fills missing metadata only");
  }
  if (omp) {
    if (typeof omp.tools === "string" || typeof omp.hooks === "string") {
      warnings.push("omp/pi manifest code entries (tools/hooks) are not executed by oma; provide oma plugin.json tools/hooks entries instead");
    }
  }
  const claudeInline = claude?.hooks;
  if (claudeInline !== undefined) {
    warnings.push("claude hooks config detected and ignored: hooks run through the oma hooks entry only");
  }
  if (claude?.commands !== undefined) warnings.push("claude commands/ component ignored");
  if (claude?.agents !== undefined) warnings.push("claude agents/ component ignored");

  const result: {
    name: string; version?: string; description?: string; skills?: string;
    toolsEntry?: string; hooksEntry?: string; warnings: string[];
  } = { name: primary.name, warnings };
  const fill = (src: Record<string, unknown> | null) => {
    if (!src) return;
    result.version ??= str(src, "version");
    result.description ??= str(src, "description");
    result.skills ??= str(src, "skills");
  };
  fill(oma); fill(claude); fill(pkg);
  // oma-only code entries — never sourced from omp/claude fields.
  if (oma) {
    const t = str(oma, "tools"); if (t) result.toolsEntry = t;
    const h = str(oma, "hooks"); if (h) result.hooksEntry = h;
  }
  return result;
}
```

In `listInstalledPlugins` (line ~227 `.map((p) => {...})`), extend the mapped object with the new manifest-derived fields:

```typescript
  return Array.from(byName.values()).map((p) => {
    const manifest = loadPluginManifest(p.root);
    return {
      ...p,
      description: manifest?.description,
      version: manifest?.version ?? p.version,
      skillsDir: manifest?.skills ? join(p.root, manifest.skills) : join(p.root, "skills"),
      toolsEntry: manifest?.toolsEntry,
      hooksEntry: manifest?.hooksEntry,
      hasMcpJson: existsSync(join(p.root, ".mcp.json")),
      manifestWarnings: manifest?.warnings ?? [],
    };
  });
```

And extend `InstalledPlugin` accordingly:

```typescript
export interface InstalledPlugin {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly sourceMarketplace: string;
  readonly scope: "user" | "project";
  readonly enabled: boolean;
  readonly root: string;
  readonly skillsDir?: string;
  readonly toolsEntry?: string;
  readonly hooksEntry?: string;
  readonly hasMcpJson?: boolean;
  readonly manifestWarnings: readonly string[];
}
```

Note: `installPlugin` (~line 252) calls `loadPluginManifest(sourceRoot)` and rejects on null — unchanged behavior. Its local variable named `pluginManifest` still typechecks.

- [ ] **Step 4: Run tests**

Run: `cd apps/oh-my-agent && bun test src/core/plugins/`
Expected: new manifest tests PASS, existing `plugin-marketplace.test.ts` PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/oh-my-agent/src/core/plugins/plugin-marketplace.ts apps/oh-my-agent/src/core/plugins/plugin-manifest.test.ts
git commit -m "feat(oh-my-agent): multi-source plugin manifest with conflict matrix"
```

---

### Task 3: Marketplace `.claude-plugin/marketplace.json` catalog fallback

**Files:**
- Modify: `apps/oh-my-agent/src/core/plugins/plugin-marketplace.ts` (`loadMarketplaceManifest`)
- Test: `apps/oh-my-agent/src/core/plugins/plugin-manifest.test.ts` (append)

- [ ] **Step 1: Append the failing test**

```typescript
import { listMarketplaces, addMarketplace } from "./plugin-marketplace.js";

describe("claude marketplace catalog fallback", () => {
  test("addMarketplace reads .claude-plugin/marketplace.json when no marketplace.json exists", () => {
    const workspace = mkdtempSync(join(tmpdir(), "oma-mkt-ws-"));
    const agent = mkdtempSync(join(tmpdir(), "oma-mkt-agent-"));
    const marketRoot = mkdtempSync(join(tmpdir(), "oma-mkt-src-"));
    process.env.OMA_CODING_AGENT_DIR = agent;
    try {
      mkdirSync(join(marketRoot, ".claude-plugin"), { recursive: true });
      mkdirSync(join(marketRoot, "demo"), { recursive: true });
      writeFileSync(join(marketRoot, "demo", "plugin.json"), JSON.stringify({ name: "demo" }));
      writeFileSync(join(marketRoot, ".claude-plugin", "marketplace.json"), JSON.stringify({
        name: "claude-market",
        plugins: [{ name: "demo", source: "./demo", description: "from claude catalog" }],
      }));
      const add = addMarketplace(workspace, marketRoot);
      expect(add.ok).toBe(true);
      expect(add.name).toBe("claude-market");
      const install = installPlugin(workspace, "claude-market/demo");
      expect(install.ok).toBe(true);
    } finally {
      delete process.env.OMA_CODING_AGENT_DIR;
      rmSync(workspace, { recursive: true, force: true });
      rmSync(agent, { recursive: true, force: true });
      rmSync(marketRoot, { recursive: true, force: true });
    }
  });
});
```

(Also add `installPlugin` to the import list at the top of the file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/oh-my-agent && bun test src/core/plugins/plugin-manifest.test.ts`
Expected: new test FAILS (`.claude-plugin/marketplace.json` not read → addMarketplace not ok).

- [ ] **Step 3: Implement — replace `loadMarketplaceManifest` (lines 104-123) with:**

```typescript
function parseMarketplaceCatalog(o: Record<string, unknown>): MarketplaceManifest | null {
  const name = typeof o.name === "string" ? o.name : null;
  const rawPlugins = Array.isArray(o.plugins) ? o.plugins : [];
  const plugins: MarketplacePluginEntry[] = [];
  for (const entry of rawPlugins) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const entryName = typeof e.name === "string" ? e.name : null;
    // oma catalogs use `path`; Claude catalogs use `source` (relative "./..." form).
    const pathLike =
      typeof e.path === "string" ? e.path :
      typeof e.source === "string" && e.source.startsWith("./") ? e.source.slice(1) : null;
    if (!entryName || !pathLike) continue;
    plugins.push({ name: entryName, path: pathLike });
  }
  if (!name || plugins.length === 0) return null;
  return { name, plugins };
}

export function loadMarketplaceManifest(root: string): MarketplaceManifest | null {
  for (const rel of ["marketplace.json", join(".claude-plugin", "marketplace.json")]) {
    const parsed = readJson(join(root, rel));
    if (!parsed) continue;
    const manifest = parseMarketplaceCatalog(parsed);
    if (manifest) return manifest;
  }
  return null;
}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/oh-my-agent && bun test src/core/plugins/`
Expected: all PASS (including original plugin-marketplace.test.ts).

- [ ] **Step 5: Commit**

```bash
git add apps/oh-my-agent/src/core/plugins/plugin-marketplace.ts apps/oh-my-agent/src/core/plugins/plugin-manifest.test.ts
git commit -m "feat(oh-my-agent): claude marketplace catalog fallback"
```

---

### Task 4: Plugin code loader (`plugin-code.ts`)

**Files:**
- Create: `apps/oh-my-agent/src/core/plugins/plugin-code.ts`
- Test: `apps/oh-my-agent/src/core/plugins/plugin-code.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPluginCode } from "./plugin-code.js";

function tmp(): string { return mkdtempSync(join(tmpdir(), "oma-code-")); }

describe("loadPluginCode", () => {
  test("loads a tools entry exporting PluginTool[] (named and default)", async () => {
    const root = tmp();
    try {
      writeFileSync(join(root, "tools.ts"), `
        export const tools = [{
          name: "hello", description: "says hello",
          async execute() { return { content: "hi" }; },
        }];
      `);
      const r = await loadPluginCode(root, "./tools.ts");
      expect(r.ok).toBe(true);
      expect(r.tools?.map((t) => t.name)).toEqual(["hello"]);

      writeFileSync(join(root, "tools-default.ts"), `
        export default [{ name: "bye", description: "d",
          async execute() { return {}; } }];
      `);
      const r2 = await loadPluginCode(root, "./tools-default.ts");
      expect(r2.tools?.[0]?.name).toBe("bye");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("loads a hooks entry exporting PluginHooks", async () => {
    const root = tmp();
    try {
      writeFileSync(join(root, "hooks.ts"), `
        export const hooks = { beforeRun() {}, afterTool() {} };
      `);
      const r = await loadPluginCode(root, "./hooks.ts");
      expect(r.ok).toBe(true);
      expect(Object.keys(r.hooks ?? {})).toEqual(["beforeRun", "afterTool"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("invalid exports fail soft with a reason, never throw", async () => {
    const root = tmp();
    try {
      writeFileSync(join(root, "bad.ts"), "export const tools = 42;");
      const r = await loadPluginCode(root, "./bad.ts");
      expect(r.ok).toBe(false);
      expect(r.error).toContain("tools");

      const missing = await loadPluginCode(root, "./nope.ts");
      expect(missing.ok).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("unknown hooks keys are dropped with a warning", async () => {
    const root = tmp();
    try {
      writeFileSync(join(root, "hooks2.ts"), `
        export const hooks = { beforeRun() {}, notAHook: 1 };
      `);
      const r = await loadPluginCode(root, "./hooks2.ts");
      expect(r.ok).toBe(true);
      expect(r.hooks && "beforeRun" in r.hooks).toBe(true);
      expect(r.hooks && "notAHook" in r.hooks).toBe(false);
      expect(r.warnings.join(" ")).toContain("notAHook");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/oh-my-agent && bun test src/core/plugins/plugin-code.test.ts`
Expected: FAIL (module `./plugin-code.js` not found).

- [ ] **Step 3: Implement `plugin-code.ts`**

```typescript
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginHooks, PluginTool } from "../runtime/plugin.js";

const KNOWN_HOOK_KEYS = new Set([
  "beforeRun", "afterRun", "beforeModel", "afterModel",
  "beforeTool", "afterTool", "transformToolArgs", "beforeStop", "afterStop",
]);

export interface PluginCodeResult {
  readonly ok: boolean;
  readonly tools?: readonly PluginTool[];
  readonly hooks?: PluginHooks;
  readonly warnings: readonly string[];
  readonly error?: string;
}

function isPluginToolLike(v: unknown): v is PluginTool {
  if (typeof v !== "object" || v === null) return false;
  const t = v as Record<string, unknown>;
  return typeof t.name === "string" && typeof t.description === "string" &&
    typeof t.execute === "function";
}

/** Load ONE code entry (tools or hooks) from an installed plugin root.
 *  Never throws: any failure degrades to {ok:false, error} (spec failure semantics). */
export async function loadPluginCode(root: string, entry: string): Promise<PluginCodeResult> {
  const file = join(root, entry);
  let mod: Record<string, unknown>;
  try {
    // Bun-native dynamic import: TS transpiles natively, no jiti (spec).
    // The import itself executes module top-level code — treat like omp's withHostGuard:
    // failures here are plugin bugs, not oma crashes.
    mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false, warnings: [],
      error: `failed to import ${entry}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const warnings: string[] = [];

  const toolsExport = mod.tools ?? (mod.default as unknown);
  if (toolsExport !== undefined) {
    if (!Array.isArray(toolsExport) || !toolsExport.every(isPluginToolLike)) {
      return { ok: false, warnings, error: `${entry}: tools export must be PluginTool[]` };
    }
    return { ok: true, tools: toolsExport, warnings };
  }

  const hooksExport = (mod.hooks ?? mod.default) as unknown;
  if (typeof hooksExport === "object" && hooksExport !== null) {
    const src = hooksExport as Record<string, unknown>;
    const hooks: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      if (KNOWN_HOOK_KEYS.has(k)) hooks[k] = v;
      else warnings.push(`${entry}: unknown hook key "${k}" ignored`);
    }
    return { ok: true, hooks: hooks as PluginHooks, warnings };
  }

  return { ok: false, warnings, error: `${entry}: no tools/hooks export found` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/oh-my-agent && bun test src/core/plugins/plugin-code.test.ts`
Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/oh-my-agent/src/core/plugins/plugin-code.ts apps/oh-my-agent/src/core/plugins/plugin-code.test.ts
git commit -m "feat(oh-my-agent): plugin code loader with shape validation"
```

---

### Task 5: Trust record (`plugin-trust.ts`)

**Files:**
- Create: `apps/oh-my-agent/src/core/plugins/plugin-trust.ts`
- Test: `apps/oh-my-agent/src/core/plugins/plugin-trust.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computePluginHash, readTrustedPlugins, trustPlugin, writeTrustedPlugins } from "./plugin-trust.js";

function setup(): { agent: string; pluginRoot: string } {
  const agent = mkdtempSync(join(tmpdir(), "oma-trust-agent-"));
  process.env.OMA_CODING_AGENT_DIR = agent;
  const pluginRoot = mkdtempSync(join(tmpdir(), "oma-trust-plugin-"));
  mkdirSync(join(pluginRoot, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(pluginRoot, "tools.ts"), "export const tools = [];");
  writeFileSync(join(pluginRoot, "node_modules", "dep", "x.js"), "x");
  return { agent, pluginRoot };
}

describe("plugin trust record", () => {
  test("hash covers files but skips node_modules; content change changes hash", () => {
    const { agent, pluginRoot } = setup();
    try {
      const h1 = computePluginHash(pluginRoot);
      expect(h1.startsWith("sha256:")).toBe(true);
      writeFileSync(join(pluginRoot, "node_modules", "dep", "y.js"), "y");
      expect(computePluginHash(pluginRoot)).toBe(h1);
      writeFileSync(join(pluginRoot, "extra.ts"), "x");
      expect(computePluginHash(pluginRoot)).not.toBe(h1);
    } finally {
      delete process.env.OMA_CODING_AGENT_DIR;
      rmSync(agent, { recursive: true, force: true });
      rmSync(pluginRoot, { recursive: true, force: true });
    }
  });

  test("trustPlugin writes a record; readTrustedPlugins returns it; corrupt file = empty", () => {
    const { agent, pluginRoot } = setup();
    try {
      expect(readTrustedPlugins().get(pluginRoot)).toBeUndefined();
      trustPlugin(pluginRoot);
      const rec = readTrustedPlugins().get(pluginRoot);
      expect(rec?.hash).toBe(computePluginHash(pluginRoot));
      expect(typeof rec?.trustedAt).toBe("string");

      writeTrustedPlugins("not json {{{");
      expect(readTrustedPlugins().size).toBe(0); // corrupt = treat all untrusted
    } finally {
      delete process.env.OMA_CODING_AGENT_DIR;
      rmSync(agent, { recursive: true, force: true });
      rmSync(pluginRoot, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/oh-my-agent && bun test src/core/plugins/plugin-trust.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `plugin-trust.ts`**

```typescript
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "../session/session-file.js";

export interface TrustRecord {
  readonly hash: string;
  readonly trustedAt: string;
}

export type TrustedPlugins = Map<string, TrustRecord>;

function trustedPath(): string {
  return join(agentDir(), "trusted-plugins.json");
}

/** Directory hash: recursive sha256 over sorted (relpath, fileHash) pairs,
 *  excluding node_modules (spec). */
export function computePluginHash(pluginRoot: string): string {
  const files: Array<{ rel: string; fileHash: string }> = [];
  const walk = (dir: string, prefix: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "node_modules") continue;
      const full = join(dir, ent.name);
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(full, rel);
      else if (ent.isFile()) {
        files.push({ rel, fileHash: createHash("sha256").update(readFileSync(full)).digest("hex") });
      }
    }
  };
  walk(pluginRoot, "");
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const aggregate = files.map((f) => `${f.rel}\0${f.fileHash}`).join("\n");
  return `sha256:${createHash("sha256").update(aggregate).digest("hex")}`;
}

/** Corrupt file = empty map (all untrusted) — never throws (spec failure semantics). */
export function readTrustedPlugins(): TrustedPlugins {
  try {
    const parsed = JSON.parse(readFileSync(trustedPath(), "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return new Map();
    const out: TrustedPlugins = new Map();
    for (const [root, rec] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof rec === "object" && rec !== null &&
        typeof (rec as Record<string, unknown>).hash === "string") {
        out.set(root, rec as TrustRecord);
      }
    }
    return out;
  } catch {
    return new Map();
  }
}

export function writeTrustedPlugins(map: TrustedPlugins): void {
  const obj: Record<string, TrustRecord> = {};
  for (const [root, rec] of map) obj[root] = rec;
  writeFileSync(trustedPath(), `${JSON.stringify(obj, null, 2)}\n`);
}

/** Record explicit user trust for a plugin root at its current hash. */
export function trustPlugin(pluginRoot: string): void {
  const map = readTrustedPlugins();
  map.set(pluginRoot, { hash: computePluginHash(pluginRoot), trustedAt: new Date().toISOString() });
  writeTrustedPlugins(map);
}

/** Trust decision for a plugin root: approved only when the recorded hash matches. */
export function isPluginTrusted(pluginRoot: string, trusted: TrustedPlugins): boolean {
  const rec = trusted.get(pluginRoot);
  return rec !== undefined && rec.hash === computePluginHash(pluginRoot);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/oh-my-agent && bun test src/core/plugins/plugin-trust.test.ts`
Expected: 2 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/oh-my-agent/src/core/plugins/plugin-trust.ts apps/oh-my-agent/src/core/plugins/plugin-trust.test.ts
git commit -m "feat(oh-my-agent): plugin trust record with directory hash"
```

---

### Task 6: `resolvePluginComponents` + `assemblePluginRuntime`

**Files:**
- Create: `apps/oh-my-agent/src/core/plugins/plugin-resolve.ts`
- Test: `apps/oh-my-agent/src/core/plugins/plugin-resolve.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPlugin, addMarketplace, setPluginEnabled } from "./plugin-marketplace.js";
import { resolvePluginComponents } from "./plugin-resolve.js";
import { trustPlugin } from "./plugin-trust.js";
import type { Plugin } from "../runtime/plugin.js";

function makePluginDir(marketRoot: string, name: string, withCode: boolean): string {
  const root = join(marketRoot, name);
  mkdirSync(join(root, "skills", name), { recursive: true });
  writeFileSync(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\nbody`);
  const manifest: Record<string, unknown> = { name, version: "1.0.0" };
  if (withCode) {
    manifest.tools = "./tools.ts";
    writeFileSync(join(root, "tools.ts"),
      `export const tools = [{ name: "${name}-tool", description: "d", async execute() { return {}; } }];`);
  }
  writeFileSync(join(root, "plugin.json"), JSON.stringify(manifest));
  writeFileSync(join(root, ".mcp.json"), JSON.stringify({
    mcpServers: { [`${name}-srv`]: { command: "echo", args: ["hi"] } },
  }));
  return root;
}

function setup(withCode = true): { workspace: string; agent: string; marketRoot: string } {
  const workspace = mkdtempSync(join(tmpdir(), "oma-res-ws-"));
  const agent = mkdtempSync(join(tmpdir(), "oma-res-agent-"));
  process.env.OMA_CODING_AGENT_DIR = agent;
  const marketRoot = join(workspace, "market");
  mkdirSync(marketRoot, { recursive: true });
  writeFileSync(join(marketRoot, "marketplace.json"),
    JSON.stringify({ name: "mkt", plugins: [{ name: "p-user", path: "p-user" }, { name: "p-proj", path: "p-proj" }] }));
  makePluginDir(marketRoot, "p-user", withCode);
  makePluginDir(marketRoot, "p-proj", withCode);
  return { workspace, agent, marketRoot };
}

describe("resolvePluginComponents scope x mode matrix", () => {
  test("user-scope code loads in every mode; project-scope needs trust (tui) or is rejected (rpc)", async () => {
    const { workspace, agent, marketRoot } = setup();
    try {
      expect(addMarketplace(workspace, marketRoot).ok).toBe(true);
      expect(installPlugin(workspace, "mkt/p-user", "user").ok).toBe(true);
      expect(installPlugin(workspace, "mkt/p-proj", "project").ok).toBe(true);

      // user: all modes approved
      for (const mode of ["tui", "print", "json", "rpc"] as const) {
        const r = resolvePluginComponents(workspace, mode);
        expect(r.codeEntries.map((c) => c.name)).toEqual(["p-user"]);
      }

      // project untrusted: tui warns, print/json skip with warning, rpc never
      const tui = resolvePluginComponents(workspace, "tui");
      expect(tui.codeEntries.map((c) => c.name)).toEqual(["p-user"]);
      expect(tui.warnings.join(" ")).toContain("/plugin trust");
      const rpc = resolvePluginComponents(workspace, "rpc");
      expect(rpc.codeEntries.map((c) => c.name)).toEqual(["p-user"]);
      expect(rpc.warnings.join(" ")).toContain("rpc"));

      // after trusting: tui/print/json approve; rpc STILL rejects project
      const projRoot = join(workspace, ".oma", "plugins", "p-proj");
      trustPlugin(projRoot);
      const tui2 = resolvePluginComponents(workspace, "tui");
      expect(tui2.codeEntries.map((c) => c.name).sort()).toEqual(["p-proj", "p-user"]);
      const rpc2 = resolvePluginComponents(workspace, "rpc");
      expect(rpc2.codeEntries.map((c) => c.name)).toEqual(["p-user"]);

      // mcp configs follow the same gates
      expect(tui2.mcpServers.map((m) => m.pluginName).sort()).toEqual(["p-proj", "p-user"]);
      expect(rpc2.mcpServers.map((m) => m.pluginName)).toEqual(["p-user"]);
    } finally {
      delete process.env.OMA_CODING_AGENT_DIR;
      rmSync(workspace, { recursive: true, force: true });
      rmSync(agent, { recursive: true, force: true });
    }
  });

  test("disabled plugins contribute nothing; assemblePluginRuntime loads code into Plugin objects", async () => {
    const { workspace, agent, marketRoot } = setup();
    try {
      expect(addMarketplace(workspace, marketRoot).ok).toBe(true);
      expect(installPlugin(workspace, "mkt/p-user", "user").ok).toBe(true);
      setPluginEnabled(workspace, "p-user", false);
      expect(resolvePluginComponents(workspace, "tui").codeEntries).toEqual([]);

      setPluginEnabled(workspace, "p-user", true);
      const assembled = await assemblePluginRuntime(workspace, "tui");
      const plugin: Plugin | undefined = assembled.plugins.find((p) => p.name === "plugin:p-user");
      expect(plugin?.tools?.map((t) => t.name)).toEqual(["p-user-tool"]);
    } finally {
      delete process.env.OMA_CODING_AGENT_DIR;
      rmSync(workspace, { recursive: true, force: true });
      rmSync(agent, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/oh-my-agent && bun test src/core/plugins/plugin-resolve.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `plugin-resolve.ts`**

```typescript
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "../runtime/plugin.js";
import { listInstalledPlugins } from "./plugin-marketplace.js";
import { loadPluginCode } from "./plugin-code.js";
import { isPluginTrusted, readTrustedPlugins } from "./plugin-trust.js";

export type OmaMode = "tui" | "print" | "json" | "rpc";

export interface CodeEntry {
  readonly name: string;
  readonly root: string;
  readonly toolsEntry?: string;
  readonly hooksEntry?: string;
}

/** A plugin's .mcp.json servers, gated identically to code entries. */
export interface PluginMcpConfig {
  readonly pluginName: string;
  readonly pluginRoot: string;
  readonly scope: "user" | "project";
  readonly servers: Record<string, unknown>;
}

export interface ResolvedComponents {
  readonly codeEntries: readonly CodeEntry[];
  readonly mcpServers: readonly PluginMcpConfig[];
  readonly warnings: readonly string[];
}

function readPluginMcp(root: string): Record<string, unknown> | null {
  const path = join(root, ".mcp.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, unknown> };
    return parsed.mcpServers ?? null;
  } catch {
    return null;
  }
}

/** Policy layer (spec): scope x mode trust matrix. Pure — no imports, no loading. */
export function resolvePluginComponents(workspaceRoot: string, mode: OmaMode): ResolvedComponents {
  const warnings: string[] = [];
  const trusted = readTrustedPlugins();
  const codeEntries: CodeEntry[] = [];
  const mcpServers: PluginMcpConfig[] = [];

  for (const p of listInstalledPlugins(workspaceRoot)) {
    if (!p.enabled) continue;
    warnings.push(...p.manifestWarnings.map((w) => `${p.name}: ${w}`));
    const hasCode = Boolean(p.toolsEntry || p.hooksEntry);
    const mcp = p.hasMcpJson ? readPluginMcp(p.root) : null;
    if (!hasCode && !mcp) continue;

    if (p.scope === "project") {
      if (mode === "rpc") {
        warnings.push(`${p.name}: project-scope code components never load in rpc mode`);
        continue;
      }
      if (!isPluginTrusted(p.root, trusted)) {
        warnings.push(
          `${p.name}: project-scope code components untrusted (hash mismatch or no record); run /plugin trust ${p.name} to approve`,
        );
        continue;
      }
    }
    if (hasCode) {
      codeEntries.push({
        name: p.name, root: p.root,
        ...(p.toolsEntry ? { toolsEntry: p.toolsEntry } : {}),
        ...(p.hooksEntry ? { hooksEntry: p.hooksEntry } : {}),
      });
    }
    if (mcp) {
      mcpServers.push({ pluginName: p.name, pluginRoot: p.root, scope: p.scope, servers: mcp });
    }
  }
  return { codeEntries, mcpServers, warnings };
}

export interface AssembledPluginRuntime {
  readonly plugins: readonly Plugin[];
  readonly mcpServers: readonly PluginMcpConfig[];
  readonly warnings: readonly string[];
}

/** Mode-layer entry: resolve policy + load approved code. The ONLY function modes call. */
export async function assemblePluginRuntime(
  workspaceRoot: string,
  mode: OmaMode,
): Promise<AssembledPluginRuntime> {
  const resolved = resolvePluginComponents(workspaceRoot, mode);
  const warnings = [...resolved.warnings];
  const plugins: Plugin[] = [];
  for (const entry of resolved.codeEntries) {
    let tools = [];
    let hooks: Record<string, unknown> | undefined;
    if (entry.toolsEntry) {
      const r = await loadPluginCode(entry.root, entry.toolsEntry);
      if (r.ok && r.tools) tools = [...r.tools];
      else warnings.push(`${entry.name}: ${r.error ?? "tools entry failed"}`);
      warnings.push(...r.warnings.map((w) => `${entry.name}: ${w}`));
    }
    if (entry.hooksEntry) {
      const r = await loadPluginCode(entry.root, entry.hooksEntry);
      if (r.ok && r.hooks) hooks = r.hooks as Record<string, unknown>;
      else warnings.push(`${entry.name}: ${r.error ?? "hooks entry failed"}`);
      warnings.push(...r.warnings.map((w) => `${entry.name}: ${w}`));
    }
    if (tools.length > 0 || hooks) {
      plugins.push({
        name: `plugin:${entry.name}`,
        ...(tools.length > 0 ? { tools } : {}),
        ...(hooks ? { hooks: hooks as Plugin["hooks"] } : {}),
      });
    }
  }
  return { plugins, mcpServers: resolved.mcpServers, warnings };
}
```

(Type note: `let tools = []` infers `never[]`; if tsc complains, declare `let tools: import("../runtime/plugin.js").PluginTool[] = [];`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/oh-my-agent && bun test src/core/plugins/plugin-resolve.test.ts`
Expected: 2 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/oh-my-agent/src/core/plugins/plugin-resolve.ts apps/oh-my-agent/src/core/plugins/plugin-resolve.test.ts
git commit -m "feat(oh-my-agent): plugin component resolution with scope-mode trust matrix"
```

---

### Task 7: mcp-mount multi-source merge + `${CLAUDE_PLUGIN_ROOT}`

**Files:**
- Modify: `apps/oh-my-agent/src/core/tools/mcp-mount.ts` (`mountWorkspaceMcpServers`, `loadMcpConfig` reuse, placeholder expansion)
- Test: `apps/oh-my-agent/src/core/tools/mcp-mount-plugins.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginMcpConfig } from "../plugins/plugin-resolve.js";
import { mergeMcpConfigs, substitutePluginVars } from "./mcp-mount.js";

describe("plugin mcp merge", () => {
  test("workspace wins on name conflicts; plugin order preserved otherwise", () => {
    const ws = mkdtempSync(join(tmpdir(), "oma-mcp-ws-"));
    try {
      writeFileSync(join(ws, ".mcp.json"), JSON.stringify({
        mcpServers: { shared: { command: "workspace-bin" }, wsOnly: { command: "a" } },
      }));
      const plugins: PluginMcpConfig[] = [
        { pluginName: "p1", pluginRoot: "/x/p1", scope: "user",
          servers: { shared: { command: "plugin-bin" }, p1Only: { command: "b" } } },
        { pluginName: "p2", pluginRoot: "/x/p2", scope: "project",
          servers: { p2Only: { command: "c" } } },
      ];
      const merged = mergeMcpConfigs(ws, plugins);
      expect(Object.keys(merged).sort()).toEqual(["p1Only", "p2Only", "shared", "wsOnly"]);
      expect((merged.shared as { command: string }).command).toBe("workspace-bin");
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  test("CLAUDE_PLUGIN_ROOT and CLAUDE_PROJECT_DIR substitute into command/args/env", () => {
    const out = substitutePluginVars(
      { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/s.js"], env: { D: "${CLAUDE_PROJECT_DIR}" } },
      { pluginRoot: "/x/p1", workspaceRoot: "/w" },
    ) as { command: string; args: string[]; env: Record<string, string> };
    expect(out.args[0]).toBe("/x/p1/s.js");
    expect(out.env.D).toBe("/w");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/oh-my-agent && bun test src/core/tools/mcp-mount-plugins.test.ts`
Expected: FAIL (exports not found).

- [ ] **Step 3: Implement — add to `mcp-mount.ts` (keep everything else unchanged):**

```typescript
/** Expand ${CLAUDE_PLUGIN_ROOT}/${CLAUDE_PROJECT_DIR} in a server config
 *  (spec: Claude plugin .mcp.json compatibility). */
export function substitutePluginVars(
  server: McpJsonServer,
  ctx: { pluginRoot: string; workspaceRoot: string },
): McpJsonServer {
  const sub = (s: string): string =>
    s.replaceAll("${CLAUDE_PLUGIN_ROOT}", ctx.pluginRoot)
      .replaceAll("${CLAUDE_PROJECT_DIR}", ctx.workspaceRoot);
  const out: McpJsonServer = { ...server };
  if (server.command) out.command = sub(server.command);
  if (server.args) out.args = server.args.map(sub);
  if (server.env) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(server.env)) env[k] = sub(String(v));
    env.CLAUDE_PLUGIN_ROOT = ctx.pluginRoot;
    env.CLAUDE_PROJECT_DIR = ctx.workspaceRoot;
    out.env = env;
  }
  if (server.headers) {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(server.headers)) headers[k] = sub(String(v));
    out.headers = headers;
  }
  return out;
}

export function mergeMcpConfigs(
  workspaceRoot: string,
  plugins: readonly import("../plugins/plugin-resolve.js").PluginMcpConfig[],
): Record<string, McpJsonServer> {
  const merged: Record<string, McpJsonServer> = loadMcpConfig(workspaceRoot); // workspace wins
  for (const p of plugins) {
    for (const [name, raw] of Object.entries(p.servers)) {
      if (name in merged) continue; // spec: workspace > plugin; plugin order otherwise
      if (typeof raw !== "object" || raw === null) continue;
      merged[name] = substitutePluginVars(raw as McpJsonServer, {
        pluginRoot: p.pluginRoot, workspaceRoot,
      });
    }
  }
  return merged;
}
```

Then change `mountWorkspaceMcpServers` to accept extra plugin sources and use the merged table. Replace its first two lines:

```typescript
export async function mountWorkspaceMcpServers(
  workspaceRoot: string,
  nativeNames: ReadonlySet<string>,
  pluginServers: readonly import("../plugins/plugin-resolve.js").PluginMcpConfig[] = [],
): Promise<MountedMcpServers> {
  const servers = mergeMcpConfigs(workspaceRoot, pluginServers);
```

(the rest of the function body is unchanged — it iterates `servers`).

- [ ] **Step 4: Run tests**

Run: `cd apps/oh-my-agent && bun test src/core/tools/mcp-mount-plugins.test.ts src/core/tools/mcp-mount.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/oh-my-agent/src/core/tools/mcp-mount.ts apps/oh-my-agent/src/core/tools/mcp-mount-plugins.test.ts
git commit -m "feat(oh-my-agent): plugin mcp config merge with claude plugin root vars"
```

---

### Task 8: Runtime wiring — `assembleRunRuntime` + `permissionMode` deny

**Files:**
- Modify: `apps/oh-my-agent/src/core/runtime/run-runtime.ts` (deps + merge + permissionMode)
- Modify: `apps/oh-my-agent/src/core/runtime/create-runtime.ts` (options pass-through)
- Test: `apps/oh-my-agent/src/core/runtime/create-runtime.test.ts` (append)

- [ ] **Step 1: Append the failing test**

```typescript
test("plugin code tools load into the Run tool table; permissionMode deny drops them", async () => {
  const pluginRoot = join(tmp, "plug");
  mkdirSync(join(pluginRoot, "skills", "s"), { recursive: true });
  writeFileSync(join(pluginRoot, "skills", "s", "SKILL.md"), "---\nname: s\n---\nb");
  writeFileSync(join(pluginRoot, "plugin.json"), JSON.stringify({ name: "plug" }));
  writeFileSync(join(pluginRoot, "tools.ts"), `
    export const tools = [{ name: "plug-hello", description: "plugin tool",
      executionMode: "concurrent",
      async execute() { return { content: "hello from plugin" }; } }];
  `);
  const record: Message[][] = [];
  const mk = async (permissionMode?: "ask" | "auto" | "deny") => {
    return await createOmaRuntime({
      runId: `r-plug-${permissionMode ?? "none"}`,
      modelId: "fake/echo",
      workspaceRoot: tmp,
      workspaceAccess: "read_write",
      modelRuntime: makeModelRuntime(record),
      skillRoots: [],
      pluginComponents: {
        plugins: [{
          name: "plugin:plug",
          tools: [{
            name: "plug-hello", description: "plugin tool", executionMode: "concurrent",
            async execute() { return { content: "hello from plugin" }; },
          }],
        }],
      },
      ...(permissionMode ? { permissionMode } : {}),
    });
  };
  const rt = await mk(undefined);
  const seg = await rt.run(runInput("r-plug-none"));
  const { outcome, events } = await settle(seg);
  await rt.close();
  expect(outcome.status).toBe("completed");
  expect(events.some((e) => e.type === "tool_execution_start" && (e as { toolName?: string }).toolName === "plug-hello")).toBe(true);

  const denied = await mk("deny");
  const seg2 = await denied.run(runInput("r-plug-deny"));
  const out2 = await seg2.outcome;
  await denied.close();
  expect(out2.status).toBe("completed"); // deny drops plugin tools; Run itself is fine
});
```

Add `pluginComponents` usage imports if the test file needs them (none — plain objects). Reuse the file's existing `makeModelRuntime`, `settle`, `runInput`, `tmp` fixtures (they exist at top of `create-runtime.test.ts`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/oh-my-agent && bun test src/core/runtime/create-runtime.test.ts`
Expected: FAIL (`pluginComponents`/`permissionMode` not accepted in options).

- [ ] **Step 3: Implement**

In `run-runtime.ts` `RunRuntimeDeps`, add:

```typescript
  /** Loaded plugin code components (mode layer already applied trust policy).
   *  runtime only mounts. */
  codePlugins?: readonly Plugin[];
  /** Plugin .mcp.json configs (already trust-approved by the mode layer). */
  pluginMcpServers?: readonly import("../plugins/plugin-resolve.js").PluginMcpConfig[];
  /** Frozen Run permissionMode (ADR 0020 decision 7). "deny" drops plugin
   *  code components at assembly; native tools unaffected (MVP scope). */
  permissionMode?: "ask" | "auto" | "deny";
```

In `assembleRunRuntime` (the `mountWorkspaceMcpServers` call site — search `mountWorkspaceMcpServers(`), pass the extra arg:

```typescript
  const mounted = await mountWorkspaceMcpServers(
    deps.workspaceRoot,
    new Set(nativeTools.map((t) => t.name)),
    deps.pluginMcpServers ?? [],
  );
```

(Adapt to the actual existing call signature — keep the existing nativeNames argument, append the third.)

Then, at the `const plugins: Plugin[] = [nativeToolsPlugin, createSkill({ roots: deps.skillRoots })];` line (search `const plugins: Plugin[]`), append after it:

```typescript
  if (deps.codePlugins?.length) {
    if (deps.permissionMode === "deny") {
      // MVP permission enforcement: deny = no plugin code components at all.
      // Native tools are unaffected; the Run proceeds without them.
    } else {
      const nativeNames = new Set(plugins.flatMap((p) => (p.tools ?? []).map((t) => t.name)));
      for (const cp of deps.codePlugins) {
        const tools = (cp.tools ?? []).filter((t) => {
          if (!nativeNames.has(t.name)) return true;
          return false; // native wins (spec conflict matrix)
        });
        plugins.push({ name: cp.name, ...(cp.hooks ? { hooks: cp.hooks } : {}), ...(tools.length ? { tools } : {}) });
      }
    }
  }
```

In `create-runtime.ts` `CreateOmaRuntimeOptions`, add:

```typescript
  /** Assembled plugin code components (from assemblePluginRuntime). */
  pluginComponents?: { plugins: import("./plugin.js").Plugin[]; mcpServers?: import("../plugins/plugin-resolve.js").PluginMcpConfig[] };
  /** Frozen Run permissionMode; "deny" drops plugin code components. */
  permissionMode?: "ask" | "auto" | "deny";
```

and forward them inside `createOmaRuntime`'s `assembleRunRuntime({...})` call:

```typescript
    ...(options.pluginComponents?.plugins.length ? { codePlugins: options.pluginComponents.plugins } : {}),
    ...(options.pluginComponents?.mcpServers?.length ? { pluginMcpServers: options.pluginComponents.mcpServers } : {}),
    ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
```

(Use the real import path for `Plugin` — `./plugin.js` — rather than inline `import()` types if lint prefers.)

- [ ] **Step 4: Run tests**

Run: `cd apps/oh-my-agent && bun test src/core/runtime/create-runtime.test.ts`
Expected: all PASS (new + existing).

- [ ] **Step 5: Commit**

```bash
git add apps/oh-my-agent/src/core/runtime/run-runtime.ts apps/oh-my-agent/src/core/runtime/create-runtime.ts apps/oh-my-agent/src/core/runtime/create-runtime.test.ts
git commit -m "feat(oh-my-agent): mount plugin code components in runtime with permission deny"
```

---

### Task 9: Wire the four modes + `/plugin trust` TUI command

**Files:**
- Modify: `apps/oh-my-agent/src/modes/rpc/rpc-mode.ts`, `modes/print-mode.ts`, `modes/json-mode.ts`, `modes/tui/tui-mode.ts`, `modes/tui/tui-commands.ts`
- Test: `apps/oh-my-agent/src/modes/tui/tui-commands.test.ts` (append — check existing test file name first; if none, extend `tui-mode.test.ts`)

- [ ] **Step 1: Append the failing test for `/plugin trust`**

In the TUI commands test file, follow the existing command-test pattern (look for an existing `/plugin` test in `tui-mode.test.ts` or `tui-commands` tests; reuse its harness). Test body:

```typescript
test("/plugin trust records trust and unblocks project code", async () => {
  const ws = mkdtempSync(join(tmpdir(), "oma-tui-trust-ws-"));
  const agent = mkdtempSync(join(tmpdir(), "oma-tui-trust-agent-"));
  process.env.OMA_CODING_AGENT_DIR = agent;
  try {
    // install a project-scope plugin with code (reuse marketplace fixture pattern)
    const marketRoot = join(ws, "market");
    mkdirSync(join(marketRoot, "p", "skills", "p"), { recursive: true });
    writeFileSync(join(marketRoot, "marketplace.json"),
      JSON.stringify({ name: "m", plugins: [{ name: "p", path: "p" }] }));
    writeFileSync(join(marketRoot, "p", "plugin.json"), JSON.stringify({ name: "p", tools: "./tools.ts" }));
    writeFileSync(join(marketRoot, "p", "tools.ts"), "export const tools = [];");
    addMarketplace(ws, marketRoot);
    installPlugin(ws, "m/p", "project");

    const before = resolvePluginComponents(ws, "tui");
    expect(before.codeEntries).toEqual([]);
    expect(before.warnings.join(" ")).toContain("/plugin trust");

    // simulate the command handler directly
    trustPlugin(join(ws, ".oma", "plugins", "p"));

    const after = resolvePluginComponents(ws, "tui");
    expect(after.codeEntries.map((c) => c.name)).toEqual(["p"]);
  } finally {
    delete process.env.OMA_CODING_AGENT_DIR;
    rmSync(ws, { recursive: true, force: true });
    rmSync(agent, { recursive: true, force: true });
  }
});
```

(Imports: `resolvePluginComponents` from `../../core/plugins/plugin-resolve.js`, `trustPlugin` from `../../core/plugins/plugin-trust.js`, `addMarketplace`/`installPlugin` from `../../core/plugins/plugin-marketplace.js`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/oh-my-agent && bun test src/modes/tui/`
Expected: FAIL if the resolver wiring is wrong; the trustPlugin call itself should pass once Tasks 5-6 landed — the assertion on warnings text must match the resolver's message exactly.

- [ ] **Step 3: Implement — `tui-commands.ts`: extend the existing `plugin` command**

In the `plugin` command definition (search `argumentHint: "[list|install"`), update `argumentHint` to `"[list|install <mkt>/<plugin>|uninstall <name>|enable <name>|disable <name>|trust <name>]"` and add the `trust` branch inside its `run`:

```typescript
        if (sub === "trust") {
          const name = rest[0] ?? "";
          const plugins = listInstalledPlugins(ctx.opts.workspaceRoot);
          const target = plugins.find((p) => p.name === name && p.scope === "project");
          if (!target) {
            ctx.pushStatus(`no project-scope plugin named "${name}"`);
            return;
          }
          trustPlugin(target.root);
          ctx.pushStatus(`trusted ${name} (hash recorded; code components will load)`);
          return;
        }
```

(Add `trustPlugin` to the import block from `../../core/plugins/plugin-trust.js`.)

- [ ] **Step 4: Implement — each mode calls `assemblePluginRuntime` and forwards results**

In `rpc-mode.ts`, inside the `try` block right before `createOmaRuntime({...})` (search `const cwdSkills =`):

```typescript
      const pluginRt = await assemblePluginRuntime(input.workspace.root, "rpc");
      for (const w of pluginRt.warnings) debugLog("oma", `plugin: ${w}`);
```

and inside the `createOmaRuntime({...})` options object add:

```typescript
        ...(pluginRt.plugins.length || pluginRt.mcpServers.length
          ? { pluginComponents: { plugins: pluginRt.plugins, mcpServers: pluginRt.mcpServers } }
          : {}),
        ...(input.run.permissionMode ? { permissionMode: input.run.permissionMode } : {}),
```

In `print-mode.ts` and `json-mode.ts`, same pattern with mode `"print"` / `"json"`, using `built.workspace.root`, `built.run.permissionMode`, and forwarding warnings to `console.error` (print) / the json-mode event stream is NOT needed — use `debugLog("oma", ...)`.

In `tui-mode.ts`, before its `createOmaRuntime` call (search `runId: \`tui-`), same with mode `"tui"`, and surface warnings via the existing `io.pushStatus`/status mechanism used nearby (copy the nearest warning-surfacing call in that function).

Add the import in all four: `import { assemblePluginRuntime } from "../core/plugins/plugin-resolve.js";` (adjust relative path per file).

- [ ] **Step 5: Run all mode tests**

Run: `cd apps/oh-my-agent && bun test src/modes/`
Expected: all PASS (rpc-mode.test.ts, tui-mode.test.ts, cli-modes.test.ts, plus the new trust test).

- [ ] **Step 6: Commit**

```bash
git add apps/oh-my-agent/src/modes
git commit -m "feat(oh-my-agent): wire plugin components into all modes with trust command"
```

---

### Task 10: End-to-end verification + gates

**Files:**
- Test: `apps/oh-my-agent/src/core/plugins/plugin-e2e.test.ts` (create)

- [ ] **Step 1: Write the end-to-end test — an installed user-scope plugin's tool runs inside a real Oma Run**

```typescript
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIMessageChunk } from "@chengchenccc/core";
import type { Message } from "@chengchenccc/message";
import { createInMemorySessionStore } from "../runtime/persistence/in-memory-session-store.js";
import { createOmaSession } from "../runtime/agent-loop.js";
import { addMarketplace, installPlugin } from "./plugin-marketplace.js";
import { assemblePluginRuntime } from "./plugin-resolve.js";

test("installed plugin tool executes in a Run (e2e)", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "oma-e2e-ws-"));
  const agent = mkdtempSync(join(tmpdir(), "oma-e2e-agent-"));
  process.env.OMA_CODING_AGENT_DIR = agent;
  try {
    const marketRoot = join(workspace, "market");
    mkdirSync(join(marketRoot, "e2e", "skills", "e2e"), { recursive: true });
    writeFileSync(join(marketRoot, "marketplace.json"),
      JSON.stringify({ name: "m", plugins: [{ name: "e2e", path: "e2e" }] }));
    writeFileSync(join(marketRoot, "e2e", "skills", "e2e", "SKILL.md"), "---\nname: e2e\n---\nb");
    writeFileSync(join(marketRoot, "e2e", "plugin.json"),
      JSON.stringify({ name: "e2e", tools: "./tools.ts" }));
    writeFileSync(join(marketRoot, "e2e", "tools.ts"), `
      export const tools = [{
        name: "e2e-tool", description: "e2e", executionMode: "concurrent",
        async execute() { return { content: "E2E-OK" }; },
      }];
    `);
    expect(addMarketplace(workspace, marketRoot).ok).toBe(true);
    expect(installPlugin(workspace, "m/e2e", "user").ok).toBe(true);

    const assembled = await assemblePluginRuntime(workspace, "tui");
    expect(assembled.warnings).toEqual([]);
    expect(assembled.plugins[0]?.tools?.map((t) => t.name)).toEqual(["e2e-tool"]);

    const store = createInMemorySessionStore();
    let turn = 0;
    const session = createOmaSession({
      sessionId: "e2e", store,
      plugins: assembled.plugins,
      maxSteps: 2, maxForceContinues: 0,
      summarize: async () => "s",
      modelStream: async function* (): AsyncIterable<AIMessageChunk> {
        turn++;
        if (turn === 1) {
          yield { delta: { type: "tool_use", id: "t1", name: "e2e-tool" } };
          yield { stopReason: "tool_use" };
        } else {
          yield { delta: { type: "text", text: "done" } };
        }
      },
    });
    await session.startLoop({
      input: { inputId: "in", message: { role: "user", text: "go" } },
      run: { runId: "r", model: { backendKind: "oma", modelId: "fake/echo" }, configRevision: 1 },
      workspace: { root: workspace, access: "read_write" },
    } as never);
    const snap = await store.open("e2e");
    const raw = JSON.stringify(snap.entries);
    expect(raw).toContain("E2E-OK"); // content contract: verbatim, not JSON-dumped
  } finally {
    delete process.env.OMA_CODING_AGENT_DIR;
    rmSync(workspace, { recursive: true, force: true });
    rmSync(agent, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it**

Run: `cd apps/oh-my-agent && bun test src/core/plugins/plugin-e2e.test.ts`
Expected: PASS.

- [ ] **Step 3: Full gates**

```bash
cd apps/oh-my-agent && bun run typecheck
cd apps/oh-my-agent && bun run lint
cd apps/oh-my-agent && bun test
```

Expected: all green. If typecheck flags the inline `import()` types from Task 7/8, convert them to top-level `import type` statements (behavior identical).

- [ ] **Step 4: Root gates (repo policy)**

```bash
cd /root/my-agent-team && bun run typecheck && bun run lint
```

Expected: green (only app-internal changes; no package dist rebuild needed).

- [ ] **Step 5: Commit**

```bash
git add apps/oh-my-agent/src/core/plugins/plugin-e2e.test.ts
git commit -m "test(oh-my-agent): plugin system end-to-end coverage"
```
