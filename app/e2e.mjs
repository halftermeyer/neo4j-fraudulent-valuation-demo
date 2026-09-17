// End-to-end drive of the running app (dev server on :5173): reset the database,
// ingest the three layers FROM THE UI, walk the Explore reveal, run S1–S4 and the
// Policy panel, ask the Assistant one question. Screenshots to ../docs/screenshots/.
// Run: node e2e.mjs   (after `npm run dev` and `make data`)

import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE || "http://localhost:5175";
const SHOTS = new URL("../docs/screenshots/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("dialog", (d) => d.accept());
page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));

const shot = async (name) => {
  await page.screenshot({ path: `${SHOTS}${name}.png`, fullPage: false });
  console.log(`shot: ${name}`);
};
const btn = (name) => page.getByRole("button", { name });
const clickTab = async (label) => {
  await page.getByRole("tab", { name: label }).or(btn(label)).first().click();
  await page.waitForTimeout(400);
};

await page.goto(BASE);
await page.waitForSelector("text=Fraudulent Valuation");

// ── 1. Reset, then ingest layer by layer from the UI ──
console.log("reset database…");
await btn("Reset database").click();
await page.waitForSelector("text=database emptied", { timeout: 120_000 });
await shot("0-empty");

for (const [i, layer] of ["market", "governance", "cases"].entries()) {
  console.log(`ingest ${layer}…`);
  await page.getByRole("button", { name: "Ingest", exact: true, disabled: false }).first().click();
  await page.waitForFunction(
    (n) => document.body.innerText.split("Loaded ✓").length - 1 >= n,
    i + 1,
    { timeout: 600_000 },
  );
  console.log(`  ${layer} loaded`);
}
await shot("1-ingested");

// ── 2. Explore: progressive reveal on POS-TP ──
const stepButtons = [/^1 ·/, /^2 ·/, /^3 ·/];
for (const re of stepButtons) {
  await btn(re).first().click();
  await page.waitForTimeout(1200);
}
for (const label of [
  "Add PnL signals", "Add price overrides", "Add methodology changes",
  "Add IPV reviews", "Add governance gaps",
]) {
  await btn(new RegExp(label)).first().click();
  await page.waitForTimeout(900);
}
await shot("2-explore-reveal");

// ── 3. Scenarios ──
await clickTab("Scenarios");

await btn(/S1 · Conjunction/).click();
await btn("Run the conjunction query").click();
await page.waitForSelector("text=Positions ranked", { timeout: 120_000 });
await btn(/Louvain/).click();
await page.waitForSelector("text=Louvain found", { timeout: 300_000 });
await shot("3-s1-conjunction");

await btn(/S2 · Chronology/).click();
await btn("Reconstruct").click();
await page.waitForSelector("text=MISSED", { timeout: 120_000 });
await shot("4-s2-chronology");

await btn(/S3 · Abstraction/).click();
await btn(/Abstract the confirmed case/).click();
await page.waitForSelector("text=REQUIRES", { timeout: 120_000 });
await shot("5-s3-pattern");

await btn(/S4 · Read-across/).click();
await btn("Run read-across").click();
await page.waitForSelector("text=1.00", { timeout: 120_000 });
await btn(/predict held-out links/).click();
await page.waitForSelector("text=held-out", { timeout: 300_000 });
await shot("6-s4-readacross");

await btn(/Policy panel/).click();
await page.waitForSelector("text=R1", { timeout: 60_000 });
await shot("7-policy-panel");

// ── 4. Assistant (live Gemini — tolerate failure, report it) ──
await clickTab("Assistant");
try {
  await page.locator(".chat-chip").first().click();
  await page.waitForSelector(".chat-bubble.chat-assistant:not(.chat-thinking)", {
    timeout: 240_000,
  });
  await shot("8-assistant");
  console.log("assistant answered");
} catch (e) {
  await shot("8-assistant-FAILED");
  console.log("ASSISTANT FAILED:", e.message);
}

await browser.close();
console.log("E2E COMPLETE");
