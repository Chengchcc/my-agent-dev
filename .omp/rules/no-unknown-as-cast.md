---
description: Refuse `as unknown as X` double casts - a type-system bypass, not a typing solution
condition: "as\\s+unknown\\s+as"
scope: "tool:edit(**/*.{ts,tsx}), tool:write(**/*.{ts,tsx})"
---

You were about to write `x as unknown as T`. The `unknown` middle step exists to
silence "neither type sufficiently overlaps" — it never fixes the mismatch, it
hides it. The cast survives every refactor: if `x` stops being `T`-shaped, no
compiler will tell you.

Reach for one of these instead, in order:

1. **Fix the producer's type.** If the value is loose because a schema/parse
   step types it as `Record<string, unknown>`, either tighten the schema or
   keep the loose type flowing to the consumer and validate there.
2. **Validate at the boundary.** Untrusted input (JSON.parse, wire formats,
   CLI args) is `unknown` by nature — parse it through the real schema
   (`messageSchema.parse(x)`, a type guard) and let the validator carry the
   burden.
3. **Narrow honestly.** A `typeof`/`instanceof`/discriminant check that
   actually narrows, so the type reflects reality.
4. **Single-step cast.** When the value IS the target type at runtime but the
   static type is loose, `x as T` (without `unknown`) keeps the check visible
   in code review.

Legitimate exceptions: the parse boundary of a durable/external format, where
a typed cast pins the shape (`JSON.parse(line) as { type?: string }`), and
positional wire-codecs whose consumer re-validates. Write a comment naming the
boundary when you use one. `as unknown as` is never the answer — if only the
double cast compiles, the types disagree on purpose; fix the type, not the cast.
