import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createReadImageTool } from "./read-image.js";

const tmp = `/tmp/read-image-${Math.random().toString(36).slice(2, 8)}`;
mkdirSync(tmp, { recursive: true });

/** 1x1 red PNG. */
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8BQDwAEgAF/poBPAAAAAElFTkSuQmCC";
const pngBytes = Buffer.from(PNG_1PX, "base64");
writeFileSync(join(tmp, "dot.png"), pngBytes);
writeFileSync(join(tmp, "not-an-image.txt"), "hello");

describe("createReadImageTool", () => {
  test("returns a base64 image block with sniffed media type", async () => {
    const tool = createReadImageTool({ cwd: tmp });
    const out = (await tool.execute({ path: "dot.png" })) as unknown as {
      content: string;
      mediaType: string;
      images: Array<{ type: string; mediaType: string; base64: string }>;
    };
    expect(out.content).toContain("dot.png");
    expect(out.mediaType).toBe("image/png");
    expect(out.images).toHaveLength(1);
    expect(out.images[0]?.type).toBe("image");
    expect(out.images[0]?.mediaType).toBe("image/png");
    expect(out.images[0]?.base64).toBe(PNG_1PX);
  });

  test("non-image files and escapes are errors", async () => {
    const tool = createReadImageTool({ cwd: tmp });
    const bad = (await tool.execute({ path: "not-an-image.txt" })) as {
      content: string;
      isError?: boolean;
    };
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain("unsupported image format");
    const esc = (await tool.execute({ path: "../etc/passwd" })) as {
      content: string;
      isError?: boolean;
    };
    expect(esc.isError).toBe(true);
    expect(esc.content).toContain("escapes workspace");
  });

  test("sibling-prefix paths outside the workspace are rejected", async () => {
    const tool = createReadImageTool({ cwd: tmp });
    const out = (await tool.execute({ path: `${tmp}-evil/x.png` })) as {
      content: string;
      isError?: boolean;
    };
    expect(out.isError).toBe(true);
    expect(out.content).toContain("escapes workspace");
  });

  test("symlink inside the workspace pointing outside is rejected", async () => {
    symlinkSync("/etc/passwd", join(tmp, "escape-link.png"));
    const tool = createReadImageTool({ cwd: tmp });
    const out = (await tool.execute({ path: "escape-link.png" })) as {
      content: string;
      isError?: boolean;
    };
    expect(out.isError).toBe(true);
    expect(out.content).toContain("escapes workspace");
  });
});
