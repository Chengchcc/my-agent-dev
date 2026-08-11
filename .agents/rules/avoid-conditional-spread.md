---
description: Avoid conditional object spread `...(cond ? { ... } : {})` — build the object explicitly
condition: "\\.\\.\\([^)]*\\?[^)]*:\\s*\\{\\}"
scope: "tool:edit(**/*.{ts,tsx}), tool:write(**/*.{ts,tsx})"
interruptMode: never
---

Conditional object spreads like `...(opts?.effort ? { output_config: { effort: opts.effort } } : {})` bury the condition inside a spread and are hard to read and to debug. Build the object explicitly instead:

```typescript
// Hard to read: the condition is hidden inside a spread of a ternary.
const body = {
  ...(opts?.thinking ? { thinking: { type: opts.thinking.type } } : {}),
  ...(opts?.effort ? { output_config: { effort: opts.effort } } : {}),
};

// Clear: the object is assembled with obvious conditionals.
const request: Record<string, unknown> = {
  model: modelId,
  max_tokens: maxTokens,
  messages,
  stream: true,
};
if (opts?.thinking) {
  const thinking: Record<string, unknown> = { type: opts.thinking.type };
  if (opts.thinking.display) thinking.display = opts.thinking.display;
  if (opts.thinking.budgetTokens) thinking.budget_tokens = opts.thinking.budgetTokens;
  request.thinking = thinking;
}
if (opts?.effort) {
  request.output_config = { effort: opts.effort };
}
```

The explicit form reads top to bottom: each field is either always present or obviously conditional. A plain `if` also lets you assemble nested configs without nested spreads.
