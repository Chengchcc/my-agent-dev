import { assertSafeUrl, FETCH_TIMEOUT_MS, MAX_REDIRECTS, UrlGuardError } from "./url-guard.js";
import type { WebFetchPort, WebSearchPort } from "./web-ports.js";

/** Max bytes read from a fetched page (fetch port is heavier than the
 *  url-guard default: real pages, not snippets). */
const FETCH_CAP_BYTES = 512_000;

function decodeEntities(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Naive HTML → readable text: drop script/style/head, strip tags. */
function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n"),
  );
}

/** Std fetch port: global fetch, manual redirect walk (each hop re-validated
 *  against the url guard), timeout + size caps, HTML→text. */
export function createStdWebFetchPort(): WebFetchPort {
  return {
    async fetch(url, signal) {
      let current = assertSafeUrl(url).toString();
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const resp = await fetch(current, {
          redirect: "manual",
          signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: { "user-agent": "oma/0.1 (+web_fetch)" },
        });
        if ([301, 302, 303, 307, 308].includes(resp.status)) {
          const location = resp.headers.get("location");
          if (!location) throw new Error(`redirect without location from ${current}`);
          current = assertSafeUrl(new URL(location, current).toString()).toString();
          continue;
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${current}`);
        const reader = resp.body?.getReader();
        if (!reader) {
          const text = await resp.text();
          return { text: htmlToText(text).slice(0, FETCH_CAP_BYTES), title: titleOf(text) };
        }
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          chunks.push(value);
          if (bytes > FETCH_CAP_BYTES) break;
        }
        const html = new TextDecoder().decode(concat(chunks));
        return { text: htmlToText(html), title: titleOf(html) };
      }
      throw new UrlGuardError(`too many redirects (>${MAX_REDIRECTS})`);
    },
  };
}

function titleOf(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m?.[1] !== undefined ? decodeEntities(m[1]).slice(0, 200) : undefined;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** DuckDuckGo no-JS HTML frontend as a zero-config search port (same source
 *  omp uses). DDG routes outbound links through /l/?uddg=<encoded> — those
 *  are unwrapped back to the target URL. */
const DDG_HTML_URL = "https://html.duckduckgo.com/html/";

function unwrapDdgHref(href: string): string | undefined {
  const wrap = /[?&]uddg=([^&]+)/.exec(href.replace(/&amp;/gi, "&"));
  if (wrap?.[1] !== undefined) {
    try {
      return decodeURIComponent(wrap[1]);
    } catch {
      return undefined;
    }
  }
  if (href.startsWith("//")) return `https:${href}`;
  if (href.startsWith("http://") || href.startsWith("https://")) return href;
  return undefined;
}

function parseDdgResults(html: string): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const blockRe =
    /<div\b[^>]*\bclass="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)(?=<div\b[^>]*\bclass="[^"]*\bresult\b|<div\b[^>]*\bclass="[^"]*\bnav-link\b|$)/g;
  const titleRe =
    /<a\b[^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/;
  const snippetRe =
    /<(?:a|div|span)\b[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/;
  for (const match of html.matchAll(blockRe)) {
    const block = match[1] ?? "";
    const title = titleRe.exec(block);
    if (!title) continue;
    const url = unwrapDdgHref(title[1] ?? "");
    const titleText = decodeEntities(title[2] ?? "");
    if (!url || !titleText) continue;
    const snippet = snippetRe.exec(block);
    results.push({
      title: titleText,
      url,
      snippet: snippet ? decodeEntities(snippet[1] ?? "") : "",
    });
  }
  return results;
}

export function createDdgWebSearchPort(): WebSearchPort {
  return {
    async search(query, limit = 5, signal) {
      const resp = await fetch(DDG_HTML_URL, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": "oma/0.1 (+web_search)",
        },
        body: new URLSearchParams({ q: query }).toString(),
        signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const html = await resp.text();
      if (html.includes("anomaly-modal") || html.includes("anomaly.js")) {
        throw new Error("duckduckgo bot challenge — retry or use a different query");
      }
      return parseDdgResults(html).slice(0, limit);
    },
  };
}
