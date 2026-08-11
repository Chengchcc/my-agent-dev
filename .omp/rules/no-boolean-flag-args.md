---
description: Refuse boolean-literal flag arguments — an options object or named constants read better
condition: "(\\(|,)\\s*(true|false)\\s*[,)]"
scope: "tool:edit(**/*.{ts,tsx}), tool:write(**/*.{ts,tsx})"
---

You were about to pass a bare `true`/`false` as a function argument. `retry(3, true)` tells the reader nothing about what the flag does; every call site is a trip back to the signature.

Use one of:

- An options object for more than one flag: `retry(3, { force: true })`
- A well-named constant when the flag is a named choice: `retry(3, FORCE)`
- A separate function when the flag switches behavior: `retryForce(3)`

```typescript
// Hard to read: what does `true` mean?
connect(url, true);
retry(3, false);

// Clear:
connect(url, { useTls: true });
retry(3, { force: false });

// Or name the choice:
const WITH_RETRY = true;
retry(3, WITH_RETRY);
```

Exceptions that stay as literals: function DEFAULT parameters (`opts = true`), comparisons (`x === true`), array/object literals, and single-flag functions whose name already carries the meaning (`useStrict(true)` is borderline — prefer `{ strict: true }` when the function takes other options too).
