/** Product Tool manifest (ADR 0003 decision 6): the fixed tool definitions
 *  the oma exposes over MCP. The SAME manifest is
 *  - persisted per run at first dispatch (product-tools MCP authorizes calls
 *    against the run's declared tools),
 *  - written into the agent workspace (`.oma/product-tools.json`) so the
 *    child builds its tool table from cwd files, not the run input.
 *  `entrypoint` is the deployment's product-tools MCP URL/executable. */
export interface ProductToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly entrypoint: string;
}

export function buildHistoryTools(entrypoint: string): readonly ProductToolDescriptor[] {
  return [
    {
      name: "artifact_upload",
      description:
        "Upload a single artifact file into backend artifact storage. Returns an artifacts://<folder>/<filename> URL that other agents (or this conversation) can download. Use this to hand off produced files to later workflow steps.",
      inputSchema: {
        type: "object",
        properties: {
          folder: {
            type: "string",
            description: "Logical folder (can be nested, e.g. report/2026)",
          },
          filename: { type: "string", description: "File name, e.g. quality.md" },
          content: {
            type: "string",
            description: "File content (UTF-8 text, or base64 when encoding=base64)",
          },
          encoding: { type: "string", enum: ["utf8", "base64"], description: "Default utf8" },
        },
        required: ["folder", "filename", "content"],
      },
      entrypoint,
    },
    {
      name: "artifact_download",
      description:
        "Download an artifact file from backend artifact storage by its artifacts://<folder>/<filename> URL. Returns the content (or base64 when the file is binary).",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "artifacts://<folder>/<filename>" },
        },
        required: ["url"],
      },
      entrypoint,
    },
    {
      name: "history_recent",
      description:
        "Read the most recent messages visible to this agent member in the conversation. Returns the last N messages with their ledger seq and role.",
      inputSchema: { type: "object", properties: { limit: { type: "number" } } },
      entrypoint,
    },
    {
      name: "history_search",
      description:
        "Search the conversation ledger for messages matching a keyword. Scoped to this run's conversation only.",
      inputSchema: {
        type: "object",
        properties: { keyword: { type: "string" }, limit: { type: "number" } },
        required: ["keyword"],
      },
      entrypoint,
    },
    {
      name: "history_around",
      description:
        "Read messages around a ledger seq in this conversation (context window before and after).",
      inputSchema: {
        type: "object",
        properties: {
          seq: { type: "number" },
          before: { type: "number" },
          after: { type: "number" },
        },
        required: ["seq"],
      },
      entrypoint,
    },
    {
      name: "history_retain",
      description:
        "Pin a conversation message into this agent's context branch so later runs keep it. Semantic mutation; replay-safe.",
      inputSchema: {
        type: "object",
        properties: { seq: { type: "number" }, reason: { type: "string" } },
        required: ["seq"],
      },
      entrypoint,
    },
    {
      name: "todo_write",
      description:
        "Replace this run's task list (durable, shown in the product UI). Pass the full desired list as items: [{id: string, text: string, status: pending | in_progress | done}]. The product injects your current list as Current Tasks in the system prompt.",
      inputSchema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                text: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "done"] },
              },
              required: ["id", "text", "status"],
            },
          },
        },
        required: ["items"],
      },
      entrypoint,
    },
  ];
}
