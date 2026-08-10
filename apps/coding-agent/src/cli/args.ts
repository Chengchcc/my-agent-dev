export type CliMode = "print" | "json" | "rpc";

export interface CliArgs {
  mode: CliMode;
  prompt: string;
  listModels: boolean;
  /** Canonical `<provider>/<model>` id; undefined = first available model. */
  model?: string;
}

export class UsageError extends Error {}

const USAGE = `coding-agent - Coding Agent product CLI

Usage:
  coding-agent -p "<prompt>"              print mode: one Run, final text on stdout
  coding-agent "<prompt>"                 print mode shorthand
  coding-agent --mode json "<prompt>"     json mode: all events + one outcome as JSONL
  coding-agent --mode rpc                 rpc mode: stdin/stdout JSONL protocol
  coding-agent --list-models              print the model catalog as JSON
  coding-agent --model <provider/model> -p "<prompt>"
                                          pick a model by canonical id
                                          (default: first available model)

Piped stdin (print/json modes):
  cat file | coding-agent -p "Review"
  git diff | coding-agent --mode json "Review"
  cat error.log | coding-agent -p          (stdin only)
`;

/** Parse argv SYNTAX only: whether a run actually has an input (prompt or
 *  piped stdin) is decided in main() after stdin is read. */
export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { mode: "print", prompt: "", listModels: false };
  const positional: string[] = [];
  let modeFlag: string | null = null;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === "-p") {
      modeFlag = "print";
    } else if (arg === "--mode") {
      const value = argv[i + 1];
      if (!value || !["print", "json", "rpc"].includes(value)) {
        throw new UsageError("--mode requires one of: print | json | rpc");
      }
      modeFlag = value;
      i++;
    } else if (arg.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length);
      if (!["print", "json", "rpc"].includes(value)) {
        throw new UsageError("--mode requires one of: print | json | rpc");
      }
      modeFlag = value;
    } else if (arg === "--list-models") {
      args.listModels = true;
    } else if (arg === "--model") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new UsageError("--model requires a canonical <provider>/<model> id");
      }
      args.model = value;
      i++;
    } else if (arg.startsWith("--model=")) {
      const value = arg.slice("--model=".length);
      if (!value) throw new UsageError("--model requires a canonical <provider>/<model> id");
      args.model = value;
    } else if (arg === "--help" || arg === "-h") {
      throw new UsageError(USAGE);
    } else if (arg.startsWith("-")) {
      throw new UsageError(`unknown option: ${arg}\n\n${USAGE}`);
    } else {
      positional.push(arg);
    }
    i++;
  }
  if (modeFlag) args.mode = modeFlag as CliMode;
  args.prompt = positional.join(" ");
  return args;
}
