import { describe, expect, test } from "bun:test";
import { Text } from "./components/text.ts";
import { TUI } from "./tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("TUI resize scrollback", () => {
  test("width change clears native scrollback so old-width wraps do not remain", async () => {
    const vt = new VirtualTerminal(20, 5);
    const tui = new TUI(vt);
    for (let i = 0; i < 10; i++) {
      tui.addChild(new Text("A".repeat(20), 0, 0));
    }
    tui.start();
    await vt.waitForRender();

    const before = vt.getScrollBuffer();
    expect(before.some((line) => line.includes("A".repeat(20)))).toBe(true);

    vt.resize(10, 5);
    await vt.waitForRender();

    const after = vt.getScrollBuffer();
    // The 20-column rows must not survive a 10-column rerender; content is
    // re-wrapped into 10-column rows instead.
    expect(after.some((line) => line.includes("A".repeat(20)))).toBe(false);
    expect(after.some((line) => line.includes("A".repeat(10)))).toBe(true);
  });
});
