import { parseEnv } from "@chengchenccc/config";

export interface LarkBotArgs {
  agentId: string;
  backendUrl: string;
  stateRoot: string;
  botDisplayName: string | null;
  agentName: string | null;
  larkProfile: string | null;
  backendAuthToken: string | null;
}

/** Parse CLI arguments for lark-bot process. */
export function parseArgs(raw: string[]): LarkBotArgs {
  const args: Record<string, string> = {};
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const next = raw[i + 1];
      const val = next && !next.startsWith("--") ? raw[++i]! : "true";
      args[key] = val;
    }
  }
  const agentId = args["agent-id"];
  if (!agentId) throw new Error("--agent-id is required");

  const env = parseEnv(process.env);

  return {
    agentId,
    backendUrl: args["backend-url"] ?? env.BACKEND_URL,
    stateRoot: args["state-root"] ?? env.BACKEND_DATA_DIR ?? "./.data",
    botDisplayName: args["bot-display-name"] ?? null,
    agentName: args["agent-name"] ?? null,
    larkProfile: args["lark-profile"] ?? null,
    backendAuthToken: args["backend-auth-token"] ?? env.BACKEND_AUTH_TOKEN,
  };
}
