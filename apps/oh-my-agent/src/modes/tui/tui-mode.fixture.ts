import { createModelRuntime } from "@chengchenccc/ai";
import { registerBuiltinProviders } from "../../core/runtime/run-runtime.js";
import type { TuiCommand, TuiIo } from "./tui-mode.js";
import type { TuiViewState } from "./view-state.js";

/** Scripted TuiIo: feeds idle inputs sequentially, captures renders.
 *  Live submits (during a run) are recorded and forwarded to the handler. */
export function scriptedIo(inputs: string[]): TuiIo & {
  renders: TuiViewState[];
  live: string[];
  liveCommands: string[];
  headers: Array<{ model?: string; sessionId?: string; title?: string; context?: string }>;
  toolRendered: Promise<void>;
  submitLive: (text: string) => void;
  sendLiveCommand: (text: string) => void;
  sendCommand: (cmd: TuiCommand) => void;
} {
  const renders: TuiViewState[] = [];
  const live: string[] = [];
  const liveCommands: string[] = [];
  const headers: Array<{ model?: string; sessionId?: string; title?: string; context?: string }> =
    [];
  let i = 0;
  let liveHandler: ((text: string) => void) | null = null;
  let liveCommandHandler: ((text: string) => void) | null = null;
  let commandHandler: ((cmd: TuiCommand) => void) | null = null;
  const { promise: toolRendered, resolve: markToolRendered } = Promise.withResolvers<void>();
  return {
    renders,
    live,
    liveCommands,
    headers,
    toolRendered,
    render: (state) => {
      renders.push(state);
      if (
        state.runs.some((run) => run.items.some((item) => item.kind === "tool" && item.streaming))
      ) {
        markToolRendered();
      }
    },
    waitForInput: () => Promise.resolve(i < inputs.length ? inputs[i++]! : null),
    onLiveInput: (handler) => {
      liveHandler = handler;
    },
    onLiveCommand: (handler) => {
      liveCommandHandler = handler;
    },
    onCommand: (handler) => {
      commandHandler = handler;
    },
    setHeader: (info) => {
      headers.push(info);
    },
    submitLive: (text: string) => {
      live.push(text);
      liveHandler?.(text);
    },
    sendLiveCommand: (text: string) => {
      liveCommands.push(text);
      liveCommandHandler?.(text);
    },
    sendCommand: (cmd: TuiCommand) => {
      commandHandler?.(cmd);
    },
    pickBranchTree: async () => null,
    close: () => {},
  };
}

export function testModelRuntime() {
  const modelRuntime = createModelRuntime();
  process.env.OMA_FAKE_PROVIDER = "1";
  registerBuiltinProviders(modelRuntime, process.env);
  return modelRuntime;
}
