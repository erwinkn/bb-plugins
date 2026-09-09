#!/usr/bin/env node
/**
 * Open a BB thread's plan panel in Playwright WebKit with an iPhone profile and
 * print the same report as the panel's Diagnostics dialog, plus a screenshot.
 * WebKit is the engine behind iOS Safari and the BB mobile app; the jsdom test
 * suite cannot see engine behaviour such as highlights skipped under
 * `user-select: none`, which is how the mobile highlight bug was found.
 *
 *   npx playwright install webkit            # once
 *   node scripts/mobile-probe.mjs /projects/<project>/threads/<thread>
 *
 * The base URL comes from BB_SERVER_URL (set inside `bb` shells) or
 * --base <url>. Add --engine-only to skip BB and run the minimal paint check.
 */
import { devices, webkit } from "playwright";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
};
const engineOnly = args.includes("--engine-only");
const base = flag("--base") ?? process.env.BB_SERVER_URL ?? "http://127.0.0.1:38886";
const threadPath = args.find((arg) => arg.startsWith("/"));
const screenshot = flag("--screenshot") ?? "/tmp/plans-mobile-probe.png";

const browser = await webkit.launch();
const context = await browser.newContext({ ...devices["iPhone 15"] });
const page = await context.newPage();

/** Paints one Highlight in and out of a `user-select: none` subtree. */
const engineCheck = async () => {
  await page.setContent(`<style>::highlight(free),::highlight(shell){background-color: rgb(255 0 0 / .4)}</style>
    <p id="free">Highlight outside the shell.</p>
    <div style="-webkit-user-select:none"><p id="shell">Highlight inside select-none.</p></div>`);
  return page.evaluate(() => {
    const range = (id) => {
      const node = document.getElementById(id).firstChild;
      const r = document.createRange();
      r.setStart(node, 0);
      r.setEnd(node, 9);
      return r;
    };
    CSS.highlights.set("free", new Highlight(range("free")));
    CSS.highlights.set("shell", new Highlight(range("shell")));
    return { highlightApi: "highlights" in CSS, note: "Compare the two lines in the screenshot; WebKit paints only the first." };
  });
};

if (engineOnly) {
  console.log(JSON.stringify(await engineCheck(), null, 2));
  await page.waitForTimeout(300);
  await page.screenshot({ path: screenshot, clip: { x: 0, y: 0, width: 393, height: 80 } });
  console.log(`screenshot: ${screenshot}`);
  await browser.close();
  process.exit(0);
}

if (!threadPath) {
  console.error("Usage: node scripts/mobile-probe.mjs /projects/<project>/threads/<thread> [--base <url>] [--screenshot <file>] | --engine-only");
  await browser.close();
  process.exit(2);
}

page.on("console", (message) => {
  if (message.type() === "error" && !message.text().includes("interactive-widget")) console.error("console:", message.text().slice(0, 200));
});
await page.goto(new URL(threadPath, base).toString(), { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
const openPlan = page.getByRole("button", { name: /review plan|plan/i }).first();
if ((await openPlan.count()) > 0 && (await page.locator(".plans-document").count()) === 0) {
  await openPlan.click();
  await page.waitForTimeout(3000);
}

const report = await page.evaluate(() => {
  const root = document.querySelector(".plans-document");
  const out = {
    userAgent: navigator.userAgent,
    viewport: `${innerWidth}×${innerHeight}`,
    pointer: matchMedia("(pointer: coarse)").matches ? "coarse" : "fine",
    highlightApi: "highlights" in CSS && typeof Highlight === "function",
    documentFound: root !== null,
    painted: {},
    userSelect: null,
    blockingAncestor: null,
  };
  if (out.highlightApi) for (const [name, highlight] of CSS.highlights) if (name.startsWith("plans-")) out.painted[name] = highlight.size;
  for (let el = root; el !== null; el = el.parentElement) {
    const value = getComputedStyle(el).webkitUserSelect || getComputedStyle(el).userSelect;
    if (value && value !== "auto") {
      out.userSelect = value;
      out.blockingAncestor = value === "none" ? `${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 4).join(".")}` : null;
      break;
    }
  }
  return out;
});
console.log(JSON.stringify(report, null, 2));
if (report.documentFound) await page.locator(".plans-document").first().screenshot({ path: screenshot });
else await page.screenshot({ path: screenshot });
console.log(`screenshot: ${screenshot}`);
await browser.close();
