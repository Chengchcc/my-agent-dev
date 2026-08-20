"use client";

import { MoreHorizontal, Trash2 } from "lucide-react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { EvidenceChainPanel } from "@/components/work/EvidenceChainPanel";
import { LoopBoard } from "@/components/work/LoopBoard";
import {
  useActivateLoop,
  useAddLoopItem,
  useDeactivateLoop,
  useDeferItem,
  useDeleteLoop,
  useDoctorLoop,
  useLoopDetail,
  useRunLoop,
  useUndeferItem,
} from "@/features/loop/hooks";

const STEP_ORDER = ["fixing", "verifying", "awaiting_review", "resolved"] as const;
const STEP_BADGE: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  fixing: "outline",
  verifying: "secondary",
  awaiting_review: "default",
  resolved: "outline",
};

export default function LoopDetailPage() {
  const { loopId } = useParams<{ loopId: string }>();
  const router = useRouter();
  const { data, isLoading } = useLoopDetail(loopId);
  const runMu = useRunLoop();
  const doctorMu = useDoctorLoop();
  const [doctorReport, setDoctorReport] = useState<{
    issues: Array<{ kind: string; target: string; action: string }>;
    fixed: string[];
  } | null>(null);
  const activateMu = useActivateLoop();
  const deactivateMu = useDeactivateLoop();
  const addItemMu = useAddLoopItem(loopId);
  const deferItemMu = useDeferItem(loopId);
  const undeferItemMu = useUndeferItem(loopId);
  const deleteLoopMu = useDeleteLoop();
  const [deferOpen, setDeferOpen] = useState(false);
  const [deferReason, setDeferReason] = useState("");

  const loop = data?.loop;
  const searchParams = useSearchParams();
  const view = searchParams.get("view") === "board" ? "board" : "list";
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [source, setSource] = useState("manual");
  const [summary, setSummary] = useState("");
  const [priority, setPriority] = useState("");

  const items = loop?.items ?? [];
  const grouped = useMemo(() => {
    const map: Record<string, typeof items> = {};
    for (const it of items) {
      if (!map[it.step]) map[it.step] = [];
      map[it.step]!.push(it);
    }
    return map;
  }, [items]);

  const selected = items.find((i) => i.id === selectedId) ?? null;

  if (isLoading)
    return (
      <Page>
        <PageBody>
          <p className="text-sm text-(--mute)">Loading...</p>
        </PageBody>
      </Page>
    );
  if (!loop)
    return (
      <Page>
        <PageBody>
          <p className="text-sm text-(--mute)">Loop not found.</p>
        </PageBody>
      </Page>
    );

  return (
    <Page>
      <PageHeader
        breadcrumb="Work"
        title={loop.name}
        description={`${loop.cronExpr || "Manual"}${
          loop.lastRun ? ` · Last run: ${new Date(loop.lastRun).toLocaleString()}` : ""
        }${loop.pendingCount > 0 ? ` · ${loop.pendingCount} awaiting review` : ""}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {loop.enabled === false ? (
              <>
                <Badge variant="outline">Draft</Badge>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    activateMu.mutate(loopId, {
                      onSuccess: () => toast.success("Loop activated"),
                      onError: (e) => toast.error(`Activate failed: ${String(e)}`),
                    })
                  }
                  disabled={activateMu.isPending}
                >
                  Activate
                </Button>
              </>
            ) : (
              <label className="flex items-center gap-2 text-xs text-(--mute)">
                <Switch
                  checked
                  onCheckedChange={() =>
                    deactivateMu.mutate(loopId, {
                      onSuccess: () => toast.success("Loop disabled"),
                      onError: (e) => toast.error(`Disable failed: ${String(e)}`),
                    })
                  }
                  disabled={deactivateMu.isPending}
                />
                Enabled
              </label>
            )}
            <a
              href={`/work/${loopId}${view === "list" ? "?view=board" : ""}`}
              className="text-xs text-(--mute) hover:text-(--ink-strong) border border-(--hairline) rounded px-2 py-1"
            >
              {view === "list" ? "Board" : "List"}
            </a>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                runMu.mutate(loopId, {
                  onSuccess: () => toast.success("Run triggered"),
                  onError: (e) => toast.error(`Run failed: ${String(e)}`),
                })
              }
              disabled={runMu.isPending}
            >
              Run Now
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                doctorMu.mutate(loopId, {
                  onSuccess: (data) => {
                    const report = data?.report;
                    const n = report?.fixed.length ?? 0;
                    toast.success(
                      n > 0
                        ? `Doctor fixed ${n} issue${n === 1 ? "" : "s"}`
                        : "Doctor: all healthy",
                    );
                    setDoctorReport(report ?? null);
                  },
                  onError: (e) => toast.error(`Doctor failed: ${String(e)}`),
                })
              }
              disabled={doctorMu.isPending}
            >
              Doctor
            </Button>
            <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
              Add Item
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 "
                    aria-label="More actions"
                  />
                }
              >
                <MoreHorizontal size={14} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => {
                    if (!confirm(`Delete loop "${loop.name}"? This cannot be undone.`)) return;
                    deleteLoopMu.mutate(loopId, {
                      onSuccess: () => router.push("/work"),
                      onError: (e) => toast.error(`Delete failed: ${String(e)}`),
                    });
                  }}
                >
                  <Trash2 size={14} />
                  Delete Loop
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      />
      <PageBody className="space-y-6">
        {doctorReport && (
          <Card>
            <CardHeader>
              <CardTitle>Doctor report</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {doctorReport.issues.length === 0 ? (
                <p className="text-(--mute)">All healthy.</p>
              ) : (
                doctorReport.issues.map((issue, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 rounded border border-(--hairline) p-2"
                  >
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {issue.kind}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-xs">{issue.target}</div>
                      <div className="text-xs text-(--mute)">{issue.action}</div>
                    </div>
                  </div>
                ))
              )}
              {doctorReport.fixed.length > 0 && (
                <p className="text-xs text-emerald-600">Fixed: {doctorReport.fixed.join(", ")}</p>
              )}
            </CardContent>
          </Card>
        )}
        {loop.config && (
          <Card>
            <CardHeader>
              <CardTitle>Configuration</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-(--mute)">Model</div>
                <div className="font-mono text-xs">{loop.config.model}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-(--mute)">Acceptance</div>
                <div className="text-xs">{loop.config.acceptance || "—"}</div>
              </div>
              <div className="sm:col-span-2">
                <div className="text-[10px] uppercase tracking-wider text-(--mute)">
                  Workflow — verify 段
                </div>
                <pre className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap rounded border border-(--hairline) bg-(--canvas-soft) p-2 text-xs">
                  {loop.config.verifyPrompt}
                </pre>
                {loop.config.verifyCommands.length > 0 && (
                  <div className="mt-2">
                    <div className="text-[10px] uppercase tracking-wider text-(--mute)">
                      Verify commands(强制执行)
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {loop.config.verifyCommands.map((c) => (
                        <code
                          key={c}
                          className="rounded border border-(--hairline) bg-(--canvas-soft) px-1.5 py-0.5 font-mono text-[11px]"
                        >
                          {c}
                        </code>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}
        {view === "list" ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:h-[calc(100dvh-15rem)]">
            {/* Left: item list grouped by step */}
            <div className="lg:col-span-1 overflow-y-auto border border-(--hairline) rounded-lg bg-background">
              {items.length === 0 ? (
                <p className="text-sm text-(--mute) p-4">No items.</p>
              ) : (
                STEP_ORDER.filter((s) => (grouped[s] ?? []).length > 0).map((step) => (
                  <div key={step} className="p-2">
                    <div className="flex items-center gap-2 px-2 py-1">
                      <Badge variant={STEP_BADGE[step]} className="text-[10px]">
                        {step}
                      </Badge>
                      <span className="text-xs text-(--mute)">{grouped[step]!.length}</span>
                    </div>
                    <div className="space-y-1">
                      {grouped[step]!.map((item) => (
                        <button
                          key={item.id}
                          onClick={() => setSelectedId(item.id)}
                          className={`w-full text-left rounded-md p-2  text-sm transition-colors ${
                            selectedId === item.id
                              ? "bg-(--mute)/20 ring-1 ring-(--hairline)"
                              : "hover:bg-(--mute)/10"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate flex-1">{item.summary}</span>
                            <span className="text-[10px] text-(--mute) shrink-0">
                              att {item.attempt}
                            </span>
                          </div>
                          <div className="text-[10px] text-(--mute) font-mono truncate">
                            {item.source}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Right: evidence chain */}
            <div className="lg:col-span-2 overflow-y-auto">
              {selected && (
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  {selected.defer ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => undeferItemMu.mutate(selected.id)}
                    >
                      Resume ({selected.defer.reason})
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setDeferOpen(true)}
                    >
                      Defer
                    </Button>
                  )}
                </div>
              )}
              <EvidenceChainPanel loopId={loopId} item={selected} />
            </div>
          </div>
        ) : (
          <div className="h-[calc(100%-5rem)] flex flex-col">
            <LoopBoard items={items} selectedId={selectedId} onSelect={setSelectedId} />
            {selected && (
              <div className="mt-4 border border-(--hairline) rounded-lg p-4 overflow-y-auto max-h-[40%]">
                <EvidenceChainPanel loopId={loopId} item={selected} />
              </div>
            )}
          </div>
        )}
        {loop.budgetHistory && loop.budgetHistory.length > 0 && (
          <Card className="mt-4">
            <CardHeader>
              <CardTitle>Budget History</CardTitle>
            </CardHeader>
            <CardContent>
              {loop.budgetHistory.map((b) => (
                <div key={b.date} className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{b.date}</span>
                  <span>{b.spent.toLocaleString()} tokens</span>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </PageBody>
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Item</DialogTitle>
          </DialogHeader>{" "}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              addItemMu.mutate(
                {
                  source,
                  summary,
                  priority: priority ? Number(priority) : undefined,
                },
                {
                  onSuccess: (data) => {
                    const itemId = data?.item?.id;
                    if (itemId) setSelectedId(itemId);
                    setAddOpen(false);
                    setSummary("");
                    setPriority("");
                    toast.success("Item added");
                  },
                  onError: (e) => toast.error(`Add failed: ${String(e)}`),
                },
              );
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="add-source">Source</Label>
              <Select value={source} onValueChange={(v) => setSource(v ?? "manual")}>
                <SelectTrigger id="add-source" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ci">ci</SelectItem>
                  <SelectItem value="manual">manual</SelectItem>
                  <SelectItem value="lark">lark</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="add-summary">Summary</Label>
              <Textarea
                id="add-summary"
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                required
                rows={3}
                className="text-sm"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="add-priority">Priority (optional)</Label>
              <Input
                id="add-priority"
                type="number"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={addItemMu.isPending}>
                Add
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={deferOpen} onOpenChange={setDeferOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Defer item</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!selected) return;
              deferItemMu.mutate(
                { itemId: selected.id, reason: deferReason },
                {
                  onSuccess: () => {
                    setDeferOpen(false);
                    setDeferReason("");
                    toast.success("Item deferred");
                  },
                  onError: (err) => toast.error(`Defer failed: ${String(err)}`),
                },
              );
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="defer-reason">Reason</Label>
              <Textarea
                id="defer-reason"
                value={deferReason}
                onChange={(e) => setDeferReason(e.target.value)}
                required
                rows={2}
                className="text-sm"
                placeholder="e.g. waiting for upstream PR"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDeferOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={deferItemMu.isPending || !deferReason.trim()}>
                Defer
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
