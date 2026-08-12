/** Fake claude CLI for adapter tests: prints the recorded stream-json
 *  fixture lines to stdout, reads (and discards) stdin, records argv +
 *  stdin to CLAUDE_FAKE_LOG for assertions. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const which = process.env.CLAUDE_FAKE_FIXTURE ?? "claude-wire-text.jsonl";
const fixture = readFileSync(join(import.meta.dir, which), "utf8");

let stdinText = "";
{
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    stdinText += decoder.decode(value);
  }
}

const logPath = process.env.CLAUDE_FAKE_LOG;
if (logPath) {
  writeFileSync(logPath, JSON.stringify({ argv: process.argv.slice(2), stdin: stdinText.trim() }));
}

for (const line of fixture.split("\n")) {
  if (line.trim() !== "") console.log(line);
}
