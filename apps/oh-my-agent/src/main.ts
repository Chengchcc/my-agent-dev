import { createModelRuntime } from "@chengchenccc/ai";
import { parseArgs, UsageError } from "./cli/args.js";
import { mergeInitialInput, readPipedStdin } from "./cli/initial-input.js";
import { buildBackendModelCatalog } from "./core/runtime/model-catalog.js";
import { registerBuiltinProviders } from "./core/runtime/run-runtime.js";
import { runJsonMode } from "./modes/json-mode.js";
import { runPrintMode } from "./modes/print-mode.js";
import { runRpcMode } from "./modes/rpc/rpc-mode.js";
import { runTuiMode } from "./modes/tui/tui-mode.js";

export const OMA_VERSION = "0.1.0";

/** Parse args, run one CLI invocation, and return the process exit code.
 *  Never calls process.exit() - callers own exit-code assignment so stdout
 *  protocol output can flush. Pure enough to be imported from tests. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const modelRuntime = createModelRuntime();
  registerBuiltinProviders(modelRuntime, process.env);

  if (args.listModels) {
    // stdout carries ONLY the catalog JSON (the adapter parses it).
    const catalog = await buildBackendModelCatalog({ modelRuntime });
    process.stdout.write(`${JSON.stringify(catalog)}\n`);
    return 0;
  }

  if (args.mode === "rpc") {
    // RPC stdin is the JSONL command stream: NEVER pre-read it.
    const controller = runRpcMode({ modelRuntime });
    let signaled = false;
    const onSignal = (): void => {
      if (signaled) return;
      signaled = true;
      controller.stop();
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
    try {
      return await controller.promise;
    } finally {
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
    }
  }

  if (args.mode === "tui") {
    return runTuiMode({
      modelRuntime,
      workspaceRoot: process.cwd(),
      model: args.model,
      sessionId: args.session,
    });
  }

  // Standalone default: `oma` (or `oma "<prompt>"`) on a TTY opens the
  // TUI, with the positional prompt prefilled into the editor. Explicit
  // -p/--mode or a pipe stays one-shot print/json.
  if (!args.modeExplicit && process.stdin.isTTY) {
    return runTuiMode({
      modelRuntime,
      workspaceRoot: process.cwd(),
      model: args.model,
      sessionId: args.session,
      ...(args.prompt ? { initialPrompt: args.prompt } : {}),
    });
  }

  const prompt = mergeInitialInput({
    prompt: args.prompt,
    piped: await readPipedStdin(),
  });
  if (!prompt) {
    throw new UsageError(
      'bare oma opens the interactive TUI - run it in a terminal. Outside a terminal, give a prompt: oma -p "<prompt>" (or piped stdin)',
    );
  }

  const opts = { prompt, workspaceRoot: process.cwd(), modelRuntime, model: args.model };
  return args.mode === "json" ? runJsonMode(opts) : runPrintMode(opts);
}

/** CLI entry wrapper: run main() and map errors to stderr + exit codes.
 *  Used by src/cli.ts (the executable entry) and tests. */
export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  try {
    process.exitCode = await main(argv);
  } catch (err: unknown) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`[oma] failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
