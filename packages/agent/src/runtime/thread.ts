import type { Message } from "@my-agent-team/message";
import type { Session } from "../persistence/session.js";

/**
 * Thread: a synchronous message cache that delegates persistence to an optional
 * Session (tree-structured). When a Session is present, push() appends to both
 * the cache (sync) and the session (async). refreshMessages() rebuilds the
 * cache from the session. Non-push mutations (unshift, splice, index assign)
 * operate on the cache and set a dirty flag; the next save/flush reconciles the
 * session by rebuilding from the cache.
 *
 * ponytail: keep the synchronous messages API to avoid touching every caller.
 * The session is an optional secondary persistence layer; messageStore remains
 * the primary flat persistence for backward compat.
 */
export class Thread {
  readonly id: string;
  #session?: Session;
  #messages: Message[];
  #dirty = false;
  #pendingOps: Promise<unknown>[] = [];
  constructor(id: string, messages: Message[] = [], session?: Session, dirty = false) {
    this.id = id;
    this.#messages = [...messages];
    this.#session = session;
    this.#dirty = dirty;
  }

  get messages(): Message[] {
    return this.#messages;
  }

  get session(): Session | undefined {
    return this.#session;
  }

  get hasSession(): boolean {
    return this.#session !== undefined;
  }

  /** Append a message: sync cache + async session.appendMessage. */
  push(msg: Message): void {
    this.#messages.push(msg);
    if (this.#session) {
      this.#pendingOps.push(this.#session.appendMessage(msg));
    }
  }

  /** Mark the cache as diverged from the session (after non-push mutations).
   *  The next flush/refresh reconciles the session from the cache. */
  markDirty(): void {
    this.#dirty = true;
  }

  /** Await pending session ops, then reconcile if dirty (rebuild session from cache). */
  async flushSession(): Promise<void> {
    if (!this.#session) return;
    await Promise.all(this.#pendingOps);
    this.#pendingOps = [];
    if (this.#dirty) {
      await this.#session.moveTo(null);
      for (const m of this.#messages) {
        await this.#session.appendMessage(m);
      }
      this.#dirty = false;
    }
  }

  /** Rebuild the cache from the session (flush first to ensure consistency). */
  async refreshMessages(): Promise<void> {
    if (!this.#session) return;
    await this.flushSession();
    const ctx = await this.#session.buildContext();
    this.#messages = ctx.messages;
  }

  /** Append a compaction entry to the session and refresh the cache. */
  async appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
  ): Promise<void> {
    if (!this.#session) return;
    await this.flushSession();
    await this.#session.appendCompaction(summary, firstKeptEntryId, tokensBefore);
    const ctx = await this.#session.buildContext();
    this.#messages = ctx.messages;
  }
}

export function createThread(
  messages: Message[] = [],
  id?: string,
  session?: Session,
  dirty = false,
): Thread {
  return new Thread(id ?? crypto.randomUUID(), messages, session, dirty);
}
