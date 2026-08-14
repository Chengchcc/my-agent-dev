/** Secret collection + redaction for CLI child stderr: a crashed CLI echoing
 *  its environment must never write API keys into persistent run records. */

const REDACTED = "[REDACTED]";

const KNOWN_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CODING_AGENT_PRODUCT_TOOL_TOKEN",
  "PRODUCT_TOOLS_SERVICE_TOKEN",
  "PRODUCT_TOOLS_RUN_TOKEN",
  "BACKEND_AUTH_TOKEN",
];

export function collectSecrets(env: Readonly<Record<string, string | undefined>>): string[] {
  const secrets = new Set<string>();
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
  }
  return out;
}
