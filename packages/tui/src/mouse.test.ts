import { describe, expect, test } from "bun:test";
import { parseSgrMouse, routeSgrMouseInput } from "./mouse.ts";

describe("parseSgrMouse", () => {
  test("wheel up (button 64) and wheel down (button 65)", () => {
    const up = parseSgrMouse("\x1b[<64;10;5M");
    expect(up).toMatchObject({ button: 64, col: 9, row: 4, wheel: -1, release: false });
    const down = parseSgrMouse("\x1b[<65;1;1M");
    expect(down).toMatchObject({ button: 65, wheel: 1, col: 0, row: 0 });
  });

  test("left click press vs release vs motion", () => {
    expect(parseSgrMouse("\x1b[<0;3;3M")).toMatchObject({ leftClick: true, motion: false });
    expect(parseSgrMouse("\x1b[<0;3;3m")).toMatchObject({ release: true, leftClick: false });
    expect(parseSgrMouse("\x1b[<32;3;3M")).toMatchObject({ motion: true, leftClick: false });
  });

  test("non-mouse input returns null", () => {
    expect(parseSgrMouse("\x1b[A")).toBeNull();
    expect(parseSgrMouse("\x1b[5~")).toBeNull();
    expect(parseSgrMouse("x")).toBeNull();
  });
});

describe("routeSgrMouseInput", () => {
  test("routes wheel and reports consumed; falls through on other input", () => {
    const wheels: number[] = [];
    const consumed = routeSgrMouseInput("\x1b[<64;1;1M", (event) => {
      if (event.wheel) wheels.push(event.wheel);
      return true;
    });
    expect(consumed).toBe(true);
    // Not an SGR report: handler must not run.
    expect(
      routeSgrMouseInput("\x1b[5~", () => {
        wheels.push(99);
      }),
    ).toBe(false);
    expect(wheels).toEqual([-1]);
  });
});
