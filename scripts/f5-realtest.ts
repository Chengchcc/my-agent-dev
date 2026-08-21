// F5 real-model verification: DeepSeek (openai-completions) with
// response_format JSON Schema. Requires DEEPSEEK_API_KEY.
import { createModelRuntime, createProvider } from "../packages/ai/src/index.js";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error("DEEPSEEK_API_KEY is required");
  process.exit(2);
}

const model = {
  id: "deepseek-chat",
  name: "DeepSeek Chat",
  provider: "deepseek",
  api: "openai-completions" as const,
  reasoning: false,
  input: ["text"] as const,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 64_000,
  maxTokens: 4096,
  compat: { thinkingFormat: "deepseek" as const, maxTokensField: "max_tokens" as const },
};

const rt = createModelRuntime();
rt.registerProvider(
  createProvider({
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    auth: { apiKey },
    models: [model],
  }),
);

const schema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    confidence: { type: "number" },
  },
  required: ["summary", "confidence"],
  additionalProperties: false,
};

let text = "";
for await (const c of rt.stream(
  "deepseek",
  model.id,
  [
    {
      role: "user",
      text: "Summarize 'The quick brown fox jumps over the lazy dog' in one short line and rate confidence 0-1.",
    },
  ],
  {
    apiKey,
    responseFormat: { name: "summary_result", schema, strict: true },
  },
)) {
  if (c.delta?.type === "text") text += c.delta.text;
}

console.log("RAW OUTPUT:", JSON.stringify(text.slice(0, 500)));
const parsed = JSON.parse(text) as { summary?: unknown; confidence?: unknown };
console.log("PARSED:", JSON.stringify(parsed));
const ok =
  typeof parsed.summary === "string" &&
  parsed.summary.length > 0 &&
  typeof parsed.confidence === "number";
console.log(ok ? "SCHEMA OK" : "SCHEMA FAIL");
process.exit(ok ? 0 : 1);
