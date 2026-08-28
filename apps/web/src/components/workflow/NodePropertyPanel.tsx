"use client";

import type { AskQuestionInput } from "@chengchenccc/agent-contract";
import type { WorkflowDefinition, WorkflowNode } from "@chengchenccc/workflow";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
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
import { api } from "@/lib/api";
import "@/lib/monaco-loader";
import { AskQuestionCard } from "./AskQuestionCard";

const MonacoCodeEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.default), {
  ssr: false,
  loading: () => <div className="p-2 text-xs text-(--mute)">Loading editor…</div>,
});

type Def = WorkflowDefinition;

function formToQuestions(
  form: Record<string, unknown> | undefined,
  question: string | undefined,
): AskQuestionInput {
  const questions: AskQuestionInput["questions"] = [];
  for (const [key, raw] of Object.entries(form ?? {})) {
    const f = raw as { type?: string; label?: string; options?: string[]; required?: boolean };
    const label = f.label ?? key;
    if (f.type === "enum") {
      questions.push({
        id: key,
        kind: "select",
        question: label,
        header: question,
        options: (f.options ?? []).map((v) => ({ value: v, label: v })),
        validation: { required: f.required !== false },
      });
    } else if (f.type === "boolean") {
      questions.push({
        id: key,
        kind: "select",
        question: label,
        header: question,
        options: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ],
        validation: { required: f.required !== false },
      });
    } else {
      questions.push({
        id: key,
        kind: "text",
        question: label,
        header: question,
        multiline: f.type === "textarea",
        placeholder: f.label,
        validation: { required: f.required !== false },
      });
    }
  }
  if (questions.length === 0 && question)
    questions.push({ id: "answer", kind: "text", question, multiline: true });
  return { questions };
}

function patchNode(def: Def, nodeId: string, patch: Record<string, unknown>): Def {
  return {
    ...def,
    nodes: def.nodes.map((n) => (n.id === nodeId ? ({ ...n, ...patch } as WorkflowNode) : n)),
  };
}

function renameNode(def: Def, oldId: string, newId: string): Def {
  if (!oldId || !newId || oldId === newId) return def;
  return {
    ...def,
    nodes: def.nodes.map((n) => (n.id === oldId ? ({ ...n, id: newId } as WorkflowNode) : n)),
    edges: def.edges.map((e) => ({
      ...e,
      from: e.from === oldId ? newId : e.from,
      to: e.to === oldId ? newId : e.to,
    })),
  };
}

const TYPE_LABEL: Record<string, string> = {
  start: "Start",
  end: "End",
  agent: "Agent",
  script: "Script",
  human: "Human",
};

/** Node inspector — edits write straight back to the DSL (live). */
export function NodePropertyPanel({
  nodeId,
  definition,
  onChange,
}: {
  nodeId: string;
  definition: Def;
  onChange: (def: Def) => void;
}) {
  const node = useMemo(() => definition.nodes.find((n) => n.id === nodeId), [definition, nodeId]);
  const [agents, setAgents] = useState<Array<{ id: string; name?: string }>>([]);
  useEffect(() => {
    api
      .listAgents()
      .then((rows) =>
        setAgents((rows ?? []).map((a) => ({ id: a.id, name: (a as { name?: string }).name }))),
      )
      .catch(() => setAgents([]));
  }, []);
  if (!node) return null;

  const set = (patch: Record<string, unknown>) => onChange(patchNode(definition, nodeId, patch));

  return (
    <div className="flex h-full flex-col overflow-auto p-4 text-(--ink)">
      <div className="mb-3 flex items-center justify-between">
        <Input
          className="min-w-0 flex-1 border-(--hairline) bg-(--canvas) font-mono text-xs text-(--info)"
          value={nodeId}
          placeholder="节点 id"
          onChange={(e) => onChange(renameNode(definition, nodeId, e.target.value))}
        />
        <Badge variant="outline" className="shrink-0 border-(--hairline) text-[10px] text-(--mute)">
          {TYPE_LABEL[node.type] ?? node.type}
        </Badge>
      </div>
      <div className="mb-4 space-y-1">
        <Label className="text-xs text-(--mute)">name</Label>
        <Input
          className="border-(--hairline) bg-(--canvas) text-xs"
          value={(node as { label?: string }).label ?? ""}
          placeholder="节点名称（画布显示）"
          onChange={(e) => set({ label: e.target.value })}
        />
      </div>

      {node.type === "agent" && (
        <>
          <div className="space-y-1">
            <Label className="text-xs text-(--mute)">agent（从系统选择）</Label>
            <Select value={node.agentId ?? ""} onValueChange={(v) => set({ agentId: v })}>
              <SelectTrigger className="h-8 w-full border-(--hairline) bg-(--canvas) font-mono text-xs">
                <SelectValue placeholder="选择 agent，或留空内联 model+prompt" />
              </SelectTrigger>
              <SelectContent>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name ? `${a.name} (${a.id})` : a.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="mt-3 space-y-1">
            <Label className="text-xs text-(--mute)">model</Label>
            <Input
              className="border-(--hairline) bg-(--canvas) font-mono text-xs"
              value={node.model ?? ""}
              placeholder="deepseek/deepseek-v4-flash"
              onChange={(e) => set({ model: e.target.value })}
            />
          </div>
          <div className="mt-3 space-y-1">
            <Label className="text-xs text-(--mute)">prompt</Label>
            <Textarea
              className="min-h-24 border-(--hairline) bg-(--canvas) font-mono text-xs"
              value={node.prompt ?? ""}
              onChange={(e) => set({ prompt: e.target.value })}
            />
          </div>
        </>
      )}

      {node.type === "script" && (
        <>
          <div className="space-y-1">
            <Label className="text-xs text-(--mute)">code</Label>
            <div className="overflow-hidden rounded-md border border-(--hairline)">
              <MonacoCodeEditor
                height="300px"
                defaultLanguage="javascript"
                value={node.code ?? ""}
                onChange={(v) => set({ code: v ?? "" })}
                theme="workflow-dark"
                beforeMount={(monaco) => {
                  monaco.editor.defineTheme("workflow-dark", {
                    base: "vs-dark",
                    inherit: true,
                    rules: [],
                    colors: {
                      "editor.background": "#0b0e14",
                      "editor.foreground": "#e2e8f0",
                      "editor.lineHighlightBackground": "#1a2332",
                      "editorIndentGuide.background": "#1f2937",
                      "editorGutter.background": "#0b0e14",
                      "editorCursor.foreground": "#38bdf8",
                      "editor.selectionBackground": "#33415588",
                    },
                  });
                }}
                options={{ minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false }}
              />
            </div>
          </div>
          <div className="mt-3 space-y-1">
            <Label className="text-xs text-(--mute)">timeoutMs</Label>
            <Input
              type="number"
              className="border-(--hairline) bg-(--canvas) font-mono text-xs"
              value={node.timeoutMs ?? ""}
              onChange={(e) =>
                set({ timeoutMs: e.target.value === "" ? undefined : Number(e.target.value) })
              }
            />
          </div>
        </>
      )}

      {node.type === "human" && (
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs text-(--mute)">question</Label>
            <Textarea
              className="min-h-24 border-(--hairline) bg-(--canvas) font-mono text-xs"
              value={node.question ?? ""}
              onChange={(e) => set({ question: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-(--mute)">问卷预览</Label>
            <div className="pointer-events-none overflow-hidden rounded-lg border border-(--hairline)">
              <AskQuestionCard input={formToQuestions(node.form, node.question)} />
            </div>
          </div>
        </div>
      )}

      {node.type === "end" && (
        <div className="space-y-1">
          <Label className="text-xs text-(--mute)">status</Label>
          <Input
            className="border-(--hairline) bg-(--canvas) font-mono text-xs"
            value={node.status ?? ""}
            onChange={(e) => set({ status: e.target.value })}
          />
        </div>
      )}

      {node.retry !== undefined && (
        <div className="mt-3 space-y-1">
          <Label className="text-xs text-(--mute)">retry</Label>
          <Input
            type="number"
            className="border-(--hairline) bg-(--canvas) font-mono text-xs"
            value={node.retry}
            onChange={(e) => set({ retry: Number(e.target.value) })}
          />
        </div>
      )}
    </div>
  );
}
