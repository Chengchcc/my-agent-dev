/** Completion fan-out for background jobs (M-bash/M-eval): the tools own
 *  the registries, a UI surface (TUI) subscribes once per process and
 *  renders the settlement. Backend/RPC runs simply never set a listener —
 *  results stay pollable via jobAction as before. */

export interface BgJobCompletion {
  id: string;
  kind: "bash" | "eval";
  exitCode: number | null;
  timedOut: boolean;
  killed: boolean;
  /** Captured output tail (capped by the emitting tool). */
  output: string;
  isError: boolean;
}

type Listener = ((completion: BgJobCompletion) => void) | null;

let listener: Listener = null;

export function setBgJobCompletionListener(cb: Listener): void {
  listener = cb;
}

export function notifyBgJobCompletion(completion: BgJobCompletion): void {
  if (!listener) return;
  try {
    listener(completion);
  } catch {
    /* a broken UI listener never breaks the job */
  }
}
