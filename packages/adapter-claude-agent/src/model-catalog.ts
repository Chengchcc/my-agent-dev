/** Static model catalog for claude. claude has no model enumeration command
 *  (D3 risk #2): the table lists the models this deployment actually uses,
 *  in the canonical `<provider>/<model>` id format. Update when the
 *  provider/model surface changes. */

import type { BackendModel, BackendModelCatalog } from "@chengchenccc/agent-contract";

export class ClaudeModelCatalog {
  list(): Promise<BackendModelCatalog> {
    return Promise.resolve({
      backendKind: "claude_code",
      models: CLAUDE_MODELS,
    });
  }
}

const deepseek = (id: string, reasoning: boolean): BackendModel => ({
  id: `deepseek/${id}`,
  displayName: `DeepSeek ${id}`,
  reasoning,
  inputModalities: ["text"],
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
  available: true,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

const CLAUDE_MODELS: readonly BackendModel[] = [
  deepseek("deepseek-v4-flash", false),
  deepseek("deepseek-v4-pro", true),
  deepseek("deepseek-chat", false),
  deepseek("deepseek-reasoner", true),
];
