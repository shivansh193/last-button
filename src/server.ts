// Last Button web server.
import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { existsSync } from "node:fs";
import { ScanError } from "./scan/crawl.js";
import { confirmRow, createLinks, enqueueVerification, getMigration, queueLength, startMigration } from "./migrate/service.js";
import { jsonLd, patchHtml, swapScript, toCsv, exportRows } from "./migrate/outputs.js";
import { recordEvent, verifySignature } from "./verify/webhooks.js";
import { loadDemoSnapshot, demoSnapshotId } from "./demo.js";
import type { Migration } from "./types.js";

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));
const ROOT = process.cwd();
const DATA_DIR = process.env.DATA_DIR ?? "data";
const PUBLIC_BASE = () => (process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, "");

// ---- tiny per-IP rate limiter ----
const hits = new Map<string, number[]>();
function limit(bucket: string, max: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${bucket}:${req.ip}`;
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= max) return res.status(429).json({ error: `Easy there: you can do this ${max} times every ${Math.round(windowMs / 60000)} minutes. Try again shortly.` });
    list.push(now);
    hits.set(key, list);
    next();
  };
}

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) =>
  fn(req, res).catch((e) => {
    console.error(e);
    res.status(e instanceof ScanError ? 400 : 500).json({ error: e.message ?? String(e) });
  });

function publicView(m: Migration) {
  const { sourceHtml, ...rest } = m;
  return { ...rest, queue: queueLength() };
}

function need(req: Request, res: Response): Migration | null {
  const m = getMigration(String(req.params.id));
  if (!m) {
    res.status(404).json({ error: "That migration isn't here any more. Run a new scan." });
    return null;
  }
  return m;
}

// ---- static: demo site, fixtures, app ----
app.use("/demo-site", express.static(path.join(ROOT, "fixtures/demo-site")));
app.use("/fixtures", express.static(path.join(ROOT, "fixtures"), { index: "index.html" }));
app.use("/screens", express.static(path.join(DATA_DIR, "screens"), { maxAge: "1h" }));
app.use("/screens", express.static(path.join(ROOT, "fixtures/demo-run/screens"), { maxAge: "1h" }));
app.use(express.static(path.join(ROOT, "public"), { extensions: ["html"] }));
app.get("/m/:id", (_req, res) => res.sendFile(path.join(ROOT, "public/app.html")));
app.get("/thanks", (_req, res) => res.sendFile(path.join(ROOT, "public/thanks.html")));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ---- API ----
app.get("/api/config", (_req, res) =>
  res.json({ demoUrl: `${PUBLIC_BASE()}/demo-site/`, demoSnapshot: demoSnapshotId(), ai: !!process.env.GEMINI_API_KEY, paypal: !!process.env.PAYPAL_CLIENT_ID }),
);

app.post(
  "/api/scan",
  limit("scan", 8, 10 * 60_000),
  wrap(async (req, res) => {
    const { url, html } = req.body ?? {};
    if (!url && !html) return res.status(400).json({ error: "Give a web address or paste some HTML." });
    if (html && String(html).length > 1_000_000) return res.status(400).json({ error: "That HTML is over 1 MB. Paste one page at a time." });
    const demoUrl = `${PUBLIC_BASE()}/demo-site/`;
    const isDemo = !!url && String(url).replace(/index\.html$/, "") === demoUrl;
    const m = await startMigration(url ? { url: String(url).trim() } : { html: String(html) }, { isDemo });
    res.json({ id: m.id });
  }),
);

app.get("/api/m/:id", (req, res) => {
  const m = need(req, res);
  if (m) res.json(publicView(m));
});

app.post(
  "/api/m/:id/rows/:rowId/confirm",
  wrap(async (req, res) => {
    const m = need(req, res);
    if (!m) return;
    confirmRow(m, String(req.params.rowId), req.body?.edits ?? {});
    res.json(publicView(m));
  }),
);

app.post(
  "/api/m/:id/links",
  limit("links", 20, 10 * 60_000),
  wrap(async (req, res) => {
    const m = need(req, res);
    if (!m) return;
    await createLinks(m, req.body?.rowIds);
    res.json(publicView(m));
  }),
);

app.post(
  "/api/m/:id/verify",
  limit("verify", 6, 10 * 60_000),
  wrap(async (req, res) => {
    const m = need(req, res);
    if (!m) return;
    const rowIds: string[] | undefined = req.body?.rowIds;
    // Keep the shared sandbox buyer from being used as a free load generator.
    const count = m.rows.filter((r) => r.link && (!rowIds || rowIds.includes(r.button.id))).length;
    if (!m.isDemo && count > 10) return res.status(400).json({ error: "Verification runs on up to 10 links at a time outside the demo." });
    enqueueVerification(m, rowIds);
    res.json(publicView(m));
  }),
);

async function pageHtml(m: Migration, pagePath: string): Promise<{ html: string; url: string } | null> {
  if (m.sourceHtml != null) return { html: m.sourceHtml, url: "pasted" };
  const page = m.scan.pages.find((p) => p.path === pagePath);
  if (!page) return null;
  const r = await fetch(page.url, { signal: AbortSignal.timeout(15000) });
  return { html: await r.text(), url: page.url };
}

app.get(
  "/api/m/:id/patched",
  wrap(async (req, res) => {
    const m = need(req, res);
    if (!m) return;
    const pagePath = String(req.query.page ?? "");
    const src = await pageHtml(m, pagePath);
    if (!src) return res.status(404).json({ error: "Unknown page" });
    const rows = m.rows.filter((r) => r.button.pagePath === pagePath && r.link);
    const out = patchHtml(src.html, rows);
    const name = (pagePath.replace(/[^a-z0-9.-]+/gi, "_") || "page") + (pagePath.endsWith(".html") ? "" : ".html");
    res.setHeader("Content-Disposition", `attachment; filename="patched-${name}"`);
    res.type("text/html").send(out.html);
  }),
);

app.get("/api/m/:id/swap.js", (req, res) => {
  const m = need(req, res);
  if (m) res.type("application/javascript").send(swapScript(m));
});
app.get("/api/m/:id/export.csv", (req, res) => {
  const m = need(req, res);
  if (!m) return;
  res.setHeader("Content-Disposition", `attachment; filename="last-button-${m.id}.csv"`);
  res.type("text/csv").send(toCsv(m));
});
app.get("/api/m/:id/export.json", (req, res) => {
  const m = need(req, res);
  if (!m) return;
  res.setHeader("Content-Disposition", `attachment; filename="last-button-${m.id}.json"`);
  res.json({ migration: m.id, scanned: m.scan.input, createdAt: m.createdAt, rows: exportRows(m), full: publicView(m).rows });
});
app.get("/api/m/:id/jsonld", (req, res) => {
  const m = need(req, res);
  if (m) res.type("text/plain").send(jsonLd(m));
});

// ---- PayPal webhook ----
app.post(
  "/api/paypal/webhook",
  wrap(async (req, res) => {
    const verified = await verifySignature(req.headers, req.body);
    const ev = recordEvent(req.body, verified);
    console.log("webhook", req.body?.event_type, ev?.linkId ?? "", verified ? "signature ok" : "signature NOT verified");
    res.sendStatus(200);
  }),
);

loadDemoSnapshot();
const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Last Button listening on :${port} (${PUBLIC_BASE()})`));
export { app };
