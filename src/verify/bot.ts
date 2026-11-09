// Playwright buyer bot: pays through a sandbox Payment Link as the sandbox buyer.
// Learned in spike 2: wait for load (not network idle), the order ID is the
// checkout URL's ?token=, click #btnLogin explicitly once the spinner clears.
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { BrowserContext, Frame, Page } from "playwright";
import { getBrowser } from "../scan/browser.js";

export interface BotResult {
  orderId: string | null;
  captureId: string | null;
  pageTotal: string | null;
  confirmationText: string;
  finalUrl: string;
  screenshot: string | null; // file name under DATA_DIR/screens
  log: string[];
}

const DATA_DIR = process.env.DATA_DIR ?? "data";
let storageState: any = null; // reuse the buyer's PayPal session between runs

async function findPayPalButton(page: Page): Promise<{ frame: Frame | Page; sel: string } | null> {
  const sels = ['[data-funding-source="paypal"]', 'div[role="link"][aria-label*="PayPal" i]'];
  for (let i = 0; i < 25; i++) {
    for (const f of page.frames()) {
      for (const sel of sels) if (await f.locator(sel).count().catch(() => 0)) return { frame: f, sel };
    }
    await page.waitForTimeout(1000);
  }
  return null;
}

export async function payThroughLink(linkUrl: string, opts: { variant?: string | null; quantity?: number; tag: string }): Promise<BotResult> {
  const email = process.env.SANDBOX_BUYER_EMAIL;
  const password = process.env.SANDBOX_BUYER_PASSWORD;
  if (!email || !password) throw new Error("Sandbox buyer login is not configured (SANDBOX_BUYER_EMAIL / SANDBOX_BUYER_PASSWORD).");
  if (!/^https:\/\/www\.sandbox\.paypal\.com\/ncp\/payment\//.test(linkUrl)) throw new Error("The buyer bot only pays sandbox Payment Links.");
  const log: string[] = [];
  const say = (s: string) => log.push(`${new Date().toISOString().slice(11, 19)} ${s}`);
  const browser = await getBrowser();
  const ctx: BrowserContext = await browser.newContext({ viewport: { width: 1200, height: 860 }, locale: "en-US", storageState: storageState ?? undefined });
  ctx.setDefaultTimeout(30000);
  const page = await ctx.newPage();
  let orderId: string | null = null;
  try {
    await page.goto(linkUrl, { waitUntil: "load", timeout: 60000 });
    await page.locator("select, iframe[src*='smart/buttons']").first().waitFor({ timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
    say("opened link page");

    if (opts.variant) {
      const select = page.locator("select").first();
      const labels = await select.locator("option").allTextContents();
      const match = labels.find((l) => l.trim().toLowerCase().startsWith(opts.variant!.toLowerCase()));
      if (!match) throw new Error(`Option "${opts.variant}" is not on the link page (found: ${labels.join(", ")})`);
      await select.selectOption({ label: match });
      say(`picked ${match}`);
    }
    if (opts.quantity && opts.quantity > 1) {
      const qty = page.locator('input[type="number"], input[name*="quantity" i], input[aria-label*="quantity" i]').first();
      if (await qty.count()) {
        await qty.fill(String(opts.quantity));
        await qty.press("Tab");
        say(`quantity ${opts.quantity}`);
      } else say("no quantity box found; paying for 1");
    }
    await page.waitForTimeout(800);
    const summary = await page.evaluate(() => document.body.innerText);
    const pageTotal = summary.match(/Total\s*\$?([\d,.]+)/)?.[1]?.replace(/,/g, "") ?? null;

    const btn = await findPayPalButton(page);
    if (!btn) throw new Error("PayPal button did not appear on the link page");
    const popupP = ctx.waitForEvent("page", { timeout: 20000 }).catch(() => null);
    await btn.frame.locator(btn.sel).first().click();
    const pay = (await popupP) ?? page;
    await pay.waitForLoadState("domcontentloaded");
    orderId = new URL(pay.url()).searchParams.get("token");
    say(`checkout opened, order ${orderId}`);

    // Log in unless the saved session already did.
    const emailBox = pay.locator('#email, input[name="login_email"]').first();
    const submit = pay.locator('#payment-submit-btn, [data-id="payment-submit-btn"], button:has-text("Complete Purchase"), button:has-text("Pay Now")').first();
    const first = await Promise.race([
      emailBox.waitFor({ timeout: 45000 }).then(() => "login"),
      submit.waitFor({ timeout: 45000 }).then(() => "review"),
    ]).catch(() => "timeout");
    if (first === "login") {
      await emailBox.fill(email);
      const next = pay.locator("#btnNext");
      if (await next.isVisible().catch(() => false)) await next.click();
      const pw = pay.locator('#password, input[name="login_password"]').first();
      await pw.waitFor({ state: "visible" });
      await pw.fill(password);
      await pay.locator(".spinner[aria-busy=true]").waitFor({ state: "hidden", timeout: 20000 }).catch(() => {});
      await pay.locator("#btnLogin").click();
      say("logged in as sandbox buyer");
    } else if (first === "timeout") throw new Error("PayPal checkout did not show a login or review page");
    await submit.waitFor({ timeout: 60000 });
    await pay.waitForTimeout(1500);
    await submit.click();
    say("clicked pay");
    if (pay !== page) await pay.waitForEvent("close", { timeout: 90000 }).catch(() => {});
    await page.waitForURL(/\/ncp\/payment\/[^/]+\/[A-Z0-9]+|[?&]tx=/, { timeout: 60000 }).catch(() => {});
    await page.waitForLoadState("load").catch(() => {});
    await page.waitForTimeout(2500);
    storageState = await ctx.storageState().catch(() => storageState);

    const finalUrl = page.url();
    const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    const u = new URL(finalUrl);
    const captureId = u.searchParams.get("tx") ?? text.match(/([0-9A-Z]{17})\s*\n?\s*Transaction ID/i)?.[1] ?? text.match(/Transaction ID:?\s*([0-9A-Z]{17})/i)?.[1] ?? null;
    orderId = orderId ?? finalUrl.match(/\/ncp\/payment\/[^/]+\/([A-Z0-9]+)/)?.[1] ?? null;
    mkdirSync(path.join(DATA_DIR, "screens"), { recursive: true });
    const shot = `${opts.tag}-${orderId ?? Date.now()}.png`;
    // Top of the confirmation only: amount, item and option. Keeps the buyer's details out.
    await page.screenshot({ path: path.join(DATA_DIR, "screens", shot), clip: { x: 0, y: 0, width: 1200, height: 520 } }).catch(() => {});
    say(`done: ${finalUrl.replace(/\?.*/, "")}`);
    return { orderId, captureId, pageTotal, confirmationText: text.slice(0, 2000), finalUrl, screenshot: shot, log };
  } catch (e: any) {
    mkdirSync(path.join(DATA_DIR, "screens"), { recursive: true });
    const shot = `${opts.tag}-error-${Date.now()}.png`;
    const pages = ctx.pages();
    await pages[pages.length - 1]?.screenshot({ path: path.join(DATA_DIR, "screens", shot) }).catch(() => {});
    const err = new Error(e.message?.split("\n")[0] ?? String(e));
    (err as any).botLog = log;
    (err as any).orderId = orderId;
    (err as any).screenshot = shot;
    throw err;
  } finally {
    await ctx.close().catch(() => {});
  }
}
