import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineContext, type Plugin } from "@my-agent-team/agent";
import type { ChatModel } from "@my-agent-team/core";
import type { Message } from "@my-agent-team/message";
import type { AgentFsLike } from "@my-agent-team/tools-common";
import { pjoin } from "@my-agent-team/tools-common";
import { consolidateMemories, extractMemories, persistExtractedMemories } from "./auto-memory.js";
import { readMemoryWithMtimeCache } from "./cache.js";
import { memoryReadTool } from "./memory-read.js";
import { memoryRetainTool } from "./memory-retain.js";
import { memorySearchTool } from "./memory-search.js";

export const MemoryKey = defineContext<string>("memory");

export interface MemoryPluginOptions {
  ws?: AgentFsLike;
  cwd?: string;
  root?: string;
  enableWrite?: boolean;
  limit?: number;
  autoExtract?: boolean;
  extractModel?: ChatModel;
  consolidateModel?: ChatModel;
  minMessagesForExtraction?: number;
  consolidateThreshold?: number;
}

function nodeFsAdapter(cwd: string): AgentFsLike {
  const root = resolve(cwd);
  return {
    async read(p: string) {
      try {
        const full = resolve(root, p);
        if (!full.startsWith(root)) return null;
        return readFileSync(full, "utf-8");
      } catch {
        return null;
      }
    },
    async write(p: string, content: string) {
      const full = resolve(root, p);
      if (!full.startsWith(root)) throw new Error("Path escapes workspace");
      mkdirSync(resolve(full, ".."), { recursive: true });
      writeFileSync(full, content, "utf-8");
    },
    async list(p: string) {
      try {
        return readdirSync(resolve(root, p));
      } catch {
        return [];
      }
    },
    async stat(p: string) {
      try {
        const s = statSync(resolve(root, p));
        return { mtimeMs: s.mtimeMs, size: s.size };
      } catch {
        return null;
      }
    },
    async exists(p: string) {
      return existsSync(resolve(root, p));
    },
    async mkdirp(p: string) {
      mkdirSync(resolve(root, p), { recursive: true });
    },
  };
}

export function memoryPlugin(options: MemoryPluginOptions): Plugin {
  const ws = options.ws ?? (options.cwd ? nodeFsAdapter(options.cwd) : undefined);
  if (!ws) throw new Error("memoryPlugin: either ws or cwd must be provided");
  const root = options.root ?? "./memory/";
  const enableWrite = options.enableWrite ?? true;
  const limit = options.limit ?? 5;
  const autoExtract = options.autoExtract ?? false;
  const minMessages = options.minMessagesForExtraction ?? 5;
  const consolidateThreshold = options.consolidateThreshold ?? 10;
  const extractModel = options.extractModel;
  const consolidateModel = options.consolidateModel;

  let lastExtractedCount = 0;
  let lastConsolidatedCount = 0;
  let initialized = false;
  const tools = [memoryReadTool({ ws, root }), memorySearchTool({ ws, root, limit })];
  if (enableWrite) tools.push(memoryRetainTool({ ws, root }));

  return {
    name: "memory",
    tools,
    hooks: {
      async beforeRun(ctx, messages: readonly Message[]): Promise<Message[]> {
        if (!initialized) {
          await ws.mkdirp(root);
          await ws.mkdirp(pjoin(root, "facts"));
          initialized = true;
        }
        try {
          const memContent = await readMemoryWithMtimeCache(ws, root);
          if (memContent) ctx.context.set(MemoryKey, memContent);
        } catch (err) {
          ctx.logger.warn("memory: read failed, skipping injection", err);
        }
        return [...messages];
      },

      async afterModel(ctx, messages) {
        if (!autoExtract || !extractModel) return;

        const newMessages = messages.slice(lastExtractedCount);
        lastExtractedCount = messages.length;
        if (newMessages.length < minMessages) return;

        try {
          const result = await extractMemories(extractModel, newMessages);
          if (!result || result.items.length === 0) return;
          await persistExtractedMemories(ws, root, result.items);

          const factsDir = pjoin(root, "facts");
          const files = (await ws.list(factsDir)).filter((f) => f.endsWith(".md"));
          const newSinceLastConsolidation = files.length - lastConsolidatedCount;
          if (newSinceLastConsolidation < consolidateThreshold || !consolidateModel) return;
          lastConsolidatedCount = files.length;

          const facts: string[] = [];
          for (const f of files.slice(-consolidateThreshold)) {
            const content = await ws.read(pjoin(factsDir, f));
            if (content) facts.push(content);
          }
          const summary = await consolidateMemories(consolidateModel, facts.join("\n\n---\n\n"));
          if (summary) {
            await ws.write(pjoin(root, "memory_summary.md"), summary);
          }
        } catch (err) {
          ctx.logger.warn("memory: auto-extract failed", err);
        }
      },
    },
  };
}
