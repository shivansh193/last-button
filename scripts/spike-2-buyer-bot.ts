// Spike 2: pay through a sandbox Payment Link as the sandbox buyer and capture an
// order / transaction ID. Exploratory: screenshots + page text at every step go to
// runs/spike2/. Buyer credentials come from env only.
//   npm run spike:pay -- <payment_link_url> [variantLabel]
// HEADED=1 shows the browser.
import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { chromium, type Page, type Frame } from "playwright";

const dir = "runs/spike2";
mkdirSync(dir, { recursive: true });

let url = process.argv[2];
const variant = process.argv[3] ?? "XL";
if (!url && existsSync("runs/spike1.json")) url = JSON.parse(readFileSync("runs/spike1.json", "utf8")).results?.variants?.link;
if (!url) throw new Error("usage: spike-2 <payment_link_url> [variant]");
const email = process.env.SANDBOX_BUYER_EMAIL;
const password = process.env.SANDBOX_BUYER_PASSWORD;
if (!email || !password) throw new Error("SANDBOX_BUYER_EMAIL / SANDBOX_BUYER_PASSWORD not set");

const log: any[] = [];
let step = 0;
async function snap(page: Page, label: string) {
  step++;
  const name = `${String(step).padStart(2, "0")}-${label}`;
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true }).catch(() => {});
  const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  writeFileSync(`${dir}/${name}.txt`, `URL: ${page.url()}\n\n${text}`);
  log.push({ step: name, url: page.url() });
  console.log(`[${name}] ${page.url()}`);
}

const browser = await chromium.launch({ headless: !process.env.HEADED });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
const page = await ctx.newPage();
const network: string[] = [];
ctx.on("response", (r) => {
  const u = r.url();
  if (/orders|capture|ncp|checkout|transaction|graphql/i.test(u) && !/\.(js|css|png|svg|woff2?)(\?|$)/.test(u)) {
    network.push(`${r.status()} ${r.request().method()} ${u}`);
  }
});

// The sandbox page keeps polling, so "networkidle" is unreliable. Wait for the variant select instead.
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.locator("select, iframe[src*='smart/buttons']").first().waitFor({ timeout: 30000 }).catch(() => {});
await page.waitForTimeout(2000);
await snap(page, "link-page");

// Pick the variant from a dropdown, or click it by text.
const select = page.locator("select").first();
if (await select.count()) {
  const opts = await select.locator("option").allTextContents();
  console.log("select options:", opts);
  const match = opts.find((o) => o.toLowerCase().includes(variant.toLowerCase()));
  if (match) await select.selectOption({ label: match });
} else {
  const byText = page.getByText(variant, { exact: false }).first();
  if (await byText.count()) await byText.click().catch(() => {});
}
await snap(page, "variant-picked");

// Find the PayPal smart button (usually inside an iframe).
async function findPayPalButton(): Promise<{ frame: Frame | Page; sel: string } | null> {
  const sels = ['[data-funding-source="paypal"]', 'div[role="link"][aria-label*="PayPal" i]', 'button:has-text("PayPal")'];
  for (let i = 0; i < 20; i++) {
    for (const f of page.frames()) {
      for (const sel of sels) {
        if (await f.locator(sel).count().catch(() => 0)) return { frame: f, sel };
      }
    }
    await page.waitForTimeout(1000);
  }
  return null;
}
const btn = await findPayPalButton();
if (!btn) {
  await snap(page, "no-paypal-button");
  console.log("frames:", page.frames().map((f) => f.url()));
  throw new Error("PayPal button not found");
}
const popupPromise = ctx.waitForEvent("page", { timeout: 15000 }).catch(() => null);
await btn.frame.locator(btn.sel).first().click();
const pay: Page = (await popupPromise) ?? page;
await pay.waitForLoadState("domcontentloaded");
await pay.waitForTimeout(3000);
await snap(pay, "after-paypal-click");
// The checkout URL carries the Orders v2 order ID as ?token=.
const orderToken = new URL(pay.url()).searchParams.get("token");
console.log("order token from checkout URL:", orderToken);

// Log in: email, next, password, login (tolerates the single-page variant).
const emailBox = pay.locator('#email, input[name="login_email"]').first();
await emailBox.waitFor({ timeout: 30000 });
await emailBox.fill(email);
const next = pay.locator("#btnNext");
if (await next.isVisible().catch(() => false)) await next.click();
const pw = pay.locator('#password, input[name="login_password"]').first();
await pw.waitFor({ state: "visible", timeout: 30000 });
await pw.fill(password);
await pay.locator(".spinner[aria-busy=true]").waitFor({ state: "hidden", timeout: 20000 }).catch(() => {});
await pay.locator("#btnLogin").click();
await pay.waitForLoadState("domcontentloaded");
await pay.waitForTimeout(6000);
await snap(pay, "logged-in-review");

// Complete the purchase.
const submit = pay
  .locator('#payment-submit-btn, [data-id="payment-submit-btn"], button:has-text("Complete Purchase"), button:has-text("Pay Now"), button:has-text("Continue")')
  .first();
await submit.waitFor({ timeout: 45000 });
await submit.click();

if (pay !== page) await pay.waitForEvent("close", { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(8000);
await snap(page, "after-pay");

const text = await page.evaluate(() => document.body.innerText);
const ids = {
  candidates: text.match(/\b[0-9A-Z]{17}\b/g) ?? [],
  urlParams: Object.fromEntries(new URL(page.url()).searchParams),
};
console.log("candidate IDs:", ids);
writeFileSync(`${dir}/result.json`, JSON.stringify({ url, variant, orderToken, finalUrl: page.url(), ids, network, log }, null, 2));
console.log(`network:\n  ${network.join("\n  ")}`);
await browser.close();
