import { describe, expect, test } from "bun:test";
import { resolveMermaidAscii } from "../mermaid.ts";
import { visibleWidth } from "../utils.ts";
import { Markdown, type MarkdownTheme } from "./markdown.ts";

const theme: MarkdownTheme = {
  heading: (s) => s,
  link: (s) => s,
  linkUrl: (s) => s,
  code: (s) => s,
  codeBlock: (s) => s,
  codeBlockBorder: (s) => s,
  quote: (s) => s,
  quoteBorder: (s) => s,
  hr: (s) => s,
  listBullet: (s) => s,
  bold: (s) => s,
  italic: (s) => s,
  strikethrough: (s) => s,
  underline: (s) => s,
};

const wideDiagram = `graph LR
  Start[Start Request] --> Auth{Auth Valid?}
  Auth --No--> Deny[401 Unauthorized]
  Auth --Yes--> Query[Query Service] --> DB[(Database)]
  Query --> Build[Build Response] --> OK[200 OK]`;

describe("markdown mermaid", () => {
  test("clips wide mermaid ASCII rows instead of wrapping them", () => {
    const md = new Markdown(`\`\`\`mermaid\n${wideDiagram}\n\`\`\``, 0, 0, theme);
    const resolved = resolveMermaidAscii(wideDiagram, { maxWidth: 40 });
    expect(resolved).not.toBeNull();
    const resolvedLines = resolved!.split("\n");
    // Re-fit can pick a taller TD layout when the base LR graph overflows.

    const rendered = md.render(40);
    // Every preformatted row stays exactly one row; the wrap pass must not
    // fragment the box-drawing canvas.
    expect(rendered.length).toBe(resolvedLines.length);
    for (const line of rendered) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
    for (const line of rendered) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
  });
});
