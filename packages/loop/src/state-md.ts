import type { ItemState, ItemStep, LoopState, Verdict } from "./types.js";

// ============================================================
// Lightweight YAML helpers (two levels: result + reasons array)
// ============================================================

type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

function yamlEscape(value: string): string {
  // Quote strings that contain special chars
  if (/[:#{}[\]&*!|>'"%@`,\-?]/.test(value) || value.includes("\n")) {
    return JSON.stringify(value);
  }
  return value;
}

function yamlFormatScalar(value: YamlValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return yamlEscape(value);
  if (Array.isArray(value)) return value.map(yamlFormatScalar).join(", ");
  return JSON.stringify(value);
}

// ============================================================
// Verdict ↔ YAML
// ============================================================

function formatVerdict(v: Verdict, indent: number): string {
  const pad = "  ".repeat(indent);
  const lines: string[] = [];
  lines.push(`${pad}verdict: ${v.verdict}`);
  if ("reasons" in v && v.reasons.length > 0) {
    lines.push(`${pad}reasons:`);
    for (const r of v.reasons) {
      lines.push(`${pad}  - ${yamlEscape(r)}`);
    }
  }
  lines.push(`${pad}evidence: ${JSON.stringify(v.evidence)}`);
  return lines.join("\n");
}

function parseVerdict(data: Record<string, YamlValue>): Verdict {
  const verdict = String(data.verdict ?? "ESCALATE") as Verdict["verdict"];
  const evidence = String(data.evidence ?? "");
  if (verdict === "PASS") {
    return { verdict: "PASS", evidence };
  }
  const reasons = Array.isArray(data.reasons) ? data.reasons.map(String) : [];
  return { verdict, reasons, evidence } as Verdict;
}

// ============================================================
// ItemState ↔ YAML
// ============================================================

function itemStateToYaml(item: ItemState): string {
  const lines: string[] = [];
  lines.push(`source: ${yamlEscape(item.source)}`);
  lines.push(`summary: ${yamlEscape(item.summary)}`);
  lines.push(`step: ${item.step}`);
  lines.push(`attempt: ${item.attempt}`);
  lines.push(`priority: ${item.priority}`);
  if (item.generatorRunId) {
    lines.push(`generatorRunId: ${yamlEscape(item.generatorRunId)}`);
  }
  if (item.evaluatorRunId) {
    lines.push(`evaluatorRunId: ${yamlEscape(item.evaluatorRunId)}`);
  }
  if (item.result !== null) {
    lines.push("result:");
    lines.push(formatVerdict(item.result, 1));
  }
  return `${lines.join("\n")}\n`;
}

function parseItemYaml(id: string, lines: string[]): ItemState {
  const data = parseYamlBlock(lines);
  return {
    id,
    source: String(data.source ?? ""),
    summary: String(data.summary ?? ""),
    step: String(data.step ?? "triaged") as ItemStep,
    attempt: Number(data.attempt ?? 1),
    priority: Number(data.priority ?? 0),
    result:
      data.result && typeof data.result === "object" && !Array.isArray(data.result)
        ? parseVerdict(data.result as Record<string, YamlValue>)
        : null,
    generatorRunId: data.generatorRunId ? String(data.generatorRunId) : undefined,
    evaluatorRunId: data.evaluatorRunId ? String(data.evaluatorRunId) : undefined,
  };
}

// ============================================================
// YAML block parser (frontmatter + item sections)
// ============================================================

function parseYamlBlock(lines: string[]): Record<string, YamlValue> {
  const result: Record<string, YamlValue> = {};

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }

    const indent = line.search(/\S/);
    const trimmed = line.trim();

    // Top-level key: value
    const kvMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (kvMatch && indent === 0) {
      const key = kvMatch[1]!;
      const rawValue = kvMatch[2]!;

      if (rawValue === "") {
        // Nested object or array follows
        const nested: string[] = [];
        i++;
        while (i < lines.length) {
          const nextLine = lines[i]!;
          if (nextLine.trim() === "") {
            i++;
            continue;
          }
          const nextIndent = nextLine.search(/\S/);
          if (nextIndent <= indent) break; // end of nested block
          nested.push(nextLine);
          i++;
        }

        if (nested.length > 0 && nested[0]!.trim().startsWith("-")) {
          // Array
          result[key] = nested
            .filter((l) => l.trim().startsWith("-"))
            .map((l) => l.trim().replace(/^-\s*/, ""));
        } else {
          // Nested object — strip base indent from all lines
          const baseIndent = Math.min(...nested.map((l) => l.search(/\S/)));
          result[key] = parseYamlBlock(nested.map((l) => l.slice(baseIndent)));
        }
        continue;
      }

      // Scalar value
      result[key] = yamlParseScalar(rawValue);
      i++;
    } else {
      i++;
    }
  }

  return result;
}

function yamlParseScalar(raw: string): YamlValue {
  const trimmed = raw.trim();
  if (trimmed === "null" || trimmed === "") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  // Try JSON unquote
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

// ============================================================
// Public API
// ============================================================

export function parseStateMd(md: string): LoopState {
  if (!md.trim()) {
    return { loopId: "", lastRun: null, items: {} };
  }

  // Extract frontmatter (first --- to second ---)
  const fmMatch = md.match(/^---\s*\n([\s\S]*?)\n---/);
  const fmBody = fmMatch?.[1];
  const frontmatter: Record<string, YamlValue> = fmBody ? parseYamlBlock(fmBody.split("\n")) : {};

  // Find ## Items and parse ### sections
  const items: LoopState["items"] = {};
  const itemsHeaderIdx = md.indexOf("## Items");
  if (itemsHeaderIdx >= 0) {
    const itemsSection = md.slice(itemsHeaderIdx);
    const sections = itemsSection.split(/\n(?=### )/);
    for (const section of sections) {
      const lines = section.split("\n");
      const firstLine = lines[0]?.trim() ?? "";
      const idMatch = firstLine.match(/^###\s+(\S+)/);
      if (!idMatch) continue;
      const id = idMatch[1]!;
      // Skip the ### line, parse the rest
      items[id] = parseItemYaml(id, lines.slice(1));
    }
  }

  return {
    loopId: String(frontmatter.loopId ?? ""),
    lastRun:
      frontmatter.lastRun !== undefined && frontmatter.lastRun !== null
        ? String(frontmatter.lastRun)
        : null,
    items,
  };
}

export function formatStateMd(state: LoopState): string {
  let md = "---\n";
  md += `loopId: ${yamlEscape(state.loopId)}\n`;
  if (state.lastRun !== null) {
    md += `lastRun: ${yamlEscape(state.lastRun)}\n`;
  } else {
    md += "lastRun: null\n";
  }
  md += "version: 1\n";
  md += "---\n\n";
  md += "# Loop State\n\n";
  md += "## Items\n\n";

  for (const item of Object.values(state.items)) {
    md += `### ${item.id}\n`;
    md += itemStateToYaml(item);
    md += "\n";
  }

  return md;
}

export function parseInboxMd(md: string): LoopState["items"] {
  if (!md.trim()) return {};

  const items: LoopState["items"] = {};
  const sections = md.split(/\n(?=### )/);
  for (const section of sections) {
    const lines = section.split("\n");
    const firstLine = lines[0]?.trim() ?? "";
    const idMatch = firstLine.match(/^###\s+(\S+)/);
    if (!idMatch) continue;
    const id = idMatch[1]!;
    items[id] = parseItemYaml(id, lines.slice(1));
  }

  return items;
}

export function formatInboxMd(items: LoopState["items"]): string {
  let md = "";
  for (const item of Object.values(items)) {
    md += `### ${item.id}\n`;
    md += itemStateToYaml(item);
    md += "\n";
  }
  return md;
}

export function parseVerdictMd(md: string): Verdict | null {
  if (!md.trim()) return null;

  const vMatch = md.match(/verdict:\s*(PASS|REJECT|ESCALATE)/i);
  if (!vMatch) return null;

  const verdict = vMatch[1]!.toUpperCase() as Verdict["verdict"];
  const eMatch = md.match(/evidence:\s*(.+)/);
  const evidence = eMatch?.[1]?.trim() ?? "";

  if (verdict === "PASS") {
    return { verdict, evidence };
  }

  const rMatch = md.match(/reasons:\s*(.+)/);
  let reasons: string[] = [];
  if (rMatch?.[1]) {
    try {
      const parsed = JSON.parse(rMatch[1].trim());
      reasons = Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
    } catch {
      reasons = rMatch[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return { verdict, reasons, evidence } as Verdict;
}

// ============================================================
// LOOP.md config parsing
// ============================================================

export interface LoopConfig {
  projectId: string;
  /** The agent whose (agent, project) worktree runs this loop's steps
   *  (ADR 0023 P2). Empty string = "default" (back-compat). */
  agent: string;
  generator: { model: string; systemPrompt: string };
  evaluator: { model: string; systemPrompt: string };
  acceptance: string;
  budget: { dailyCap: number } | null;
  denylist: string[];
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String);
}

export function parseLoopConfig(md: string): LoopConfig | null {
  if (!md.trim()) return null;

  const fmMatch = md.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch?.[1]) return null;

  const frontmatter = parseYamlBlock(fmMatch[1].split("\n"));
  const gen = frontmatter.generator as Record<string, unknown> | undefined;
  const eval_ = frontmatter.evaluator as Record<string, unknown> | undefined;

  if (!gen?.model || !eval_?.model) return null;

  if (gen.model === eval_.model) {
    throw new Error(
      `parseLoopConfig: generator.model ("${String(gen.model)}") must differ from evaluator.model`,
    );
  }

  const budgetRaw = frontmatter.budget as Record<string, unknown> | undefined;
  const dailyCap = Number(budgetRaw?.dailyCap ?? 0);
  const budget = Number.isFinite(dailyCap) && dailyCap > 0 ? { dailyCap } : null;

  return {
    projectId: String(frontmatter.projectId ?? ""),
    agent: String(frontmatter.agent ?? "default") || "default",
    generator: {
      model: String(gen.model),
      systemPrompt: String(gen.systemPrompt ?? ""),
    },
    evaluator: {
      model: String(eval_.model),
      systemPrompt: String(eval_.systemPrompt ?? ""),
    },
    acceptance: String(frontmatter.acceptance ?? ""),
    budget,
    denylist: toStringArray(frontmatter.denylist),
  };
}
