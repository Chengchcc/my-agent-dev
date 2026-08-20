import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRuntime } from "@chengchenccc/ai";
import { extractText, type Message } from "@chengchenccc/message";

/**
 * Autonomous memory pipeline (v1, OMP AutoLearn-style but per-Run).
 *
 * After a COMPLETED oma run the child:
 *   1. asks the model to extract durable facts from the run transcript
 *      (JSON contract, cheap call, 60s cap);
 *   2. writes them to `memory/facts/<runId>.md` (idempotent per run);
 *   3. merges them into `memory/memory_summary.md` (a second call).
 *
 * `memory/MEMORY.md` stays agent-written — the pipeline never touches it.
 * Every failure is swallowed: memory must never fail or slow the Run.
 * Env: OMA_MEMORY_EXTRACT=0 disables; OMA_MEMORY_MODEL=<provider>/<model>
 * overrides the extract/merge model (default: the Run's own model).
 */

const EXTRACT_PROMPT = `You are a memory extractor for a coding agent.
Extract durable, reusable facts from the run transcript below.
A fact is: a project convention, a constraint, a decision with its why,
a workflow that worked, a pitfall with its fix, or a discovered
environment detail. NEVER extract transient chatter, task-specific
details without reuse value, or unverified guesses.
Return STRICT JSON only:
{"facts":[{"content":"one durable fact","context":"where it applies (file/module/scope)"}]}
Return {"facts":[]} when nothing durable.`;

const CONSOLIDATE_PROMPT = `You maintain the agent's long-term memory summary
(memory/memory_summary.md). Merge the NEW facts into the EXISTING summary,
keeping it a compact digest of durable knowledge. Drop facts already covered.
Return the new summary text only (markdown), no preamble.`;

const EXTRACT_TIMEOUT_MS = 60_000;
const TRANSCRIPT_BUDGET_CHARS = 8_000;

interface ExtractedFact {
  content: string;
  context?: string;
}

interface ExtractResult {
  facts: ExtractedFact[];
}

export interface AutonomousMemoryInput {
  modelRuntime: ModelRuntime;
  /** Canonical "<provider>/<model>" of the Run's model. */
  modelId: string;
  workspaceRoot: string;
  runId: string;
  messages: readonly Message[];
  compactions: readonly string[];
}

export async function extractAutonomousMemory(input: AutonomousMemoryInput): Promise<void> {
  try {
    if (process.env.OMA_MEMORY_EXTRACT === "0") return;
    // Default: the cheapest available catalog model (memory extraction is
    // quality-tolerant); OMA_MEMORY_MODEL explicitly overrides; fall back to
    // the Run's own model when the catalog is empty/unreadable.
    const modelRef = await resolveMemoryModel(input.modelRuntime, input.modelId);
    const transcript = buildTranscript(input.messages, input.compactions);
    if (transcript.trim().length === 0) return;

    const facts = parseFacts(
      await callModel(
        input.modelRuntime,
        modelRef,
        `${EXTRACT_PROMPT}\n\n<transcript>\n${transcript}\n</transcript>`,
      ),
    );
    if (facts.length === 0) return;

    const memDir = join(input.workspaceRoot, "memory");
    const factsDir = join(memDir, "facts");
    mkdirSync(factsDir, { recursive: true });
    writeFileSync(join(factsDir, `${input.runId}.md`), renderFacts(input.runId, facts), "utf-8");

    const oldSummary = readTextOrNull(join(memDir, "memory_summary.md"));
    const newSummary = await callModel(
      input.modelRuntime,
      modelRef,
      `${CONSOLIDATE_PROMPT}\n\n<existing_summary>\n${oldSummary ?? "(none)"}\n</existing_summary>\n\n<new_facts>\n${renderFacts(input.runId, facts)}\n</new_facts>`,
    );
    if (newSummary) writeFileSync(join(memDir, "memory_summary.md"), newSummary, "utf-8");
  } catch (err) {
    // Memory is best-effort: never fail or slow the Run over it.
    console.error(
      "[oma] autonomous memory skipped:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function resolveMemoryModel(modelRuntime: ModelRuntime, runModelId: string): Promise<string> {
  const explicit = process.env.OMA_MEMORY_MODEL;
  if (explicit) return explicit;
  try {
    const catalog = await modelRuntime.getCatalog();
    const candidates = catalog.models.filter((m) => m.available !== false);
    if (candidates.length > 0) {
      const costOf = (m: (typeof candidates)[number]) => m.cost.input + m.cost.output;
      const cheapest = candidates.reduce((a, b) => (costOf(a) <= costOf(b) ? a : b));
      // On a cost tie prefer the Run's own model: never surprise-upgrade
      // (or downgrade) the memory model when the catalog gives no reason.
      const runEntry = candidates.find((m) => `${m.providerId}/${m.modelId}` === runModelId);
      if (runEntry && costOf(runEntry) <= costOf(cheapest)) return runModelId;
      return `${cheapest.providerId}/${cheapest.modelId}`;
    }
  } catch {
    /* unreadable catalog — fall back to the Run's model */
  }
  return runModelId;
}

function buildTranscript(messages: readonly Message[], compactions: readonly string[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const label = m.role === "assistant" ? "Assistant" : m.role === "user" ? "User" : m.role;
    const text = extractText(m).trim();
    if (text) lines.push(`${label}: ${text}`);
  }
  for (const c of compactions) {
    if (c.trim()) lines.push(`[compaction summary]\n${c.trim()}`);
  }
  return lines.join("\n\n").slice(0, TRANSCRIPT_BUDGET_CHARS);
}

async function callModel(
  modelRuntime: ModelRuntime,
  modelRef: string,
  prompt: string,
): Promise<string> {
  const slash = modelRef.indexOf("/");
  const providerId = slash > 0 ? modelRef.slice(0, slash) : modelRef;
  const modelId = slash > 0 ? modelRef.slice(slash + 1) : modelRef;
  let text = "";
  for await (const chunk of modelRuntime.stream(
    providerId,
    modelId,
    [{ role: "user", text: prompt }],
    {
      signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
    },
  )) {
    if (chunk.delta?.type === "text" && chunk.delta.text) text += chunk.delta.text;
  }
  return text.trim();
}

function parseFacts(raw: string): ExtractedFact[] {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return [];
  let parsed: ExtractResult;
  try {
    parsed = JSON.parse(m[0]) as ExtractResult;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.facts)) return [];
  return parsed.facts.filter(
    (f): f is ExtractedFact => typeof f?.content === "string" && f.content.trim().length > 0,
  );
}

function renderFacts(runId: string, facts: readonly ExtractedFact[]): string {
  const lines = [`---`, `runId: ${runId}`, `createdAt: ${Date.now()}`, `---`, ""];
  for (const f of facts) {
    lines.push(
      f.context?.trim() ? `- **${f.context.trim()}** ${f.content.trim()}` : `- ${f.content.trim()}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function readTextOrNull(path: string): string | null {
  try {
    const text = readFileSync(path, "utf-8");
    return text.trim() || null;
  } catch {
    return null;
  }
}
