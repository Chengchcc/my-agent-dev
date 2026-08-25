/** 3.4 subagent role registry.
 *
 *  A named subagent is either a builtin (`explore` / `worker`) or a
 *  workspace definition at `<workspaceRoot>/.oma/agents/<name>.md`:
 *
 *    ---
 *    name: reviewer
 *    description: Reviews diffs for correctness
 *    tools: [read, grep]
 *    model: anthropic/claude-sonnet
 *    ---
 *    <body becomes the system prompt>
 *
 *  Frontmatter is parsed by hand (line regexes, no YAML dependency) — same
 *  precedent as tools-common's skills parseFrontmatter.
 */

export interface SubagentRegistryEntry {
  readonly name: string;
  readonly description: string;
  /** The role body — the executor appends the generic subagent tail. */
  readonly systemPrompt: string;
  /** Tool name allowlist; undefined = every executor file tool. */
  readonly tools?: readonly string[];
  /** Optional model override (must resolve in the runtime catalog). */
  readonly modelId?: string;
}

/** Validate a subagent/script name: a plain label, never a path segment.
 *  Model-supplied names must not escape `.oma/agents` / `.workflows`. */
export function isValidWorkflowName(name: string): boolean {
  return /^[a-z0-9-]{1,64}$/i.test(name);
}

/** Builtin roles, usable with no workspace files — the claude Task-family
 *  trio (explore / plan / task), with prompt structure following oh-my-pi's
 *  builtin agent definitions (scout/task): a terse role line plus
 *  <directives>/<critical> sections. `explore` and `plan` are strictly
 *  read-only; `task` gets the full executor tool set (tools undefined). */
const BUILTIN_AGENTS: Readonly<Record<string, SubagentRegistryEntry>> = {
  explore: {
    name: "explore",
    description:
      "MUST be used for exploratory codebase research and broad pattern searches; read-only",
    systemPrompt: `You are a read-only exploration subagent: investigate the workspace and return structured findings the caller can act on without re-reading everything.

<directives>
- You MUST use grep/glob for broad pattern searches as much as possible; then read only the needed ranges. NEVER read full files unless they are tiny.
- If a search returns nothing, try at least one alternate pattern before concluding the target is absent.
- Note the types/interfaces/key functions you touch and how files connect.
</directives>

<critical>
You MUST operate as read-only. You NEVER write, edit, or modify files, nor execute state-changing commands. You MUST keep going until the investigation is complete.
</critical>`,
    tools: ["read", "grep", "glob", "tree", "read_image"],
  },
  plan: {
    name: "plan",
    description:
      "MUST be used for read-only implementation planning; explore the codebase and produce an execution plan",
    systemPrompt: `You are a planning subagent: explore the codebase read-only and produce a concrete implementation plan the caller can execute.

<directives>
- You MUST use read/grep/glob/tree/read_image to understand the relevant code before proposing changes.
- Identify the files to touch, the order of changes, and any risks/dependencies. Prefer specific paths over vague areas.
- Keep the plan actionable: steps a worker agent can follow without re-investigating.
</directives>

<critical>
You MUST operate as read-only. You NEVER write, edit, or modify files, nor execute state-changing commands. You MUST keep going until the plan is complete.
</critical>`,
    tools: ["read", "grep", "glob", "tree", "read_image"],
  },
  task: {
    name: "task",
    description: "General-purpose task worker with the full file tool set",
    systemPrompt: `You are a general-purpose task subagent: a delegated task executor with full file tools.

<directives>
- MUST hyperfocus the assigned task; NEVER deviate.
- MUST finish only the assigned work and return the minimum useful result; do not repeat filesystem writes.
- MUST be concise; no filler, no repetition, no tool transcripts. Your result is notes for the caller.
- Prefer narrow lookups (grep/glob), then read only needed ranges.
- Prefer editing existing files over creating new ones; NEVER create documentation files (*.md) unless the task explicitly requests one.
- Persist durable results as files and report what you changed.
</directives>`,
  },
};

/** Parse `.oma/agents/*.md` — YAML-subset frontmatter with the four fields
 *  name / description / tools / model; unknown keys are ignored. */
export function parseAgentDefinition(md: string): SubagentRegistryEntry | null {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(md);
  const frontmatter = match?.[1] ?? "";
  const body = (match?.[2] ?? md).trim();
  const field = (key: string): string | undefined =>
    new RegExp(`^${key}:\\s*(.+)$`, "m").exec(frontmatter)?.[1]?.trim();
  const name = field("name");
  if (!name) return null; // a definition without a name is not loadable
  const tools = field("tools")
    ?.replace(/[[\]'"\s]/g, "")
    .split(",")
    .filter(Boolean);
  return {
    name,
    description: field("description") ?? "",
    systemPrompt: body,
    ...(tools && tools.length > 0 ? { tools } : {}),
    ...(field("model") ? { modelId: field("model") } : {}),
  };
}

export function builtinAgentNames(): string[] {
  return Object.keys(BUILTIN_AGENTS);
}

/** Resolve a role: builtin first, then the workspace definition. Returns
 *  null when unknown or the name is unsafe. `allowWorkspace` is false for
 *  read_only workspaces (no `.oma/agents` files). */
export async function resolveAgent(
  name: string,
  readAgentDefinition: (name: string) => Promise<string | null>,
  opts: { allowWorkspace?: boolean } = {},
): Promise<SubagentRegistryEntry | null> {
  const builtin = BUILTIN_AGENTS[name];
  if (builtin) return builtin;
  if (!isValidWorkflowName(name)) return null;
  if (opts.allowWorkspace === false) return null;
  const md = await readAgentDefinition(name);
  if (md === null) return null;
  const parsed = parseAgentDefinition(md);
  // The file name is the identity; a mismatched frontmatter name is a
  // hygiene hint, not an authorization boundary.
  return parsed ? { ...parsed, name: parsed.name || name } : null;
}
