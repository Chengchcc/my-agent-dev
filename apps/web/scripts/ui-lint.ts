#!/usr/bin/env bun
/** UI token discipline (no-VLM lock): bare hex (outside globals.css),
 *  `tracking-[` arbitrary values, and inline font/letterSpacing/padding/
 *  margin styles are lint errors. Run via `bun run lint:ui`. */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "src");

const failures: string[] = [];

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules") continue;
      yield* walk(full);
    } else if (/\.(tsx|css)$/.test(name)) {
      yield full;
    }
  }
}

for (const file of walk(SRC)) {
  const text = readFileSync(file, "utf-8");
  // chart.tsx carries shadcn-generated recharts SELECTORS (stroke='#ccc')
  // - not palette literals. globals.css is the token home.
  if (
    !file.endsWith("globals.css") &&
    !file.endsWith("ui/chart.tsx") &&
    /#[0-9a-fA-F]{3,8}\b/.test(text)
  ) {
    failures.push(`${file}: bare hex literal`);
  }
  if (/tracking-\[/.test(text)) {
    failures.push(`${file}: tracking-[ arbitrary value`);
  }
  if (/style=\{\{[^}]*\b(fontSize|letterSpacing|padding|margin)\b/.test(text)) {
    failures.push(`${file}: inline fontSize/letterSpacing/padding/margin style`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("ui-lint: clean");
