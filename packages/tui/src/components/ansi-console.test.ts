import { describe, expect, test } from "bun:test";
import { AnsiConsole } from "./ansi-console.ts";

describe("AnsiConsole", () => {
  test("renders raw ANSI output into bounded rows", async () => {
    const pane = new AnsiConsole(
      20,
      3,
      () => {},
      () => {},
    );
    pane.write("hello \x1b[32mgreen\x1b[0m\r\nsecond line");
    await pane.flush();
    const lines = pane.render(20);
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain("hello");
    expect(lines[0]).toContain("green");
    expect(lines[1]).toContain("second line");
  });

  test("handleInput forwards bytes; lone Esc triggers exit key", () => {
    const forwarded: string[] = [];
    let exited = false;
    const pane = new AnsiConsole(
      20,
      3,
      (data) => forwarded.push(data),
      () => {
        exited = true;
      },
    );
    pane.handleInput("a");
    pane.handleInput("\x1b[B"); // arrow key escape sequence: forwarded
    pane.handleInput("\x1b"); // lone Esc: exit
    expect(forwarded).toEqual(["a", "\x1b[B"]);
    expect(exited).toBe(true);
  });

  test("output beyond the visible rows scrolls the virtual screen", async () => {
    const pane = new AnsiConsole(
      20,
      3,
      () => {},
      () => {},
    );
    pane.write("l1\nl2\nl3\nl4\nl5");
    await pane.flush();
    const lines = pane.render(20);
    expect(lines.length).toBe(3);
    expect(lines[2]).toContain("l5");
    expect(lines.join("\n")).not.toContain("l1");
    expect(lines.join("\n")).not.toContain("l2");
  });
});
