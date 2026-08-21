export type CliMode = "print" | "json" | "rpc" | "tui";

export interface CliArgs {
  mode: CliMode;
  prompt: string;
  listModels: boolean;
  /** Canonical `<provider>/<model>` id; undefined = first available model. */
  model?: string;
  /** Resume a session file by id (TUI mode). */
  session?: string;
}

export class UsageError extends Error {}

const USAGE = `oma - Oma product CLI

Usage:
  oma -p "<prompt>"              print mode: one Run, final text on stdout
  oma "<prompt>"                 print mode shorthand
  oma --mode json "<prompt>"     json mode: all events + one outcome as JSONL
  oma --mode rpc                 rpc mode: stdin/stdout JSONL protocol
  oma --list-models              print the model catalog as JSON
  oma --model <provider/model> -p "<prompt>"
                                          pick a model by canonical id
                                          (default: first available model)

Piped stdin (print/json modes):
  cat file | oma -p "Review"
  git diff | oma --mode json "Review"
  cat error.log | oma -p          (stdin only)
`;

const MODES = ["print", "json", "rpc", "tui"];

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
      if (!value || !MODES.includes(value)) {
        throw new UsageError(`--mode requires one of: ${MODES.join(" | ")}`);
      }
      modeFlag = value;
      i++;
    } else if (arg.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length);
      if (!MODES.includes(value)) {
        throw new UsageError(`--mode requires one of: ${MODES.join(" | ")}`);
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
    } else if (arg === "--session") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new UsageError("--session requires a session id");
      }
      args.session = value;
      i++;
    } else if (arg.startsWith("--session=")) {
      const value = arg.slice("--session=".length);
      if (!value) throw new UsageError("--session requires a session id");
      args.session = value;
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
