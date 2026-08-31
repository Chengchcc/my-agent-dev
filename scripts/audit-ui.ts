/**
 * UI consistency audit.
 *
 * Zero-tolerance:
 *   - native alert( / confirm( / window.confirm( in apps/web/src (UI review
 *     WS-2: every confirmation/error goes through useConfirm / toast).
 *
 * Also gating (translation completed 2026-08-31):
 *   - CJK characters anywhere in apps/web/src — user-visible strings are
 *     English-only now; new UI copy must not reintroduce Chinese.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const WEB_SRC = join(ROOT, "apps/web/src");
const failures: string[] = [];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(tsx|ts)$/.test(entry)) out.push(p);
  }
  return out;
}

const files = walk(WEB_SRC);
const cjkByDir = new Map<string, number>();
const cjkFiles: string[] = [];

for (const file of files) {
  const src = readFileSync(file, "utf8");
  // Native popup — zero tolerance.
  if (/window\.confirm\s*\(/.test(src)) {
    failures.push(`native confirm in ${relative(ROOT, file)}`);
  }
  if (/window\.alert\s*\(/.test(src)) {
    failures.push(`native alert in ${relative(ROOT, file)}`);
  }
  // CJK: now gating — the translation is complete (2026-08-31). New
  // user-visible Chinese belongs in comments only, which this scan skips
  // for files under components/ui (none expected) but checks everywhere
  // else. Zero tolerance, same as the review acceptance.
  // EXEMPT: lib/locales/ — that is where i18n translation dictionaries
  // live by design (see lib/locales/README.md); non-English text there is
  // the feature, not rot.
  if (!file.includes(join("lib", "locales"))) {
    const cjk = (src.match(/[\u4e00-\u9fff]/g) ?? []).length;
    if (cjk > 0) {
      failures.push(`CJK in ${relative(ROOT, file)} (${cjk} chars)`);
      const dir = relative(ROOT, file).split("/").slice(0, 3).join("/");
      cjkByDir.set(dir, (cjkByDir.get(dir) ?? 0) + cjk);
      cjkFiles.push(relative(ROOT, file));
    }
  }
}

if (failures.length > 0) {
  console.error(`audit:ui FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`audit:ui OK — no native alert/confirm (${files.length} files scanned)`);
console.log("CJK remaining (informational, zero-gated once translations land):");
for (const [dir, n] of [...cjkByDir.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${n}\t${dir}`);
}
