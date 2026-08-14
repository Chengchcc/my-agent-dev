import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface IdentityData {
  soul: string | null;
  user: string | null;
}

export interface IdentityPatch {
  soul?: string;
  user?: string;
}

export interface AgentIdentityStore {
  getIdentity(agentId: string): Promise<IdentityData>;
  updateIdentity(agentId: string, patch: IdentityPatch): Promise<void>;
}

function isCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === code;
}

/** Read a text file; return null when the file doesn't exist. */
async function readTextOrNull(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch (err) {
    if (isCode(err, "ENOENT")) return null;
    throw err;
  }
}

/** Read memory facts from the agent workspace.
 *
 *  Layout:
 *    memory/MEMORY.md          — summary / dated memory
 *    memory/facts/*.md         — agent-written facts
 *
 *  Also reads flat memory/*.md for backward compat (legacy agents). */

export function createAgentIdentityStore(opts: {
  dataDir: string;
  getAgent: (agentId: string) => Promise<{ workspacePath: string }>;
}): AgentIdentityStore {
  return {
    async getIdentity(agentId: string): Promise<IdentityData> {
      const agent = await opts.getAgent(agentId); // validate agent exists
      const root = agent.workspacePath;
      await mkdir(root, { recursive: true });

      const [soul, user] = await Promise.all([
        readTextOrNull(path.join(root, "SOUL.md")),
        readTextOrNull(path.join(root, "USER.md")),
      ]);
      return { soul, user };
    },

    async updateIdentity(agentId: string, patch: IdentityPatch): Promise<void> {
      const agent = await opts.getAgent(agentId); // validate agent exists
      const root = agent.workspacePath;
      await mkdir(root, { recursive: true });

      // Ensure memory/facts/ directory exists so the agent can write
      await mkdir(path.join(root, "memory", "facts"), { recursive: true });

      if (typeof patch.soul === "string") {
        await writeFile(path.join(root, "SOUL.md"), patch.soul, "utf-8");
      }
      if (typeof patch.user === "string") {
        await writeFile(path.join(root, "USER.md"), patch.user, "utf-8");
      }
    },
  };
}
