/** Bounded stderr tail for child-process diagnostics. The tail is the ONLY
 *  stderr surface surfaced to errors, and secrets are redacted before it
 *  ever reaches a message: API keys, Product Tool tokens, auth headers and
 *  full env dumps are never leaked. */

export interface StderrTailOptions {
  /** Max retained bytes (default 64 KiB). */
  limit?: number;
  /** Secret values replaced in the tail. */
  secrets?: readonly string[];
}

export interface StderrTail {
  push(chunk: string): void;
  text(): string;
}

const REDACTED = "[REDACTED]";

/** Collect known secret values from an env surface (command env + known
 *  credential keys). Values shorter than 8 chars are ignored (too noisy). */
export function collectSecrets(env: Readonly<Record<string, string | undefined>>): string[] {
  const secrets = new Set<string>();
  const KNOWN_KEYS = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CODING_AGENT_PRODUCT_TOOL_TOKEN",
    "PRODUCT_TOOLS_SERVICE_TOKEN",
    "BACKEND_AUTH_TOKEN",
  ];
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.length < 8) continue;
    if (KNOWN_KEYS.includes(key) || /TOKEN|KEY|SECRET|PASSWORD|AUTH/i.test(key)) {
      secrets.add(value);
    }
  }
  return [...secrets];
}

export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join(REDACTED);
    // Also redact the Bearer-prefixed form (token alone is often insufficient
    // context to spot in a paste).
    out = out.split(`Bearer ${REDACTED}`).join(REDACTED);
  }
  return out;
}

export function createStderrTail(opts: StderrTailOptions = {}): StderrTail {
  const limit = opts.limit ?? 64 * 1024;
  const secrets = opts.secrets ?? [];
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      if (buffer.length > limit) {
        buffer = buffer.slice(buffer.length - limit);
      }
    },
    text() {
      return redactText(buffer, secrets);
    },
  };
}
