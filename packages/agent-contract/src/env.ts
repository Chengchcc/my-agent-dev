/** Parent env keys forwarded to spawned agent CLIs. Everything else in the
 *  parent environment (backend auth tokens, host secrets, daemon handles)
 *  must NOT reach an agent-controlled child. Per-run secrets ride in the
 *  `extra` argument and are never inherited. */
const FORWARDED_KEYS = [
  "PATH",
  "HOME",
  "LANG",
  "TZ",
  // Provider credentials (the child resolves which providers have keys).
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

/** Build a child spawn env: a small allowlist of parent vars plus the
 *  caller's explicit overrides. `extra` wins on key collisions. */
export function childEnv(
  extra?: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of FORWARDED_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}
