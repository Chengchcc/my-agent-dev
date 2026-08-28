"use client";

import type { JsonLogicRule, WorkflowDefinition } from "@chengchenccc/workflow";
import { useMemo, useState } from "react";
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
  const [condOp, setCondOp] = useState<"==" | "!=" | ">" | "<" | "exists">("==");
  const [condLeft, setCondLeft] = useState("");
  const [condRight, setCondRight] = useState("");
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
          onClick={() => {
            if (!confirm(`删除边 ${edge.from} → ${edge.to}？`)) return;
            onDelete?.(deleteEdge(definition, edgeIndex));
          }}
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
          <Select value={condOp} onValueChange={(v) => setCondOp((v ?? "==") as typeof condOp)}>
            <SelectTrigger className="h-8 w-full border-(--hairline) bg-(--canvas) font-mono text-xs">
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
          {condOp === "exists" ? (
            <Select value={condLeft} onValueChange={(v) => setCondLeft(v ?? "")}>
              <SelectTrigger className="h-8 w-full border-(--hairline) bg-(--canvas) font-mono text-xs">
                <SelectValue placeholder="选择输出变量" />
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
          ) : (
            <>
              <Select value={condLeft} onValueChange={(v) => setCondLeft(v ?? "")}>
                <SelectTrigger className="h-8 w-full border-(--hairline) bg-(--canvas) font-mono text-xs">
                  <SelectValue placeholder="选择输出变量" />
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
              <Input
                className="h-8 border-(--hairline) bg-(--canvas) font-mono text-xs"
                placeholder="常量值（high / yes / 1）"
                value={condRight}
                onChange={(e) => setCondRight(e.target.value)}
              />
            </>
          )}
          <Button
            className="w-full"
            onClick={() => {
              if (!condLeft) return;
              if (condOp === "exists") {
                onChange(
                  updateEdge(definition, edgeIndex, {
                    when: { [condOp]: [{ var: condLeft }] } as JsonLogicRule,
                  }),
                );
              } else {
                const right =
                  condRight.trim() === "true"
                    ? true
                    : condRight.trim() === "false"
                      ? false
                      : condRight;
                onChange(
                  updateEdge(definition, edgeIndex, {
                    when: { [condOp]: [{ var: condLeft }, right] } as JsonLogicRule,
                  }),
                );
              }
            }}
          >
            添加条件
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
              alert("Invalid JSONLogic JSON");
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
