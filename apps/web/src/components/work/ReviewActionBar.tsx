"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useReviewLoopItem } from "@/features/loop/hooks";
import type { LoopDetail } from "@/lib/api";

type LoopItem = NonNullable<NonNullable<LoopDetail>["items"]>[number];

type Verdict = "approve" | "reject" | "promote" | "retry" | "dismiss";

const ACTIONS: { verdict: Verdict; label: string; variant: "default" | "outline" | "ghost" }[] = [
  { verdict: "approve", label: "Approve", variant: "default" },
  { verdict: "reject", label: "Reject", variant: "outline" },
  { verdict: "promote", label: "Promote", variant: "ghost" },
  { verdict: "retry", label: "Retry", variant: "outline" },
  { verdict: "dismiss", label: "Dismiss", variant: "ghost" },
];

const ACTIONS_WITH_FEEDBACK: Verdict[] = ["reject", "promote"];

export function ReviewActionBar({ loopId, item }: { loopId: string; item: LoopItem }) {
  const reviewMu = useReviewLoopItem(loopId);
  const [feedback, setFeedback] = useState("");
  const [pending, setPending] = useState<Verdict | null>(null);

  const submit = (verdict: Verdict) => {
    setPending(verdict);
    reviewMu.mutate(
      {
        itemId: item.id,
        verdict,
        feedback: ACTIONS_WITH_FEEDBACK.includes(verdict) ? feedback || undefined : undefined,
      },
      {
        onSettled: () => setPending(null),
      },
    );
  };

  return (
    <div className="space-y-3 border-t border-(--hairline) pt-4">
      <div className="flex flex-wrap gap-2">
        {ACTIONS.map((a) => (
          <Button
            key={a.verdict}
            size="sm"
            variant={a.variant}
            onClick={() => submit(a.verdict)}
            disabled={reviewMu.isPending}
          >
            {pending === a.verdict && reviewMu.isPending ? "…" : a.label}
          </Button>
        ))}
      </div>
      <Textarea
        placeholder="Feedback (required context for reject / promote)"
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        rows={2}
        className="text-sm"
      />
    </div>
  );
}
