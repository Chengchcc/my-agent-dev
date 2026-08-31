/** i18n seam (UI review: "English baseline + i18n wiring").
 *
 *  The UI language is English-only, enforced by `audit:ui` (zero CJK in
 *  apps/web/src — EXCEPT files under lib/locales/, which is where
 *  translation dictionaries live).
 *
 *  Wiring contract:
 *  - Keys ARE the English strings: `t("Today")` returns "Today" when no
 *    dictionary overrides it. Migration is incremental and safe — wrap a
 *    string in t() and it keeps rendering English until a locale
 *    dictionary lands.
 *  - Dictionaries live in `lib/locales/<lang>.ts` and are registered via
 *    registerLocale(). They are the ONLY place non-English UI text may
 *  appear (audit:ui exempts that directory).
 *  - setLocale() swaps the active dictionary at runtime. No reactive
 *    subscription yet — wire a React context when a real locale switcher
 *    lands (ponytail: the seam, not the framework). */

type Dictionary = Record<string, string>;

const locales = new Map<string, Dictionary>();
let current = "en";

/** Register a dictionary for a locale (later registrations win). */
export function registerLocale(lang: string, dict: Dictionary): void {
  locales.set(lang, { ...(locales.get(lang) ?? {}), ...dict });
}

/** Switch the active locale. Unknown keys fall back to the key itself. */
export function setLocale(lang: string): void {
  current = lang;
}

/** Translate a key. The key is the English source of truth; a missing
 *  entry renders the key unchanged, so untranslated strings stay English. */
export function t(key: string): string {
  return locales.get(current)?.[key] ?? key;
}
