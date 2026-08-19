/**
 * M15.1: In-memory Lark profile setup session manager.
 * Sessions live in memory only; agent DB is updated on completion.
 * Backend restart loses pending sessions (safe: no half-enabled state).
 */

import type { LarkProfileProvisioner } from "./provisioner.js";

export interface LarkProfileSetupSession {
  setupId: string;
  agentId: string;
  profileRef: string;
  botDisplayName: string | null;
  brand: "feishu" | "lark";
  status: "pending" | "completed" | "failed" | "expired" | "cancelled";
  url: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const EXPIRE_CHECK_INTERVAL_MS = 60_000; // 1 minute

export class LarkSetupManager {
  #sessions = new Map<string, LarkProfileSetupSession>();
  #provisioner: LarkProfileProvisioner;
  #expiryTimer: ReturnType<typeof setInterval>;
  #cancelFns = new Map<string, () => Promise<void>>();
  /** Callback when a setup session completes successfully. */
  #onComplete: (session: LarkProfileSetupSession) => Promise<void>;

  constructor(
    provisioner: LarkProfileProvisioner,
    onComplete: (session: LarkProfileSetupSession) => Promise<void>,
  ) {
    this.#provisioner = provisioner;
    this.#onComplete = onComplete;
    this.#expiryTimer = setInterval(() => this.#reapExpired(), EXPIRE_CHECK_INTERVAL_MS);
  }

  get provisioner(): LarkProfileProvisioner {
    return this.#provisioner;
  }

  /** Create a new setup session and start the provisioner. */
  async create(input: {
    agentId: string;
    botDisplayName?: string;
    brand: "feishu" | "lark";
  }): Promise<LarkProfileSetupSession> {
    const { agentId, botDisplayName, brand } = input;
    const profileRef = `agent:${agentId}`;
    const setupId = `setup_${crypto.randomUUID()}`;
    const now = Date.now();

    const session: LarkProfileSetupSession = {
      setupId,
      agentId,
      profileRef,
      botDisplayName: botDisplayName ?? null,
      brand,
      status: "pending",
      url: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + DEFAULT_TIMEOUT_MS,
    };

    // Start provisioner in background
    void this.#provisioner
      .start({
        agentId,
        profileRef,
        brand,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        onUrl: (url) => {
          // Surface the setup URL to the 3s polling UI as soon as lark-cli
          // prints it (stdout TTY or stderr piped) — do not wait for exit.
          session.url = url;
          session.updatedAt = Date.now();
        },
      })
      .then((result) => {
        // Store cancel function so cancel() can SIGTERM the lark-cli process
        this.#cancelFns.set(setupId, result.cancel);
        session.updatedAt = Date.now();

        void result.waitForCompletion
          .then((url) => {
            session.url = url; // resolved after all stdout data has arrived
            this.#cancelFns.delete(setupId);
            this.complete(setupId);
          })
          .catch((err: Error) => {
            this.#cancelFns.delete(setupId);
            // Don't mark as failed if user cancelled
            if (session.status !== "cancelled") {
              this.fail(setupId, err.message);
            }
          });
      })
      .catch((err: Error) => {
        this.fail(setupId, err.message);
      });

    this.#sessions.set(setupId, session);
    return { ...session };
  }

  get(setupId: string): LarkProfileSetupSession | null {
    return this.#sessions.get(setupId) ?? null;
  }

  /** Get the most recent setup session for an agent. */
  getByAgentId(agentId: string): LarkProfileSetupSession | null {
    for (const [, s] of this.#sessions) {
      if (s.agentId === agentId) return s;
    }
    return null;
  }

  async complete(setupId: string): Promise<void> {
    const session = this.#sessions.get(setupId);
    if (!session) return;
    session.status = "completed";
    session.updatedAt = Date.now();
    try {
      await this.#onComplete(session);
    } catch (err) {
      console.error(
        `[setup-manager] onComplete failed for ${setupId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  fail(setupId: string, error: string): void {
    const session = this.#sessions.get(setupId);
    if (!session) return;
    session.status = "failed";
    session.error = error;
    session.updatedAt = Date.now();
  }

  cancel(setupId: string): void {
    const session = this.#sessions.get(setupId);
    if (!session) return;
    session.status = "cancelled";
    session.updatedAt = Date.now();
    this.#sessions.delete(setupId);
    // SIGTERM the provisioner's lark-cli process (never SIGKILL)
    const cancelFn = this.#cancelFns.get(setupId);
    if (cancelFn) {
      this.#cancelFns.delete(setupId);
      void cancelFn();
    }
  }

  /** Check for expired sessions. */
  #reapExpired(): void {
    const now = Date.now();
    for (const [id, session] of this.#sessions) {
      if (session.status === "pending" && now > session.expiresAt) {
        session.status = "expired";
        session.updatedAt = now;
        this.#sessions.delete(id);
      }
    }
  }

  dispose(): void {
    clearInterval(this.#expiryTimer);
    for (const [, cancelFn] of this.#cancelFns) {
      void cancelFn();
    }
    this.#cancelFns.clear();
    this.#sessions.clear();
  }
}
