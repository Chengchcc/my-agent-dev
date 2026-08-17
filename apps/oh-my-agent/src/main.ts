import { createModelRuntime } from "@chengchenccc/ai";
import { parseArgs, UsageError } from "./cli/args.js";
import { mergeInitialInput, readPipedStdin } from "./cli/initial-input.js";
import { buildBackendModelCatalog } from "./core/model-catalog.js";
import { registerBuiltinProviders } from "./core/run-runtime.js";
import { runJsonMode } from "./modes/json-mode.js";
import { runPrintMode } from "./modes/print-mode.js";
import { runRpcMode } from "./modes/rpc/rpc-mode.js";

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

  const prompt = mergeInitialInput({
    prompt: args.prompt,
    piped: await readPipedStdin(),
  });
  if (!prompt) {
    throw new UsageError("no prompt or piped stdin given");
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
