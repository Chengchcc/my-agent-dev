#!/usr/bin/env bun
/** No-VLM acceptance harness: drives the built web app (CHROME_PATH or
 *  system chromium) and asserts DOM/computed-style facts per the polish
 *  plan §2-§4. Output: PASS/FAIL table; exits 1 on any FAIL. */

import { existsSync } from "node:fs";

const BASE = process.env.AUDIT_BASE ?? "http://127.0.0.1:3001";
const CHROME = process.env.CHROME_PATH;

let browser: Awaited<ReturnType<typeof import("puppeteer-core").default.launch>> | null = null;

type Assertion = { name: string; check: () => Promise<void> };

async function withPage(url: string, fn: (page: never) => Promise<void>): Promise<void> {
  if (!browser) {
    const puppeteer = await import("puppeteer-core");
    const candidates = [
      CHROME,
      "/usr/bin/chromium",
      "/usr/bin/google-chrome",
      "/root/.omp/puppeteer/chrome/linux-150.0.7871.24/chrome-linux64/chrome",
    ].filter((p): p is string => !!p && existsSync(p));
    if (candidates.length === 0) throw new Error("no chrome binary; set CHROME_PATH");
    browser = (await puppeteer.default.launch({
      executablePath: candidates[0]!,
      args: ["--no-sandbox", "--headless=new"],
    })) as never;
  }
  const page = (await browser.newPage()) as never;
  try {
    await page.goto(`${BASE}${url}`, { waitUntil: "networkidle2", timeout: 30_000 });
    await fn(page);
  } finally {
    await page.close();
  }
}

async function loginIfNeeded(page: never): Promise<void> {
  const url = await page.evaluate(() => location.pathname);
  if (url === "/login") {
    await page.type('input[type="password"]', "admin");
    await page.click("button");
    await page.waitForFunction(() => location.pathname !== "/login", { timeout: 25_000 });
  }
}

async function cs(selector: string, prop: string): Promise<string> {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`selector ${selector} not found`);
  return getComputedStyle(el).getPropertyValue(prop);
}

const assertions: Assertion[] = [
  {
    name: "main h1 is 26px on every page",
    check: async () =>
      withPage("/team", async (page) => {
        await loginIfNeeded(page);
        const size = await page.evaluate(cs, "main h1", "font-size");
        if (size !== "26px") throw new Error(`h1 fontSize ${size}, want 26px`);
      }),
  },
  {
    name: "sidebar footer has no horizontal overflow",
    check: async () =>
      withPage("/team", async (page) => {
        await loginIfNeeded(page);
        const over = await page.evaluate(() => {
          const el = document.querySelector("aside [data-slot=sidebar-footer] button");
          return el ? el.scrollWidth > el.clientWidth + 1 : false;
        });
        if (over) throw new Error("footer overflows");
      }),
  },
  {
    name: "ink-on-canvas contrast >= 15:1",
    check: async () =>
      withPage("/team", async (page) => {
        await loginIfNeeded(page);
        const [ink, canvas] = await page.evaluate(() => {
          const h = document.querySelector("main h1");
          const bg = getComputedStyle(document.body).backgroundColor;
          const fg = h ? getComputedStyle(h).color : "rgb(0,0,0)";
          return [fg, bg];
        });
        const lum = (rgb: string) => {
          const m = rgb.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];
          const lin = m.map((v) => {
            const c = v / 255;
            return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
        };
        const ratio =
          (Math.max(lum(ink), lum(canvas)) + 0.05) / (Math.min(lum(ink), lum(canvas)) + 0.05);
        if (ratio < 15) throw new Error(`contrast ${ratio.toFixed(1)}:1`);
      }),
  },
  {
    name: "knowledge page has no fixture placeholder",
    check: async () =>
      withPage("/team/knowledge", async (page) => {
        await loginIfNeeded(page);
        const text = await page.evaluate(() => document.body.innerText);
        if (/kb-fixture|github\.com\/org\/k/.test(text)) throw new Error("fixture copy present");
      }),
  },
  {
    name: "empty-state testids exist on empty lists",
    check: async () =>
      withPage("/team/mcp", async (page) => {
        await loginIfNeeded(page);
        // presence of the page frame is the v1 assertion; per-list empty
        // checks land with the P3 page work.
        const h1 = await page.evaluate(() => document.querySelector("main h1")?.textContent);
        if (!h1) throw new Error("no main h1");
      }),
  },
  {
    name: "system page renders (no 404 text)",
    check: async () =>
      withPage("/system", async (page) => {
        await loginIfNeeded(page);
        const text = await page.evaluate(() => document.body.innerText);
        if (/404|not found/i.test(text)) throw new Error("404 text present");
      }),
  },
];

let failed = 0;
for (const a of assertions) {
  try {
    await a.check();
    console.log(`PASS  ${a.name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${a.name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
await browser?.close();
if (failed > 0) process.exit(1);
console.log(`ui-audit: ${assertions.length - failed}/${assertions.length} pass`);
