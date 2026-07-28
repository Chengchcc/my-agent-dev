import { Agent } from "./agent.js";
import type { AgentConfig } from "./agent-options.js";
import { Session } from "./persistence/session.js";
import type { SessionRepo } from "./persistence/session-repo.js";
import { sqlitePersistence } from "./persistence/sqlite-persistence.js";
import { sqliteSessionRepo } from "./persistence/sqlite-session-repo.js";
import { sqliteSessionStorage } from "./persistence/sqlite-session-storage.js";
import type { RunSpan } from "./runtime/trace.js";

export type StartSpanFn = (
  spanId: string,
  sessionId: string,
  opts?: unknown,
) => Promise<RunSpan> | RunSpan;

export interface SessionManagerConfig {
  checkpointerPath: string;
  startSpan?: StartSpanFn;
}

export interface SessionManager {
  create(config: AgentConfig): Agent;
  open(sessionId: string, config: AgentConfig): Agent;
  get(sessionId: string): Agent | undefined;
  dispose(sessionId: string): void;
}

export class SqliteSessionManager implements SessionManager {
  #sessions = new Map<string, Agent>();
  #config: SessionManagerConfig;
  #persistence: ReturnType<typeof sqlitePersistence>;
  #repo: SessionRepo;

  constructor(config: SessionManagerConfig) {
    this.#config = config;
    this.#persistence = sqlitePersistence({ db: config.checkpointerPath });
    this.#repo = sqliteSessionRepo({ db: config.checkpointerPath });
  }

  create(config: AgentConfig): Agent {
    const sessionId = crypto.randomUUID();
    const agent = new Agent({
      ...config,
      sessionId,
      messageStore: this.#persistence.messageStore,
      eventLog: this.#persistence.eventLog,
      interruptStore: this.#persistence.interruptStore,
      session: new Session(sqliteSessionStorage({ db: this.#config.checkpointerPath, sessionId })),
      startSpan: this.#config.startSpan,
    });
    this.#sessions.set(sessionId, agent);
    return agent;
  }

  open(sessionId: string, config: AgentConfig): Agent {
    const existing = this.#sessions.get(sessionId);
    if (existing) return existing;
    const agent = new Agent({
      ...config,
      sessionId,
      messageStore: this.#persistence.messageStore,
      eventLog: this.#persistence.eventLog,
      interruptStore: this.#persistence.interruptStore,
      session: new Session(sqliteSessionStorage({ db: this.#config.checkpointerPath, sessionId })),
      startSpan: this.#config.startSpan,
    });
    this.#sessions.set(sessionId, agent);
    return agent;
  }

  get(sessionId: string): Agent | undefined {
    return this.#sessions.get(sessionId);
  }

  dispose(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (session) {
      session.dispose();
      this.#sessions.delete(sessionId);
    }
  }

  get repo(): SessionRepo {
    return this.#repo;
  }
}

export { InMemorySessionManager } from "./session-manager-memory.js";
