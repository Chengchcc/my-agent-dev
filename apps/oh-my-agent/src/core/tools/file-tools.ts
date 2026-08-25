import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { Tool } from "@chengchenccc/message";
import { WorkspaceSandbox } from "./workspace-sandbox.js";

type InputRec = Record<string, unknown>;

/** Simple cwd-based default - tools resolve relative paths against this. */
export function withDefaultCwd(tool: Tool, cwd: string): Tool {
  return {
    ...tool,
    execute: async (input: unknown, signal?: AbortSignal) => {
      const rec = input as InputRec;
      return tool.execute({ ...rec, cwd: rec.cwd ?? cwd }, signal);
    },
  };
}
function safePath(cwd: string, userPath: string): string | null {
  try {
    const sandbox = new WorkspaceSandbox(cwd);
    return sandbox.validate(userPath);
  } catch {
    return null;
  }
}

function safePathNew(cwd: string, userPath: string): string | null {
  try {
    const sandbox = new WorkspaceSandbox(cwd);
    return sandbox.validateNew(userPath);
  } catch {
    return null;
  }
}
/** Resolve a path against a fixed workspace root using realpath containment. */
export function resolveWorkspacePath(root: string, userPath: string): string | null {
  try {
    return new WorkspaceSandbox(root).validate(userPath);
  } catch {
    return null;
  }
}

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
  ".ico",
]);
const READ_MAX_SIZE_BYTES = 256 * 1024;

/** Shared "description" parameter - forces the model to explain its intent before each tool call. */
const descriptionParam = {
  type: "string" as const,
  description:
    "Must be the first parameter. A short human-readable summary explaining why this tool is being called.",
};

// ─── read ──────────────────────────────────────────────────────

/** Create a read-file tool scoped to a cwd. */
export function createReadTool(opts: { cwd: string }): Tool {
  const { cwd } = opts;
  return {
    name: "read",
    description:
      "Read a file from the workspace. Returns file contents with line numbers (line\\tcontent). " +
      "For images, returns a placeholder with file size. Output capped at 256KB; use offset/limit for large files.",
    inputSchema: {
      type: "object",
      properties: {
        description: descriptionParam,
        path: {
          type: "string",
          description: "Path to the file to read, relative to workspace root",
        },
        offset: {
          type: "number",
          description: "1-based line number to start reading from. Defaults to 1.",
        },
        limit: {
          type: "number",
          description: "Maximum number of lines to read from offset.",
        },
      },
      required: ["path"],
    },
    async execute(input: unknown) {
      const rec = input as InputRec;
      const full = safePath(cwd, String(rec.path ?? ""));
      if (!full) return { content: "Error: path escapes workspace", isError: true };
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          return { content: `Error: ${rec.path} is a directory, not a file.`, isError: true };
        }
        if (IMAGE_EXTENSIONS.has(extname(full).toLowerCase())) {
          return { content: `[image file: ${rec.path} (${stat.size} bytes)]` };
        }
        const content = readFileSync(full, "utf-8");
        const lines = content.split("\n");
        const offset = typeof rec.offset === "number" ? rec.offset : undefined;
        const limit = typeof rec.limit === "number" ? rec.limit : undefined;
        const start = offset && offset > 1 ? offset - 1 : 0;
        const end = limit !== undefined ? start + Math.max(0, limit) : lines.length;
        const selected = lines.slice(start, Math.max(start, end));

        const out: string[] = [];
        let bytes = 0;
        let truncated = false;
        for (let i = 0; i < selected.length; i++) {
          const rendered = `${start + i + 1}\t${selected[i]}`;
          const size = Buffer.byteLength(rendered, "utf8") + 1;
          if (out.length > 0 && bytes + size > READ_MAX_SIZE_BYTES) {
            truncated = true;
            break;
          }
          bytes += size;
          out.push(rendered);
        }

        let result = out.join("\n");
        if (truncated) {
          result += `\n... [truncated at ${READ_MAX_SIZE_BYTES} bytes; pass offset/limit to read a specific range]`;
        }
        return { content: result };
      } catch (err) {
        return {
          content: `Error reading file: ${err instanceof Error ? err.message : err}`,
          isError: true,
        };
      }
    },
  };
}

// ─── write ─────────────────────────────────────────────────────

/** Create a write-file tool scoped to a cwd. */
export function createWriteTool(opts: { cwd: string }): Tool {
  const { cwd } = opts;
  return {
    name: "write",
    description:
      "Write content to a file in the workspace. Creates parent directories if needed. Overwrites if file exists.",
    inputSchema: {
      type: "object",
      properties: {
        description: descriptionParam,
        path: {
          type: "string",
          description: "Path to the file to write, relative to workspace root",
        },
        content: {
          type: "string",
          description: "Content to write to the file",
        },
      },
      required: ["path", "content"],
    },
    async execute(input: unknown) {
      const rec = input as InputRec;
      const full = safePathNew(cwd, String(rec.path ?? ""));
      if (!full) return { content: "Error: path escapes workspace", isError: true };
      try {
        mkdirSync(resolve(full, ".."), { recursive: true });
        const content = String(rec.content ?? "");
        writeFileSync(full, content, "utf-8");
        return { content: `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${rec.path}` };
      } catch (err) {
        return {
          content: `Error writing file: ${err instanceof Error ? err.message : err}`,
          isError: true,
        };
      }
    },
  };
}

// ─── edit ──────────────────────────────────────────────────────

/** Create an edit-file tool scoped to a cwd. */
export function createEditTool(opts: { cwd: string }): Tool {
  const { cwd } = opts;
  return {
    name: "edit",
    description:
      "Perform exact string replacement in a file. old_string must match exactly and be unique " +
      "unless replace_all is set. Use for surgical edits; prefer write for full replacement.",
    inputSchema: {
      type: "object",
      properties: {
        description: descriptionParam,
        path: {
          type: "string",
          description: "Path to the file to edit, relative to workspace root",
        },
        old_string: {
          type: "string",
          description: "The exact text to replace (must be unique unless replace_all is true)",
        },
        new_string: {
          type: "string",
          description: "The replacement text (must differ from old_string)",
        },
        replace_all: {
          type: "boolean",
          description: "Replace all occurrences. Defaults to false (first match only).",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
    async execute(input: unknown) {
      const rec = input as InputRec;
      const full = safePath(cwd, String(rec.path ?? ""));
      if (!full) return { content: "Error: path escapes workspace", isError: true };
      try {
        if (!existsSync(full)) {
          return { content: `Error: file not found: ${rec.path}`, isError: true };
        }
        const oldStr = String(rec.old_string ?? "");
        const newStr = String(rec.new_string ?? "");
        const replaceAll = rec.replace_all === true;

        if (oldStr === newStr) {
          return { content: "Error: new_string must differ from old_string.", isError: true };
        }

        const content = readFileSync(full, "utf-8");
        const occurrences = content.split(oldStr).length - 1;
        if (occurrences === 0) {
          return {
            content:
              "Error: old_string not found in file. The file may have changed since you last read it.",
            isError: true,
          };
        }
        if (!replaceAll && occurrences > 1) {
          return {
            content: `Error: old_string is not unique (${occurrences} matches). Provide a larger unique string or set replace_all.`,
            isError: true,
          };
        }

        const newContent = replaceAll
          ? content.split(oldStr).join(newStr)
          : content.replace(oldStr, newStr);
        writeFileSync(full, newContent, "utf-8");
        const count = replaceAll ? occurrences : 1;
        return { content: `Replaced ${count} occurrence${count === 1 ? "" : "s"} in ${rec.path}` };
      } catch (err) {
        return {
          content: `Error editing file: ${err instanceof Error ? err.message : err}`,
          isError: true,
        };
      }
    },
  };
}
