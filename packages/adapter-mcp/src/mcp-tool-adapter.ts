import type { Tool, ToolExecuteResult } from "@chengchenccc/core";

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolCaller {
  callTool(params: { name: string; arguments?: unknown }): Promise<{ content: unknown }>;
}

/** lowercase + replace non-[a-z0-9] with `-`, trim leading/trailing `-`, fallback to "server". */
export function sanitizeServerName(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "server";
}

/** returns `mcp__{sanitizedServerName}__{toolName}`. */
export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${sanitizeServerName(serverName)}__${toolName}`;
}

/** Adapt an MCP tool definition into the `Tool` interface. */
export function adaptMcpTool(
  serverName: string,
  mcpTool: McpToolDefinition,
  caller: McpToolCaller,
): Tool {
  const name = mcpToolName(serverName, mcpTool.name);
  const description = mcpTool.description ?? `MCP tool: ${mcpTool.name}`;
  const inputSchema = mcpTool.inputSchema ?? { type: "object", properties: {} };

  return {
    name,
    description,
    inputSchema,
    // ponytail: signal not forwarded - MCP SDK callTool doesn't accept AbortSignal yet
    async execute(input: unknown): Promise<ToolExecuteResult> {
      try {
        const result = await caller.callTool({ name: mcpTool.name, arguments: input });
        return {
          content:
            typeof result.content === "string" ? result.content : JSON.stringify(result.content),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: message, isError: true };
      }
    },
  };
}
