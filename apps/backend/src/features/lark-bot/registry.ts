import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { parseEnv } from "@chengchenccc/config";
import { safeAgentId } from "../../infra/agent-id.js";

const _env = parseEnv(process.env);

export type LarkBotStatus = "not_configured" | "configured" | "running" | "degraded" | "error";

export interface LarkBotRegistry {
  ensureLarkBot(
    agentId: string,
    botDisplayName?: string | null,
    larkProfile?: string | null,
  ): Promise<void>;
  stopLarkBot(agentId: string): Promise<void>;
  statusOf(agentId: string): LarkBotStatus;
  dispose(): Promise<void>;
}

// ─── Shared helpers ───

interface DevBot {
  agentId: string;
  botDisplayName?: string | null;
  larkProfile?: string | null;
  child: ChildProcess;
}

async function terminateChild(child: ChildProcess, timeoutMs = 5000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), timeoutMs);
    child.on("exit", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
  if (exited) return;
  // SIGKILL only after grace period — lark-cli event consume must SIGTERM first
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => {
    child.on("exit", () => resolve());
    setTimeout(() => resolve(), 1000);
  });
}

// ─── Dev registry (spawns lark-bot processes) ───

interface DesiredConfig {
  agentId: string;
  botDisplayName?: string | null;
  larkProfile?: string | null;
}

export class DevLarkBotRegistry implements LarkBotRegistry {
  #bots = new Map<string, DevBot>();
  #backoff = new Map<string, number>();
  #desired = new Map<string, DesiredConfig>();
  #stableTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #lastError = new Map<string, { message: string; ts: number }>();

  constructor(
    private opts: {
      dataDir: string;
      larkBotBin: string;
      backendUrl: string;
    },
  ) {}

  async ensureLarkBot(
    agentId: string,
    botDisplayName?: string | null,
    larkProfile?: string | null,
  ): Promise<void> {
    const key = safeAgentId(agentId);

    // Always save desired config so restarts and updates don't lose args
    this.#desired.set(key, { agentId, botDisplayName, larkProfile });

    const existing = this.#bots.get(key);
    if (existing && existing.child.exitCode === null) return; // already running

    const args = [
      this.opts.larkBotBin,
      "--agent-id",
      agentId,
      "--backend-url",
      this.opts.backendUrl,
      "--state-root",
      this.opts.dataDir,
    ];
    if (botDisplayName) {
      args.push("--bot-display-name", botDisplayName);
    }
    if (larkProfile) {
      args.push("--lark-profile", larkProfile);
    }
    // Pass backend auth token so lark-bot can authenticate its HTTP requests
    args.push("--backend-auth-token", _env.BACKEND_AUTH_TOKEN);

    const child = spawn("bun", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdout?.on("data", (d: Buffer) => {
      process.stdout.write(`[lark-bot:${key}] ${d}`);
    });
    child.stderr?.on("data", (d: Buffer) => {
      process.stderr.write(`[lark-bot:${key}] ${d}`);
    });

    child.on("exit", (code, signal) => {
      // Clear stable timer on exit
      const stableTimer = this.#stableTimers.get(key);
      if (stableTimer) {
        clearTimeout(stableTimer);
        this.#stableTimers.delete(key);
      }

      if (!this.#bots.has(key)) return; // intentional stop

      if (code === 0) {
        // Clean exit — lark-bot chose to stop (agent disabled/archived/not found)
        this.#bots.delete(key);
        this.#backoff.delete(key);
        this.#desired.delete(key);
        this.#lastError.delete(key);
        console.log(`[lark-bot:${key}] exited cleanly code=0, not restarting`);
        return;
      }

      // Record last error for diagnostics
      this.#lastError.set(key, {
        message: `exited code=${code} signal=${signal ?? "none"}`,
        ts: Date.now(),
      });

      const backoff = this.#backoff.get(key) ?? 0;
      const next = Math.min((backoff + 1) * 2000, 30000);
      this.#backoff.set(key, next);
      console.error(
        `[lark-bot:${key}] exited code=${code} signal=${signal}, restart in ${next}ms (backoff=${backoff})`,
      );
      setTimeout(() => {
        if (this.#bots.has(key)) {
          const desired = this.#desired.get(key);
          if (desired) {
            this.ensureLarkBot(desired.agentId, desired.botDisplayName, desired.larkProfile).catch(
              () => {
                /* backoff loop continues */
              },
            );
          }
        }
      }, next);
    });

    this.#bots.set(key, { agentId, botDisplayName, larkProfile, child });
    // Reset backoff only after 60s stable runtime — prevents 2s reset loop on rapid crash
    const stableTimer = setTimeout(() => {
      if (this.#bots.get(key)?.child === child && child.exitCode === null) {
        this.#backoff.set(key, 0);
        this.#lastError.delete(key);
        this.#stableTimers.delete(key);
      }
    }, 60_000);
    this.#stableTimers.set(key, stableTimer);
  }

  async stopLarkBot(agentId: string): Promise<void> {
    const key = safeAgentId(agentId);
    const bot = this.#bots.get(key);
    if (!bot) return;
    this.#bots.delete(key); // mark intentional — prevents restart
    this.#backoff.delete(key);
    this.#desired.delete(key);
    const stableTimer = this.#stableTimers.get(key);
    if (stableTimer) {
      clearTimeout(stableTimer);
      this.#stableTimers.delete(key);
    }
    await terminateChild(bot.child);
  }

  statusOf(agentId: string): LarkBotStatus {
    const key = safeAgentId(agentId);
    const bot = this.#bots.get(key);
    if (!bot) return this.#lastError.has(key) ? "error" : "configured";
    if (bot.child.exitCode !== null) return "error";
    return "running";
  }

  async dispose(): Promise<void> {
    for (const timer of this.#stableTimers.values()) clearTimeout(timer);
    this.#stableTimers.clear();
    const entries = [...this.#bots.entries()];
    this.#bots.clear();
    this.#backoff.clear();
    this.#desired.clear();
    this.#lastError.clear();
    for (const [, bot] of entries) {
      await terminateChild(bot.child);
    }
  }
}

// ─── Prod registry (resolve only, no spawn) ───

export class ProdLarkBotRegistry implements LarkBotRegistry {
  async ensureLarkBot(
    _agentId: string,
    _botDisplayName?: string | null,
    _larkProfile?: string | null,
  ): Promise<void> {
    /* external orchestration */
  }
  async stopLarkBot(_agentId: string): Promise<void> {
    /* external orchestration */
  }
  statusOf(_agentId: string): LarkBotStatus {
    // Prod doesn't know runtime status — caller should query external supervisor
    return "configured";
  }
  async dispose(): Promise<void> {
    /* no-op */
  }
}
