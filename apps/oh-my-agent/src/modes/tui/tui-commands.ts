import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveStandaloneSkillRoots } from "../../cli/initial-input.js";
import {
  addMarketplace,
  installPlugin,
  listInstalledPlugins,
  listMarketplaces,
  removeMarketplace,
  setPluginEnabled,
  uninstallPlugin,
} from "../../core/plugins/plugin-marketplace.js";
import { trustPlugin } from "../../core/plugins/plugin-trust.js";
import type { OmaRuntime } from "../../core/runtime/create-runtime.js";
import {
  loadProjectSettings,
  saveProjectModel,
  saveProjectSettings,
} from "../../core/settings/project-settings.js";
import { buildSkillIndex } from "../../core/tools/index.js";
import { listMcpServers, testMcpServer } from "../../core/tools/mcp-mount.js";
import { buildSessionCommands } from "./tui-commands-session.js";
import { formatTokens } from "./tui-format.js";
import type { TuiIo, TuiModeOptions } from "./tui-mode.js";
import type { TuiViewState } from "./view-state.js";

export interface CommandDef {
  name: string;
  description: string;
  argumentHint?: string;
  group: string;
  aliases?: readonly string[];
  live?: boolean;
  run: (args: string) => void | Promise<void>;
}

export interface TuiSessionContext {
  state: TuiViewState;
  io: TuiIo;
  opts: TuiModeOptions;
  session: { sessionId: string; messages: Record<string, unknown>[]; dir: string };
  sessionTitle?: string;
  modelId?: string;
  quitting: boolean;
  exitArmed: boolean;
  pendingPrompt?: string;
  pendingWorkflowScript?: string;
  liveRuntime: OmaRuntime | null;
  pushStatus: (lines: string | readonly string[], replacePrefix?: string) => void;
  commandsWithSkills?: readonly CommandDef[];
  listModels: () => Promise<string[]>;
  listModelRows: () => Promise<Array<{ id: string; meta: string; contextWindow: number }>>;
  listSessions: () => Array<{
    id: string;
    title?: string;
    preview?: string;
    workspace?: string;
    modifiedAt: number;
    forkOf?: string;
  }>;
  lastContextTokens?: number;
  pendingFocusRecap?: string;
  runCommandText?: (text: string) => Promise<void>;
  pickModelInteractive: () => Promise<void>;
  forkTreeInteractive: () => Promise<void>;
}

export function buildCommands(ctx: TuiSessionContext): CommandDef[] {
  const commands: ReadonlyArray<{
    name: string;
    description: string;
    argumentHint?: string;
    group: string;
    aliases?: readonly string[];
    live?: boolean;
    run: (args: string) => void | Promise<void>;
  }> = [
    {
      name: "help",
      description: "list slash commands",
      group: "general",
      live: true,
      run: () => {
        const groups: Array<[string, string[]]> = [];
        for (const c of ctx.commandsWithSkills ?? []) {
          const aliases = c.aliases?.length ? `|${c.aliases.join("|")}` : "";
          const entry = `/${c.name}${aliases}${c.argumentHint ? ` ${c.argumentHint}` : ""} — ${c.description}`;
          const found = groups.find(([name]) => name === c.group);
          if (found) found[1].push(entry);
          else groups.push([c.group, [entry]]);
        }
        ctx.pushStatus(
          groups.flatMap(([group, entries]) => [`[${group}]`, ...entries.map((e) => `  ${e}`)]),
        );
      },
    },
    {
      name: "exit",
      description: "quit the session (twice to confirm)",
      group: "general",
      live: true,
      run: () => {
        if (ctx.exitArmed) {
          ctx.quitting = true;
          return;
        }
        ctx.exitArmed = true;
        ctx.pushStatus("type /exit again to quit");
      },
    },
    {
      name: "quit",
      description: "alias of /exit",
      group: "general",
      live: true,
      run: () => {
        if (ctx.exitArmed) {
          ctx.quitting = true;
          return;
        }
        ctx.exitArmed = true;
        ctx.pushStatus("type /quit again to quit");
      },
    },
    ...buildSessionCommands(ctx),
    {
      name: "settings",
      description: "edit project settings (.oma/settings.json)",
      group: "settings",
      run: async () => {
        if (!ctx.io.editSettings) {
          ctx.pushStatus("settings editor not supported");
          return;
        }
        const updated = await ctx.io.editSettings(loadProjectSettings(ctx.opts.workspaceRoot));
        if (!updated) {
          ctx.pushStatus("settings edit cancelled");
          return;
        }
        saveProjectSettings(ctx.opts.workspaceRoot, updated);
        ctx.pushStatus("settings saved");
        ctx.io.render(ctx.state);
      },
    },
    {
      name: "plugin",
      aliases: ["plugins"],
      description: "list/install/uninstall/enable/disable plugins",
      argumentHint:
        "[list|install <mkt>/<plugin>|uninstall <name>|enable <name>|disable <name>|trust <name>]",
      group: "settings",
      run: async (args) => {
        const [sub, ...rest] = args.trim().split(/\s+/);
        if (!sub || sub === "list") {
          const plugins = listInstalledPlugins(ctx.opts.workspaceRoot);
          if (plugins.length === 0) {
            ctx.pushStatus("no plugins installed");
            return;
          }
          ctx.pushStatus([
            `plugins (${plugins.length}):`,
            ...plugins.map(
              (p) =>
                `  ${p.enabled ? "+" : "-"} ${p.name}${p.description ? ` \u2014 ${p.description}` : ""} (${p.scope})`,
            ),
          ]);
          return;
        }
        if (sub === "install") {
          const ref = rest[0];
          if (!ref) {
            ctx.pushStatus("usage: /plugin install <marketplace>/<plugin>");
            return;
          }
          const res = installPlugin(ctx.opts.workspaceRoot, ref);
          if (!res.ok) {
            ctx.pushStatus(`plugin install failed: ${res.error}`);
            return;
          }
          ctx.pushStatus(`installed plugin: ${ref}`);
          ctx.io.render(ctx.state);
          return;
        }
        if (sub === "uninstall") {
          const name = rest[0];
          if (!name) {
            ctx.pushStatus("usage: /plugin uninstall <name>");
            return;
          }
          ctx.pushStatus(
            uninstallPlugin(ctx.opts.workspaceRoot, name)
              ? `uninstalled plugin: ${name}`
              : `no plugin: ${name}`,
          );
          return;
        }
        if (sub === "enable" || sub === "disable") {
          const name = rest[0];
          if (!name) {
            ctx.pushStatus(`usage: /plugin ${sub} <name>`);
            return;
          }
          const enabled = sub === "enable";
          ctx.pushStatus(
            setPluginEnabled(ctx.opts.workspaceRoot, name, enabled)
              ? `plugin ${sub}d: ${name}`
              : `no plugin: ${name}`,
          );
          return;
        }
        if (sub === "trust") {
          const name = rest[0];
          if (!name) {
            ctx.pushStatus("usage: /plugin trust <name>");
            return;
          }
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
        ctx.pushStatus(
          "usage: /plugin list|install <mkt>/<plugin>|uninstall <name>|enable <name>|disable <name>|trust <name>",
        );
      },
    },
    {
      name: "marketplace",
      aliases: ["marketplaces"],
      description: "list/add/remove marketplaces",
      argumentHint: "[list|add <path|url>|remove <name>]",
      group: "settings",
      run: (args) => {
        const [sub, ...rest] = args.trim().split(/\s+/);
        if (!sub || sub === "list") {
          const markets = listMarketplaces(ctx.opts.workspaceRoot);
          if (markets.length === 0) {
            ctx.pushStatus("no marketplaces added");
            return;
          }
          ctx.pushStatus([
            `marketplaces (${markets.length}):`,
            ...markets.map((m) => `  ${m.name} \u2014 ${m.source}`),
          ]);
          return;
        }
        if (sub === "add") {
          const source = rest[0];
          if (!source) {
            ctx.pushStatus("usage: /marketplace add <path|url>");
            return;
          }
          const res = addMarketplace(ctx.opts.workspaceRoot, source);
          if (!res.ok) {
            ctx.pushStatus(`marketplace add failed: ${res.error}`);
            return;
          }
          ctx.pushStatus(`added marketplace: ${res.name ?? source}`);
          return;
        }
        if (sub === "remove") {
          const name = rest[0];
          if (!name) {
            ctx.pushStatus("usage: /marketplace remove <name>");
            return;
          }
          ctx.pushStatus(
            removeMarketplace(ctx.opts.workspaceRoot, name)
              ? `removed marketplace: ${name}`
              : `no marketplace: ${name}`,
          );
          return;
        }
        ctx.pushStatus("usage: /marketplace list|add <path|url>|remove <name>");
      },
    },
    {
      name: "model",
      aliases: ["models"],
      description: "show or switch the model",
      argumentHint: "<provider/model>",
      group: "model",
      live: true,
      run: async (args) => {
        if (!args) {
          // TUI: the interactive picker IS the listing (pi's /model opens the
          // selector); the text list is the headless fallback.
          if (ctx.io.pickModel) {
            await ctx.pickModelInteractive();
            return;
          }
          const rows = await ctx.listModelRows();
          const current = ctx.modelId ?? rows[0]?.id ?? "(none)";
          ctx.pushStatus([
            `current model: ${current}`,
            ...rows.map((r) => `  ${r.id === current ? "*" : " "} ${r.id} — ${r.meta}`),
          ]);
          return;
        }
        const rows = await ctx.listModelRows();
        const row = rows.find((r) => r.id === args);
        if (!row) {
          ctx.pushStatus(`unknown model: ${args} (see /model for the list)`);
          return;
        }
        ctx.modelId = args;
        saveProjectModel(ctx.opts.workspaceRoot, ctx.modelId);
        ctx.io.setHeader?.({
          model: ctx.modelId,
          sessionId: ctx.session.sessionId,
          title: ctx.sessionTitle,
        });
        ctx.pushStatus(`model: ${ctx.modelId} · ctx ${formatTokens(row.contextWindow)}`);
      },
    },
    {
      name: "thinking",
      description: "toggle thinking blocks (ctrl+t)",
      group: "view",
      live: true,
      run: () => {
        ctx.state.showThinking = !ctx.state.showThinking;
        ctx.pushStatus(`thinking ${ctx.state.showThinking ? "expanded" : "collapsed"}`);
      },
    },
    {
      name: "tools",
      description: "toggle tool detail (ctrl+o)",
      group: "view",
      live: true,
      run: () => {
        ctx.state.showToolDetail = !ctx.state.showToolDetail;
        ctx.pushStatus(`tool detail ${ctx.state.showToolDetail ? "expanded" : "collapsed"}`);
      },
    },
    {
      name: "abort",
      description: "abort the live run (esc)",
      group: "view",
      live: true,
      run: () => {
        if (ctx.liveRuntime) void ctx.liveRuntime.stop().catch(() => {});
        else ctx.pushStatus("no live run");
      },
    },
    {
      name: "mcp",
      description: "list .mcp.json servers, or test one",
      argumentHint: "test <name>",
      group: "mcp",
      live: true,
      run: async (args) => {
        const space = args.indexOf(" ");
        const sub = (space === -1 ? args : args.slice(0, space)).trim();
        const name = space === -1 ? "" : args.slice(space + 1).trim();
        if (sub === "test") {
          if (!name) {
            ctx.pushStatus("usage: /mcp test <name>");
            return;
          }
          ctx.pushStatus(`testing ${name}…`);
          ctx.io.render(ctx.state);
          const result = await testMcpServer(ctx.opts.workspaceRoot, name);
          if (result.ok) {
            const tools = result.tools.slice(0, 8).join(", ");
            const more = result.tools.length > 8 ? `, +${result.tools.length - 8} more` : "";
            ctx.pushStatus(`${name}: ok · ${result.tools.length} tools (${tools}${more})`);
          } else {
            ctx.pushStatus(`${name}: FAILED — ${result.error}`);
          }
          return;
        }
        if (sub) {
          ctx.pushStatus(`unknown subcommand "${sub}" — /mcp lists, /mcp test <name> tests`);
          return;
        }
        const servers = listMcpServers(ctx.opts.workspaceRoot);
        if (servers.length === 0) {
          ctx.pushStatus(`no .mcp.json servers in ${ctx.opts.workspaceRoot}`);
          return;
        }
        ctx.pushStatus([
          `mcp servers (${servers.length}) — mounted at run start:`,
          ...servers.map((s) => `  ${s.name} [${s.kind}] ${s.detail}`),
        ]);
      },
    },
    {
      name: "skill",
      description: "list installed skills",
      group: "skill",
      live: true,
      run: () => {
        const skills = buildSkillIndex(resolveStandaloneSkillRoots(ctx.opts.workspaceRoot));
        if (skills.length === 0) {
          ctx.pushStatus(`no skills found (looked in ${join(ctx.opts.workspaceRoot, "skills")})`);
          return;
        }
        ctx.pushStatus([
          `skills (${skills.length}):`,
          ...skills.map((sk) => `  /skill:${sk.name} — ${sk.description || "(no description)"}`),
        ]);
      },
    },
    {
      name: "workflow",
      description: "run a workflow script (file path or inline JS)",
      argumentHint: "<path|script>",
      group: "workflow",
      run: (args) => {
        if (!args) {
          ctx.pushStatus("usage: /workflow <path-or-inline-script>");
          return;
        }
        const firstToken = args.split(/\s+/)[0] ?? "";
        let script: string;
        let label: string;
        if (existsSync(firstToken) && statSync(firstToken).isFile()) {
          script = readFileSync(firstToken, "utf8");
          label = firstToken;
        } else {
          script = args;
          label = "inline";
        }
        ctx.pendingPrompt = `workflow ${label}`;
        ctx.pendingWorkflowScript = script;
      },
    },
  ];
  return commands as CommandDef[];
}
