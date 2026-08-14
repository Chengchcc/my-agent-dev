# Token-per-run Product-Tools Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind every product-tools MCP token to exactly one Agent Run: minted at dispatch, revoked at settle, `.mcp.json` carries only a placeholder — no static token anywhere.

**Architecture:** A process-internal `RunTokenRegistry` (SHA-256 keyed Map) replaces the static bearer. The execution service mints per run and passes the token through `BackendRunInput.productToolsToken`; each adapter injects it into the child's spawn env under `PRODUCT_TOOLS_RUN_TOKEN` (coding_agent keeps `CODING_AGENT_PRODUCT_TOOL_TOKEN`). The workspace `.mcp.json` writes `Bearer ${PRODUCT_TOOLS_RUN_TOKEN}` once, statically.

**Tech Stack:** Bun 1.3, TypeScript (ESM/NodeNext), bun:test, @modelcontextprotocol/sdk SSE transport.

**Spec:** `docs/superpowers/specs/2026-08-14-token-per-run-design.md`

**Hard rules from repo/session:**
- commitlint: scope in parentheses, no CJK anywhere in the message, body lines ≤100 chars.
- No `as unknown as`; no python/sed to edit source files — use read+edit.
- Every task: `bun run build --filter=<pkg>` when a workspace package's public types change (backend typechecks the built `dist`).

---

## Task 1: RunTokenRegistry

**Files:**
- Create: `apps/backend/src/features/product-tools/run-token-registry.ts`
- Test: `apps/backend/src/features/product-tools/run-token-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { createRunTokenRegistry } from "./run-token-registry.js";

describe("RunTokenRegistry", () => {
  test("mint → validate round-trips the bound context", () => {
    const reg = createRunTokenRegistry();
    const token = reg.mint({ runId: "r1", agentId: "a1", exp: Date.now() + 60_000 });
    expect(reg.validate(token)).toMatchObject({ runId: "r1", agentId: "a1" });
  });

  test("revoke invalidates exactly that run's token (idempotent)", () => {
    const reg = createRunTokenRegistry();
    const t1 = reg.mint({ runId: "r1", agentId: "a1", exp: Date.now() + 60_000 });
    const t2 = reg.mint({ runId: "r2", agentId: "a1", exp: Date.now() + 60_000 });
    reg.revoke("r1");
    reg.revoke("r1");
    expect(reg.validate(t1)).toBeNull();
    expect(reg.validate(t2)).not.toBeNull();
  });

  test("expired tokens fail validation", () => {
    const reg = createRunTokenRegistry();
    const t = reg.mint({ runId: "r1", agentId: "a1", exp: Date.now() - 1 });
    expect(reg.validate(t)).toBeNull();
  });

  test("re-minting a runId invalidates its previous token", () => {
    const reg = createRunTokenRegistry();
    const t1 = reg.mint({ runId: "r1", agentId: "a1", exp: Date.now() + 60_000 });
    const t2 = reg.mint({ runId: "r1", agentId: "a1", exp: Date.now() + 60_000 });
    expect(t1).not.toBe(t2);
    expect(reg.validate(t1)).toBeNull();
    expect(reg.validate(t2)).not.toBeNull();
  });

  test("unknown tokens are null", () => {
    const reg = createRunTokenRegistry();
    expect(reg.validate("garbage")).toBeNull();
  });

  test("capacity guard throws instead of growing unbounded", () => {
    const reg = createRunTokenRegistry({ capacity: 2 });
    reg.mint({ runId: "r1", agentId: "a", exp: Date.now() + 60_000 });
    reg.mint({ runId: "r2", agentId: "a", exp: Date.now() + 60_000 });
    expect(() =>
      reg.mint({ runId: "r3", agentId: "a", exp: Date.now() + 60_000 }),
    ).toThrow(/capacity/);
  });
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `cd apps/backend && bun test src/features/product-tools/run-token-registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import { createHash, randomBytes } from "node:crypto";

export interface RunTokenContext {
  readonly runId: string;
  readonly agentId: string;
  readonly exp: number;
}

export interface RunTokenRegistry {
  mint(ctx: RunTokenContext): string;
  validate(token: string): RunTokenContext | null;
  revoke(runId: string): void;
}

const DEFAULT_CAPACITY = 10_000;

/** Process-internal per-run bearer registry. Keys are SHA-256 of the token
 *  (plaintext never retained in the Map), so a heap snapshot cannot leak a
 *  usable credential. One live token per runId — re-minting supersedes. */
export function createRunTokenRegistry(
  opts: { capacity?: number } = {},
): RunTokenRegistry {
  const capacity = opts.capacity ?? DEFAULT_CAPACITY;
  /** sha256(token) → context */
  const byHash = new Map<string, RunTokenContext>();
  /** runId → sha256(token) */
  const byRun = new Map<string, string>();

  const keyOf = (token: string): string =>
    createHash("sha256").update(token).digest("hex");

  return {
    mint(ctx) {
      if (byHash.size >= capacity) {
        throw new Error(
          `run-token registry at capacity (${capacity}); active runs not settling?`,
        );
      }
      const prev = byRun.get(ctx.runId);
      if (prev !== undefined) {
        byHash.delete(prev);
        byRun.delete(ctx.runId);
      }
      const token = randomBytes(32).toString("base64url");
      byHash.set(keyOf(token), ctx);
      byRun.set(ctx.runId, keyOf(token));
      return token;
    },
    validate(token) {
      const ctx = byHash.get(keyOf(token));
      if (!ctx) return null;
      if (Date.now() > ctx.exp) {
        byHash.delete(keyOf(token));
        byRun.delete(ctx.runId);
        return null;
      }
      return ctx;
    },
    revoke(runId) {
      const hash = byRun.get(runId);
      if (hash === undefined) return;
      byRun.delete(runId);
      byHash.delete(hash);
    },
  };
}
```

- [ ] **Step 4: Run test, expect pass**

Run: `cd apps/backend && bun test src/features/product-tools/run-token-registry.test.ts`
Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/features/product-tools/run-token-registry.ts apps/backend/src/features/product-tools/run-token-registry.test.ts
git commit -m "feat(backend): run-token registry - sha256-keyed per-run bearer store"
```

---

## Task 2: MCP server accepts registry tokens only

**Files:**
- Modify: `apps/backend/src/features/product-tools/mcp.ts` (authorize + opts)
- Test: extend `apps/backend/src/features/product-tools/mcp.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

If `mcp.test.ts` does not exist, create it with this content; otherwise append the describe block.

```typescript
import { describe, expect, test } from "bun:test";
import { createRunTokenRegistry } from "./run-token-registry.js";
import { createProductToolsMcpServer } from "./mcp.js";
import type { ProductToolsService } from "./service.js";

function fakeService(): ProductToolsService {
  return {
    listTools: () => [],
    callTool: async () => ({ content: [] }),
  } as unknown as ProductToolsService;
}

describe("product-tools MCP auth", () => {
  test("rejects without / with wrong bearer, accepts registry token, rejects after revoke", async () => {
    const registry = createRunTokenRegistry();
    const server = await createProductToolsMcpServer({
      service: fakeService(),
      tokenRegistry: registry,
      host: "127.0.0.1",
      port: 0,
    });
    const token = registry.mint({ runId: "r1", agentId: "a1", exp: Date.now() + 60_000 });
    const base = server.url;

    const noAuth = await fetch(`${base}/sse`);
    expect(noAuth.status).toBe(401);
    await noAuth.text();

    const wrong = await fetch(`${base}/sse`, {
      headers: { Authorization: "Bearer nope" },
    });
    expect(wrong.status).toBe(401);
    await wrong.text();

    const ok = await fetch(`${base}/sse`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(ok.status).toBe(200);
    ok.body?.cancel();

    registry.revoke("r1");
    const revoked = await fetch(`${base}/sse`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(revoked.status).toBe(401);
    await revoked.text();
    await server.close();
  });
});
```

Note: the `as unknown as ProductToolsService` is the boundary-test-double exception the repo rule allows; if the real service type is constructible with fewer fields, prefer building the real one.

- [ ] **Step 2: Run it, expect failure**

Run: `cd apps/backend && bun test src/features/product-tools/mcp.test.ts`
Expected: FAIL — `tokenRegistry` not a known option (type error at runtime: serviceToken undefined / compile error).

- [ ] **Step 3: Change the server**

In `mcp.ts`:

1. Replace the `serviceToken: string` option with `tokenRegistry: RunTokenRegistry` (import from `./run-token-registry.js`).
2. Replace `authorize`:

```typescript
function authorize(req: IncomingMessage, registry: RunTokenRegistry): RunTokenContext | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  if (scheme !== "Bearer" || value === undefined) return null;
  return registry.validate(value);
}
```

3. In the request handler, replace `if (!authorize(req, serviceToken))` with:

```typescript
const caller = authorize(req, tokenRegistry);
if (!caller) {
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ code: "unauthorized", message: "missing or invalid token" }));
  return;
}
```

(`caller.runId` is now available at the auth point for §3.2's audit stamp — wire it into the tool-call audit in Step 4 only if the service already exposes a per-call audit field; otherwise leave a named `const` and a one-line comment `// audit stamp: caller.runId`, and note it in the commit body.)

4. Delete the now-unused constant-time `authorize` helpers (`timingSafeEqual` import) if nothing else uses them.

- [ ] **Step 4: Run test, expect pass**

Run: `cd apps/backend && bun test src/features/product-tools/mcp.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/features/product-tools/mcp.ts apps/backend/src/features/product-tools/mcp.test.ts
git commit -m "feat(backend): product-tools MCP accepts registry tokens only"
```

---

## Task 3: `BackendRunInput.productToolsToken`

**Files:**
- Modify: `packages/agent-backend/src/run.ts` (interface)
- Modify: `packages/agent-backend/src/index.ts` only if it re-exports the type explicitly (check first)

- [ ] **Step 1: Add the field**

In `BackendRunInput` (after `workspace`):

```typescript
  /** Per-run product-tools bearer. Backends deliver it to their child
   *  (spawn env). Absent = no product tools for this run. */
  readonly productToolsToken?: string;
```

- [ ] **Step 2: Build + typecheck**

Run: `cd /root/my-agent-team && bun run build --filter=@my-agent-team/agent-backend && cd apps/backend && bun run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/agent-backend/src/run.ts
git commit -m "feat(agent): BackendRunInput carries per-run product-tools token"
```

---

## Task 4: Adapters inject the per-run env

Three adapters, same shape. For each: in `execute()`, merge the token into the spawn env (falling back to `undefined` = omit, never an empty-string header).

**Files:**
- Modify: `packages/adapter-claude-agent/src/backend.ts`
- Modify: `packages/adapter-pi-agent/src/backend.ts`
- Modify: `packages/adapter-omp-agent/src/backend.ts`
- Modify: `packages/adapter-coding-agent/src/backend.ts`

- [ ] **Step 1: claude — per-run env**

In `ClaudeBackend.execute()`, replace the `spawnClaudeProcess` call:

```typescript
    const runEnv = input.productToolsToken
      ? { ...this.extraEnv, PRODUCT_TOOLS_RUN_TOKEN: input.productToolsToken }
      : this.extraEnv;
    proc = spawnClaudeProcess(
      { executable: this.executable, args: [...this.extraArgs, ...args], env: runEnv },
      { cwd: workspace },
    );
```

Delete the `productToolsToken` constructor option, the `private readonly productToolsToken` field, and its assignment.

- [ ] **Step 2: pi — same change** (around `spawnPiProcess`)

- [ ] **Step 3: omp — same change** (around its spawn call)

- [ ] **Step 4: coding_agent — per-execute env override**

`CodingAgentBackend` holds a shared `command` (env baked at construction):

```typescript
      proc = spawnCodingAgentProcess(
        input.productToolsToken
          ? {
              ...this.command,
              env: {
                ...this.command.env,
                CODING_AGENT_PRODUCT_TOOL_TOKEN: input.productToolsToken,
              },
            }
          : this.command,
        { cwd: input.workspace.root },
      );
```

- [ ] **Step 5: Build adapters + backend typecheck**

Run: `cd /root/my-agent-team && bun run build --filter=@my-agent-team/adapter-claude-agent --filter=@my-agent-team/adapter-pi-agent --filter=@my-agent-team/adapter-omp-agent --filter=@my-agent-team/adapter-coding-agent && cd apps/backend && bun run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/adapter-claude-agent/src/backend.ts packages/adapter-pi-agent/src/backend.ts packages/adapter-omp-agent/src/backend.ts packages/adapter-coding-agent/src/backend.ts
git commit -m "feat(agent): adapters inject per-run product-tools token into spawn env"
```

---

## Task 5: Execution mints + revokes

**Files:**
- Modify: `apps/backend/src/features/agent-run/execution.ts`
- Modify: `apps/backend/src/features/agent-run/execution.test.ts` (extend)

- [ ] **Step 1: Deps + mint + revoke**

1. `AgentRunExecutionDeps` gains:

```typescript
  /** Per-run product-tools bearer registry; minted at dispatch, revoked
   *  in dispatchFn's finally (every terminal path). */
  readonly productToolsTokenRegistry: RunTokenRegistry;
```

2. In `deliverInput`'s try (a mint throw = existing dispatch failure path):

```typescript
    const productToolsToken = deps.productToolsTokenRegistry.mint({
      runId: run.runId,
      agentId: run.agentMemberId,
      exp: Date.now() + 30 * 60_000,
    });
```

Add `productToolsToken` to the returned `BackendRunInput` literal in `buildRunInput`'s caller (pass it as a parameter if the literal lives in `buildRunInput`).

3. In `dispatchFn`'s `finally` (next to `closeSubscribers(runId)`):

```typescript
        deps.productToolsTokenRegistry.revoke(runId);
```

- [ ] **Step 2: Extend the integration test**

In `execution.test.ts`, `makeExecution(fakeDaemon, runPortOverride?, modelCatalogOverride?, contextPortOverride?)` (line 110) — add a fifth optional param `tokenRegistry?: RunTokenRegistry` defaulting to `createRunTokenRegistry()`, forwarded into `createAgentRunExecutionService`. Existing call sites stay untouched.

The fake daemon's backend records the token (registry capture is impossible — hashes are one-way). Extend `createFakeDaemon`'s backend double with `recordTokens?: string[]` that `execute()` pushes `input.productToolsToken` into, then:

```typescript
  test("per-run product-tools token: unique across runs, revoked at settle", async () => {
    const fake = createFakeDaemon();
    const registry = createRunTokenRegistry();
    const execution = makeExecution(fake, undefined, undefined, undefined, registry);
    const tokenLog: string[] = [];
    fake.recordTokens = tokenLog;

    const first = await enqueue("normal", "tok-1", "hello");
    await execution.dispatch(first.run!.runId);
    const second = await enqueue("normal", "tok-2", "hello again");
    await execution.dispatch(second.run!.runId);

    expect(new Set(tokenLog).size).toBe(2);
    for (const t of tokenLog) expect(registry.validate(t)).toBeNull();
  });
```

- [ ] **Step 3: Run the suite**

Run: `cd apps/backend && bun test src/features/agent-run/execution.test.ts`
Expected: all pass, including the new test.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/features/agent-run/execution.ts apps/backend/src/features/agent-run/execution.test.ts
git commit -m "feat(backend): mint per-run product-tools token at dispatch, revoke in finally"
```

Delete the `productToolsToken` constructor option, the `private readonly productToolsToken` field, and its assignment (constructor param destructure + assignment line).

- [ ] **Step 2: pi — same change**

In `PiBackend.execute()`, same `runEnv` construction around `spawnPiProcess`; delete the dead option/field.

- [ ] **Step 3: omp — same change**

Same in `OmpBackend.execute()` around its spawn call; delete the dead option/field.

- [ ] **Step 4: coding_agent — env override per execute**

`CodingAgentBackend` holds a shared `command` (env baked at construction). Add a per-run override in `execute()`:

```typescript
      proc = spawnCodingAgentProcess(
        input.productToolsToken
          ? {
              ...this.command,
              env: {
                ...this.command.env,
                CODING_AGENT_PRODUCT_TOOL_TOKEN: input.productToolsToken,
              },
            }
          : this.command,
        { cwd: input.workspace.root },
      );
```

- [ ] **Step 5: Build all adapters + backend typecheck**

Run: `cd /root/my-agent-team && bun run build --filter=@my-agent-team/adapter-claude-agent --filter=@my-agent-team/adapter-pi-agent --filter=@my-agent-team/adapter-omp-agent --filter=@my-agent-team/adapter-coding-agent`
Expected: build errors only in `apps/backend` consumers — none in the packages.

- [ ] **Step 6: Commit**

```bash
git add packages/adapter-*/src/backend.ts
git commit -m "feat(agent): adapters inject per-run product-tools token into spawn env"
```

---

## Task 6: Bootstrap rewiring + config deletion

**Files:**
- Modify: `apps/backend/src/bootstrap/features.ts`
- Modify: `apps/backend/src/config.ts`
- Modify: `apps/backend/src/infra/coding-agent-command.ts`
- Modify: `packages/agent-backend/src/redact.ts`
- Modify: `packages/adapter-coding-agent/src/stderr-tail.ts`

- [ ] **Step 1: features.ts**

1. Create the registry once: `const productToolsTokenRegistry = createRunTokenRegistry();`
2. MCP server startup condition drops the static token:

```typescript
  if (config.productToolsMcpUrl) {
    const mcpUrl = new URL(config.productToolsMcpUrl);
    productToolsMcp = await createProductToolsMcpServer({
      service: productTools,
      tokenRegistry: productToolsTokenRegistry,
      host: mcpUrl.hostname,
      port: Number(mcpUrl.port) || 0,
    });
```

3. `createAgentRunExecutionService({...})` gains `productToolsTokenRegistry`.
4. The three CLI backend constructors lose `productToolsToken: config.productToolsServiceToken` (field already deleted in Task 4).
5. The reconcile product-tools entry (features.ts:528-536) becomes unconditional-placeholder:

```typescript
          ...(config.productToolsMcpUrl
            ? [
                {
                  name: "product-tools",
                  transport: "sse" as const,
                  url: config.productToolsMcpUrl,
                  // Placeholder: the per-run token reaches the CLI child via
                  // spawn env (PRODUCT_TOOLS_RUN_TOKEN) which expands here.
                  headers: { Authorization: "Bearer ${PRODUCT_TOOLS_RUN_TOKEN}" },
                },
              ]
            : []),
```

- [ ] **Step 2: config.ts**

Delete `productToolsServiceToken?: string;` (line 31) and its env mapping `productToolsServiceToken: env.PRODUCT_TOOLS_SERVICE_TOKEN,` (line 59).

- [ ] **Step 3: coding-agent-command.ts**

Delete the static injection block (lines ~40-43):

```typescript
    ...(config.productToolsServiceToken
      ? { CODING_AGENT_PRODUCT_TOOL_TOKEN: config.productToolsServiceToken }
      : {}),
```

(The per-run value now comes via Task 4's execute-time override.)

- [ ] **Step 4: redact lists**

`packages/agent-backend/src/redact.ts`: add `"PRODUCT_TOOLS_RUN_TOKEN"` next to `CODING_AGENT_PRODUCT_TOOL_TOKEN`.
`packages/adapter-coding-agent/src/stderr-tail.ts`: add the same name.
Rebuild both packages.

- [ ] **Step 5: Full verify**

Run: `cd /root/my-agent-team && bun run build --filter=@my-agent-team/agent-backend --filter=@my-agent-team/adapter-coding-agent && cd apps/backend && bun run typecheck && bun test src/features/`
Expected: typecheck clean; suites green.

Run: `grep -rn "productToolsServiceToken" apps/backend/src --include="*.ts" | grep -v test`
Expected: zero hits.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/bootstrap/features.ts apps/backend/src/config.ts apps/backend/src/infra/coding-agent-command.ts packages/agent-backend/src/redact.ts packages/adapter-coding-agent/src/stderr-tail.ts
git commit -m "feat(backend): static product-tools token removed - registry wiring only"
```

---

## Task 7: Live CLI matrix (spec §3.4/§7)

**Files:**
- Modify: `docs/superpowers/specs/2026-08-14-token-per-run-design.md` (write results into §3.4 table)

No code unless a CLI fails a path. For each of claude_code / pi / omp with a real binary on this box:

- [ ] **Step 1: matrix probe per CLI**

1. Ensure a workspace `.mcp.json` with the placeholder entry exists (reconcile runs at agent boot; or craft one manually in a scratch workspace).
2. Spawn the CLI with `PRODUCT_TOOLS_RUN_TOKEN=<minted>` in env, pointed at that workspace, with any minimal prompt.
3. Observe: product-tools connection carries `Bearer <minted>` (backend log `[product-tools]` audit or a temporary `console.log` of `caller.runId` from Task 2's auth point — remove after probing).
4. Record per CLI: `${VAR}` expansion works / needed fallback (per-invocation config or header flag).

- [ ] **Step 2: degrade if all paths fail for a CLI**

If a CLI supports none of: env expansion in `.mcp.json`, per-invocation config override, header flag — remove the product-tools entry from that CLI's reconcile (guard the merge by backend kind in features.ts) and log one bootstrap warning:

```typescript
console.warn(`[bootstrap] product-tools disabled for ${kind}: no per-run token path`);
```

Never reintroduce a static token.

- [ ] **Step 3: Write results into the spec §3.4 table + commit**

```bash
git add docs/superpowers/specs/2026-08-14-token-per-run-design.md
git commit -m "docs(docs): token-per-run CLI matrix results"
```

---

## Task 8: Full regression + close the backlog

**Files:**
- Modify: `docs/architecture/security-debt-backlog.md`

- [ ] **Step 1: Full gates**

Run: `cd /root/my-agent-team && bun run typecheck && bun run lint && bun run test`
Expected: all green.

- [ ] **Step 2: Spec §9 checklist**

Verify each item:
- `grep -rn "productToolsServiceToken" apps/backend/src` → zero (tests included this time).
- Scratch a workspace: `cat <workspace>/.mcp.json` → placeholder only.
- Registry unit tests + MCP 401 matrix green (Tasks 1-2).
- Execution uniqueness + post-settle 401 green (Task 5).
- Matrix results written (Task 7).

- [ ] **Step 3: Backlog close**

In `docs/architecture/security-debt-backlog.md`, strike the D5 entry with date and one-line resolution.

- [ ] **Step 4: Commit + push**

```bash
git add docs/architecture/security-debt-backlog.md
git commit -m "docs(docs): close D5 - token-per-run shipped"
git push
```
