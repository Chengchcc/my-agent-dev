# Locale dictionaries

Translation dictionaries for the UI (`lib/i18n.ts` is the seam). This
directory is the ONLY place in apps/web/src that may contain non-English
text — `audit:ui` exempts it from the CJK gate.

Shape (register at app bootstrap):

```ts
// lib/locales/zh.ts
import { registerLocale } from "@/lib/i18n";
registerLocale("zh", { Today: "今天", Workflows: "工作流" });
```

Keys are the English strings themselves; `t("Today")` falls back to the
key when a locale has no entry, so migration is incremental.
