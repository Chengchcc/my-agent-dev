import { describe, expect, test } from "bun:test";
import { renderMermaidAscii } from "beautiful-mermaid";
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
    const natural = renderMermaidAscii(wideDiagram, { colorMode: "none" });
    const naturalLines = natural.split("\n");
    expect(Math.max(...naturalLines.map(visibleWidth))).toBeGreaterThan(40);

    const rendered = md.render(40);
    // Each preformatted row stays one line; the wrap pass must not fragment it.
    expect(rendered.length).toBe(naturalLines.length);
    for (const line of rendered) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
  });
});
