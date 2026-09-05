# Future Work

## oma plugin system: implemented MVP (2026-08-26) — remaining follow-ups

**MVP shipped** (commits db428685..36e8e8cd, spec acceptance 1-8 green, 384 tests):
multi-source manifest with conflict matrix, oma custom tools/hooks entries (Bun
native dynamic import), tool result `content` contract, plugin `.mcp.json` merge with
`${CLAUDE_PLUGIN_ROOT}`, Claude marketplace catalog fallback, scope×mode trust matrix
(`trusted-plugins.json` hash record, `/plugin trust` command, RPC never loads
project-scope code), `permissionMode` deny drops plugin code components.

**Follow-ups also shipped (2026-08-26, HITL Phase A):**

- Workspace `.mcp.json` standalone trust gate (`gateWorkspaceMcp` in tui/print/json,
  `/mcp trust` command, fail-closed when untrusted; fixed a pre-existing duplicate
  mounted-tools bug that broke any real MCP server mount into a Run).
- HITL approval pipeline (oma side): `ApprovalHandler` threaded
  mode->runtime->loop; `permissionMode:"ask"` gates plugin code tools;
  tools get `options.request`; per-mode resolution - TUI `confirmApproval`
  overlay, print/json fail-closed deny, RPC wire (`approval_request` event
  reaches the backend via the `backend.oma.*` passthrough + `resolve_approval`
  command + `OMA_APPROVAL_TIMEOUT_MS` deadline deny).

**Remaining follow-ups:**

- HITL Phase B shipped (2026-08-26): backend `POST /api/agent-runs/:runId/approval`
  + `AgentRunExecutionService.resolveApproval`, oma adapter `resolveApproval`
  JSONL command (id-matched response), web `backend.oma.approval_request` SSE →
  transient approval card (Allow/Deny) → POST → child resolves. The SSE event was
  already forwarded by the `backend.oma.*` default mapping — no adapter event
  change needed.
- `permissionMode` native-tool gate shipped (2026-08-26, 4633e9af): bash/write/edit/
  create_file/mcp__* run through `makeSessionPermissionGate` in ask/deny; auto mode
  classifies bash/eval/mcp__*/plugin code tools (fail-closed, 600afddf); workflow
  subagents share the gate (46c574cd). Remaining: an allow-rules granular native
  permission system is a separate design.

**Older remaining list (superseded where marked above):**

- Marketplace cache + version management (shipped 2026-08-26): new `packages/source-fetch` is the shared base (fetchGitSource/fetchGitSourceSync/materializeZipSource/directoryFingerprint) — no backend/oma coupling; oma marketplace `marketplaceSourceToRoot` now clones via the base and records the git HEAD rev on `MarketplaceRecord.version` (shown in `/marketplace` list). Backend skill-pack can reuse the same base (its own git/zip clone currently duplicated inline). Shipped: skill-pack git/zip install now uses the same base (fetchGitSource/materializeZipSource) — the two inline clone/unzip/checksum implementations are gone; a pre-extraction zip-entry guard (reject `..`/absolute paths before unzip) was added to the base for fail-closed safety. Remaining: plugin `update` command (re-fetch + re-copy).
- omp `CustomTool`/hook module shape compat - evaluated and rejected 2026-08-26; revisit only if the ecosystem value justifies porting the API surface.

## oma plugin system: design history (superseded by the shipped MVP above)

**Goal**

Installed plugins contribute oma-native custom tools + hooks (our own shapes, the only execution mechanism), while Claude and omp plugin ecosystems remain installable: their compatible fields (skills, plugin `.mcp.json`, marketplace catalogs) work, their incompatible code fields are detected and skipped with warnings.

**Status**

- Short-term baseline: product tools are ordinary MCP servers via `.mcp.json`; installed plugins currently contribute skills only.
- 2026-08-26 decision (four rounds with user):
  - Claude ecosystem: peripheral compatibility only — marketplace catalog (`.claude-plugin/marketplace.json` fallback), plugin `skills/`, plugin `.mcp.json` (near-free: oma `mcp-mount` already parses the Claude `{mcpServers}` shape). No Claude hooks.json shell protocol, no commands/agents/LSP.
  - Code tools/hooks: oma's own mechanism. omp `CustomTool` shape compat was evaluated and rejected (ArkType tri-schema + `CustomToolAPI` factory + `CustomToolContext` + `AgentToolResult` + render hooks ≈ porting half the pi runtime). Manifest field names honor omp (`tools`/`hooks` entry paths); shapes are oma's (`PluginTool[]` / `PluginHooks`, current sync signatures — no async relaxation needed, no subprocess hooks).
  - Installing Claude or omp plugins goes through the conflict matrix: oma manifest wins; omp/claude code fields are ignored with warnings; tool-name conflicts native-wins then registry order; hooks never conflict (all fire); MCP names workspace > user-scope > project-scope.
  - No jiti anywhere: Bun native dynamic `import()` (verified 2026-08-26). omp itself loads custom tools via native Bun import too.

**Reference**

- Spec (approved direction): [`superpowers/specs/2026-08-26-plugin-trust-model-design.md`](./superpowers/specs/2026-08-26-plugin-trust-model-design.md) — conflict matrix, oma custom-tool loading/validation, trust model.
- omp: `packages/coding-agent/src/extensibility/custom-tools/loader.ts` (native Bun import), `plugins/marketplace/fetcher.ts` (`.claude-plugin/marketplace.json` fallback), `source-resolver.ts` (future git/registry source reference).
- Claude: `.claude-plugin/plugin.json` schema subset (name/version/description/skills), plugin `.mcp.json`.

**Potential downstream consumers**

| Consumer | What it needs |
|---|---|
| oma plugin system | oma `plugin.json` gains `tools`/`hooks` entry fields; multi-source manifest read (oma → Claude → omp) with conflict matrix |
| TUI `/plugin` commands | `install` / `enable` / `disable` also resolve components (skills ungated; code entries + MCP gated) |
| Marketplace modules | `.claude-plugin/marketplace.json` catalog fallback; cpSync install stays |
| Runtime assembly (`assembleRunRuntime`) | Receive loaded tools/hooks + plugin mcp configs via new deps; policy stays in mode layer (`resolvePluginComponents`) |
| RPC / backend child | user-scope code components available; project-scope code components NEVER load in RPC (enforced inside the oma child) |
| Security | scope = trust boundary: user-scope install-consent (all modes); project-scope code components need hash trust record (`<agentDir>/trusted-plugins.json`, TUI ask-once); markdown/skills ungated |

**Non-goals (for now)**

- omp `CustomTool`/hook module shape compatibility; Claude hooks.json protocol; commands/agents/LSP/monitors.
- Plugin code API injection surface (no `CustomToolAPI` equivalent).
- Marketplace git/registry sources, cache, version management; npm dependency auto-install.

**Where to start**

1. Manifest multi-source read + conflict matrix (per spec).
2. `loadPluginCode` (native dynamic import) + shape validation for tools/hooks entries.
3. Plugin `.mcp.json` merge into `mcp-mount` (+ `${CLAUDE_PLUGIN_ROOT}` substitution).
4. `resolvePluginComponents` + trust record + TUI ask-once dialog; wire into `assembleRunRuntime`.

## Web UI capability alignment (2026-09-04) — P1/P2 shipped, P3 remains

**Shipped** (commits accb4dce..f8d3762a redesign + 03b48c54/f5698b7f/39cc7647/
611ad7ab capability alignment): Obsidian Control Matrix token migration, 9
designed pages rebuilt to the design anatomy, TopBar, page-pattern kit, and the
P1/P2 server capabilities — MCP tool catalog/schema-hash/probe-latency/invoke/
restart, system metrics (/proc subprocess scan), batch human-gate resolution,
per-model×hour cost rollup, knowledge pack stats, skill-pack lockfile/validate.
Verification loop: 1920px screenshots vs design PNGs via vision diff (fidelity
scoreboard in git history; vision absolute scores are prompt/crop sensitive —
treat as gap-finders, verify claimed gaps against the DOM before acting).

**P3 remaining items** (each needs its own design pass / ADR):

- **Span traces Tier 2 — transport segments.** Tier 1 shipped: run-detail
  `RunWaterfall` derives tool-call spans + model-turn gaps from the existing
  `agent_run_event` log (no new identity). Tier 2 adds rpc_spawn / jsonl_pipe /
  sqlite_write timing — requires L3 (adapter-oma-agent) instrumentation. ADR
  required: spans are run-scoped telemetry (FK to runId, no lifecycle), never a
  second execution identity (Phase 6 deleted the old span/attempt/control-plane
  tables for exactly that fragmentation).
- **Agent-run pause.** New runtime control state beyond stop: oma child must
  checkpoint mid-run and resume on resume-command. Touches oma loop, adapter
  JSONL protocol, and branch input queue semantics.
- **Vector retrieval / embeddings for knowledge.** New product line: embedding
  pipeline, vector store, chunk-level retrieval; current knowledge packs are
  file-level only. Includes stats exposure beyond file counts (tokens/chunks are
  estimates today) and reindex/test-query endpoints.
- **Lark conversation binding sync.** The chat page's "Lark Sync" pill needs the
  larkChatId↔conversationId mapping that lives in apps/lark-bot's own SQLite —
  cross-app sync into the backend (schema + flow) so the web can render binding
  state per conversation.
- **Skill/pack invocation counters.** Per-pack and per-skill usage telemetry
  (design's "Invocations Today" tiles). Requires tool-call events to carry the
  originating pack id.
- **Artifact ledger + retention.** Source provenance exists (meta.json + list
  API); missing: sha256 content ledger with verification endpoint, retention
  TTL sweep (cron), purge API.
- **Knowledge reindex / test-query endpoints** (S): re-materialize a pack and
  a timed search probe; cut from P2 as non-essential.
- **Budget ceiling.** Client computes pace from the 24h cost curve; a formal
  ceiling needs a settings key + alert field in telemetry summary.
- **`ask_question` (HITL 提问) as a Product Tools MCP tool — ADR 0027.** The
  native `ask_question` tool (apps/oh-my-agent/src/core/tools/ask-question.ts)
  executes through `options.ask`, wired only in **TUI mode**; the oma child in
  `--mode rpc` has no ask transport, so it fail-closes
  (`{"error":"no ask pipeline configured"}`, observed on conv `78fa86d5...`).
  A RPC-native fix would only cover `oma` — `claude`/`pi`/`omp` are separate
  CLIs via their own adapters and never see the oma JSONL protocol. So the
  correct cross-runtime path is **MCP injection**: implement `ask_question` in
  the backend Product Tools MCP (all four runtimes mount it via the shared
  `adapter-mcp.callTool`), block on an in-memory parked resolver, emit SSE, and
  let the web answer via a reused `AskQuestionCard`. Design + layer plan in
  docs/adr/0027-ask-question-product-tools-mcp.md (status Draft).

**Dev convenience:** `apps/backend/scripts/seed-demo.ts` seeds the dev DB with
dense demo data (48 runs/24h, workflow gates incl. pending-human rows, artifact
files with provenance) so UI pages render at design-like density. Ephemeral
ids — dev DB only.
