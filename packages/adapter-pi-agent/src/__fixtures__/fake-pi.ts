/** Fake pi CLI for adapter tests: prints the recorded wire fixture lines
 *  to stdout and exits 0, ignoring all args. Mirrors real pi's session
 *  behavior: `--session <path>` writes a fresh file AND resumes an
 *  existing one; argv is recorded to `<path>.args` for assertions. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const which = process.env.PI_FAKE_FIXTURE ?? "pi-wire-text.jsonl";
const fixture = readFileSync(join(import.meta.dir, which), "utf8");

const argv = process.argv.slice(2);
const sessionIdx = argv.indexOf("--session");
if (sessionIdx >= 0) {
  const path = argv[sessionIdx + 1]!;
  writeFileSync(path, "", { flag: "a" });
  writeFileSync(`${path}.args`, JSON.stringify(argv));
}

for (const line of fixture.split("\n")) {
  if (line.trim() !== "") console.log(line);
}
