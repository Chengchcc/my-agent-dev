import { describe, expect, test } from "bun:test";
import { parseArgs, UsageError } from "./args.js";
import { mergeInitialInput, readPipedStdin } from "./initial-input.js";

describe("parseArgs (syntax only)", () => {
  test("-p sets print mode with the positional prompt", () => {
    expect(parseArgs(["-p", "fix this"])).toEqual({
      mode: "print",
      prompt: "fix this",
      listModels: false,
    });
  });

  test("a bare positional prompt is the print shorthand", () => {
    expect(parseArgs(["fix this"])).toEqual({
      mode: "print",
      prompt: "fix this",
      listModels: false,
    });
  });

  test("--mode json / --mode=json set the json mode", () => {
    expect(parseArgs(["--mode", "json", "translate"])).toMatchObject({
      mode: "json",
      prompt: "translate",
    });
    expect(parseArgs(["--mode=json", "translate"])).toMatchObject({ mode: "json" });
  });

  test("--list-models needs no prompt", () => {
    expect(parseArgs(["--list-models"])).toEqual({
      mode: "print",
      prompt: "",
      listModels: true,
    });
  });

  test("empty argv is syntactically valid (input validation lives in main)", () => {
    expect(parseArgs([])).toEqual({ mode: "print", prompt: "", listModels: false });
  });

  test("the standalone --json flag is gone (unknown option)", () => {
    expect(() => parseArgs(["--json"])).toThrow(UsageError);
  });

  test("unknown options are rejected", () => {
    expect(() => parseArgs(["--session"])).toThrow(/unknown option/);
  });
});

describe("mergeInitialInput", () => {
  test("prompt only", () => {
    expect(mergeInitialInput({ prompt: "review" })).toBe("review");
  });

  test("piped stdin only", () => {
    expect(mergeInitialInput({ piped: "diff" })).toBe("diff");
  });

  test("stdin appears before the instruction, separated by a blank line", () => {
    expect(mergeInitialInput({ piped: "diff", prompt: "review" })).toBe("diff\n\nreview");
  });

  test("whitespace-only inputs are empty", () => {
    expect(mergeInitialInput({ piped: "   \n  ", prompt: "" })).toBe("");
    expect(mergeInitialInput({})).toBe("");
  });

  test("parts are trimmed", () => {
    expect(mergeInitialInput({ piped: "  diff  ", prompt: "  review  " })).toBe("diff\n\nreview");
  });
});

describe("readPipedStdin", () => {
  function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(encoder.encode(chunk));
        c.close();
      },
    });
  }

  test("reads piped content", async () => {
    const { isTTY } = process.stdin;
    // The TTY check reads the REAL process stdin; the manual stream below is
    // what matters. (Under bun test stdin is not a TTY, so the read path runs.)
    void isTTY;
    expect(await readPipedStdin(streamOf(["error line 1\n", "error line 2\n"]))).toBe(
      "error line 1\nerror line 2",
    );
  });

  test("whitespace-only piped content is undefined", async () => {
    expect(await readPipedStdin(streamOf(["   \n \t "]))).toBeUndefined();
  });

  test("empty piped content is undefined", async () => {
    expect(await readPipedStdin(streamOf([]))).toBeUndefined();
  });

  test("oversized piped stdin throws UsageError (16 MiB bound)", async () => {
    const big = "x".repeat(17 * 1024 * 1024);
    expect(readPipedStdin(streamOf([big]))).rejects.toThrow(/16 MiB/);
  });
});
