---
description: Refuse `else` after a `return` in the if block — return early instead
condition: "if\\s*\\([^)]*\\)\\s*\\{[^{}]*return[^{}]*\\}\\s*else"
scope: "tool:edit(**/*.{ts,tsx}), tool:write(**/*.{ts,tsx})"
---

You were about to write an `if` block that ends in `return` and is still followed by `else`. The `else` is dead weight: the `return` already exits the function, so the `else` adds indentation without adding control flow.

Drop the `else` and unindent the rest:

```typescript
// Hard to read: the else is unreachable ceremony.
function roleLabel(role: string): string {
  if (role === "admin") {
    return "Owner";
  } else {
    return "Member";
  }
}

// Clear: return early, no else.
function roleLabel(role: string): string {
  if (role === "admin") return "Owner";
  return "Member";
}
```

This is the guard-clause style: handle the exceptional cases first with early returns, let the happy path fall through. Applies to `else if` chains too — convert to sequential guards when each branch returns.
