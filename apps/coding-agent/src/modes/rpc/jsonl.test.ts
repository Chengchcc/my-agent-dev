import { describe, expect, test } from "bun:test";

import { createJsonlReader } from "./jsonl.js";

/** Strict LF framing: only \n splits; half packets buffer; bounded frames. */

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of iter) out.push(line);
  return out;
}

describe("createJsonlReader", () => {
  test("splits complete lines on LF only", async () => {
    const lines = await collect(createJsonlReader(streamOf(["a\nb\nc\n"])));
    expect(lines).toEqual(["a", "b", "c"]);
  });

  test("buffers half packets across chunk boundaries", async () => {
    const lines = await collect(createJsonlReader(streamOf(["hel", "lo wo", "rld\nseco", "nd\n"])));
    expect(lines).toEqual(["hello world", "second"]);
  });

  test("does not split on Unicode separators (only LF)", async () => {
    // U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR) must stay
    // inside a frame: a generic line reader would split them.
    const lines = await collect(createJsonlReader(streamOf(["a\u2028b\u2029c\n"])));
    expect(lines).toEqual(["a\u2028b\u2029c"]);
  });

  test("emits a trailing frame without a final LF", async () => {
    const lines = await collect(createJsonlReader(streamOf(["first\nsecond"])));
    expect(lines).toEqual(["first", "second"]);
  });

  test("handles multibyte UTF-8 split across chunks", async () => {
    const lines = await collect(createJsonlReader(streamOf(["你", "好\n世界\n"])));
    expect(lines).toEqual(["你好", "世界"]);
  });

  test("oversized frames are skipped and reported, memory stays bounded", async () => {
    const oversize: number[] = [];
    const big = "x".repeat(500);
    const lines = await collect(
      createJsonlReader(streamOf([`${big}\nok\n`]), {
        maxLineBytes: 100,
        onOversize: (n) => oversize.push(n),
      }),
    );
    expect(lines).toEqual(["ok"]);
    expect(oversize.length).toBe(1);
    expect(oversize[0]).toBe(500);
  });

  test("empty chunks and empty lines are tolerated", async () => {
    const lines = await collect(createJsonlReader(streamOf(["", "\n", "\n"])));
    expect(lines).toEqual(["", ""]);
  });
});
