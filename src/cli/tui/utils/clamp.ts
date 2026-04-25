export function clampPct(value: number, total: number): number {
  if (total <= 0) return 0;
  const ratio = value / total;
  return Math.max(0, Math.min(1, ratio));
}
