# Future Work

## oma custom tools via jiti (long-term)

**Goal**

Align with omp: dynamically load oma plugin "custom tools" (TypeScript/JS modules) at runtime using `jiti` instead of only declarative bundles.

**Status**

- Short-term: product tools are ordinary MCP servers via `.mcp.json`; oma no longer has a special product-tool mental model.
- Long-term: add a jiti-based plugin runtime loader so installed plugins can contribute code-backed tools/hooks/commands/extensions.

**Reference**

- omp: `packages/coding-agent/src/extensibility/plugins/manager.ts`, `loader.ts`, `marketplace/*`
- omp plugin manifest lives in `package.json` `omp`/`pi` fields; tools/hooks/commands/extensions are resolved to loadable module entries.

**Potential downstream consumers**

| Consumer | What it needs |
|---|---|
| oma plugin system | A `PluginManifest` may declare code entry points (`tools`, `hooks`, `commands`, `extensions`) in addition to `skills/` |
| TUI `/plugin` commands | `install` / `upgrade` / `enable` / `disable` must also load and register jiti modules |
| Marketplace modules | Install code-backed plugins from a marketplace source (git URL / local dir) |
| Runtime assembly (`assembleRunRuntime`) | After resolving installed plugins, dynamically import entry modules and merge returned tools/hooks into the Plugin[] list |
| RPC / backend child | Same custom tools must be available in standalone TUI and backend-invoked RPC modes |
| Security | Code-backed plugins execute arbitrary code; need permission model / trust gating / sandbox before enabling |
| Skills / MCP | A plugin may provide `skills/` dirs and MCP server config alongside code tools |

**Non-goals (for now)**

- Full omp MarketplaceManager/registry/cache parity.
- Automatic plugin upgrades.
- Multi-tenant plugin sandboxing.

**Where to start**

1. Define a `plugin.json` code entry shape (`entry` / `tools` / `hooks` / `commands`).
2. Add a `loadPluginModule(root, entry)` using `jiti` (runtime-selected path; static import cannot work).
3. Wire discovered custom tools into `assembleRunRuntime` plugins.
4. Add a trust/permission gate before enabling code-backed plugins.
