import { createModelRuntime } from "@chengchenccc/ai";
import type { VirtualTerminal } from "@chengchenccc/tui";
import { registerBuiltinProviders } from "../../core/runtime/run-runtime.js";

export function fakeModelRuntime() {
  const modelRuntime = createModelRuntime();
  process.env.OMA_FAKE_PROVIDER = "1";
  registerBuiltinProviders(modelRuntime, process.env);
  return modelRuntime;
}

/** Join the viewport into one string for substring assertions. */
export function screen(vt: VirtualTerminal): string {
  return vt.getViewport().join("\n");
}

export async function typeAndSubmit(vt: VirtualTerminal, text: string): Promise<void> {
  if (text) vt.sendInput(text);
  await vt.waitForRender();
  vt.sendInput("\r");
  await vt.waitForRender();
}

/** /exit now requires a second confirmation; this sends both. */
export async function quitTui(vt: VirtualTerminal): Promise<void> {
  await typeAndSubmit(vt, "/exit");
  await typeAndSubmit(vt, "/exit");
}

/** Poll the viewport until a substring/regex appears (event-driven
 *  alternative to fixed sleeps for async run transitions). */
export async function waitForText(
  vt: VirtualTerminal,
  needle: string | RegExp,
  ms: number,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const haystack = screen(vt);
    const hit = needle instanceof RegExp ? needle.test(haystack) : haystack.includes(needle);
    if (hit) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for text: ${String(needle)}`);
}
