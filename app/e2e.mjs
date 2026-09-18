// End-to-end drive of the running app (dev server on :5175): reset the database,
// ingest the three layers FROM THE UI (with a schema peek), walk the Explore
// reveal, then the Scenarios flow in its demo order — Policy (compute gaps,
// which unlocks S1) → S1 → S2 (+ companion explain/focus) → S3 → S4 — and ask
// the Assistant one question. Screenshots to ../docs/screenshots/.
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

// schema peek on the governance layer card (live mini-schema + sample)
await page.getByTestId("schema-peek-governance").click();
await page.waitForSelector(".schema-peek-pop .schema-peek-sample", { timeout: 60_000 });
await shot("1b-schema-peek");
await page.mouse.click(10, 500); // click-away closes
await page.waitForTimeout(300);

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

// ── 3. Scenarios — Policy first: computing the gaps unlocks S1 ──
await clickTab("Scenarios");
await page.waitForSelector("text=R1", { timeout: 60_000 });
const s1Locked = await page.getByTestId("subtab-s1").isDisabled();
console.log(`S1 locked before compute: ${s1Locked}`);
if (!s1Locked) throw new Error("S1 should be locked before the gaps are computed");
await page.getByTestId("policy-compute").click();
await page.waitForSelector('[data-testid="gap-summary"]', { timeout: 120_000 });
await shot("7-policy-panel");

await btn(/S1 · Conjunction/).click();
await btn("Run the conjunction query").click();
await page.waitForSelector("text=Positions ranked", { timeout: 120_000 });
// the conjunction opens on the financial timeline; the network is a toggle away
await page.waitForSelector(".position-timeline canvas", { timeout: 120_000 });
await page.waitForTimeout(1500);
await shot("3-s1-conjunction");
await page.getByTestId("s1-show-graph").click();
await page.waitForSelector(".s1-graph .graph-canvas", { timeout: 60_000 });
await btn(/Louvain/).click();
await page.waitForSelector("text=Louvain found", { timeout: 300_000 });
await shot("3b-s1-community");

await btn(/S2 · Chronology/).click();
await btn("Reconstruct").click();
await page.waitForSelector("text=MISSED", { timeout: 120_000 });
await page.waitForSelector(".position-timeline canvas", { timeout: 120_000 });
await page.waitForTimeout(1200);
await shot("4-s2-chronology");

// companion focus: the explanation cites event ids → the view scrolls/flashes them
await page.getByTestId("explain-s2-card").click();
await page.waitForSelector(".companion-entry .companion-text", { timeout: 240_000 });
await shot("4b-s2-explain-focus");
await page.getByTestId("companion-close").click();

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
