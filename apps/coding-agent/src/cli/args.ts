export type CliMode = "print" | "json" | "rpc";

export interface CliArgs {
  mode: CliMode;
  prompt: string;
  listModels: boolean;
  listModelsJson: boolean;
}

export class UsageError extends Error {}

const USAGE = `coding-agent - Coding Agent product CLI

Usage:
  coding-agent -p "<prompt>"              print mode: one Run, final text on stdout
  coding-agent --mode json "<prompt>"     json mode: all events + one outcome as JSONL
  coding-agent --mode rpc                 rpc mode: stdin/stdout JSONL protocol
  coding-agent --list-models [--json]     print the model catalog as JSON
`;

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { mode: "print", prompt: "", listModels: false, listModelsJson: false };
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
    } else if (arg === "--json") {
      args.listModelsJson = true;
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
  if (args.mode !== "rpc" && !args.listModels && !args.prompt) {
    throw new UsageError(`no prompt given\n\n${USAGE}`);
  }
  return args;
}
