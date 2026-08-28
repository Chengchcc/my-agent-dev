"use client";

import type { AskQuestionInput, AskQuestionResult } from "@chengchenccc/agent-contract";
import { useForm } from "react-hook-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Row = { selected: string[]; freeText: string };
type FormValues = Record<string, Row>;

function defaults(input: AskQuestionInput): FormValues {
  const v: FormValues = {};
  for (const q of input.questions) v[q.id] = { selected: [], freeText: "" };
  return v;
}

function validateRow(
  q: AskQuestionInput["questions"][number],
  row: Row | undefined,
): string | undefined {
  const r = q.validation ?? {};
  const required = r.required !== false;
  if (q.kind === "text") {
    const text = (row?.freeText ?? "").trim();
    if (required && text.length === 0) return "This field is required";
    if (r.minLength && text.length < r.minLength) return `At least ${r.minLength} characters`;
    if (r.maxLength && text.length > r.maxLength) return `At most ${r.maxLength} characters`;
    return undefined;
  }
  const n = row?.selected.length ?? 0;
  if (required && n === 0 && !(row?.freeText ?? "").trim()) return "Pick at least one option";
  if (r.minSelections && n < r.minSelections) return `Pick at least ${r.minSelections}`;
  if (r.maxSelections && n > r.maxSelections) return `Pick at most ${r.maxSelections}`;
  return undefined;
}

export function AskQuestionCard({
  input,
  onSubmit,
  onChat,
}: {
  input: AskQuestionInput;
  onSubmit?: (result: AskQuestionResult) => void;
  onChat?: () => void;
}) {
  const form = useForm<FormValues>({ defaultValues: defaults(input) });
  const hasChat = input.questions.some((q) => q.allowChat);

  function toggle(qid: string, value: string, multi: boolean, current: string[]): string[] {
    if (!multi) return current.includes(value) ? [] : [value];
    return current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit((values) => {
          const errors: Record<string, string> = {};
          for (const q of input.questions) {
            const err = validateRow(q, values[q.id]);
            if (err) errors[q.id] = err;
          }
          if (Object.keys(errors).length > 0) {
            for (const [k, v] of Object.entries(errors)) form.setError(k, { message: v });
            return;
          }
          onSubmit?.({
            answers: input.questions.map((q) => ({
              id: q.id,
              selectedValues: values[q.id]?.selected ?? [],
              freeText: (values[q.id]?.freeText ?? "").trim() || undefined,
            })),
          });
        })}
        className="space-y-4"
      >
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {input.questions[0]?.header ?? "A few questions"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {input.questions.map((q) => (
              <FormField
                key={q.id}
                control={form.control}
                name={q.id}
                render={({ field }) => {
                  const row = (field.value as Row) ?? { selected: [], freeText: "" };
                  return (
                    <FormItem>
                      <FormLabel>{q.question}</FormLabel>
                      {q.kind === "text" ? (
                        <FormControl>
                          {q.multiline ? (
                            <Textarea
                              rows={4}
                              placeholder={q.placeholder}
                              value={row.freeText}
                              onChange={(e) => field.onChange({ ...row, freeText: e.target.value })}
                            />
                          ) : (
                            <Input
                              placeholder={q.placeholder}
                              value={row.freeText}
                              onChange={(e) => field.onChange({ ...row, freeText: e.target.value })}
                            />
                          )}
                        </FormControl>
                      ) : (
                        <div className="space-y-1.5">
                          {(q.options ?? []).map((o) => {
                            const checked = row.selected.includes(o.value);
                            return (
                              <button
                                type="button"
                                key={o.value}
                                onClick={() =>
                                  field.onChange({
                                    ...row,
                                    selected: toggle(q.id, o.value, Boolean(q.multi), row.selected),
                                  })
                                }
                                className={cn(
                                  "flex w-full items-start gap-2 rounded-lg border p-2 text-left transition-colors",
                                  checked
                                    ? "border-amber-500 bg-amber-50 dark:bg-amber-950/40"
                                    : "hover:bg-muted/50",
                                )}
                              >
                                <Checkbox
                                  checked={checked}
                                  className="mt-0.5 pointer-events-none"
                                />
                                <span className="flex-1">
                                  <span className="text-sm font-medium">
                                    {o.label}
                                    {q.recommended === o.value && (
                                      <Badge variant="outline" className="ml-2 text-[10px]">
                                        Recommended
                                      </Badge>
                                    )}
                                  </span>
                                  {o.description && (
                                    <FormDescription className="mt-0.5">
                                      {o.description}
                                    </FormDescription>
                                  )}
                                </span>
                              </button>
                            );
                          })}
                          {q.allowOther && (
                            <Input
                              placeholder="Other (type your own)"
                              value={row.freeText}
                              onChange={(e) => field.onChange({ ...row, freeText: e.target.value })}
                            />
                          )}
                        </div>
                      )}
                      <FormMessage />
                    </FormItem>
                  );
                }}
              />
            ))}
          </CardContent>
        </Card>
        <div className="flex gap-2">
          <Button type="submit" className="flex-1">
            Submit
          </Button>
          {hasChat && onChat && (
            <Button type="button" variant="outline" onClick={onChat}>
              Chat about this
            </Button>
          )}
        </div>
      </form>
    </Form>
  );
}
