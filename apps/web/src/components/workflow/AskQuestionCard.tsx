"use client";

import type { AskQuestionInput, AskQuestionResult } from "@chengchenccc/agent-contract";
import { Questionnaire } from "@shadcn/react/questionnaire";
import { MessageCircle, Sparkles } from "lucide-react";
import { MonoLabel, StatusPill } from "@/components/patterns";

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

/** AskQuestionCard — Agent OS-styled HITL question form. Shared by the
 *  workflow human gate node and the product-tools MCP ask surface, so both
 *  read the same design language (panel card, mono micro-label, label-caps
 *  question index, pill options, primary Submit). */
export function AskQuestionCard({
  input,
  onSubmit,
  onChat,
  title,
}: {
  input: AskQuestionInput;
  onSubmit?: (result: AskQuestionResult) => void;
  onChat?: () => void;
  /** Override the card heading (defaults to the first question's header). */
  title?: string;
}) {
  const items = buildItems(input);
  const hasChat = input.questions.some((q) => q.allowChat);
  const heading = title ?? input.questions[0]?.header ?? "A few questions";

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
    <div className="rounded-lg border border-(--hairline) bg-(--panel) p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 shrink-0 text-(--accent-violet)" />
          <MonoLabel>{heading}</MonoLabel>
        </div>
        {hasChat ? (
          <button
            onClick={onChat}
            className="flex items-center gap-1.5 rounded-sm border border-(--hairline) px-2 py-0.5 font-mono text-[10px] text-(--mute) transition-colors hover:border-(--accent-violet) hover:text-(--accent-violet)"
          >
            <MessageCircle className="size-3" />
            Chat about this
          </button>
        ) : (
          <StatusPill tone="waiting">
            {input.questions.length} question{input.questions.length > 1 ? "s" : ""}
          </StatusPill>
        )}
      </div>

      <Questionnaire.Root
        items={items}
        onSubmit={handleSubmit}
        shortcuts="letters"
        className="space-y-5"
        noValidate
      >
        <Questionnaire.Progress className="h-1 rounded-full bg-(--panel2)" />

        {input.questions.map((q, qi) => (
          <Questionnaire.Item
            key={q.id}
            name={q.id}
            required={q.validation?.required !== false}
            className="space-y-2"
          >
            <div className="flex items-baseline gap-2">
              {input.questions.length > 1 && (
                <span className="shrink-0 font-mono text-[10px] text-(--faint)">
                  {String(qi + 1).padStart(2, "0")}
                </span>
              )}
              <Questionnaire.Title className="font-headline-sm text-headline-sm font-semibold text-(--ink)">
                {q.question}
              </Questionnaire.Title>
            </div>

            {q.kind === "text" ? (
              <Questionnaire.Input
                className="h-9 w-full rounded-md border border-(--hairline) bg-(--canvas-soft) px-3 text-sm text-(--ink) placeholder:text-(--faint) focus:border-(--primary)"
                placeholder={q.placeholder}
              />
            ) : (
              <>
                <Questionnaire.Choices className="space-y-1.5">
                  {(q.options ?? []).map((o) => (
                    <Questionnaire.Choice
                      key={o.value}
                      value={o.value}
                      className="flex w-full cursor-pointer items-start gap-2.5 rounded-md border border-(--hairline) bg-(--canvas-soft)/60 px-3 py-2 transition-colors has-[input:checked]:border-(--primary) has-[input:checked]:bg-(--primary)/10"
                    >
                      <Questionnaire.ChoiceInput className="peer sr-only" />
                      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-(--hairline) peer-checked:border-(--primary)">
                        <span className="size-2 rounded-full bg-(--primary) opacity-0 transition-opacity peer-checked:opacity-100" />
                      </span>
                      <Questionnaire.ChoiceLabel className="flex items-center gap-2 text-sm">
                        <span className="font-medium text-(--ink)">{o.label}</span>
                        {o.description && (
                          <span className="text-xs text-(--mute)">{o.description}</span>
                        )}
                      </Questionnaire.ChoiceLabel>
                    </Questionnaire.Choice>
                  ))}
                  {q.allowOther && (
                    <Questionnaire.Choice
                      value="__other__"
                      className="flex w-full cursor-pointer items-start gap-2.5 rounded-md border border-(--hairline) bg-(--canvas-soft)/60 px-3 py-2 transition-colors has-[input:checked]:border-(--primary) has-[input:checked]:bg-(--primary)/10"
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
                    className="mt-1 h-8 w-full rounded-md border border-(--hairline) bg-(--canvas-soft) px-3 text-sm text-(--ink) placeholder:text-(--faint)"
                    placeholder="Type your own…"
                    type="text"
                  />
                )}
              </>
            )}
            <Questionnaire.Error className="text-xs text-(--err)" />
          </Questionnaire.Item>
        ))}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-(--hairline) pt-3">
          <Questionnaire.Previous className="rounded-sm border border-(--hairline) px-3 py-1.5 font-mono text-[10px] uppercase tracking-kicker text-(--mute) transition-colors hover:border-(--faint) hover:text-(--ink)">
            Previous
          </Questionnaire.Previous>
          <Questionnaire.Skip className="rounded-sm border border-(--hairline) px-3 py-1.5 font-mono text-[10px] uppercase tracking-kicker text-(--mute) transition-colors hover:border-(--faint) hover:text-(--ink)">
            Skip
          </Questionnaire.Skip>
          <Questionnaire.Next className="rounded-sm border border-(--hairline) px-3 py-1.5 font-mono text-[10px] uppercase tracking-kicker text-(--mute) transition-colors hover:border-(--faint) hover:text-(--ink)">
            Next
          </Questionnaire.Next>
          <Questionnaire.Submit className="rounded-sm bg-(--primary-soft) px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-kicker text-(--on-primary) transition-colors hover:bg-(--primary)">
            Submit
          </Questionnaire.Submit>
        </div>
      </Questionnaire.Root>
    </div>
  );
}
