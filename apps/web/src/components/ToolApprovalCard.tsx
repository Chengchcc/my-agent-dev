"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface ToolApprovalCardProps {
  tool: { id: string; name: string; input: unknown };
  onApprove: (message?: string) => void;
  onDeny: (message?: string) => void;
  disabled?: boolean;
}

const DANGEROUS_TOOLS = new Set(["bash", "write", "edit", "delete", "rm", "mv"]);
const READONLY_TOOLS = new Set(["read", "grep", "glob", "ls", "cat", "head", "tail"]);

function toolRisk(toolName: string): "dangerous" | "safe" | "neutral" {
  const n = toolName.toLowerCase();
  if (DANGEROUS_TOOLS.has(n)) return "dangerous";
  if (READONLY_TOOLS.has(n)) return "safe";
  return "neutral";
}

const riskStyles = {
  dangerous: {
    border: "border-destructive",
    dot: "bg-destructive",
    text: "text-destructive",
    label: "Approval Required — Destructive Action",
  },
  safe: {
    border: "border-[var(--primary)]",
    dot: "bg-[var(--primary)]",
    text: "text-[var(--primary)]",
    label: "Approval Required",
  },
  neutral: {
    border: "border-[var(--chart-4)]",
    dot: "bg-[var(--chart-4)]",
    text: "text-[var(--chart-4)]",
    label: "Approval Required",
  },
} as const;

export function ToolApprovalCard({ tool, onApprove, onDeny, disabled }: ToolApprovalCardProps) {
  const [message, setMessage] = useState("");
  const risk = toolRisk(tool.name);
  const s = riskStyles[risk];

  return (
    <div className={`border-t-2 ${s.border} bg-(--canvas)`}>
      <div className="px-6 py-5 mx-auto" style={{ maxWidth: "72ch" }}>
        {/* Header */}
        <div className="flex items-center gap-3 mb-3">
          <span className={`size-2  rounded-full ${s.dot}`} />
          <p
            className={`text-[10px] tracking-[0.15em] uppercase font-sans font-semibold ${s.text}`}
          >
            {s.label}
          </p>
        </div>

        {risk === "dangerous" && (
          <div className="mb-3 p-2 rounded border border-destructive/30 bg-destructive/10 text-xs text-destructive">
            This tool can modify files or execute commands. Review carefully before approving.
          </div>
        )}

        <p className="text-sm text-(--ink) mb-2">
          Agent requests to use{" "}
          <span className="text-[13px] font-mono bg-(--canvas-soft) px-1.5 py-0.5 border border-(--hairline) rounded text-(--canvas-text-soft)">
            {tool.name}
          </span>
        </p>

        <pre className="text-[13px] text-(--mute) mb-4 max-h-20 overflow-y-auto leading-relaxed font-mono bg-(--canvas-soft) rounded p-3">
          {JSON.stringify(tool.input, null, 2)}
        </pre>

        <Input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Optional feedback..."
          className="w-full bg-(--canvas-soft) border border-(--hairline) rounded-md
                     px-3 py-2 mb-4 text-sm text-(--ink)
                     placeholder:text-(--mute)
                     focus:outline-none focus:border-(--primary)
                     transition-colors duration-200"
        />

        <div className="flex gap-3">
          <Button
            variant="default"
            onClick={() => onApprove(message || undefined)}
            disabled={disabled}
          >
            {disabled ? "Approving…" : "Approve"}
          </Button>
          <Button
            variant="outline"
            onClick={() => onDeny(message || undefined)}
            disabled={disabled}
          >
            {disabled ? "Denying…" : "Deny"}
          </Button>
        </div>
      </div>
    </div>
  );
}
