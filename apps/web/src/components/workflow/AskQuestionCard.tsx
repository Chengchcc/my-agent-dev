"use client";

import type { AskQuestionInput, AskQuestionResult } from "@chengchenccc/agent-contract";
import { Questionnaire } from "@shadcn/react/questionnaire";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Items = React.ComponentProps<typeof Questionnaire.Root>["items"];

function buildItems(input: AskQuestionInput): Items {
  return input.questions.map((q) => {
    if (q.kind === "text") {
      return {
        name: q.id,
        required: q.validation?.required !== false,
        choices: [],
      } as const;
    }
    return {
      name: q.id,
      required: q.validation?.required !== false,
      choices: (q.options ?? []).map((o) => ({ value: o.value, label: o.label })),
    } as const;
  });
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
  const items = buildItems(input);
  const hasChat = input.questions.some((q) => q.allowChat);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const answers = input.questions.map((q) => {
      if (q.kind === "text") {
        const v = String(formData.get(q.id) ?? "").trim();
        return { id: q.id, selectedValues: [], freeText: v || undefined };
      }
      const selected = formData.getAll(q.id).map(String);
      const other = String(formData.get(`${q.id}__other`) ?? "").trim();
      return {
        id: q.id,
        selectedValues: selected.filter((v) => v !== "__other__"),
        freeText: other || undefined,
      };
    });
    onSubmit?.({ answers });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {input.questions[0]?.header ?? "A few questions"}
        </CardTitle>
        {hasChat && (
          <button onClick={onChat} className="text-xs text-(--info) hover:text-(--primary)">
            Chat about this
          </button>
        )}
      </CardHeader>
      <CardContent>
        <Questionnaire.Root
          items={items}
          onSubmit={handleSubmit}
          shortcuts="letters"
          className="space-y-4"
          noValidate
        >
          <Questionnaire.Progress className="h-1 rounded bg-(--hairline)" />
          {input.questions.map((q) => (
            <Questionnaire.Item
              key={q.id}
              name={q.id}
              required={q.validation?.required !== false}
              className="space-y-2"
            >
              <Questionnaire.Title className="text-sm font-medium">
                {q.question}
              </Questionnaire.Title>
              {q.kind === "text" ? (
                <Questionnaire.Input
                  className="h-9 w-full rounded-md border border-(--hairline) bg-(--canvas) px-3 text-sm"
                  placeholder={q.placeholder}
                />
              ) : (
                <>
                  <Questionnaire.Choices className="space-y-1">
                    {(q.options ?? []).map((o) => (
                      <Questionnaire.Choice
                        key={o.value}
                        value={o.value}
                        className="flex w-full cursor-pointer items-start gap-2 rounded-md border border-(--hairline) bg-(--canvas)/40 px-3 py-2 transition-colors has-[input:checked]:border-(--primary) has-[input:checked]:bg-(--primary)/10"
                      >
                        <Questionnaire.ChoiceInput className="peer sr-only" />
                        <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-(--hairline) peer-checked:border-(--primary)">
                          <span className="size-2 rounded-full bg-(--primary) opacity-0 transition-opacity peer-checked:opacity-100" />
                        </span>
                        <Questionnaire.ChoiceLabel className="flex items-center gap-2 text-sm">
                          <span className="font-medium">{o.label}</span>
                          {o.description && (
                            <span className="text-xs text-(--mute)">{o.description}</span>
                          )}
                        </Questionnaire.ChoiceLabel>
                      </Questionnaire.Choice>
                    ))}
                    {q.allowOther && (
                      <Questionnaire.Choice
                        value="__other__"
                        className="flex w-full cursor-pointer items-start gap-2 rounded-md border border-(--hairline) bg-(--canvas)/40 px-3 py-2 transition-colors has-[input:checked]:border-(--primary) has-[input:checked]:bg-(--primary)/10"
                      >
                        <Questionnaire.ChoiceInput className="peer sr-only" />
                        <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-(--hairline) peer-checked:border-(--primary)">
                          <span className="size-2 rounded-full bg-(--primary) opacity-0 transition-opacity peer-checked:opacity-100" />
                        </span>
                        <Questionnaire.ChoiceLabel className="text-sm text-(--mute)">
                          Other
                        </Questionnaire.ChoiceLabel>
                      </Questionnaire.Choice>
                    )}
                  </Questionnaire.Choices>
                  {q.allowOther && (
                    <input
                      name={`${q.id}__other`}
                      className="mt-1 h-8 w-full rounded-md border border-(--hairline) bg-(--canvas) px-3 text-sm"
                      placeholder="Type your own…"
                      type="text"
                    />
                  )}
                </>
              )}
              <Questionnaire.Error className="text-xs text-(--err)" />
            </Questionnaire.Item>
          ))}
          <div className="flex flex-wrap gap-2">
            <Questionnaire.Previous className="rounded-md border border-(--hairline) px-3 py-1.5 text-xs">
              上一步
            </Questionnaire.Previous>
            <Questionnaire.Skip className="rounded-md border border-(--hairline) px-3 py-1.5 text-xs">
              跳过
            </Questionnaire.Skip>
            <Questionnaire.Next className="rounded-md bg-(--primary) px-3 py-1.5 text-xs text-(--ink)">
              下一步
            </Questionnaire.Next>
            <Questionnaire.Submit className="rounded-md bg-(--info) px-3 py-1.5 text-xs text-(--ink)">
              提交
            </Questionnaire.Submit>
          </div>
        </Questionnaire.Root>
      </CardContent>
    </Card>
  );
}
