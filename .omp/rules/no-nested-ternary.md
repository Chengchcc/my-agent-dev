---
description: Refuse nested ternary expressions — extract into named values or early returns
condition: "[?](?![.?])[^:\\n]*[?](?![.?])"
scope: "tool:edit(**/*.{ts,tsx}), tool:write(**/*.{ts,tsx})"
---

You were about to write a nested ternary (`a ? b ? c : d : e`). They are almost impossible to read: the precedence is invisible, the branches interleave, and a reviewer has to count colons to figure out which branch goes with which condition.

Use one of:

- Early returns / early `continue` for guard clauses
- Well-named intermediate values for the sub-decision
- A small `switch` or a lookup map when the decision has several cases

```typescript
// Hard to read: nested ternary.
const label = isAdmin ? canEdit ? "Owner" : "Editor" : isMember ? "Member" : "Guest";

// Clear: peel the levels into named steps.
let label = "Guest";
if (isMember) label = "Member";
if (isAdmin) label = canEdit ? "Owner" : "Editor";

// Or return early:
if (!isMember && !isAdmin) return "Guest";
if (!isAdmin) return "Member";
return canEdit ? "Owner" : "Editor";
```

One ternary is fine. The moment a second `?` appears inside the first, stop and restructure.
