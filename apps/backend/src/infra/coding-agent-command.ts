import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CodingAgentCommandConfig } from "@my-agent-team/adapter-coding-agent";
import type { BackendConfig } from "../config.js";

/** Resolve the Coding Agent process command for a Backend deployment.
 *
 *  - `CODING_AGENT_BIN` configured (production): run the built `dist/cli.js`
 *    (or a deployment wrapper) with `--mode rpc`.
 *  - Not configured (monorepo dev/test): run the SOURCE CLI entry with the
 *    same Bun executable as the Backend — no global install required.
 *
 *  BOTH paths pass `--mode rpc` explicitly: without it the child falls into
 *  print mode and blocks reading piped stdin until EOF, while the adapter
 *  keeps stdin open for JSONL — a permanent deadlock. Never a shell string:
 *  `executable` + explicit `args` only (no argument injection). Secrets
 *  travel exclusively via env. */
export function resolveCodingAgentCommand(
  config: BackendConfig,
  opts: {
    env?: Readonly<Record<string, string | undefined>>;
    appEntry?: string;
  } = {},
): CodingAgentCommandConfig {
  const env = {
    ...(config.anthropicApiKey ? { ANTHROPIC_API_KEY: config.anthropicApiKey } : {}),
    ...(config.anthropicBaseUrl ? { ANTHROPIC_BASE_URL: config.anthropicBaseUrl } : {}),
    // The Product Tools service token reaches the child ONLY via env —
    // never through command args, run input, entrypoint URL or logs.
    ...(config.productToolsServiceToken
      ? { CODING_AGENT_PRODUCT_TOOL_TOKEN: config.productToolsServiceToken }
      : {}),
    ...opts.env,
  };

  if (config.codingAgentBin) {
    return { executable: config.codingAgentBin, args: ["--mode", "rpc"], env };
  }

  // Monorepo dev/test fallback: same Bun executable as the Backend, running
  // the Coding Agent's source CLI directly. apps/backend/src/infra →
  // ../../.. → apps/ → coding-agent/src/cli.ts
  const appEntry = opts.appEntry ?? resolve(import.meta.dir, "../../../coding-agent/src/cli.ts");
  if (!existsSync(appEntry)) {
    throw new Error(`Coding Agent source entry not found: ${appEntry}`);
  }

  return {
    executable: process.execPath,
    args: [appEntry, "--mode", "rpc"],
    env,
  };
}
