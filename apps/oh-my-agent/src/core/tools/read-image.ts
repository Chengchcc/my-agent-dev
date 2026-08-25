import { readFileSync, statSync } from "node:fs";
import type { Tool, ToolExecuteResult } from "@chengchenccc/message";
import { WorkspaceSandbox } from "./workspace-sandbox.js";

const MEDIA_TYPES: Record<string, "image/png" | "image/jpeg" | "image/gif" | "image/webp"> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Magic-byte sniffing: extension lies often enough to reject valid files. */
function sniffMediaType(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  const riff = String.fromCharCode(...bytes.slice(0, 4));
  const webp = String.fromCharCode(...bytes.slice(8, 12));
  if (riff === "RIFF" && webp === "WEBP") return "image/webp";
  return undefined;
}

/** Max image bytes returned to the model (base64 inflates ~1.33x). */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** read_image: return a workspace image as a vision tool result block. */
export function createReadImageTool(opts: { cwd: string }): Tool {
  const { cwd } = opts;
  const sandbox = new WorkspaceSandbox(cwd);
  return {
    name: "read_image",
    description:
      "Read an image file (png/jpeg/gif/webp) from the workspace and attach it for vision analysis. " +
      "Use this instead of `read` when the goal is to understand an image (screenshots, diagrams, photos).",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the image file, relative to workspace root",
        },
      },
      required: ["path"],
    },
    async execute(input: unknown, _signal?: AbortSignal): Promise<ToolExecuteResult> {
      const args = input as Readonly<Record<string, unknown>>;
      const raw = args.path;
      if (typeof raw !== "string" || raw.trim() === "") {
        return { content: "Error: path is required", isError: true };
      }
      let abs: string;
      try {
        // validate() resolves + realpath-checks, catching sibling-prefix
        // paths and symlinks pointing outside the workspace.
        abs = sandbox.validate(raw);
      } catch {
        return { content: `Error: path escapes workspace: ${raw}`, isError: true };
      }
      try {
        const st = statSync(abs);
        if (!st.isFile()) return { content: `Error: not a file: ${raw}`, isError: true };
        if (st.size > MAX_IMAGE_BYTES) {
          return {
            content: `Error: image too large (${st.size} bytes > 5MB)`,
            isError: true,
          };
        }
        const bytes = new Uint8Array(readFileSync(abs));
        const ext = abs.slice(abs.lastIndexOf(".")).toLowerCase();
        const mediaType = sniffMediaType(bytes) ?? MEDIA_TYPES[ext];
        if (!mediaType) {
          return { content: `Error: unsupported image format: ${raw}`, isError: true };
        }
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return {
          content: `[image ${raw} attached for vision]`,
          mediaType,
          images: [
            {
              type: "image" as const,
              mediaType: mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
              base64: btoa(binary),
            },
          ],
        } as unknown as ToolExecuteResult;
      } catch (err) {
        return {
          content: `Error: read_image failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}
