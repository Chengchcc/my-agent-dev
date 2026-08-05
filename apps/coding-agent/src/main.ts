import { createModelRuntime } from "@my-agent-team/ai";
import { parseArgs, UsageError } from "./cli/args.js";
import { buildBackendModelCatalog } from "./core/model-catalog.js";
import { registerBuiltinProviders } from "./core/run-runtime.js";
import { runJsonMode } from "./modes/json-mode.js";
import { runPrintMode } from "./modes/print-mode.js";
import { runRpcMode } from "./modes/rpc/rpc-mode.js";

export const CODING_AGENT_VERSION = "0.1.0";

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

  const workspaceRoot = process.cwd();

  switch (args.mode) {
    case "rpc": {
      const controller = runRpcMode({ modelRuntime });
      let signaled = false;
      const onSignal = (): void => {
        if (signaled) return;
        signaled = true;
        controller.stop();
      };
      process.on("SIGTERM", onSignal);
      process.on("SIGINT", onSignal);
      return await controller.promise;
    }
    case "json":
      return runJsonMode({ prompt: args.prompt, workspaceRoot, modelRuntime });
    case "print":
      return runPrintMode({ prompt: args.prompt, workspaceRoot, modelRuntime });
  }
}

if (import.meta.main) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((err: unknown) => {
      if (err instanceof UsageError) {
        process.stderr.write(`${err.message}\n`);
        process.exit(2);
      }
      process.stderr.write(
        `[coding-agent] failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
}
