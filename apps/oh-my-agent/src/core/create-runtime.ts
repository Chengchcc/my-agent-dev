import type { OmaLoopResult } from "@chengchenccc/agent";
import type {
  BackendInputMessage,
  BackendRunInput,
  BackendRunOutcome,
  BackendRunSegment,
  ProjectedHistoryItem,
} from "@chengchenccc/agent-backend";
import type { ModelRuntime } from "@chengchenccc/ai";
import type { RunEventEnvelope } from "../protocol/index.js";
import { mapRunEvent } from "../protocol/index.js";
import { assembleRunRuntime, type RunRuntime } from "./run-runtime.js";

/** The single Runtime assembly entry point for the Oma product.
 *  Every mode (print / json / rpc / future TUI) builds the SAME runtime from
 *  these options: fresh in-memory SessionStore per Runtime, no state shared
 *  across Runtimes except the process-level Provider/ModelRuntime. */
export interface CreateOmaRuntimeOptions {
  runId: string;
  /** Canonical `<provider>/<model>` id of the Run's model: the context
   *  budget and summarizer bind to it. */
  modelId: string;
  workspaceRoot: string;
  workspaceAccess: "read_only" | "read_write";
  modelRuntime: ModelRuntime;
  skillRoots: readonly string[];
  /** The resumed CLI session transcript (ADR 0003 decision 6), validated
   *  messages from the session file. Seeds the loop's store in place of the
   *  retired wire `history` projection. Absent = fresh session. */
  sessionTranscript?: readonly ProjectedHistoryItem[];
  /** Called for every runtime event as a wire envelope (id/type/data), after
   *  the in-process segment stream. Used by RPC mode to forward events to
   *  stdout; print/json modes leave it unset. */
  onEvent?: (envelope: RunEventEnvelope) => void;
}

/** One Runtime = one Run. The loop runs directly in-process; steer injects
 *  into the live loop; stop aborts it; close tears down MCP clients and the
 *  SessionStore. */
export interface OmaRuntime {
  /** Start the Run's loop. Returns the segment whose outcome is the Run's
   *  ONLY terminal result. A Runtime accepts exactly one run(). */
  run(input: BackendRunInput<"oma">): Promise<BackendRunSegment<"oma">>;
  /** Inject a steer input into the live loop. Throws when no loop is live. */
  steer(input: BackendInputMessage): Promise<void>;
  /** Request cancellation of the live loop. The segment's outcome still
   *  resolves (aborted). Safe to call before run() starts the loop. */
  stop(): Promise<void>;
  /** Close MCP clients and the in-memory Store. Call after the run settles. */
  close(): Promise<void>;
  /** Compaction summaries from this run's loop; read before close(). */
  compactions(): Promise<string[]>;
}

function mapLoopResult(result: OmaLoopResult): BackendRunOutcome {
  if (result.status === "completed") {
    // No fabricated output: when the loop persisted no canonical messages,
    // omit them rather than inventing an empty sequence.
    return {
      status: "completed",
      ...(result.messages && result.messages.length > 0 ? { messages: result.messages } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.title ? { title: result.title } : {}),
    };
  }
  if (result.status === "stopped") {
    return { status: "aborted", error: result.error ?? "stopped by user" };
  }
  return { status: "failed", error: result.error ?? "loop failed" };
}

export async function createOmaRuntime(options: CreateOmaRuntimeOptions): Promise<OmaRuntime> {
  const rt: RunRuntime = await assembleRunRuntime({
    workspaceRoot: options.workspaceRoot,
    workspaceAccess: options.workspaceAccess,
    runId: options.runId,
    modelRuntime: options.modelRuntime,
    modelId: options.modelId,
    skillRoots: options.skillRoots,
  });

  let stopRequested = false;
  let started = false;

  return {
    async run(input) {
      if (started) {
        throw new Error(`runtime ${options.runId} already ran once (one Runtime = one Run)`);
      }
      started = true;

      // run() resolves only when the loop is at a SAFE steer boundary
      // (message_start fires after acceptingSteer=true) or settled without
      // starting - acceptance therefore implies steer/abort are routable,
      // with no timing window.
      let liveResolve: (() => void) | null = null;
      const live = new Promise<void>((resolve) => {
        liveResolve = resolve;
      });
      let liveSettled = false;
      const settleLive = (): void => {
        if (liveSettled) return;
        liveSettled = true;
        liveResolve?.();
      };

      // Stop landing before the loop starts settles aborted without running.
      if (stopRequested) {
        settleLive();
        const outcome: BackendRunOutcome = { status: "aborted", error: "stopped before start" };
        return {
          events: (async function* () {})() as AsyncIterable<never>,
          outcome: Promise.resolve(outcome),
          stop: async () => {},
        };
      }

      // Push-based event fan-out: onEvent envelopes feed both the RPC stdout
      // writer and the in-process segment stream.
      const queue: Parameters<NonNullable<CreateOmaRuntimeOptions["onEvent"]>>[0][] = [];
      const waiters: Array<() => void> = [];
      let closed = false;
      let seq = 0;
      const unsubscribe = rt.session.onEvent((event) => {
        if (event.type === "recap_update")
          console.error("[create-runtime] onEvent received recap_update");
        if (event.type === "message_start" || event.type === "agent_end") settleLive();
        const envelope: RunEventEnvelope = { id: seq++, type: event.type, data: event as never };
        queue.push(envelope);
        options.onEvent?.(envelope);
        for (const w of waiters.splice(0)) w();
      });

      // The Run's store is seeded with the full Product history + the current
      // input by the loop itself (buildLoopInput appends history + meta +
      // input atomically). Create the session root first.
      await rt.store.create({
        sessionId: options.runId,
        backendKind: "oma",
        workspaceRoot: options.workspaceRoot,
        leafEntryId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      rt.setActiveRun(input.run as never);
      const outcomePromise = (async (): Promise<BackendRunOutcome> => {
        try {
          const result = await rt.session.startLoop({
            history: options.sessionTranscript ?? [],
            input: input.input,
            run: input.run as never,
            workspace: input.workspace,
            metadata: input.metadata,
          });
          return mapLoopResult(result);
        } catch (caught) {
          const errObj = caught instanceof Error ? caught : new Error(String(caught));
          return { status: "failed", error: errObj.message };
        } finally {
          settleLive(); // loop settled without starting: live is still resolved
          unsubscribe();
          closed = true;
          for (const w of waiters.splice(0)) w();
        }
      })();

      const segment: BackendRunSegment<"oma"> = {
        events: (async function* () {
          while (!closed || queue.length > 0) {
            if (queue.length > 0) {
              yield mapRunEvent(queue.shift()!);
              continue;
            }
            if (closed) return;
            await new Promise<void>((resolve) => waiters.push(resolve));
          }
        })(),
        outcome: outcomePromise,
        stop: async () => {
          rt.session.stop();
        },
      };
      // Acceptance = live: run() resolves once steer/abort are routable.
      await live;
      return segment;
    },

    async steer(input) {
      rt.session.steer(input);
    },

    async stop() {
      stopRequested = true;
      rt.session.stop();
    },

    async close() {
      await rt.close();
    },

    /** Compaction summaries produced by this run's loop (empty when the
     *  run never compacted). Read the store BEFORE close(). */
    async compactions(): Promise<string[]> {
      const branch = await rt.store.readBranch(options.runId);
      const summaries: string[] = [];
      for (const entry of branch) {
        if (entry.type === "compaction" && entry.summary) summaries.push(entry.summary);
      }
      return summaries;
    },
  };
}
