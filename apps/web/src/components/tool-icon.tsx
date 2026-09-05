import { Braces, Globe, Library, type LucideIcon, NotebookPen, TerminalSquare } from "lucide-react";

/** Per-tool icon by name — terminal / file / web / doc kinds get a stable glyph.
 *  Shared by ToolStep and ToolCallCard so every tool card reads the same. */
export function toolIcon(name: string): LucideIcon {
  const n = name.toLowerCase();
  if (n.includes("bash") || n.includes("eval") || n.includes("exec") || n.includes("shell"))
    return TerminalSquare;
  if (n.includes("read") || n.includes("write") || n.includes("edit") || n.includes("file"))
    return NotebookPen;
  if (n.includes("web") || n.includes("http") || n.includes("fetch")) return Globe;
  if (n.includes("mcp") || n.includes("todo") || n.includes("task")) return Library;
  return Braces;
}

/** Compact one-line preview of a tool's key input argument (bash command,
 *  file path, url…). Falls back to the first entry. Shared by the tool cards. */
export function inputPreview(input: unknown): string {
  if (typeof input === "string") return input.slice(0, 120);
  if (!input || typeof input !== "object") return JSON.stringify(input) ?? "";
  const o = input as Record<string, unknown>;
  for (const key of ["command", "path", "url", "query", "sql", "directory"]) {
    const v = o[key];
    if (typeof v === "string" && v) return String(v).slice(0, 120);
  }
  const [first] = Object.entries(o);
  if (first) {
    const [k, v] = first as [string, unknown];
    const vs = typeof v === "string" ? v : JSON.stringify(v);
    return `${k}: ${String(vs).slice(0, 110)}`;
  }
  return "";
}
