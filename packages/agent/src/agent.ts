import type { AgentEvent } from "./runtime/agent-event.js";
import type { ContextKey } from "./context/context.js";
import type { Agent as FrameworkAgent } from "./runtime/agent-options.js";
import type { Plugin } from "./runtime/plugin.js";
import { createAgent } from "./runtime/create-agent.js";
import { createContextStore } from "./context/context.js";
import type { AgentConfig, AgentState } from "./agent-options.js";
import type { CompactionResult } from "./compaction.js";
import type { AgentEventListener } from "./runtime/agent-options.js";
import { createHookPlugin } from "./hook-dispatcher.js";

export class Agent {
  readonly #config: AgentConfig;
  #state: AgentState = "idle";
  #core: FrameworkAgent | null = null;
  #unsub: (() => void) | null = null;
  #subscribers = new Set<AgentEventListener>();
  #abort: AbortController | null = null;
  #retryCount = 0;
  #lastError: string | null = null;
  #steering: { role: "user"; text: string }[] = [];
  #followUp: { role: "user"; text: string }[] = [];
  #pendingContext = createContextStore();

  constructor(config: AgentConfig) {
    this.#config = {
      maxSteps: 50,
      retry: { maxAttempts: 3, backoffMs: 2000, maxBackoffMs: 30_000 },
      compaction: { autoCompact: true, keepRecent: 10 },
      ...config,
    };
  }

  get sessionId(): string | undefined {
    return this.#config.sessionId;
  }
  get state(): AgentState {
    return this.#state;
  }

  // ── Lifecycle ────────────────────────────────────

  async prompt(
    input: string,
    opts?: { signal?: AbortSignal; spanId?: string; origin?: unknown },
  ): Promise<void> {
    if (this.#state === "running" || this.#state === "retrying") {
      this.steer(input);
      return;
    }
    let text = input;
    if (this.#config.hooks?.["before:run"]) {
      const result = await this.#config.hooks["before:run"](
        { sessionId: this.sessionId ?? "", state: this.#pendingContext },
        { text: input },
      );
      if (result) text = result.text;
    }
    await this.#ensureCore();
    await this.#execute(text, opts);
  }

  async continue(opts?: {
    signal?: AbortSignal;
    spanId?: string;
    origin?: unknown;
  }): Promise<void> {
    await this.#ensureCore();
    await this.#execute(undefined, opts);
  }

  async resume(
    command: { approved: boolean; message?: string },
    opts?: { signal?: AbortSignal },
  ): Promise<void> {
    if (!this.#core) throw new Error("Agent not initialized");
    this.#state = "running";
    this.#abort = new AbortController();
    try {
      const gen = this.#core.resume(command, {
        signal: this.#combineSignal(opts?.signal),
      });
      for await (const _ of gen) {
        /* events via subscriber */
      }
      this.#state = "done";
    } catch (err) {
      this.#handleError(err);
      this.#state = "error";
    } finally {
      this.#abort = null;
    }
  }

  abort(): void {
    this.#abort?.abort();
  }

  dispose(): void {
    this.#unsub?.();
    this.#subscribers.clear();
    this.#abort?.abort();
    this.#core = null;
    this.#state = "idle";
    this.#steering.length = 0;
    this.#followUp.length = 0;
  }

  async waitForIdle(): Promise<void> {
    if (this.#state !== "running" && this.#state !== "retrying" && this.#state !== "compacting")
      return;
    const { promise, resolve } = Promise.withResolvers<void>();
    const unsub = this.subscribe((e) => {
      if (e.type === "agent_end") {
        unsub();
        resolve();
      }
    });
    return promise;
  }

  // ── Runtime interventions ─────────────────────────

  steer(input: string): void {
    if (this.#state === "idle")
      throw new Error("steer requires an in-flight run; call prompt() first");
    this.#steering.push({ role: "user", text: input });
    this.#emitQueueUpdate();
  }

  followUp(input: string): void {
    this.#followUp.push({ role: "user", text: input });
    this.#emitQueueUpdate();
  }

  setContext<T>(key: ContextKey<T>, value: T): void {
    this.#pendingContext.set(key, value);
  }

  // ── Maintenance ───────────────────────────────────

  async compact(instructions?: string): Promise<CompactionResult> {
    if (!this.#core) throw new Error("Agent not initialized");
    if (!this.#config.checkpointer) throw new Error("Checkpointer required for compaction");
    this.#state = "compacting";
    const reason = instructions ? "manual" : "threshold";
    this.#emit({ type: "compaction_start", reason } as AgentEvent);
    try {
      const { compactThread } = await import("./compaction.js");
      const { messages, result } = await compactThread({
        model: this.#config.model,
        checkpointer: this.#config.checkpointer,
        sessionId: this.sessionId ?? "",
        keepRecent: this.#config.compaction?.keepRecent,
        customInstructions: instructions,
      });
      await this.#config.checkpointer.save(this.sessionId ?? "", messages);
      this.#core.thread.messages.splice(0, this.#core.thread.messages.length, ...messages);
      this.#core.thread.markDirty?.();
      this.#emit({
        type: "compaction_end",
        reason,
        result,
        aborted: false,
        willRetry: false,
      } as AgentEvent);
      this.#state = "done";
      return result;
    } catch (err) {
      this.#state = "error";
      this.#emit({
        type: "compaction_end",
        reason,
        aborted: true,
        willRetry: true,
        errorMessage: String(err),
      } as AgentEvent);
      throw err;
    }
  }
  getContextUsage(): { messageCount: number } | undefined {
    return this.#core ? { messageCount: this.#core.thread.messages.length } : undefined;
  }

  async getUsage(): Promise<number> {
    const cp = this.#config.checkpointer;
    if (!cp || !this.sessionId) return 0;
    const readEvents = cp.readEvents;
    if (typeof readEvents !== "function") return 0;
    try {
      let total = 0;
      for await (const e of readEvents.call(cp, this.sessionId)) {
        if (e.type === "model_end" && "usage" in e) {
          const u = e.usage as { input?: number; output?: number };
          total += (u.input ?? 0) + (u.output ?? 0);
        }
      }
      return total;
    } catch {
      return 0;
    }
  }

  // ── Events ────────────────────────────────────────

  subscribe(listener: AgentEventListener): () => void {
    this.#subscribers.add(listener);
    return () => {
      this.#subscribers.delete(listener);
    };
  }

  // ── Private ───────────────────────────────────────

  async #ensureCore(): Promise<void> {
    if (this.#core) return;
    const plugins: Plugin[] = [];
    if (this.#config.hooks) {
      const ctx = createContextStore();
      plugins.push(
        createHookPlugin(this.#config.hooks, {
          sessionId: this.#config.sessionId ?? "",
          state: ctx,
        }),
      );
    }
    this.#core = await createAgent({
      model: this.#config.model,
      sessionId: this.#config.sessionId,
      tools: this.#config.tools,
      plugins: [...(this.#config.plugins ?? []), ...plugins],
      checkpointer: this.#config.checkpointer,
      session: this.#config.session,
      contextManager: this.#config.contextManager,
      logger: this.#config.logger,
      systemPrompt: this.#config.systemPrompt,
      startSpan: this.#config.startSpan,
    });
    this.#unsub = this.#core.subscribe((e) => this.#handleEvent(e));
  }

  #handleEvent(event: AgentEvent): void {
    if (event.type === "message") {
      const p = event.payload;
      if (p.state === "done" || p.state === "error")
        this.#state = p.state === "done" ? "done" : "error";
      else if (p.state === "waiting") this.#state = "waiting";
    }
    this.#emit(event);
  }

  async #execute(
    input?: string,
    opts?: { signal?: AbortSignal; spanId?: string; origin?: unknown },
  ): Promise<void> {
    if (!this.#core) return;
    this.#state = "running";
    this.#retryCount = 0;
    this.#lastError = null;
    this.#abort = new AbortController();
    const signal = this.#combineSignal(opts?.signal);

    try {
      while (true) {
        try {
          if (input !== undefined) {
            const gen = this.#core.run(input, {
              signal,
              stream: true,
              maxSteps: this.#config.maxSteps,
              context: this.#pendingContext,
              steering: { drain: () => this.#steering.splice(0) },
              followUp: { drain: () => this.#followUp.splice(0) },
              spanId: opts?.spanId,
              origin: opts?.origin,
            });
            for await (const _ of gen) {
              /* events via subscriber */
            }
          } else {
            const gen = this.#core.continue({
              signal,
              stream: true,
              context: this.#pendingContext,
              steering: { drain: () => this.#steering.splice(0) },
              followUp: { drain: () => this.#followUp.splice(0) },
              spanId: opts?.spanId,
              origin: opts?.origin,
            });
            for await (const _ of gen) {
              /* events via subscriber */
            }
          }
          if (this.#config.hooks?.["after:turn"]) {
            await this.#config.hooks["after:turn"](
              { sessionId: this.sessionId ?? "", state: this.#pendingContext },
              this.#core!.thread.messages.slice(),
            );
          }
          this.#state = "done";
          this.#emit({
            type: "agent_end",
            messages: this.#core.thread.messages.slice(),
            willRetry: false,
            status: "succeeded",
          } as AgentEvent);
          if (this.#retryCount > 0) {
            this.#emit({
              type: "auto_retry_end",
              success: true,
              attempt: this.#retryCount,
            } as AgentEvent);
          }
          break;
        } catch (err) {
          this.#handleError(err);
          if (
            !this.#abort?.signal.aborted &&
            this.#lastError &&
            this.#retryCount < (this.#config.retry?.maxAttempts ?? 3)
          ) {
            this.#retryCount++;
            this.#state = "retrying";
            const base = this.#config.retry?.backoffMs ?? 2000;
            const cap = this.#config.retry?.maxBackoffMs ?? 30_000;
            const delay = Math.min(cap, base * 2 ** (this.#retryCount - 1));
            this.#emit({
              type: "auto_retry_start",
              attempt: this.#retryCount,
              maxAttempts: this.#config.retry?.maxAttempts ?? 3,
              delayMs: delay,
              errorMessage: this.#lastError,
            } as AgentEvent);
            await new Promise((r) => setTimeout(r, delay));
            this.#lastError = null;
            continue;
          }
          const aborted = this.#abort?.signal.aborted ?? false;
          if (this.#config.hooks?.["after:turn"]) {
            await this.#config.hooks["after:turn"](
              { sessionId: this.sessionId ?? "", state: this.#pendingContext },
              this.#core!.thread.messages.slice(),
            );
          }
          this.#emit({
            type: "agent_end",
            messages: this.#core!.thread.messages.slice(),
            willRetry: false,
            status: aborted ? "interrupted" : "error",
          } as AgentEvent);
          this.#emit({
            type: "auto_retry_end",
            success: false,
            attempt: this.#retryCount,
            finalError: this.#lastError ?? "unknown",
          } as AgentEvent);
          break;
        }
      }
    } finally {
      this.#abort = null;
    }
  }

  #handleError(err: unknown): void {
    this.#lastError = err instanceof Error ? err.message : String(err);
  }

  #combineSignal(external?: AbortSignal): AbortSignal | undefined {
    if (!external && !this.#abort) return undefined;
    if (!external) return this.#abort?.signal;
    if (!this.#abort) return external;
    const c = new AbortController();
    external.addEventListener("abort", () => c.abort(external.reason));
    this.#abort.signal.addEventListener("abort", () => c.abort(this.#abort!.signal.reason));
    return c.signal;
  }

  #emit(event: AgentEvent): void {
    for (const sub of this.#subscribers) {
      try {
        sub(event);
      } catch {
        /* best-effort */
      }
    }
  }

  #emitQueueUpdate(): void {
    this.#emit({
      type: "queue_update",
      steering: this.#steering.map((m) => m.text),
      followUp: this.#followUp.map((m) => m.text),
    } as AgentEvent);
  }
}
