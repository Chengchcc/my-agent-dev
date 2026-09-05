"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { MonoLabel } from "@/components/patterns";
import type { TelemetrySummary } from "@/lib/api";

/** Design's Token Consumption & Cost Burn area chart (single real series from
 *  `costByHour`: tokens per hour). Per-provider split isn't in the summary —
 *  this renders the aggregate curve. */
export function TokenAreaChart({ data }: { data: TelemetrySummary }) {
  if (data.costByHour.length === 0) return null;
  const rows = data.costByHour.map((h) => ({
    hour: new Date(h.hour).toLocaleTimeString(undefined, { hour: "numeric" }),
    tokens: h.tokens,
    costUsd: h.costUsd,
  }));
  const peak = data.costByHour.reduce((m, h) => Math.max(m, h.tokens), 0);
  const cumulative = data.costByHour.reduce((s, h) => s + h.tokens, 0);

  return (
    <div className="rounded-lg border border-(--hairline) bg-(--panel) p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <MonoLabel>Token consumption &amp; cost burn</MonoLabel>
        <span className="font-mono text-[10px] text-(--faint) uppercase tracking-kicker">
          Peak{" "}
          {peak >= 1_000_000 ? `${(peak / 1_000_000).toFixed(2)}M` : `${(peak / 1000).toFixed(1)}k`}{" "}
          tok/hr
        </span>
      </div>
      <div className="h-32 w-full">
        <ResponsiveContainer>
          <AreaChart data={rows}>
            <defs>
              <linearGradient id="tokFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.35} />
                <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--hairline)" strokeOpacity={0.4} />
            <XAxis dataKey="hour" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
            <YAxis
              width={44}
              tick={{ fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : `${v}`)}
            />
            <Tooltip
              contentStyle={{
                background: "var(--canvas-soft)",
                border: "1px solid var(--hairline)",
                borderRadius: 8,
                fontSize: 11,
              }}
            />
            <Area
              type="monotone"
              dataKey="tokens"
              stroke="var(--chart-1)"
              strokeWidth={2}
              fill="url(#tokFill)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-(--hairline) pt-3">
        <Stat label="Cumulative" value={tok(cumulative)} />
        <Stat label="Burn velocity" value={`$${data.costUsd.toFixed(2)}`} />
        <Stat label="Cost 24h" value={`$${data.costUsd.toFixed(2)}`} />
      </div>
    </div>
  );
}

function tok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-label-caps text-label-caps uppercase tracking-wider text-(--mute)">
        {label}
      </div>
      <div className="font-display text-lg font-semibold text-(--ink-strong) tabular-nums">
        {value}
      </div>
    </div>
  );
}
