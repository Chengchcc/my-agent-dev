import puppeteer from "puppeteer-core";

const CHROME = "/root/.cache/puppeteer/chrome/linux-148.0.7778.97/chrome-linux64/chrome";
const BASE = "http://127.0.0.1:3000";

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });

// login
await page.goto(`${BASE}/api/auth/login`, { waitUntil: "networkidle2" }).catch(() => {});
await page.evaluate(async () => {
  await fetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "dev-token" }),
  });
});

// list page
await page.goto(`${BASE}/agentic-workflow`, { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: "/tmp/shot-list.png" });

// detail page
await page.goto(`${BASE}/agentic-workflow/nighttime-report`, { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 3500));
await page.screenshot({ path: "/tmp/shot-editor.png" });

// executions page
await page.goto(`${BASE}/agentic-workflow/nighttime-report/executions`, {
  waitUntil: "networkidle2",
});
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: "/tmp/shot-executions.png" });

await browser.close();
console.log("done");
