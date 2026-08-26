# Future Work

## oma plugin system: oma-native code components + Claude/omp ecosystem compatibility (long-term)

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
