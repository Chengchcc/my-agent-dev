import type { TranscriptItem } from "./view-state.js";

/** omp-style plain-list todo rendering (no card/box). */
export function renderTodoTool(item: TranscriptItem, expanded: boolean): string[] {
  const lines: string[] = ["\u001b[36m  todo\u001b[0m"];
  const items = todoItems(item);
  if (items.length === 0) return ["\u001b[36m  todo\u001b[0m", "\u001b[2m    (no items)\u001b[0m"];
  for (const it of items) {
    const mark =
      it.status === "done"
        ? "\u001b[32m✓\u001b[0m"
        : it.status === "in_progress"
          ? "\u001b[33m●\u001b[0m"
          : it.status === "cancelled"
            ? "\u001b[31m✗\u001b[0m"
            : "\u001b[2m☐\u001b[0m";
    lines.push(`  ${mark} ${it.text}`);
  }
  if (!expanded) {
    const open = items.filter((i) => i.status !== "done" && i.status !== "cancelled").length;
    if (open > 0) lines.push(`\u001b[2m    ${open} open — (ctrl+o for full list)\u001b[0m`);
  }
  return lines;
}

/** omp-style plain-list task rendering (no card/box). */
export function renderTaskTool(item: TranscriptItem, expanded: boolean): string[] {
  const label = typeof item.input?.label === "string" ? item.input.label : "";
  const lines: string[] = [`\u001b[36m  task${label ? ` · ${label}` : ""}\u001b[0m`];
  const result = item.result;
  if (result && typeof result === "object" && "status" in result) {
    const st = String(result.status);
    lines.push(`\u001b[2m    status: ${st}\u001b[0m`);
  }
  const content =
    typeof result?.content === "string"
      ? result.content
      : typeof result?.text === "string"
        ? result.text
        : "";
  if (content) {
    const text = content.trim();
    if (text) lines.push(`\u001b[2m    ${text.slice(0, expanded ? 400 : 160)}\u001b[0m`);
  }
  if (lines.length === 1) lines.push(`\u001b[2m    (done)\u001b[0m`);
  return lines;
}

function todoItems(item: TranscriptItem): Array<{ id: string; text: string; status: string }> {
  const candidates: unknown[] = [];
  const result = item.result as Record<string, unknown> | undefined;
  if (result) {
    if (Array.isArray(result.items)) candidates.push(...result.items);
    const content = typeof result.content === "string" ? result.content : "";
    if (content) {
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        if (Array.isArray(parsed.items)) candidates.push(...parsed.items);
      } catch {
        // keep raw string path below
      }
    }
  }
  if (item.input && Array.isArray(item.input.items))
    candidates.push(...(item.input.items as unknown[]));
  return candidates
    .filter(
      (v): v is { id: string; text: string; status: string } =>
        typeof v === "object" &&
        v !== null &&
        "text" in v &&
        typeof (v as { text: unknown }).text === "string" &&
        "status" in v &&
        typeof (v as { status: unknown }).status === "string",
    )
    .map((v) => ({
      id: "id" in v && typeof v.id === "string" ? v.id : "",
      text: (v as { text: string }).text,
      status: (v as { status: string }).status,
    }));
}
