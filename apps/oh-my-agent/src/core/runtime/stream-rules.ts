import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { StreamRule } from "../agent-runtime.js";

/** Load TTSR-style stream rules (absorbed from oh-my-pi) from
 * `<root>/.oma/rules/*.md`. Frontmatter `condition: <regex>` is required;
 * the body below the frontmatter is the reminder text injected when the
 * rule matches mid-stream. Rule name = filename without `.md`.
 * Fail-open: an unreadable file, missing condition, empty body, or invalid
 * regex is skipped — rules must never block session startup. */
export function loadStreamRules(root: string): StreamRule[] {
  const dir = join(root, ".oma", "rules");
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
  const rules: StreamRule[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), "utf8");
      const frontmatter = content.match(/^---\n([\s\S]*?)\n---/)?.[1];
      const condition = frontmatter?.match(/^condition:\s*(.+)$/m)?.[1]?.trim();
      if (!condition) continue;
      const message = content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
      if (!message) continue;
      rules.push({
        name: file.replace(/\.md$/, ""),
        // No flags: global regexes carry lastIndex state across .test()
        // calls and would silently skip matches.
        pattern: new RegExp(condition),
        message,
      });
    } catch {
      /* invalid rule file: skipped */
    }
  }
  return rules;
}
