"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api, type ReviewQueueItem } from "@/lib/api";

const verdictTone: Record<string, string> = {
  PASS: "bg-emerald-500/15 text-emerald-700",
  REJECT: "bg-rose-500/15 text-rose-700",
  ESCALATE: "bg-amber-500/15 text-amber-700",
};

function truncate(s: string, n = 120) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function ReviewQueueCard({ item }: { item: ReviewQueueItem }) {
  const qc = useQueryClient();
  const review = useMutation({
    mutationFn: (verdict: "approve" | "reject") =>
      api.reviewLoopItem(item.loopId, { itemId: item.id, verdict }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["work-today"] });
      toast.success("Review submitted");
    },
    onError: (e) => toast.error(`Review failed: ${String(e)}`),
  });

  const result = item.result;
  const evidence = result && "evidence" in result ? result.evidence : "";
  const reasons = result && "reasons" in result ? result.reasons.join("; ") : "";

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <Link href={`/work/${item.loopId}`} className="flex-1 min-w-0 hover:underline">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs text-(--mute) truncate">{item.loopName}</span>
              {result && (
                <Badge
                  variant="secondary"
                  className={`text-[10px] ${verdictTone[result.verdict] ?? ""}`}
                >
                  {result.verdict}
                </Badge>
              )}
              <span className="text-[10px] text-(--mute)">attempt {item.attempt}</span>
            </div>
            <p className="text-sm truncate">{item.summary}</p>
            {evidence && (
              <p className="text-xs text-(--mute) mt-1 line-clamp-2">{truncate(evidence)}</p>
            )}
            {reasons && (
              <p className="text-xs text-rose-600/80 mt-0.5 line-clamp-1">
                {truncate(reasons, 80)}
              </p>
            )}
          </Link>
          <div className="flex gap-1 shrink-0">
            <Button size="sm" disabled={review.isPending} onClick={() => review.mutate("approve")}>
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={review.isPending}
              onClick={() => review.mutate("reject")}
            >
              Reject
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
