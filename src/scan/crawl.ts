// Same-origin crawler: robots.txt, rate limit, page cap, private-address guard.
// Pages whose scripts mention PayPal are rendered in Chromium to catch JS-built buttons.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import * as cheerio from "cheerio";
import { detectButtons, type RawButton } from "./detect.js";
import { renderHtml } from "./browser.js";
import type { DetectedButton, PageResult, ScanResult } from "../types.js";

const UA = "LastButtonBot/0.1 (+https://github.com/shivansh193/last-button)";
const MAX_PAGES = Number(process.env.SCAN_MAX_PAGES ?? 30);
const DELAY_MS = Number(process.env.SCAN_DELAY_MS ?? 250);
const SKIP_EXT = /\.(png|jpe?g|gif|svg|webp|ico|css|js|pdf|zip|mp[34]|woff2?|ttf|xml|json|txt)$/i;

export class ScanError extends Error {}

function isPrivate(ip: string): boolean {
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    return v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v === "::" || v.startsWith("::ffff:127.") || v.startsWith("::ffff:10.") || v.startsWith("::ffff:192.168.");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** Refuse URLs that point inside our own network, unless ALLOW_LOCAL_SCAN=1 (dev/eval). */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ScanError("That doesn't look like a web address. Try something like https://example.org");
  }
  if (!/^https?:$/.test(url.protocol)) throw new ScanError("Only http and https addresses can be scanned.");
  if (process.env.ALLOW_LOCAL_SCAN === "1") return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw new ScanError(`Couldn't find ${host}. Check the address.`);
  if (addrs.some(isPrivate)) throw new ScanError("That address points to a private network, so it can't be scanned.");
  return url;
}

async function robotsRules(origin: string): Promise<string[]> {
  try {
    const res = await fetch(`${origin}/robots.txt`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const lines = (await res.text()).split(/\r?\n/);
    const rules: string[] = [];
    let applies = false;
    for (const line of lines) {
      const [k, ...rest] = line.split(":");
      const key = k.trim().toLowerCase();
      const val = rest.join(":").trim();
      if (key === "user-agent") applies = val === "*" || /lastbutton/i.test(val);
      else if (key === "disallow" && applies && val) rules.push(val);
    }
    return rules;
  } catch {
    return [];
  }
}

const mentionsPayPal = (html: string) => {
  const $ = cheerio.load(html);
  let hit = false;
  $("script").each((_, s) => {
    const src = $(s).attr("src") ?? "";
    if (/paypal/i.test(src) || /paypal|webscr|paypalobjects/i.test($(s).text())) hit = true;
  });
  return hit;
};

async function fetchPage(url: string): Promise<{ status: number; html: string; finalUrl: string; type: string }> {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(15000) });
  const type = res.headers.get("content-type") ?? "";
  const html = type.includes("html") ? (await res.text()).slice(0, 2_000_000) : "";
  return { status: res.status, html, finalUrl: res.url, type };
}

function toDetected(raw: RawButton[], pageIdx: number, pageUrl: string, pagePath: string, staticPrints: Set<string>): DetectedButton[] {
  return raw.map((b) => ({
    ...b,
    id: `${pageIdx}-${b.index}`,
    pageUrl,
    pagePath,
    jsInjected: !staticPrints.has(b.fingerprint),
  }));
}

/** Detect buttons in one HTML document, rendering it first if its scripts mention PayPal. */
export async function scanDocument(
  html: string,
  opts: { url?: string; pageIdx: number; pagePath: string },
): Promise<{ buttons: DetectedButton[]; rendered: boolean; renderError?: string }> {
  const staticRaw = detectButtons(html);
  const staticPrints = new Set(staticRaw.map((b) => b.fingerprint));
  let raw = staticRaw;
  let rendered = false;
  let renderError: string | undefined;
  if (mentionsPayPal(html)) {
    try {
      const dom = await renderHtml(opts.url ? { url: opts.url } : { html });
      raw = detectButtons(dom);
      rendered = true;
    } catch (e: any) {
      renderError = `Couldn't run the page's JavaScript: ${e.message?.split("\n")[0]}`;
    }
  }
  return { buttons: toDetected(raw, opts.pageIdx, opts.url ?? "pasted", opts.pagePath, staticPrints), rendered, renderError };
}

export async function scanUrl(startUrl: string): Promise<ScanResult> {
  const start = await assertPublicUrl(startUrl);
  const origin = start.origin;
  // Keep the crawl inside the starting folder (e.g. /demo-site/) when one is given.
  const scope = start.pathname.endsWith("/") ? start.pathname : start.pathname.replace(/[^/]*$/, "");
  const disallow = await robotsRules(origin);
  const result: ScanResult = {
    id: randomUUID().slice(0, 8),
    input: { kind: "url", url: start.href },
    startedAt: new Date().toISOString(),
    pages: [],
    buttons: [],
    skipped: [],
  };
  // "/x/" and "/x/index.html" are the same page.
  const canon = (u: string) => u.split("#")[0].replace(/\/(index|default)\.(html?|php|asp)$/i, "/");
  const queue: string[] = [start.href.split("#")[0]];
  const seen = new Set(queue.map(canon));
  const contentSeen = new Set<string>();
  while (queue.length && result.pages.length < MAX_PAGES) {
    const url = queue.shift()!;
    const u = new URL(url);
    if (disallow.some((d) => u.pathname.startsWith(d))) {
      result.skipped.push(`${u.pathname} (robots.txt)`);
      continue;
    }
    const pagePath = u.pathname.startsWith(scope) ? u.pathname.slice(scope.length) || "index.html" : u.pathname;
    const pageIdx = result.pages.length;
    try {
      const page = await fetchPage(url);
      if (!page.type.includes("html")) continue;
      const digest = createHash("sha1").update(page.html).digest("hex");
      if (contentSeen.has(digest)) continue; // same page under another address
      contentSeen.add(digest);
      const scanned = await scanDocument(page.html, { url, pageIdx, pagePath });
      result.pages.push({ url, path: pagePath, status: page.status, rendered: scanned.rendered, buttons: scanned.buttons.length, error: scanned.renderError });
      result.buttons.push(...scanned.buttons);
      const $ = cheerio.load(page.html);
      $("a[href]").each((_, a) => {
        try {
          const next = new URL($(a).attr("href")!, page.finalUrl);
          next.hash = "";
          if (next.origin !== origin || !next.pathname.startsWith(scope) || SKIP_EXT.test(next.pathname)) return;
          if (!seen.has(canon(next.href))) {
            seen.add(canon(next.href));
            queue.push(next.href);
          }
        } catch {}
      });
    } catch (e: any) {
      result.pages.push({ url, path: pagePath, status: "error", rendered: false, buttons: 0, error: e.message });
    }
    if (queue.length) await new Promise((r) => setTimeout(r, DELAY_MS));
  }
  if (queue.length) result.skipped.push(`${queue.length} more page(s) not scanned (limit ${MAX_PAGES})`);
  result.finishedAt = new Date().toISOString();
  return result;
}

export async function scanHtml(html: string, label = "pasted HTML"): Promise<ScanResult> {
  const scanned = await scanDocument(html, { pageIdx: 0, pagePath: label });
  return {
    id: randomUUID().slice(0, 8),
    input: { kind: "html", label },
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    pages: [{ url: label, path: label, status: 200, rendered: scanned.rendered, buttons: scanned.buttons.length, error: scanned.renderError }],
    buttons: scanned.buttons,
    skipped: [],
  };
}
