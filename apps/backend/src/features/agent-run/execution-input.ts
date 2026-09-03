import type {
  BackendRunInput,
  ProjectedHistoryItem,
  WorkspaceBinding,
} from "@chengchenccc/agent-contract";
import type { ContentBlock, Message } from "@chengchenccc/message";
import type { AgentRun, BranchInput } from "./domain.js";

/** The final answer of a canonical run sequence (ADR 0017): the last
 *  assistant message carrying text. Used for mention cascade and surface
 *  display; returns undefined when the run produced no final text. */
export function finalAnswerMessage(messages: readonly Message[] | undefined): Message | undefined {
  return [...(messages ?? [])]
    .reverse()
    .find((m) => m.role === "assistant" && (m.text?.trim() ?? "") !== "");
}

/** Normalized events worth persisting for telemetry. Text/thinking deltas
 *  are transient and large; usage lives on agent_run.terminal_result. */
export const TELEMETRY_EVENT_TYPES = new Set([
  "status",
  "native_tool_started",
  "native_tool_completed",
  "workflow_started",
  "workflow_agent_started",
  "workflow_agent_completed",
  "workflow_completed",
]);

function renderBlock(b: ContentBlock, depth = 0): string {
  const pad = "  ".repeat(depth);
  if (b.type === "text") return `${pad}${b.text}`;
  if (b.type === "tool_use") {
    return `${pad}[tool ${b.name}] ${JSON.stringify(b.input ?? {}).slice(0, 400)}`;
  }
  if (b.type === "tool_result") {
    return `${pad}[${b.is_error ? "tool error" : "tool result"}] ${b.content.slice(0, 600)}`;
  }
  return `${pad}[${b.type}]`;
}

function renderHistoryBridge(history: readonly ProjectedHistoryItem[]): string {
  return history
    .map((h) => {
      const who = h.message.role === "user" ? "User" : "Assistant";
      const body =
        h.message.text && h.message.text.trim() !== ""
          ? h.message.text
          : Array.isArray(h.message.blocks)
            ? h.message.blocks
                .map((b) => renderBlock(b))
                .filter(Boolean)
                .join("\n")
            : "";
      return `${who}: ${body}`;
    })
    .join("\n\n");
}

function renderTodoSection(todoSnapshot: string | null): string {
  if (!todoSnapshot) {
    return "## Current Tasks\nNone yet. Use the todo_write product tool to track your task list.";
  }
  try {
    const items = JSON.parse(todoSnapshot) as readonly {
      id: string;
      text: string;
      status: string;
    }[];
    const marks = { pending: "- [ ]", in_progress: "- [~]", done: "- [x]" };
    return `## Current Tasks\n${items
      .map((t) => {
        const mark = marks[t.status as keyof typeof marks] ?? "- [ ]";
        return `${mark} ${t.text} (id: ${t.id})`;
      })
      .join("\n")}`;
  } catch {
    return "## Current Tasks\nNone yet. Use the todo_write product tool to track your task list.";
  }
}

/** Assemble the BackendRunInput for a run's single input. The run's
 *  systemPrompt + skillRoots are the frozen snapshot persisted at Run
 *  creation - never re-resolved at dispatch (recovery reuses them); they
 *  stay in the contract as the run-scoped override channel (ADR 0020).
 *  The Product Context (identity + current task list) rides the same
 *  prompt so CLI backends carry their run identity into product tools. */
export function buildRunInput(
  deps: {
    conversationTitleOf?: (conversationId: string) => string | null | undefined;
  },
  run: AgentRun,
  history: readonly ProjectedHistoryItem[],
  input: BranchInput,
  workspace: WorkspaceBinding,
  cliSessionRef: string | undefined,
  lastTodo: string | null,
  productToolsToken: string,
): BackendRunInput {
  const bridge = !cliSessionRef && history.length > 0 ? renderHistoryBridge(history) : "";
  const inputText = input.message.text ?? "";
  const runSnapshot: {
    runId: string;
    model: typeof run.modelRef;
    configRevision: number;
    systemPrompt?: string;
    skillRoots?: readonly string[];
    cliSessionRef?: string;
    permissionMode?: "ask" | "auto" | "deny";
    workflowBudgetTokens?: number;
  } = {
    runId: run.runId,
    model: run.modelRef,
    configRevision: run.configRevision,
  };

  // CLI backends mount product tools through .mcp.json without the child's
  // per-call wire identity: the identity + task list ride the system
  // prompt, and the model passes the identity as a tool argument.
  // SECURITY NOTE: the identity is anti-ACCIDENT, not anti-MALICE - a
  // hostile model can forge any tuple it reads from the prompt. Hard
  // binding needs a per-run token (scheduled, see security-debt-backlog).
  const productContext = [
    "## Product Context",
    "Product tools (history_recent, history_search, history_around,",
    "history_retain, todo_write) require your run identity. Always pass it",
    "as the `identity` argument:",
    `- runId: ${run.runId}`,
    `- conversationId: ${run.conversationId}`,
    `- agentId: ${run.agentId}`,
    `- branchId: ${run.branchId}`,
    "",
    renderTodoSection(lastTodo),
  ].join("\n");
  if (run.systemPrompt) {
    runSnapshot.systemPrompt = `${run.systemPrompt}\n\n${productContext}`;
  } else {
    runSnapshot.systemPrompt = productContext;
  }
  if (run.skillRoots && run.skillRoots.length > 0) runSnapshot.skillRoots = run.skillRoots;
  if (cliSessionRef) runSnapshot.cliSessionRef = cliSessionRef;
  if (run.permissionMode) {
    runSnapshot.permissionMode = run.permissionMode as "ask" | "auto" | "deny";
  }
  if (run.workflowBudgetTokens != null) runSnapshot.workflowBudgetTokens = run.workflowBudgetTokens;
  return {
    input: {
      inputId: input.inputId,
      message: bridge ? { ...input.message, text: `${bridge}\n\n${inputText}` } : input.message,
    },
    run: runSnapshot,
    ...(run.workflow ? { workflow: run.workflow } : {}),
    workspace,
    productToolsToken,
    // Auto-title: tell the child whether this conversation already has a
    // title so later turns keep retrying only while it is missing.
    convTitled: Boolean(deps.conversationTitleOf?.(run.conversationId)),
    metadata: {
      conversationId: run.conversationId,
      agentId: run.agentId,
      branchId: run.branchId,
    },
  };
}
