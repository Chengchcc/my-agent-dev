import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, ContextPipeline, Plugin } from "@my-agent-team/agent";
import { createAgentSession } from "@my-agent-team/agent";
import type { ChatModel } from "@my-agent-team/core";
import { progressiveSkillPlugin } from "@my-agent-team/plugin-progressive-skill";
import type { SkillPackSource } from "./entities.js";
import { posixSkillRoot } from "./entities.js";
import { nodeFsAdapter } from "./fs-adapter.js";
import type { SkillPackPort } from "./ports.js";
import { createAllPackTools } from "./tools.js";
export interface InstallSessionDeps {
  model: ChatModel;
  dataDir: string;
  port: SkillPackPort;

  contextManager?: ContextPipeline;
  /** Buffer for zip uploads — written to temp file and injected via tool closure. */
  zipBuffer?: Buffer;
  /** Temp file path for zip buffer. Set internally by runInstall. */
  zipPath?: string;
}

export interface InstallSource {
  packId: string;
  sourceKind: SkillPackSource;
  sourceUrl: string | null;
  versionRef: string | null;
}

// ─── Helpers ───

function buildInstallPlugins(dataDir: string): Plugin[] {
  const sharedWs = nodeFsAdapter(posixSkillRoot(dataDir));
  return [
    progressiveSkillPlugin({
      ws: sharedWs,
      roots: ["builtin"],
      posixSkillRoot: posixSkillRoot(dataDir),
    }),
  ];
}

function buildPrompt(source: InstallSource, action: "install" | "sync"): string {
  const ctx = [
    `Task: ${action === "install" ? "Install" : "Sync"} skill pack.`,
    `Pack ID: ${source.packId}`,
    `Source kind: ${source.sourceKind}`,
  ];
  if (source.sourceUrl) {
    if (source.sourceKind === "git") {
      ctx.push(`Git URL: ${source.sourceUrl}`);
      if (source.versionRef) ctx.push(`Ref: ${source.versionRef}`);
    }
    // zip: buffer is never mentioned in the prompt — it's pre-staged on disk
    // and injected into the pack_unzip tool via closure (zipPath).
  }
  ctx.push("", `Use the ${action} flow from skill-pack-installer to complete this task.`);
  if (action === "install") {
    ctx.push(`Target directory must be: ${source.packId}`);
  }
  return ctx.join("\n");
}

// ─── Session creation ───

async function createInstallSession(deps: InstallSessionDeps): Promise<Agent> {
  return createAgentSession({
    model: deps.model,
    plugins: buildInstallPlugins(deps.dataDir),

    contextManager: deps.contextManager,
    tools: createAllPackTools({
      port: deps.port,
      dataDir: deps.dataDir,
      zipPath: deps.zipBuffer ? deps.zipPath : undefined,
    }),
  });
}

// ─── Runners ───

export async function runInstall(source: InstallSource, deps: InstallSessionDeps): Promise<void> {
  // For zip installs: stage buffer to temp file, inject path via closure
  if (source.sourceKind === "zip" && deps.zipBuffer) {
    const tmpZipPath = join(tmpdir(), `pack-${source.packId}.zip`);
    writeFileSync(tmpZipPath, deps.zipBuffer);
    deps = { ...deps, zipPath: tmpZipPath };
    try {
      return await runInstallInner(source, deps);
    } finally {
      try {
        unlinkSync(tmpZipPath);
      } catch {
        /* ok */
      }
    }
  }
  return runInstallInner(source, deps);
}

async function runInstallInner(source: InstallSource, deps: InstallSessionDeps): Promise<void> {
  // Backend deterministically advances pending→installing (like syncGit does ready→syncing).
  await deps.port.applyInstallTransition(source.packId, "installing", { now: Date.now() });
  try {
    const session = await createInstallSession(deps);
    await session.prompt(buildPrompt(source, "install"));
  } finally {
    const row = await deps.port.get(source.packId);
    if (row && row.status !== "ready" && row.status !== "failed") {
      await deps.port.applyInstallTransition(source.packId, "failed", {
        error: "install session ended without terminal status",
        now: Date.now(),
      });
    }
  }
}

export async function runSync(source: InstallSource, deps: InstallSessionDeps): Promise<void> {
  try {
    const session = await createInstallSession(deps);
    await session.prompt(buildPrompt(source, "sync"));
  } finally {
    const row = await deps.port.get(source.packId);
    if (row && row.status !== "ready" && row.status !== "failed") {
      await deps.port.applyInstallTransition(source.packId, "failed", {
        error: "sync session ended without terminal status",
        now: Date.now(),
      });
    }
  }
}
