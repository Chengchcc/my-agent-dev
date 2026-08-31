"use client";

import type { JsonLogicRule, WorkflowDefinition } from "@chengchenccc/workflow";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

function updateEdge(
  def: WorkflowDefinition,
  edgeIndex: number,
  patch: Record<string, unknown>,
): WorkflowDefinition {
  return {
    ...def,
    edges: def.edges.map((e, i) => (i === edgeIndex ? ({ ...e, ...patch } as typeof e) : e)),
  };
}

/** Edge inspector: from/to reconnection + `when` JSONLogic condition. */
export function EdgePropertyPanel({
  edgeIndex,
  definition,
  onChange,
  onDelete,
}: {
  edgeIndex: number;
  definition: WorkflowDefinition;
  onChange: (def: WorkflowDefinition) => void;
  onDelete?: (def: WorkflowDefinition) => void;
}) {
  const edge = useMemo(() => definition.edges[edgeIndex], [definition, edgeIndex]);
  const [when, setWhen] = useState<string>(edge?.when ? JSON.stringify(edge.when, null, 2) : "");
  const [combine, setCombine] = useState<"and" | "or">("and");
  const [conditions, setConditions] = useState<
    Array<{ op: "==" | "!=" | ">" | "<" | "exists"; left: string; right: string }>
  >(() => {
    const w = edge?.when as Record<string, unknown> | undefined;
    if (!w || Object.keys(w).length === 0) return [];
    if (w.and && Array.isArray(w.and)) {
      return (w.and as Array<Record<string, unknown>>).map((c) => {
        const op = Object.keys(c)[0] ?? "==";
        const args = (c[op] as unknown[] | undefined) ?? [];
        const left =
          typeof args[0] === "object" && args[0]
            ? String((args[0] as { var?: string }).var ?? "")
            : String(args[0] ?? "");
        return { op: op as never, left, right: String(args[1] ?? "") };
      });
    }
    if (w.or && Array.isArray(w.or)) {
      return (w.or as Array<Record<string, unknown>>).map((c) => {
        const op = Object.keys(c)[0] ?? "==";
        const args = (c[op] as unknown[] | undefined) ?? [];
        const left =
          typeof args[0] === "object" && args[0]
            ? String((args[0] as { var?: string }).var ?? "")
            : String(args[0] ?? "");
        return { op: op as never, left, right: String(args[1] ?? "") };
      });
    }
    const op = Object.keys(w)[0] ?? "==";
    const args = (w[op] as unknown[] | undefined) ?? [];
    const left =
      typeof args[0] === "object" && args[0]
        ? String((args[0] as { var?: string }).var ?? "")
        : String(args[0] ?? "");
    return [{ op: op as never, left, right: String(args[1] ?? "") }];
  });
  if (!edge) return null;

  const nodeOptions = definition.nodes
    .filter((n) => n.type !== "start")
    .map((n) => ({ value: n.id, label: n.id }));

  return (
    <div className="flex h-full flex-col overflow-auto p-4 text-(--ink)">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="truncate font-mono text-sm font-semibold text-(--info)">
          {edge.from} → {edge.to}
        </h3>
        <button
          onClick={() => onDelete?.(deleteEdge(definition, edgeIndex))}
          className="text-xs text-(--err) hover:underline"
        >
          删除此边
        </button>
      </div>

      <div className="space-y-1">
        <Label className="text-xs text-(--mute)">from</Label>
        <Select
          value={edge.from}
          onValueChange={(v) => onChange(updateEdge(definition, edgeIndex, { from: v }))}
        >
          <SelectTrigger className="h-8 border-(--hairline) bg-(--canvas) font-mono text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {definition.nodes.map((n) => (
              <SelectItem key={n.id} value={n.id}>
                {n.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="mt-3 space-y-1">
        <Label className="text-xs text-(--mute)">to</Label>
        <Select
          value={edge.to}
          onValueChange={(v) => onChange(updateEdge(definition, edgeIndex, { to: v }))}
        >
          <SelectTrigger className="h-8 border-(--hairline) bg-(--canvas) font-mono text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {nodeOptions.map((n) => (
              <SelectItem key={n.value} value={n.value}>
                {n.value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="mt-3 flex-1 space-y-1 overflow-auto">
        <Label className="text-xs text-(--mute)">when（条件，空 = 无条件）</Label>
        <div className="space-y-2 rounded-md border border-(--hairline) bg-(--canvas)/50 p-2">
          <div className="flex items-center gap-1">
            <span className="text-xs text-(--mute)">当</span>
            <Select value={combine} onValueChange={(v) => setCombine((v ?? "and") as "and" | "or")}>
              <SelectTrigger className="h-7 w-16 border-(--hairline) bg-(--canvas) text-[10px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="and">且</SelectItem>
                <SelectItem value="or">或</SelectItem>
              </SelectContent>
            </Select>
            <span className="text-xs text-(--mute)">满足</span>
          </div>
          {conditions.map((c, i) => (
            <div key={i} className="space-y-1 rounded-md border border-(--hairline) p-2">
              <Select
                value={c.op}
                onValueChange={(v) => {
                  const next = [...conditions];
                  next[i] = { ...c, op: (v ?? "==") as typeof c.op };
                  setConditions(next);
                }}
              >
                <SelectTrigger className="h-7 w-full border-(--hairline) bg-(--canvas) font-mono text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="==">==</SelectItem>
                  <SelectItem value="!=">!=</SelectItem>
                  <SelectItem value=">">&gt;</SelectItem>
                  <SelectItem value="<">&lt;</SelectItem>
                  <SelectItem value="exists">exists</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={c.left}
                onValueChange={(v) => {
                  const next = [...conditions];
                  next[i] = { ...c, left: v ?? "" };
                  setConditions(next);
                }}
              >
                <SelectTrigger className="h-7 w-full border-(--hairline) bg-(--canvas) font-mono text-xs">
                  <SelectValue placeholder="输出变量" />
                </SelectTrigger>
                <SelectContent>
                  {definition.nodes
                    .filter((n) => n.type !== "start" && n.id !== edge.from)
                    .flatMap((n) =>
                      Object.keys((n as { output?: Record<string, unknown> }).output ?? {}).map(
                        (k) => (
                          <SelectItem key={`${n.id}.output.${k}`} value={`${n.id}.output.${k}`}>
                            {n.id}.output.{k}
                          </SelectItem>
                        ),
                      ),
                    )}
                </SelectContent>
              </Select>
              {c.op !== "exists" && (
                <Input
                  className="h-7 border-(--hairline) bg-(--canvas) font-mono text-xs"
                  placeholder="常量值"
                  value={c.right}
                  onChange={(e) => {
                    const next = [...conditions];
                    next[i] = { ...c, right: e.target.value };
                    setConditions(next);
                  }}
                />
              )}
              <div className="flex justify-end">
                <button
                  className="text-[10px] text-(--err) hover:underline"
                  onClick={() => setConditions(conditions.filter((_, j) => j !== i))}
                >
                  删除条件
                </button>
              </div>
            </div>
          ))}
          <Button
            className="w-full"
            variant="outline"
            size="sm"
            onClick={() => setConditions([...conditions, { op: "==", left: "", right: "" }])}
          >
            + 添加条件
          </Button>
          <Button
            className="w-full"
            onClick={() => {
              const conds = conditions.filter((c) => c.left);
              if (conds.length === 0) {
                onChange(updateEdge(definition, edgeIndex, { when: undefined }));
                return;
              }
              const rules = conds.map(
                (c): JsonLogicRule =>
                  c.op === "exists"
                    ? ({ [c.op]: [{ var: c.left }] } as JsonLogicRule)
                    : ({
                        [c.op]: [
                          { var: c.left },
                          c.right.trim() === "true"
                            ? true
                            : c.right.trim() === "false"
                              ? false
                              : c.right,
                        ],
                      } as JsonLogicRule),
              );
              onChange(
                updateEdge(definition, edgeIndex, {
                  when: rules.length === 1 ? rules[0] : ({ [combine]: rules } as JsonLogicRule),
                }),
              );
            }}
          >
            应用条件
          </Button>
        </div>
        <Label className="mt-2 text-xs text-(--mute)">或直接编辑 JSONLogic</Label>
        <Textarea
          className="min-h-24 border-(--hairline) bg-(--canvas) font-mono text-xs"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
          placeholder='{ "==": [ { "var": "a.output.x" }, "high" ] }'
        />
        <Button
          className="mt-1 w-full"
          onClick={() => {
            try {
              const parsed: JsonLogicRule | undefined = when.trim()
                ? (JSON.parse(when) as JsonLogicRule)
                : undefined;
              onChange(updateEdge(definition, edgeIndex, { when: parsed }));
            } catch {
              toast.error("JSONLogic 格式错误");
            }
          }}
        >
          Apply JSONLogic
        </Button>
      </div>
    </div>
  );
}

function deleteEdge(def: WorkflowDefinition, edgeIndex: number): WorkflowDefinition {
  return { ...def, edges: def.edges.filter((_, i) => i !== edgeIndex) };
}
