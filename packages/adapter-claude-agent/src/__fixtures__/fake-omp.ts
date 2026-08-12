/** Fake omp CLI for adapter tests: prints the recorded wire fixture lines
 *  to stdout and exits 0, ignoring all args. Mirrors real omp's session
 *  behavior: touches the `--session <path>` file and records argv to
 *  `<path>.args` so tests can assert resume vs fresh spawns. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const which = process.env.OMP_FAKE_FIXTURE ?? "omp-wire-text.jsonl";
const fixture = readFileSync(join(import.meta.dir, which), "utf8");

const argv = process.argv.slice(2);
const sessionIdx = argv.indexOf("--session");
const resumeIdx = argv.indexOf("-r");
if (sessionIdx >= 0) {
  const path = argv[sessionIdx + 1]!;
  writeFileSync(path, "", { flag: "a" });
  writeFileSync(`${path}.args`, JSON.stringify(argv));
} else if (resumeIdx >= 0) {
  const path = argv[resumeIdx + 1]!;
  writeFileSync(`${path}.args`, JSON.stringify(argv));
}

for (const line of fixture.split("\n")) {
  if (line.trim() !== "") console.log(line);
}
