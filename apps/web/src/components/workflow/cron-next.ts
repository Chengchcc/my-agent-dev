/** Minimal 5-field cron next-run calculator (supports *, numbers, lists,
 *  ranges a-b, steps (star-slash-n). Returns null for unparseable expressions. */

function fieldMatcher(pattern: string, min: number, max: number): ((v: number) => boolean) | null {
  const parts = pattern
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const sets: Array<(v: number) => boolean> = [];
  for (const part of parts) {
    let range = part;
    let step = 1;
    const slash = part.indexOf("/");
    if (slash !== -1) {
      range = part.slice(0, slash);
      step = Number(part.slice(slash + 1));
      if (!Number.isInteger(step) || step < 1) return null;
    }
    let lo = min;
    let hi = max;
    if (range !== "*") {
      const dash = range.indexOf("-");
      if (dash !== -1) {
        lo = Number(range.slice(0, dash));
        hi = Number(range.slice(dash + 1));
      } else {
        lo = hi = Number(range);
      }
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi)
        return null;
    }
    const l = lo;
    const h = hi;
    const st = step;
    sets.push((v) => v >= l && v <= h && (v - l) % st === 0);
  }
  return (v) => sets.some((fn) => fn(v));
}

export function nextCronRun(expr: string, from = new Date()): Date | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const dom = fieldMatcher(fields[2]!, 1, 31);
  const mon = fieldMatcher(fields[3]!, 1, 12);
  // 0 and 7 both mean Sunday — normalize 7 to 0 before matching getDay().
  const dowField = fields[4]!.replace(/(^|[^0-9])7($|[^0-9])/g, "$10$2");
  const dow = fieldMatcher(dowField, 0, 6);
  const minute = fieldMatcher(fields[0]!, 0, 59);
  const hour = fieldMatcher(fields[1]!, 0, 23);
  if (!minute || !hour || !dom || !mon || !dow) return null;
  // dom/dow semantics: if both restricted, either may match (Vixie cron).
  const domRestricted = fields[2] !== "*";
  const dowRestricted = fields[4] !== "*";

  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const limit = from.getTime() + 370 * 24 * 3600 * 1000;
  while (t.getTime() <= limit) {
    if (
      minute(t.getMinutes()) &&
      hour(t.getHours()) &&
      mon(t.getMonth() + 1) &&
      (domRestricted && dowRestricted
        ? dom(t.getDate()) || dow(t.getDay())
        : dom(t.getDate()) && dow(t.getDay()))
    ) {
      return new Date(t.getTime());
    }
    t.setMinutes(t.getMinutes() + 1);
  }
  return null;
}

export function formatNextRun(d: Date | null): string {
  if (!d) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (sameDay) return `今天 ${hm}`;
  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
  if (d.toDateString() === tomorrow.toDateString()) return `明天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}
