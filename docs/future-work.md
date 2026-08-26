# Future Work

## oma plugins: adopt the Claude Code plugin ecosystem (long-term)

**Goal**

Adopt the Claude Code plugin format (`.claude-plugin/plugin.json` + component dirs) so the existing Claude marketplace ecosystem runs on oma — instead of an oma-private plugin format.

**Status**

- Short-term: product tools are ordinary MCP servers via `.mcp.json`; oma no longer has a special product-tool mental model.
- 2026-08-26 decision (three rounds with user): pure Claude format, no oma `entry` field. Claude plugins are declarative component dirs with **no in-process Plugin object** — all code execution is subprocess (hooks shell commands / MCP / LSP). The earlier jiti plan and the `entry`/dynamic-import redesign are both obsolete; no module loader exists at all.
- MVP components: `skills` (shipped) + `commands` (flat md → TUI slash) + `hooks` (`command` type only, protocol aligned field-by-field with Claude hooks reference, mapped to a compile-time wrapper Plugin) + `.mcp.json` (→ mcp-mount).

**Reference**

- omp: `packages/coding-agent/src/extensibility/plugins/manager.ts`, `loader.ts`, `marketplace/*`
- omp plugin manifest lives in `package.json` `omp`/`pi` fields; tools/hooks/commands/extensions are resolved to loadable module entries.
- Design spec (trust model + loader): [`superpowers/specs/2026-08-26-plugin-trust-model-design.md`](./superpowers/specs/2026-08-26-plugin-trust-model-design.md) — approved 2026-08-26: scope-as-trust-boundary, user-scope install-consent, project-scope hash trust record, RPC never loads project-scope code.

**Potential downstream consumers**

| Consumer | What it needs |
|---|---|
| oma plugin system | `PluginManifest` adopts the Claude schema subset (`skills`/`commands`/`agents`/`hooks`/`mcpServers`); legacy oma `plugin.json` stays as alias |
| TUI `/plugin` commands | `install` / `upgrade` / `enable` / `disable` also resolve components (markdown ungated; hooks/MCP gated) |
| Marketplace modules | Install Claude-format plugins from a marketplace source (git URL / local dir) |
| Runtime assembly (`assembleRunRuntime`) | Receive approved hooks wrapper + mcp configs via new deps; policy stays in mode layer (`resolvePluginComponents`) |
| RPC / backend child | user-scope hooks/MCP available; project-scope code components NEVER load in RPC (enforced inside the oma child) |
| Security | scope = trust boundary: user-scope install-consent (all modes); project-scope hooks/MCP need hash trust record (`<agentDir>/trusted-plugins.json`, TUI ask-once); markdown components ungated |
| Skills / MCP | `skills/` dirs and `.mcp.json` ship alongside hooks in one plugin |

**Non-goals (for now)**

- Full omp MarketplaceManager/registry/cache parity.
- Automatic plugin upgrades.
- Multi-tenant plugin sandboxing.

**Where to start**

1. Manifest dual-read (`.claude-plugin/plugin.json` first, legacy `plugin.json` fallback) + Claude schema subset parsing.
2. `claude-hooks.ts` wrapper: config schema, matcher semantics, exec/shell form, stdin/stdout JSON protocol, exit-code semantics, timeout fail-open — per the spec's alignment tables.
3. PluginHooks async relaxation (`T | Promise<T>`) — the only runtime contract change.
4. `resolvePluginComponents` + trust record + TUI ask-once dialog; wire into `assembleRunRuntime`.
