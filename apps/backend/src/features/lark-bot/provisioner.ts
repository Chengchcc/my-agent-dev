/**
 * M15.1: Lark profile provisioner abstraction.
 * Isolates lark-cli config init from business logic so that
 * Mira managed, self-hosted, and legacy stdin paths can coexist.
 */

import { spawn } from "node:child_process";

export type LarkProfileProvisionerKind = "cli_setup" | "mira_managed" | "legacy_secret_stdin";

export interface LarkProfileSetupResult {
  setupId: string;
  profileRef: string;
  url: string; // set after waitForCompletion resolves
  waitForCompletion: Promise<string>; // resolves with the setup URL
  cancel(): Promise<void>;
}

export interface LarkProfileProvisioner {
  readonly kind: LarkProfileProvisionerKind;
  start(input: {
    agentId: string;
    profileRef: string;
    brand: "feishu" | "lark";
    timeoutMs: number;
    /** Streamed as soon as the setup URL is visible in child output —
     *  lark-cli may print it to stdout (TTY) or stderr (piped). */
    onUrl?: (url: string) => void;
  }): Promise<LarkProfileSetupResult>;
  probe(profileRef: string): Promise<"ready" | "not_ready" | "invalid">;
}

// ─── CLI Setup Provisioner (default) ───

const SETUP_URL_PATTERN = /https:\/\/open\.(?:feishu|larkoffice)\.cn\/[^\s]+/;

export class CliSetupProvisioner implements LarkProfileProvisioner {
  readonly kind: LarkProfileProvisionerKind = "cli_setup";

  async start(input: {
    agentId: string;
    profileRef: string;
    brand: "feishu" | "lark";
    timeoutMs: number;
    onUrl?: (url: string) => void;
  }): Promise<LarkProfileSetupResult> {
    const { profileRef, brand, timeoutMs, onUrl } = input;

    const child = spawn(
      "lark-cli",
      ["config", "init", "--new", "--name", profileRef, "--brand", brand],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stderr = "";
    // Combined buffer: with a piped stdout (spawn default) lark-cli prints
    // the setup URL to stderr, so the URL must be parsed from both streams.
    let buf = "";
    let urlParsed = false;
    const tryParseUrl = () => {
      if (urlParsed) return;
      const m = buf.match(SETUP_URL_PATTERN);
      if (m) {
        urlParsed = true;
        onUrl?.(m[0]);
      }
    };

    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      tryParseUrl();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      buf += d.toString();
      tryParseUrl();
    });

    // URL is parsed from the combined buffer in the exit handler (after all
    // data has arrived); the streaming onUrl above surfaces it earlier.
    let url = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    const waitForCompletion = new Promise<string>((resolve, reject) => {
      child.on("exit", (code) => {
        clearTimeout(timer);
        // Parse URL now that all data has arrived
        const match = buf.match(SETUP_URL_PATTERN);
        url = match?.[0] ?? "";
        if (timedOut) {
          reject(new Error("setup timed out"));
        } else if (code === 0) {
          resolve(url);
        } else {
          reject(new Error(`lark-cli config init exited ${code}: ${stderr.slice(0, 200)}`));
        }
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        const code = (err as NodeJS.ErrnoException).code;
        reject(
          code === "ENOENT"
            ? new Error("lark-cli not found — install lark-cli or configure a managed provisioner")
            : err,
        );
      });
    });

    return {
      setupId: `setup_${crypto.randomUUID()}`,
      profileRef,
      url, // resolved after waitForCompletion settles — caller reads via get(setupId)
      waitForCompletion,
      async cancel() {
        clearTimeout(timer);
        // SIGTERM only — never SIGKILL (respects CLI cleanup)
        if (child.exitCode === null) {
          child.kill("SIGTERM");
        }
      },
    };
  }

  async probe(profileRef: string): Promise<"ready" | "not_ready" | "invalid"> {
    return new Promise((resolve) => {
      const child = spawn("lark-cli", ["config", "probe", "--name", profileRef], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.on("exit", (code) => {
        if (code === 0) resolve("ready");
        else resolve("not_ready");
      });

      child.on("error", () => resolve("not_ready"));

      setTimeout(() => {
        child.kill("SIGTERM");
        resolve("not_ready");
      }, 5000);
    });
  }
}

// ─── Capability probe ───

/** Check if the current runtime supports CLI-based setup (config init --new). */
export function probeCliSetupCapability(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("lark-cli", ["config", "init", "--new", "--help"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.on("exit", (code) => {
      // If help exits 0, CLI setup is available
      // If stderr contains "not supported in Mira", it's disabled
      if (stderr.includes("not supported") || stderr.includes("Mira environment")) {
        resolve(false);
      } else {
        resolve(code === 0);
      }
    });

    child.on("error", () => resolve(false));

    setTimeout(() => {
      child.kill("SIGTERM");
      resolve(false);
    }, 5000);
  });
}

// ─── Sanitization ───

/**
 * Scrub secrets and sensitive data from lark-cli output before logging.
 * Replacements are exact-match first, then regex fallback for secret-like patterns.
 */
export function sanitizeLarkCliOutput(text: string, secrets: string[]): string {
  let out = text;

  // Exact secret values
  for (const s of secrets) {
    if (s.length < 4) continue;
    // Escape special regex chars
    const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "g"), "[REDACTED]");
  }

  // URL tokens in query params
  out = out.replace(/[?&](token|secret|key|code)=[^&\s]+/gi, "$1=[REDACTED]");

  // Authorization header-like strings
  out = out.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");

  // Truncate for safety
  if (out.length > 500) {
    out = `${out.slice(0, 500)}...`;
  }

  return out;
}
