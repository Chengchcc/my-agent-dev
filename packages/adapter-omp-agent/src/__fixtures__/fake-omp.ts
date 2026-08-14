/** Fake omp CLI for adapter tests: prints the recorded wire fixture lines
 *  to stdout and exits 0, ignoring all args. Records argv to
 *  OMP_FAKE_LOG so tests can assert resume vs fresh spawns. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const which = process.env.OMP_FAKE_FIXTURE ?? "omp-wire-text.jsonl";
const fixture = readFileSync(join(import.meta.dir, which), "utf8");

const logPath = process.env.OMP_FAKE_LOG;
if (logPath) {
  writeFileSync(logPath, JSON.stringify(process.argv.slice(2)));
}

for (const line of fixture.split("\n")) {
  if (line.trim() !== "") console.log(line);
}
