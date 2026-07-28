import type { Message } from "@my-agent-team/message";
import type { AgentEvent } from "./agent-event.js";
import type {
  Agent,
  AgentConfig,
  AgentEventListener,
  AgentRunOptions,
  AgentRuntime,
  ResumeCommand,
} from "./agent-options.js";
import { type Checkpointer, validateCheckpointer } from "../persistence/checkpointer.js";
import { inMemoryCheckpointer } from "../persistence/in-memory.js";
import { createContextStore } from "../context/context.js";
import { passthroughContextManager } from "../context/passthrough.js";
import type { EventLog } from "../persistence/event-log.js";
import type { InterruptStore } from "../persistence/interrupt-store.js";
import { consoleLogger } from "./logger.js";
import type { MessageStore } from "../persistence/message-store.js";
import type { HookContext } from "./plugin.js";
import { validatePlugins } from "./plugin.js";
import { createPluginRunner } from "./plugin-dispatcher.js";
import { Session } from "../persistence/session.js";
import { spanLoop } from "./span-loop.js";
import { memorySessionStorage } from "../persistence/memory-session-storage.js";
import { createThread } from "./thread.js";

export type { AgentEvent, Interrupt } from "./agent-event.js";
export { parseAgentEvent, safeParseAgentEvent } from "./agent-event.js";
export type {
  Agent,
  AgentConfig,
  AgentEventListener,
  AgentRunOptions,
  FollowUpQueue,
  ResumeCommand,
  SteeringQueue,
} from "./agent-options.js";

export async function createAgent(config: AgentConfig): Promise<Agent> {
  const sessionId = config.sessionId ?? crypto.randomUUID();
  // Accept either a composite Checkpointer (legacy shortcut) or explicit
  // split interfaces. Ponytail: derive the three from whichever is provided.
  const checkpointer: Checkpointer | undefined = config.checkpointer;
  const messageStore: MessageStore = config.messageStore ?? checkpointer ?? inMemoryCheckpointer();
  const eventLog: EventLog | undefined =
    config.eventLog ??
    (checkpointer?.appendEvent && checkpointer?.readEvents
      ? (checkpointer as EventLog)
      : undefined);
  const interruptStore: InterruptStore | undefined =
    config.interruptStore ??
    (checkpointer?.saveInterrupt && checkpointer?.consumeInterrupt
      ? (checkpointer as InterruptStore)
      : undefined);
  // Validate pairing on a composite checkpointer if one was given.
  if (checkpointer) validateCheckpointer(checkpointer);

  // Session: use provided session, or construct one over a memory storage.
  // ponytail: Session is the tree-structured persistence layer; messageStore
  // remains the flat persistence for backward compat. When a session is
  // provided, the caller owns its storage (e.g. SqliteSessionStorage).
  const session: Session = config.session ?? new Session(memorySessionStorage());

  let messages: Message[];
  if (config.messages) {
    messages = config.messages;
    messageStore.save(sessionId, messages).catch(() => {});
  } else {
    const loaded = await messageStore.load(sessionId);
    messages = loaded ?? [];
  }
  // Seed the session so refreshMessages() reflects the loaded history.
  // ponytail: only seed when the session is empty (e.g. new memory storage).
  // A caller-provided session (SessionManager.open) may already have entries
  // from persistent storage - skip to avoid duplicates.
  const branch = await session.getBranch();
  const sessionEmpty = branch.length === 0;
  if (sessionEmpty) {
    for (const m of messages) await session.appendMessage(m);
  }

  return createAgentInternal({
    ...config,
    messageStore,
    eventLog,
    interruptStore,
    session,
    sessionId,
    sessionEmpty,
    _initialMessages: messages,
  });
}

function createAgentInternal(
  config: AgentConfig & {
    _initialMessages: Message[];
    sessionId: string;
    messageStore: MessageStore;
    eventLog?: EventLog;
    interruptStore?: InterruptStore;
    session: Session;
    sessionEmpty?: boolean;
  },
): Agent {
  // Dirty when the session is empty but we have initial messages (e.g. fork
  // with a fresh session). flushSession reconciles on first save.
  const sessionEmpty = config.sessionEmpty ?? false;
  const thread = createThread(
    config._initialMessages,
    config.sessionId,
    config.session,
    sessionEmpty && config._initialMessages.length > 0,
  );
  const plugins = [...(config.plugins ?? [])];
  const tools = validatePlugins(plugins, config.tools);
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const systemPrompt = config.systemPrompt;
  const messageStore = config.messageStore;
  const eventLog = config.eventLog;
  const interruptStore = config.interruptStore;
  const contextManager = config.contextManager ?? passthroughContextManager();
  const logger = config.logger ?? consoleLogger({ level: "info" });
  const model = config.model;
  let running = false;

  const save = async (msgs: Message[]) => {
    try {
      await messageStore.save(thread.id, msgs);
    } catch (err) {
      logger.warn(`messageStore.save ${thread.id}`, err);
    }
    // ponytail: reconcile session with cache on save. Cheap no-op when clean.
    // Session errors are best-effort (the cache is the primary source).
    try {
      await thread.flushSession();
    } catch (err) {
      logger.warn(`thread.flushSession ${thread.id}`, err);
    }
  };

  const emptyStore = createContextStore();
  const pendingEvents: AgentEvent[] = [];
  const ctx: HookContext = {
    sessionId: thread.id,
    signal: undefined,
    logger,
    messageStore,
    eventLog,
    interruptStore,
    contextManager,
    emit: (event: AgentEvent) => {
      pendingEvents.push(event);
    },
    context: emptyStore,
  };

  const pluginRunner = createPluginRunner(plugins, ctx, logger);

  const subscribers = new Set<AgentEventListener>();

  const rt: AgentRuntime = {
    thread,
    plugins: pluginRunner,
    messageStore,
    eventLog,
    interruptStore,
    session: config.session,
    toolMap,
    contextManager,
    logger,
    model,
    tools,
    pendingEvents,
    save,
    spanId: thread.id,
    toolStates: [],
    assistantBlocks: [],
    subscribers,
    context: ctx.context,
    metaContext: config.metaContext,
  };

  function spanLoopOpts(opts: AgentRunOptions) {
    return {
      signal: opts.signal,
      maxSteps: opts.maxSteps ?? 32,
      stream: opts.stream,
      maxForceContinues: opts.maxForceContinues,
      steering: opts.steering,
      followUp: opts.followUp,
    };
  }

  async function* withSubscribers(gen: AsyncGenerator<AgentEvent>): AsyncGenerator<AgentEvent> {
    for await (const event of gen) {
      yield event;
      for (const sub of subscribers) sub(event);
    }
  }

  return {
    thread,

    fork(msgs, id): Agent {
      const newId = id ?? crypto.randomUUID();
      if (id && id === thread.id) {
        throw new Error(
          "Cannot fork with the same sessionId as the parent. Pass a new id or omit it.",
        );
      }
      return createAgentInternal({
        ...config,
        plugins: [...plugins],
        sessionId: newId,
        messageStore,
        eventLog,
        interruptStore,
        session: new Session(memorySessionStorage()),
        sessionEmpty: true,
        _initialMessages: msgs ?? structuredClone(thread.messages),
      });
    },

    subscribe(listener: AgentEventListener): () => void {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },

    async *run(input: string, opts: AgentRunOptions = {}) {
      if (running)
        throw new Error("Agent is already running. Use fork() for concurrent conversations.");
      running = true;
      ctx.signal = opts.signal;
      rt.spanId = opts.spanId ?? crypto.randomUUID();
      ctx.span = await config.startSpan?.(rt.spanId, thread.id, opts.origin);
      ctx.context = opts.context ?? emptyStore;
      rt.context = ctx.context;
      rt.toolStates = [];
      rt.assistantBlocks = [];
      let runStatus: "succeeded" | "error" | "interrupted" = "succeeded";
      let lastError: string | undefined;
      try {
        yield { type: "agent_start" as const, spanId: rt.spanId };
        opts.signal?.throwIfAborted();
        if (systemPrompt && !thread.messages.some((m) => m.role === "system")) {
          thread.messages.unshift({ role: "system", text: systemPrompt });
          thread.markDirty();
        }
        if (input.trim()) {
          thread.push({ role: "user", text: input });
          await save(thread.messages);
          await rt.eventLog?.appendEvent(thread.id, rt.spanId, {
            type: "user_input",
            content: input,
            ts: Date.now(),
          });
        }

        const seeded = await pluginRunner.fireBeforeRun(thread.messages);
        if (seeded !== thread.messages) {
          thread.messages.length = 0;
          thread.messages.push(...seeded);
          thread.markDirty();
          await save(thread.messages);
        }
        for (const ev of pendingEvents.splice(0)) yield ev;
        yield* withSubscribers(spanLoop(rt, spanLoopOpts(opts)));
      } catch (err) {
        runStatus = opts.signal?.aborted ? "interrupted" : "error";
        lastError = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        ctx.span?.end(runStatus, lastError);
        yield { type: "agent_end" as const, spanId: rt.spanId, status: runStatus };
        ctx.span = undefined;
        ctx.context = emptyStore;
        running = false;
        ctx.signal = undefined;
      }
    },

    async *continue(opts: AgentRunOptions = {}) {
      if (running)
        throw new Error("Agent is already running. Use fork() for concurrent conversations.");
      if (!thread.messages.some((m) => m.role === "user")) {
        throw new Error(
          "Cannot continue without a user message in checkpoint. Use run() for fresh input.",
        );
      }
      running = true;
      ctx.signal = opts.signal;
      rt.spanId = opts.spanId ?? crypto.randomUUID();
      ctx.span = await config.startSpan?.(rt.spanId, thread.id, opts.origin);
      ctx.context = opts.context ?? emptyStore;
      rt.context = ctx.context;
      rt.toolStates = [];
      rt.assistantBlocks = [];
      let runStatus: "succeeded" | "error" | "interrupted" = "succeeded";
      let lastError: string | undefined;
      try {
        if (systemPrompt && !thread.messages.some((m) => m.role === "system")) {
          thread.messages.unshift({ role: "system", text: systemPrompt });
          thread.markDirty();
          await save(thread.messages);
        }
        const seeded = await pluginRunner.fireBeforeRun(thread.messages);
        if (seeded !== thread.messages) {
          thread.messages.length = 0;
          thread.messages.push(...seeded);
          thread.markDirty();
          await save(thread.messages);
        }
        for (const ev of pendingEvents.splice(0)) yield ev;
        yield* withSubscribers(spanLoop(rt, spanLoopOpts(opts)));
      } catch (err) {
        runStatus = opts.signal?.aborted ? "interrupted" : "error";
        lastError = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        ctx.span?.end(runStatus, lastError);
        yield { type: "agent_end" as const, spanId: rt.spanId, status: runStatus };
        ctx.span = undefined;
        ctx.context = emptyStore;
        running = false;
        ctx.signal = undefined;
      }
    },

    async *resume(command: ResumeCommand, opts: AgentRunOptions = {}) {
      if (running)
        throw new Error("Agent is already running. Use fork() for concurrent conversations.");
      running = true;
      ctx.signal = opts.signal;
      rt.spanId = opts.spanId ?? crypto.randomUUID();
      ctx.span = await config.startSpan?.(rt.spanId, thread.id, opts.origin);
      ctx.context = opts.context ?? emptyStore;
      rt.context = ctx.context;
      rt.toolStates = [];
      rt.assistantBlocks = [];
      let runStatus: "succeeded" | "error" | "interrupted" = "succeeded";
      let lastError: string | undefined;
      try {
        yield { type: "agent_start" as const, spanId: rt.spanId };
        const it = await rt.interruptStore?.consumeInterrupt(thread.id);
        if (!it) throw new Error("No pending interrupt for this thread");

        await rt.eventLog?.appendEvent(thread.id, rt.spanId, {
          type: "resume",
          ts: Date.now(),
        });

        const placeholderIdx = thread.messages.findLastIndex(
          (m) =>
            Array.isArray(m.blocks) &&
            m.blocks.some(
              (b) =>
                b.type === "tool_result" &&
                b.tool_use_id === it.pendingTool.call.id &&
                b.is_error === true,
            ),
        );
        const realResult = {
          type: "tool_result" as const,
          tool_use_id: it.pendingTool.call.id,
          content: command.message ?? (command.approved ? "approved" : "denied by user"),
          is_error: !command.approved,
        };
        if (placeholderIdx >= 0) {
          thread.messages[placeholderIdx] = { role: "user", blocks: [realResult] };
          thread.markDirty();
        } else {
          thread.push({ role: "user", blocks: [realResult] });
        }
        await save(thread.messages);
        yield* withSubscribers(spanLoop(rt, spanLoopOpts(opts)));
      } catch (err) {
        runStatus = opts.signal?.aborted ? "interrupted" : "error";
        lastError = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        ctx.span?.end(runStatus, lastError);
        yield { type: "agent_end" as const, spanId: rt.spanId, status: runStatus };
        ctx.span = undefined;
        ctx.context = emptyStore;
        running = false;
        ctx.signal = undefined;
      }
    },
  };
}
