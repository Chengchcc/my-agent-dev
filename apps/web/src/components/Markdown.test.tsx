/** @jsxImportSource react */
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./Markdown";

function html(text: string): string {
  return renderToStaticMarkup(<Markdown text={text} />);
}

describe("Markdown renderer", () => {
  it("renders unordered list", () => {
    const out = html("- a\n- b");
    expect(out).toContain("<ul");
    expect((out.match(/<li/g) ?? []).length).toBe(2);
  });

  it("renders ordered list", () => {
    expect(html("1. one\n2. two")).toContain("<ol");
  });

  it("renders fenced code as pre>code", () => {
    const out = html("```ts\nconst x = 1\n```");
    expect(out).toContain("<pre");
    expect(out).toContain("<code");
  });

  it("renders blockquote", () => {
    expect(html("> quoted")).toContain("<blockquote");
  });

  it("renders gfm table", () => {
    const out = html("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(out).toContain("<table");
    expect(out).toContain("<th");
  });

  it("renders inline code and bold", () => {
    const out = html("`x` and **y**");
    expect(out).toContain("<code");
    expect(out).toContain("<strong");
  });

  it("renders heading", () => {
    expect(html("# Title")).toContain("<h1");
  });

  it("renders plain text as paragraph", () => {
    expect(html("Hello world")).toContain("<p");
    expect(html("Hello world")).toContain("Hello world");
  });
});
