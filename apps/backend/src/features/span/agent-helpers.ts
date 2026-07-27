import { mkdirSync } from "node:fs";
import type { ContextPipeline, Plugin } from "@my-agent-team/agent";
import { type Model, type ModelRegistry, type ProviderAuth, resolveModel } from "@my-agent-team/ai";
import type { ChatModel, Tool } from "@my-agent-team/core";
import { autoSummarize, pipeContextManagers, toolResultTruncator } from "@my-agent-team/framework";
import { identityPlugin } from "@my-agent-team/plugin-identity";
import { memoryPlugin } from "@my-agent-team/plugin-memory";
import { progressiveSkillPlugin } from "@my-agent-team/plugin-progressive-skill";
import {
  bashTool,
  createEditTool,
  createLsTool,
  createReadTool,
  createTreeTool,
  createWriteTool,
  globTool,
  grepTool,
} from "@my-agent-team/tools-common";
import type { BackendConfig } from "../../config.js";
import {
  createListMembersTool,
  createReadContextTool,
  createReadHistoryTool,
  createSearchTool,
} from "../conversation/conv-tools.js";
import type { ConversationPort } from "../conversation/ports.js";
import type { SettingsService } from "../settings/index.js";
import type { SkillRoots } from "./skill-roots.js";
// ─── Model Registry ────────────────────────────────────────

import { loadModelRegistry } from "../../model-registry-loader.js";

/** Create and register providers from <dataDir>/models.yml or env auto-detection. */
export function createDefaultModelRegistry(config: BackendConfig): ModelRegistry {
  const yamlPath = `${config.dataDir}/models.yml`;
  const registry = loadModelRegistry(yamlPath);
  if (registry.getProviders().length === 0) {
    throw new Error(`No model providers configured. Set ANTHROPIC_API_KEY or create ${yamlPath}`);
  }
  return registry;
}

export { resolveModel };

/** Create a ChatModel from a Model object using the registry.
 *  No bare-string compat: callers must resolve Model via registry.getModel(). */
export function createModel(model: Model, registry: ModelRegistry, auth: ProviderAuth): ChatModel {
  return registry.createModel(model, auth);
}

// ─── Tools ────────────────────────────────────────────────

export function defaultTools(cwd: string): Tool[] {
  mkdirSync(cwd, { recursive: true });
  return [
    createReadTool({ cwd }),
    createWriteTool({ cwd }),
    createEditTool({ cwd }),
    createLsTool({ cwd }),
    createTreeTool({ cwd }),
    bashTool,
    globTool,
    grepTool,
  ];
}

export function convTools(port: ConversationPort, conversationId: string): Tool[] {
  return [
    createReadHistoryTool({ convPort: port, conversationId }),
    createReadContextTool({ convPort: port, conversationId }),
    createSearchTool({ convPort: port, conversationId }),
    createListMembersTool({ convPort: port, conversationId }),
  ];
}

// ─── Plugins ──────────────────────────────────────────────

export function defaultPlugins(
  cwd: string,
  _config: BackendConfig,
  skillRoots?: SkillRoots,
  agentName?: string,
): Plugin[] {
  return [
    identityPlugin({ cwd, agentName }),
    memoryPlugin({ cwd, root: "./memory/" }),
    progressiveSkillPlugin(
      skillRoots
        ? { ws: skillRoots.ws, roots: skillRoots.roots, posixSkillRoot: skillRoots.posixSkillRoot }
        : { cwd },
    ),
  ];
}

// NOTE: conversationPlugins was removed — conversation-compose inlines the assembly:
//   plugins: [...defaultPlugins(cwd, ws, skillRoots), conversationContextPlugin({ tools: convTools(port, cid) })]

// ─── ContextManager ───────────────────────────────────────

export function defaultContextManager(settings?: SettingsService): ContextPipeline {
  return pipeContextManagers(
    toolResultTruncator({
      maxCharsPerResult: settings?.get<number>("context.toolResultMaxChars") ?? 50_000,
    }),
    autoSummarize({
      triggerAt: settings?.get<number>("context.summarizeTriggerAt") ?? 100_000,
      keepRecent: settings?.get<number>("context.summarizeKeepRecent") ?? 10,
    }),
  );
}
