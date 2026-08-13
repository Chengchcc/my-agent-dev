#!/usr/bin/env bun

/** Knowledge recall MCP server (ADR 0022): knowledge_search / knowledge_read
 *  over ONE agent's workspace knowledge/ dir. The workspace bridge merges
 *  this server into the agent's .mcp.json (stdio) so ALL four backends get
 *  the same recall surface; the dir arg is the scope boundary (no traversal
 *  outside it).
 *
 *  Usage: bun knowledge-mcp-server.ts <knowledge-dir>
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const dirArg = process.argv[2];
if (!dirArg) {
  console.error("knowledge-mcp-server: <knowledge-dir> required");
  process.exit(1);
}
const root = resolve(dirArg);
if (!existsSync(root)) {
  console.error(`knowledge-mcp-server: no such dir: ${root}`);
  process.exit(1);
}

const MAX_RESULTS = 20;
const MAX_LINE = 400;

function inside(p: string): boolean {
  return p === root || p.startsWith(`${root}${sep}`);
}

function* walkFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    try {
      if (statSync(full).isDirectory()) {
        yield* walkFiles(full);
      } else if (name !== "index.md" && /\.(md|txt|ya?ml|json)$/.test(name)) {
        yield full;
      }
    } catch {
      /* skip */
    }
  }
}

/** Optional light frontmatter (title/tags/summary) — absent = filename. */
function parseFrontmatter(text: string): { title: string; tags: string[]; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { title: "", tags: [], body: text };
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return {
    title: fields.title ?? "",
    tags: fields.tags
      ? fields.tags
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t !== "")
      : [],
    body: text.slice(m[0].length),
  };
}

const server = new McpServer({ name: "knowledge", version: "0.1.0" });

server.registerTool(
  "knowledge_search",
  {
    description:
      "Search the agent's knowledge base. Every keyword must match (AND); optional tag filter. Returns matching files with the matching lines.",
    inputSchema: {
      keywords: z.array(z.string()).describe("Keywords; every one must appear in a matching file"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Only files carrying one of these frontmatter tags"),
    },
  },
  async ({ keywords, tags }) => {
    const kw = keywords.filter((k) => k.trim() !== "");
    if (kw.length === 0) return { content: [{ type: "text", text: "keywords required" }] };
    const tagSet = new Set((tags ?? []).map((t) => t.toLowerCase()));
    const results: string[] = [];
    outer: for (const file of walkFiles(root)) {
      const text = readFileSync(file, "utf-8");
      const meta = parseFrontmatter(text);
      const rel = file.slice(root.length + 1);
      if (tagSet.size > 0 && !meta.tags.some((t) => tagSet.has(t.toLowerCase()))) continue;
      const hay = text.toLowerCase();
      for (const k of kw) if (!hay.includes(k.toLowerCase())) continue outer;
      const lines = meta.body.split("\n");
      const hits: string[] = [];
      for (let i = 0; i < lines.length && hits.length < 3; i++) {
        const line = lines[i]!;
        if (kw.some((k) => line.toLowerCase().includes(k.toLowerCase()))) {
          hits.push(`${i + 1}: ${line.slice(0, MAX_LINE)}`);
        }
      }
      const title = meta.title ? `${meta.title} (${rel})` : rel;
      results.push(`### ${title}\n${hits.join("\n")}`);
      if (results.length >= MAX_RESULTS) break;
    }
    if (results.length === 0)
      return { content: [{ type: "text", text: "No knowledge matches found." }] };
    return { content: [{ type: "text", text: results.join("\n\n") }] };
  },
);

server.registerTool(
  "knowledge_read",
  {
    description: "Read a file inside the agent's knowledge base by relative path.",
    inputSchema: {
      path: z.string().describe("Relative path under the knowledge dir"),
    },
  },
  async ({ path }) => {
    const target = resolve(root, path);
    if (!inside(target) || !existsSync(target) || !statSync(target).isFile()) {
      return {
        content: [{ type: "text", text: `no such knowledge file: ${path}` }],
        isError: true,
      };
    }
    if (statSync(target).size > 256_000) {
      return { content: [{ type: "text", text: "file too large (256K cap)" }], isError: true };
    }
    return { content: [{ type: "text", text: readFileSync(target, "utf-8") }] };
  },
);

await server.connect(new StdioServerTransport());
