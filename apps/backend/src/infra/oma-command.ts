import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { OmaCommandConfig } from "@chengchenccc/adapter-oma-agent";
import type { BackendConfig } from "../config.js";

/** Resolve the Oma process command for a Backend deployment.
 *
 *  - `OMA_BIN` configured (production): run the built `dist/cli.js`
 *    (or a deployment wrapper) with `--mode rpc`.
 *  - Not configured (monorepo dev/test): run the SOURCE CLI entry with the
 *    same Bun executable as the Backend — no global install required.
 *
 *  BOTH paths pass `--mode rpc` explicitly: without it the child falls into
 *  print mode and blocks reading piped stdin until EOF, while the adapter
 *  keeps stdin open for JSONL — a permanent deadlock. Never a shell string:
 *  `executable` + explicit `args` only (no argument injection). Secrets
 *  travel exclusively via env. */
export function resolveOmaCommand(
  config: BackendConfig,
  opts: {
    env?: Readonly<Record<string, string | undefined>>;
    appEntry?: string;
  } = {},
): OmaCommandConfig {
  const env = {
    // Provider credentials reach the child via env only (the child's
    // registerProvidersFromCatalog reads process.env). Forward the
    // provider env subset + runtime catalog location; the child resolves
    // which providers have keys. No provider is required — a clean machine
    // with zero keys still boots; agents get configured later.
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OMA_HOME: process.env.OMA_HOME,
    // Test determinism knobs (fake provider) - forwarded so in-process
    // smokes get the same scripted child as the integration harness.
    OMA_FAKE_PROVIDER: process.env.OMA_FAKE_PROVIDER,
    OMA_FAKE_TEXT: process.env.OMA_FAKE_TEXT,
    OMA_FAKE_TOOL: process.env.OMA_FAKE_TOOL,
    OMA_FAKE_TOOLS_RECORD: process.env.OMA_FAKE_TOOLS_RECORD,
    ...opts.env,
  };

  if (config.omaBin) {
    return { executable: config.omaBin, args: ["--mode", "rpc"], env };
  }

  // Monorepo dev/test fallback: same Bun executable as the Backend, running
  // the Oma's source CLI directly. apps/backend/src/infra →
  // ../../.. → apps/ → oma/src/cli.ts
  const appEntry = opts.appEntry ?? resolve(import.meta.dir, "../../../oh-my-agent/src/cli.ts");
  if (!existsSync(appEntry)) {
    throw new Error(`Oma source entry not found: ${appEntry}`);
  }

  return {
    executable: process.execPath,
    args: [appEntry, "--mode", "rpc"],
    env,
  };
}
