import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageBubble } from "./MessageBubble";

describe("MessageBubble error pill", () => {
  test("renders the error pill with the error text when state is error", () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        align="left"
        name="Agent"
        kind="agent"
        agentId="a1"
        content="partial output"
        state="error"
        error="child process exited with code 1"
      />,
    );
    expect(html).toContain("message-error");
    expect(html).toContain("child process exited with code 1");
  });

  test("does not render the pill for a done message", () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        align="left"
        name="Agent"
        kind="agent"
        agentId="a1"
        content="done"
        state="done"
      />,
    );
    expect(html).not.toContain("message-error");
  });

  test("user messages render as a panel2 bubble (§3)", () => {
    const html = renderToStaticMarkup(
      <MessageBubble align="right" kind="human" content="hello" state="done" />,
    );
    expect(html).toContain("bg-(--panel2)");
    expect(html).toContain("rounded-lg");
  });
});
