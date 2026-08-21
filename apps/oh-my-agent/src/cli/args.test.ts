import { describe, expect, test } from "bun:test";
import { createModelRuntime } from "@chengchenccc/ai";
import { fakeProvider } from "../core/fake-provider.js";
import { parseArgs, UsageError } from "./args.js";
import { buildCliRunInput, mergeInitialInput, readPipedStdin } from "./initial-input.js";

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
      model: undefined,
    });
  });

  test("--model picks a canonical provider/model id", () => {
    expect(parseArgs(["--model", "anthropic/claude-sonnet-4", "-p", "x"])).toMatchObject({
      model: "anthropic/claude-sonnet-4",
      prompt: "x",
    });
    expect(parseArgs(["--model=fake/echo", "x"])).toMatchObject({ model: "fake/echo" });
  });

  test("--model without a value is a usage error", () => {
    expect(() => parseArgs(["--model"])).toThrow(/--model requires/);
    expect(() => parseArgs(["--model="])).toThrow(/--model requires/);
  });

  test("empty argv is syntactically valid (input validation lives in main)", () => {
    expect(parseArgs([])).toEqual({ mode: "print", prompt: "", listModels: false });
  });

  test("the standalone --json flag is gone (unknown option)", () => {
    expect(() => parseArgs(["--json"])).toThrow(UsageError);
  });

  test("--session without a value is a usage error", () => {
    expect(() => parseArgs(["--session"])).toThrow(UsageError);
  });

  test("unknown options are rejected", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown option/);
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

describe("buildCliRunInput model selection", () => {
  function runtime() {
    const rt = createModelRuntime();
    rt.registerProvider(fakeProvider({}));
    return rt;
  }

  test("defaults to the first available model", async () => {
    const input = await buildCliRunInput({
      prompt: "x",
      workspaceRoot: "/tmp",
      modelRuntime: runtime(),
    });
    expect(input.run.model.modelId).toBe("fake/echo");
  });

  test("--model selects the SECOND catalog model by canonical id", async () => {
    const input = await buildCliRunInput({
      prompt: "x",
      workspaceRoot: "/tmp",
      modelRuntime: runtime(),
      modelId: "fake/echo2",
    });
    expect(input.run.model.modelId).toBe("fake/echo2");
  });

  test("an unknown --model id is rejected", async () => {
    await expect(
      buildCliRunInput({
        prompt: "x",
        workspaceRoot: "/tmp",
        modelRuntime: runtime(),
        modelId: "nope/does-not-exist",
      }),
    ).rejects.toThrow(/model not found/);
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
