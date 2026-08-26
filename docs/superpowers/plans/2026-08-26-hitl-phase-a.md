# HITL Phase A Implementation Plan (oma-side approval pipeline)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The spec's HITL pipeline, oma side: an approval handler threaded mode→runtime→loop, `permissionMode:"ask"` gating plugin code tools, per-mode resolution (TUI overlay / print+json fail-closed / RPC wire with `approval_request` event + `resolve_approval` command + timeout deny).

**Architecture:** One handler type `ApprovalHandler = (req) => Promise<{decision, reason?}>` supplied by each mode; run-runtime invokes it for plugin tools under `ask` and exposes it to tools as `options.request` (tool-initiated sensitive actions); rpc-mode implements it over the existing JSONL wire (event out / command in / pending map / deadline deny). Phase B (backend SSE consumption + HTTP endpoint + web card) is out of scope — the event already reaches the backend via the `backend.oma.*` default mapping.

**Spec:** `docs/superpowers/specs/2026-08-26-plugin-trust-model-design.md` (HITL section).

**MVP notes:** `ask` gates plugin code tools only (native tools unaffected — same scope as `deny`); approval deadline default 120s (`OMA_APPROVAL_TIMEOUT_MS`, 0 = wait forever); crash/restart does not restore pending approvals (spec).

---

### Task 1: Approval types + loop wiring

**Files:**
- Create: `apps/oh-my-agent/src/core/runtime/approval.ts`
- Modify: `apps/oh-my-agent/src/core/runtime/plugin.ts` (execute options), `agent-loop.ts` (session opts + options.request)
- Test: `apps/oh-my-agent/src/core/runtime/approval-loop.test.ts`

**Implementation:**

`approval.ts`:

```typescript
/** HITL approval (spec): one handler type, three resolution pipelines. */
export interface ApprovalRequest {
  readonly callId: string;
  readonly toolName: string;
  readonly input: unknown;
  /** Who asked: "permission" (ask-mode gate) or "tool" (options.request). */
  readonly source: "permission" | "tool";
  readonly reason?: string;
}

export interface ApprovalDecision {
  readonly decision: "allow" | "deny";
  readonly reason?: string;
}

export type ApprovalHandler = (req: ApprovalRequest) => Promise<ApprovalDecision>;

export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

export function approvalTimeoutMs(): number {
  const raw = process.env.OMA_APPROVAL_TIMEOUT_MS;
  const n = raw === undefined ? DEFAULT_APPROVAL_TIMEOUT_MS : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_APPROVAL_TIMEOUT_MS;
}

/** Resolve with a deadline; a silent human fails closed (deny). */
export function withApprovalDeadline(
  p: Promise<ApprovalDecision>,
  timeoutMs: number,
): Promise<ApprovalDecision> {
  if (timeoutMs === 0) return p;
  return Promise.race([
    p,
    new Promise<ApprovalDecision>((resolve) =>
      setTimeout(() => resolve({ decision: "deny", reason: "approval deadline exceeded" }), timeoutMs),
    ),
  ]);
}

/** The fail-closed handler for headless one-shot modes (print/json). */
export function denyAllApprovals(req: ApprovalRequest): Promise<ApprovalDecision> {
  return Promise.resolve({
    decision: "deny",
    reason: `${req.toolName}: approval requested in non-interactive mode (fail-closed)`,
  });
}
```

`plugin.ts`: extend the execute options type inside `PluginTool.execute` — add `/** HITL: ask the human; absent = no pipeline (tool should proceed or fail-closed itself). */ request?(req: { reason?: string }): Promise<ApprovalDecision | null>;` (import type from `./approval.js`; `null` = no pipeline configured).

`agent-loop.ts`: `OmaSessionOptions` gains `readonly approvalHandler?: ApprovalHandler;`. In `executeTools`'s `runOne`, when building the execute options object (`{ callId: call.id, onOutput: ... }`) add:

```typescript
              ...(opts.approvalHandler
                ? {
                    request: (req: { reason?: string }) =>
                      opts.approvalHandler!({
                        callId: call.id,
                        toolName: call.name,
                        input,
                        source: "tool",
                        ...(req.reason ? { reason: req.reason } : {}),
                      }),
                  }
                : {}),
```

**Test** (`approval-loop.test.ts`): session with a plugin tool; `approvalHandler` returns deny → tool's `options.request` call yields deny and the tool returns `{error, isError:true}`; handler allow → tool proceeds; no handler → `options.request` is undefined (tool skips).

- [ ] Steps: write test → fail → implement → pass → `git commit -m "feat(oh-my-agent): approval types and loop request wiring"`

### Task 2: ask-mode gate in run-runtime + create-runtime plumbing

**Files:**
- Modify: `run-runtime.ts`, `create-runtime.ts`
- Test: append to `create-runtime.test.ts`

**Implementation:** `RunRuntimeDeps` + `CreateOmaRuntimeOptions` gain `approvalHandler?: ApprovalHandler`. In run-runtime's codePlugins merge, when `deps.permissionMode === "ask"`, wrap every plugin tool's execute:

```typescript
const wrapped: PluginTool = {
  ...t,
  async execute(args, signal, options) {
    if (!deps.approvalHandler) {
      return { error: `${t.name}: approval required but no pipeline configured`, isError: true };
    }
    const verdict = await withApprovalDeadline(
      deps.approvalHandler({
        callId: options?.callId ?? "", toolName: t.name, input: args, source: "permission",
      }),
      approvalTimeoutMs(),
    );
    if (verdict.decision === "deny") {
      return { error: `${t.name}: denied — ${verdict.reason ?? "user denied"}`, isError: true };
    }
    return t.execute(args, signal, options);
  },
};
```

**Test:** plugin tool + `permissionMode:"ask"`: handler deny → tool result isError with "denied"; allow → executes (content verbatim); ask without handler → isError "no pipeline". Native tool under ask unaffected (bash advertised).

- [ ] Steps: test → fail → implement → pass → `git commit -m "feat(oh-my-agent): ask-mode approval gate for plugin tools"`

### Task 3: RPC wire — approval_request out, resolve_approval in

**Files:**
- Modify: `src/protocol/transport.ts` (schemas), `src/modes/rpc/rpc-mode.ts` (pipe), `src/modes/rpc/rpc-mode.test.ts`
- Check: `src/protocol/mapping.ts` needs nothing (default passthrough).

**Implementation:** transport gains:

```typescript
export const approvalRequestEventSchema = z.object({
  callId: z.string(),
  toolName: z.string(),
  input: z.unknown().optional(),
  reason: z.string().optional(),
});
export const resolveApprovalCommandSchema = z.object({
  id: z.number(),
  type: z.literal("resolve_approval"),
  callId: z.string(),
  decision: z.enum(["allow", "deny"]),
});
```

Add to the command union/parser. rpc-mode: maintain `const pendingApprovals = new Map<string, (d: ApprovalDecision) => void>();` per run; the mode's approvalHandler emits `approval_request` (via the existing `emit`/onEvent path with `eventOutputSchema`), stores the resolver, and races the promise against `withApprovalDeadline`. Command loop: `resolve_approval` resolves the pending entry (unknown callId → debugLog). Late resolution after run end → dropped silently.

**Test** (rpc-mode.test.ts pattern): fixture run with an ask-gated plugin tool; assert stdout receives `approval_request` event; write `resolve_approval allow` line → tool executes; a second run resolving deny → isError result; timeout path via tiny `OMA_APPROVAL_TIMEOUT_MS`.

- [ ] Steps: test → fail → implement → pass → `git commit -m "feat(oh-my-agent): rpc approval wire with request event and resolve command"`

### Task 4: Mode wiring (print/json fail-closed, TUI overlay)

**Files:**
- Modify: `print-mode.ts`, `json-mode.ts` (`approvalHandler: denyAllApprovals`), `tui-mode.ts`, `tui-io.ts` (+ `confirmApproval` in the IO interface used by tui-mode.ts:83ff), `tui-interactive.ts` optional helper
- Test: `tui-mode.test.ts` scripted approval

**Implementation:** print/json: `approvalHandler: denyAllApprovals` (one line each). TUI: add to the IO interface `confirmApproval?(req: { toolName: string; reason?: string }): Promise<"allow" | "deny" | null>;` implement in the real terminal IO as a minimal overlay (y/n keys, esc = deny) modeled on the existing pickers; `tui-mode.ts` passes `approvalHandler: async (req) => { const d = await io.confirmApproval?.({...}); return { decision: d === "allow" ? "allow" : "deny" }; }` (absent picker → deny, fail-closed).

**Test:** scripted io run: plugin tool under ask → overlay prompt rendered → scripted "y" → tool result present; scripted "n"/esc → denied status.

- [ ] Steps: test → fail → implement → pass → `git commit -m "feat(oh-my-agent): per-mode approval handlers with tui confirm overlay"`

### Task 5: Gates + spec/future-work status

- [ ] `bun run typecheck && bun run lint && bun test` (apps/oh-my-agent) green; root typecheck+lint green.
- [ ] Update `docs/future-work.md` follow-ups: mark #1 oma-side + #2 done; Phase B (backend SSE consumption + `POST /runs/:id/approval` + web card + adapter forward) remains.
- [ ] `git commit -m "feat(oh-my-agent): hitl approval pipeline complete (phase a)"`
