/** Headless TUI snapshot: drives runTuiSession over a VirtualTerminal with the
 *  scripted fake provider, then dumps viewport frames (plain text + re-emitted
 *  SGR) per toggle state. Style diffing without a real terminal.
 *  Usage: bun scripts/tui-snapshot.ts [outDir]  (SNAP_COLS/SNAP_ROWS env) */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelRuntime } from "@chengchenccc/ai";
import { VirtualTerminal } from "@chengchenccc/tui";
import { registerBuiltinProviders } from "../src/core/run-runtime.js";
import { createTerminalIo, runTuiSession } from "../src/modes/tui/tui-mode.js";

const outDir = process.argv[2] ?? tmpdir();
const cols = Number(process.env.SNAP_COLS ?? 100);
const rows = Number(process.env.SNAP_ROWS ?? 32);

process.env.OMA_FAKE_PROVIDER = "1";

/** A workspace the real tools can act on — a real temp git repo so the
 *  status bar's git-branch segment is exercised in the frames. */
const ws = mkdtempSync(join(tmpdir(), "oma-snap-ws-"));
writeFileSync(
  join(ws, "demo.ts"),
  "const timeout = 1000;\nexport { timeout };\nconsole.log('hello');\n",
);
Bun.spawnSync(["git", "-C", ws, "init", "-q"]);
Bun.spawnSync(["git", "-C", ws, "config", "user.email", "snap@test"]);
Bun.spawnSync(["git", "-C", ws, "config", "user.name", "snap"]);
Bun.spawnSync(["git", "-C", ws, "add", "-A"]);
Bun.spawnSync(["git", "-C", ws, "commit", "-qm", "init"]);

const RICH_TOOLS = JSON.stringify([
  { name: "bash", input: { command: "ls -la" } },
  {
    name: "edit",
    input: {
      path: "demo.ts",
      old_string: "const timeout = 1000;",
      new_string:
        "const timeout = 5000;\nconst retries = 3;\n// verbose new line 1\n// verbose new line 2\n// verbose new line 3\n// verbose new line 4\n// verbose new line 5 overflow",
    },
  },
  { name: "read", input: { path: "demo.ts", offset: 1, limit: 2 } },
  { name: "glob", input: { pattern: "packages/*/src/index.ts" } },
  { name: "bash", input: { command: "echo out; echo boom >&2; exit 2" } },
]);

const RICH_THINKING =
  "The user asked for a quick summary of the project structure.\n" +
  "I listed the workspace root, skimmed a file, then traced the package graph.\n" +
  "Long lines force wrapping in the thinking block so the collapsed view can be checked.";

const MERMAID_ANSWER = [
  "Here is the request flow:",
  "",
  "```mermaid",
  "graph LR",
  "  Start[Start Request] --> Auth{Auth Valid?}",
  "  Auth --No--> Deny[401 Unauthorized]",
  "  Auth --Yes--> Query[Query Service] --> DB[(Database)]",
  "  Query --> Build[Build Response] --> OK[200 OK]",
  "```",
  "",
  "Sentinel: snapshot-complete.",
].join("\n");

const RICH_ANSWER = [
  "## Project structure summary",
  "",
  "I inspected the repo with the tools above. Conclusion:",
  "",
  "- **packages/core** holds the wire contracts (`Message`, `ChatModel`)",
  "- **apps/backend** is the multi-tenant Elysia service",
  "- `packages/tui` owns terminal rendering",
  "",
  "> Keep new code under those layers; no cross-package deep imports.",
  "",
  "```ts",
  "const graph = buildPackageGraph(root);",
  "console.log(graph.edges.length); // walks imports once",
  "```",
  "",
  "1. Protocols first",
  "2. Runtime second",
  "3. Apps last",
  "",
  "Sentinel: snapshot-complete.",
].join("\n");

interface RunOpts {
  tools?: string;
  thinking?: string;
  answer: string;
}

async function runScenario(
  prefix: string,
  prompt: string,
  opts: RunOpts,
  afterSettled?: (vt: VirtualTerminal) => Promise<void>,
): Promise<void> {
  const sessDir = mkdtempSync(join(tmpdir(), "oma-snap-sess-"));
  const prevSessionDir = process.env.OMA_SESSION_DIR;
  process.env.OMA_SESSION_DIR = sessDir;
  process.env.OMA_FAKE_TOOL = opts.tools ?? "[]";
  if (opts.thinking === undefined) {
    delete process.env.OMA_FAKE_THINKING;
  } else {
    process.env.OMA_FAKE_THINKING = opts.thinking;
  }
  process.env.OMA_FAKE_TEXT = opts.answer;

  const vt = new VirtualTerminal(cols, rows);
  const io = createTerminalIo(vt, ws);
  const modelRuntime = createModelRuntime();
  registerBuiltinProviders(modelRuntime, process.env);
  const sessionDone = runTuiSession({ modelRuntime, workspaceRoot: ws }, io);

  const waitForText = async (needle: string, ms: number): Promise<void> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (vt.getViewport().join("\n").includes(needle)) return;
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 50);
      await promise;
    }
    throw new Error(`timed out waiting for: ${needle}`);
  };
  const dump = async (name: string): Promise<void> => {
    await vt.waitForRender();
    writeFileSync(join(outDir, `oma-snap-${prefix}-${name}.txt`), vt.getViewport().join("\n"));
    writeFileSync(
      join(outDir, `oma-snap-${prefix}-${name}.ansi.txt`),
      vt.getViewportAnsi().join("\n"),
    );
    writeFileSync(
      join(outDir, `oma-snap-${prefix}-${name}.full.ansi.txt`),
      vt.getScrollBufferAnsi().join("\n"),
    );
    console.log(`wrote ${prefix}-${name} (${vt.columns}x${vt.rows})`);
  };

  await vt.waitForRender();
  await dump("boot");
  vt.sendInput(prompt);
  await vt.waitForRender();
  vt.sendInput("\r");
  await waitForText("snapshot-complete", 15_000);
  await dump("settled");
  if (afterSettled) await afterSettled(vt);

  // Clean exit: /exit twice.
  vt.sendInput("/exit");
  await vt.waitForRender();
  vt.sendInput("\r");
  await vt.waitForRender();
  vt.sendInput("/exit");
  await vt.waitForRender();
  vt.sendInput("\r");
  await sessionDone;
  io.close();

  if (prevSessionDir === undefined) {
    delete process.env.OMA_SESSION_DIR;
  } else {
    process.env.OMA_SESSION_DIR = prevSessionDir;
  }
}

// Fit: one short exchange — header + user bubble + editor must all fit.
await runScenario("fit", "hi", { answer: "ok — snapshot-complete." });
// Catalog: tools + one short answer, sized to fit within one viewport so
// every transcript element (bubble, tools, diff, error) is on screen.
await runScenario("tools", "run the demo", {
  tools: JSON.stringify([
    { name: "bash", input: { command: "ls -la" } },
    {
      name: "edit",
      input: {
        path: "demo.ts",
        old_string: "const timeout = 1000;",
        new_string: "const timeout = 5000;\nconst retries = 3;",
      },
    },
    { name: "bash", input: { command: "echo boom >&2; exit 2" } },
  ]),
  answer: "done — snapshot-complete.",
});

// Rich: tools + thinking + markdown, then toggles and a narrow reflow.
await runScenario("mermaid", "show the diagram", { answer: MERMAID_ANSWER });

await runScenario(
  "rich",
  "scan the repo and summarize",
  { tools: RICH_TOOLS, thinking: RICH_THINKING, answer: RICH_ANSWER },
  async (vt) => {
    vt.sendInput("\x14"); // ctrl+t: expand thinking
    await vt.waitForRender();
    writeFileSync(join(outDir, "oma-snap-rich-thinking.ansi.txt"), vt.getViewportAnsi().join("\n"));
    vt.sendInput("\x0f"); // ctrl+o: expand tool detail
    await vt.waitForRender();
    writeFileSync(join(outDir, "oma-snap-rich-tools.ansi.txt"), vt.getViewportAnsi().join("\n"));
    vt.sendInput("\x10"); // ctrl+p: model picker overlay
    await vt.waitForRender();
    {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 300);
      await promise;
    }
    await vt.waitForRender();
    writeFileSync(join(outDir, "oma-snap-rich-picker.ansi.txt"), vt.getViewportAnsi().join("\n"));
    vt.sendInput("\x1b"); // esc: close overlay
    await vt.waitForRender();
    vt.resize(60, 28); // narrow reflow
    await vt.waitForRender();
    writeFileSync(join(outDir, "oma-snap-rich-narrow.ansi.txt"), vt.getViewportAnsi().join("\n"));
    writeFileSync(
      join(outDir, "oma-snap-rich-narrow.full.ansi.txt"),
      vt.getScrollBufferAnsi().join("\n"),
    );
    console.log("wrote thinking/tools/narrow frames");
  },
);

console.log("done");
