// One shared headless Chromium for rendering pages and for the buyer bot.
import { chromium, type Browser } from "playwright";

let browser: Promise<Browser> | null = null;

export function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = chromium
      .launch({ headless: !process.env.HEADED, args: ["--disable-dev-shm-usage", "--no-sandbox"] })
      .then((b) => {
        b.on("disconnected", () => (browser = null));
        return b;
      })
      .catch((e) => {
        browser = null;
        throw e;
      });
  }
  return browser;
}

export async function closeBrowser() {
  if (browser) await (await browser).close().catch(() => {});
  browser = null;
}

/** Render a page (or raw HTML) with JavaScript and return the final DOM. */
export async function renderHtml(target: { url: string } | { html: string; baseUrl?: string }): Promise<string> {
  const b = await getBrowser();
  const ctx = await b.newContext({ javaScriptEnabled: true });
  const page = await ctx.newPage();
  // Don't fetch images, fonts or media; we only need the DOM.
  await page.route("**/*", (r) => (["image", "font", "media"].includes(r.request().resourceType()) ? r.abort() : r.continue()));
  try {
    if ("url" in target) await page.goto(target.url, { waitUntil: "load", timeout: 20000 });
    else await page.setContent(target.html, { waitUntil: "load", timeout: 20000 });
    await page.waitForTimeout(800);
    return await page.content();
  } finally {
    await ctx.close();
  }
}
