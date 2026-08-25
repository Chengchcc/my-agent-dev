import type { BackendModelCatalog } from "@chengchenccc/agent-contract";
import { OmaProcessError } from "./backend.js";
import { type OmaCommandConfig, type SpawnedOmaProcess, spawnOmaProcess } from "./process.js";
import { modelCatalogResponseSchema } from "./protocol.js";

/** Model catalog over the Oma CLI: spawns
 *  `oma --list-models --json` and parses the canonical catalog.
 *  The Product Backend never maintains its own Provider Registry. Successful
 *  results are cached per instance; no catalog service exists. */

const LIST_MODELS_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 1 * 1024 * 1024;

export class OmaModelCatalog {
  private readonly command: OmaCommandConfig;
  private cached: BackendModelCatalog | null = null;

  constructor(command: OmaCommandConfig) {
    this.command = command;
  }

  async list(): Promise<BackendModelCatalog> {
    if (this.cached) return this.cached;
    // --list-models is mode-independent (the CLI checks it before mode
    // dispatch), and the run command carries --mode rpc - strip the mode
    // pair so the child never sees a meaningless `--mode rpc --list-models`.
    const base = this.command.args ?? [];
    const listArgs = base.filter((a) => a !== "--mode" && a !== "rpc");
    const listCommand: OmaCommandConfig = {
      executable: this.command.executable,
      args: [...listArgs, "--list-models"],
      env: this.command.env,
    };
    let proc: SpawnedOmaProcess;
    try {
      proc = spawnOmaProcess(listCommand, { cwd: process.cwd() });
    } catch (err) {
      throw new OmaProcessError("spawn_failed", err instanceof Error ? err.message : String(err));
    }
    const lines: string[] = [];
    let bytes = 0;
    let overflow = false;
    for await (const line of proc.stdout) {
      bytes += line.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        overflow = true;
        break;
      }
      lines.push(line);
    }
    if (overflow) {
      proc.kill();
      throw new OmaProcessError(
        "process_failed",
        "oma --list-models output exceeded the 1 MiB bound",
      );
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const code = await Promise.race([
      proc.exit,
      new Promise<null>((r) => {
        timer = setTimeout(() => r(null), LIST_MODELS_TIMEOUT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (code !== 0) {
      if (code === null) proc.kill();
      throw new OmaProcessError(
        "process_failed",
        `oma --list-models exited with code ${code}: ${proc.stderrTail.text()}`.slice(0, 2000),
      );
    }
    try {
      const parsed = modelCatalogResponseSchema.parse(JSON.parse(lines.join("\n")));
      this.cached = parsed;
      return parsed;
    } catch (err) {
      throw new OmaProcessError(
        "process_failed",
        `malformed --list-models output: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
