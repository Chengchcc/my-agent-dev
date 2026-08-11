---
description: Refuse mixing && and || inside a single if condition — split into named booleans
condition: "if\\s*\\([^)]*((&&[^)]*\\|\\|)|(\\|\\|[^)]*&&))[^)]*\\)"
scope: "tool:edit(**/*.{ts,tsx}), tool:write(**/*.{ts,tsx})"
---

You were about to write one `if` that mixes `&&` with `||`. Once a condition spans both operator kinds, operator precedence turns it into a logic puzzle (`a && b || c` is `(a && b) || c`, which nobody reads at a glance), and mixing `!` on top of that is worse.

Name the sub-conditions instead:

```typescript
// Hard to read: precedence is invisible, the intent is hidden.
if (!isArchived && role !== "admin" || isBanned && !override) { ... }

// Clear: each clause gets a name.
const canManage = !isArchived && role === "admin";
const overrideBan = isBanned && override;
if (canManage || overrideBan) { ... }
```

Rules of thumb:

- If an `if` mixes `&&` and `||`, extract each side into a named boolean.
- If a condition has more than one `!`, invert the naming (`!isArchived` → `isActive`).
- Guard clauses (`if (x) return`) beat nesting.
