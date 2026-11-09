// Migration workflow: scan -> reconstruct -> owner confirms -> links -> verification.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { scanHtml, scanUrl } from "../scan/crawl.js";
import { reconstruct } from "../reconstruct/index.js";
import { createLink, expectedTotal } from "./links.js";
import { payThroughLink } from "../verify/bot.js";
import { findEvent, onPaymentEvent } from "../verify/webhooks.js";
import { pp } from "../paypal/client.js";
import type { LinkSpec, Migration, MigrationRow, ScanResult, SpecKey, Verification } from "../types.js";

const DATA_DIR = process.env.DATA_DIR ?? "data";
const DIR = path.join(DATA_DIR, "migrations");
mkdirSync(DIR, { recursive: true });

const migrations = new Map<string, Migration>();
for (const f of existsSync(DIR) ? readdirSync(DIR) : []) {
  try {
    const m = JSON.parse(readFileSync(path.join(DIR, f), "utf8")) as Migration;
    // Anything that was mid-verification when the server stopped needs a re-run.
    for (const r of m.rows) if (r.status === "verifying") r.status = "link_created";
    migrations.set(m.id, m);
  } catch {}
}

export const getMigration = (id: string) => migrations.get(id);
export const listMigrations = () => [...migrations.values()];
export function save(m: Migration) {
  migrations.set(m.id, m);
  writeFileSync(path.join(DIR, `${m.id}.json`), JSON.stringify(m, null, 1));
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

export function diffFor(row: MigrationRow): MigrationRow["diff"] {
  const s = row.recon?.spec;
  if (!s) return [];
  const f = row.button.fields;
  const d: MigrationRow["diff"] = [];
  const add = (field: string, old: string | undefined, nu: string | null | undefined) => d.push({ field, old: old ?? "(not in page)", new: nu ?? "(none)" });
  add("name", f.item_name, s.name.value);
  add("price", f.amount, s.price.value);
  add("currency", f.currency_code, s.currency.value);
  if (f.on0 || s.variants.value) add("options", f.on0 ? `${f.on0}: ${(row.button.selectOptions.os0 ?? []).map((o) => o.text).join(", ")}` : undefined, s.variants.value ? `${s.variants.value.dimension}: ${s.variants.value.options.map((o) => `${o.label}${o.price ? ` ${o.price}` : ""}`).join(", ")}` : null);
  if (f.shipping || s.shipping.value) add("shipping", f.shipping ? `${f.shipping}${f.shipping2 ? ` (+${f.shipping2})` : ""}` : undefined, s.shipping.value ? `${s.shipping.value.first}${s.shipping.value.additional ? ` (+${s.shipping.value.additional})` : ""}` : null);
  if (f.tax_rate || f.tax || s.taxPercent.value) add("tax", f.tax_rate ? `${f.tax_rate}%` : f.tax ? `flat ${f.tax}` : undefined, s.taxPercent.value ? `${s.taxPercent.value}%` : null);
  if (f.undefined_quantity || s.quantity.value?.adjustable) add("quantity", f.undefined_quantity === "1" ? "buyer chooses" : f.quantity, s.quantity.value?.adjustable ? `buyer chooses (max ${s.quantity.value.max})` : "1");
  return d;
}

function statusAfterRecon(row: MigrationRow): MigrationRow["status"] {
  if (!row.button.affected) return "unaffected";
  if (row.button.kind === "view_cart") return "not_migratable";
  if (!row.recon) return "failed";
  return row.recon.needsOwner.length ? "needs_owner" : "ready";
}

export async function startMigration(input: { url?: string; html?: string }, opts: { isDemo?: boolean } = {}): Promise<Migration> {
  const scan: ScanResult = input.url ? await scanUrl(input.url) : await scanHtml(input.html ?? "");
  const rows: MigrationRow[] = scan.buttons.map((b) => ({ button: b, recon: null, status: "unaffected", link: null, verification: null, error: null, diff: [] }));
  await mapLimit(rows, 4, async (row) => {
    if (row.button.affected && row.button.kind !== "view_cart") {
      try {
        row.recon = await reconstruct(row.button);
      } catch (e: any) {
        row.error = `Couldn't rebuild this button: ${e.message}`;
      }
    }
    row.status = statusAfterRecon(row);
    row.diff = diffFor(row);
  });
  const m: Migration = { id: randomUUID().slice(0, 8), createdAt: new Date().toISOString(), scan, rows, isDemo: !!opts.isDemo, sourceHtml: input.url ? undefined : input.html };
  save(m);
  return m;
}

const rowOf = (m: Migration, rowId: string) => {
  const r = m.rows.find((x) => x.button.id === rowId);
  if (!r) throw new Error("No such button");
  return r;
};

/** Owner confirms the row as shown, optionally with edits. Edits are recorded as owner-sourced. */
export function confirmRow(m: Migration, rowId: string, edits: Partial<Record<SpecKey, unknown>> = {}) {
  const row = rowOf(m, rowId);
  if (!row.recon) throw new Error("Nothing to confirm for this button");
  const spec = row.recon.spec as LinkSpec;
  for (const [k, v] of Object.entries(edits) as [SpecKey, any][]) {
    if (!(k in spec)) continue;
    (spec[k] as any) = { value: v === "" ? null : v, prov: { source: "owner", confidence: 1, confirmed: true, note: "Set by the owner." } };
  }
  for (const k of row.recon.needsOwner) {
    const p = spec[k].prov;
    if (p.source !== "owner") spec[k].prov = { ...p, confirmed: true };
  }
  for (const k of ["name", "price", "currency"] as SpecKey[]) if (spec[k].value == null) throw new Error(`Please fill in the ${k} first.`);
  row.recon.needsOwner = [];
  if (row.link && ["link_created", "verified", "mismatch", "failed"].includes(row.status)) row.link = null; // spec changed: new link needed
  row.verification = null;
  row.status = "ready";
  row.error = null;
  row.diff = diffFor(row);
  save(m);
  return row;
}

export async function createLinks(m: Migration, rowIds?: string[]) {
  const targets = m.rows.filter((r) => (rowIds ? rowIds.includes(r.button.id) : true) && r.status === "ready");
  await mapLimit(targets, 3, async (row) => {
    try {
      const link = await createLink(row.recon!.spec);
      row.link = { id: link.id, url: link.url, createdAt: link.createdAt, request: link.request };
      row.status = "link_created";
      row.error = null;
    } catch (e: any) {
      row.status = "failed";
      row.error = e.message;
    }
  });
  save(m);
  return targets.length;
}

// ---- Verification queue: one buyer-bot run at a time ----
const queue: { m: Migration; row: MigrationRow }[] = [];
let running = false;
export const queueLength = () => queue.length + (running ? 1 : 0);

export function enqueueVerification(m: Migration, rowIds?: string[]) {
  const rows = m.rows.filter((r) => r.link && (rowIds ? rowIds.includes(r.button.id) : ["link_created", "failed", "mismatch"].includes(r.status)));
  for (const row of rows) {
    if (queue.some((q) => q.row === row)) continue;
    row.status = "verifying";
    row.error = null;
    queue.push({ m, row });
  }
  save(m);
  void drain();
  return rows.length;
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const { m, row } = queue.shift()!;
      await verifyRow(row).catch((e) => {
        row.status = "failed";
        row.error = e.message;
      });
      save(m);
    }
  } finally {
    running = false;
  }
}

/** Pick the dearest option, so per-option pricing is actually tested. */
function pickVariant(spec: LinkSpec): string | null {
  const opts = spec.variants.value?.options ?? [];
  if (!opts.length) return null;
  return [...opts].sort((a, b) => Number(b.price ?? spec.price.value) - Number(a.price ?? spec.price.value))[0].label;
}

export async function verifyRow(row: MigrationRow): Promise<Verification> {
  const spec = row.recon!.spec;
  const variant = pickVariant(spec);
  const exp = expectedTotal(spec, variant, 1);
  const started = Date.now();
  const problems: string[] = [];
  let bot;
  try {
    try {
      bot = await payThroughLink(row.link!.url, { variant, quantity: 1, tag: row.link!.id });
    } catch (first: any) {
      // The sandbox sometimes shows "Things don't appear to be working". Retry once,
      // but never after an order was created (that payment may have gone through).
      if (first.orderId) throw first;
      await new Promise((r) => setTimeout(r, 5000));
      bot = await payThroughLink(row.link!.url, { variant, quantity: 1, tag: row.link!.id });
    }
  } catch (e: any) {
    row.verification = {
      at: new Date().toISOString(), variant, quantity: 1, expectedTotal: exp.total, paidTotal: null, orderId: e.orderId ?? null, captureId: null,
      orderStatus: null, linkIdOnOrder: null, variantOnOrder: null, screenshot: e.screenshot ?? null, webhook: null, ok: false,
      problems: [`The buyer bot couldn't finish: ${e.message}`], durationMs: Date.now() - started,
    };
    row.status = "failed";
    row.error = e.message;
    return row.verification;
  }
  // Source of truth: Orders v2 with our own credentials (spike 3).
  let order: any = null;
  if (bot.orderId) {
    for (let i = 0; i < 3 && !order; i++) {
      const res = await pp("GET", `/v2/checkout/orders/${bot.orderId}`);
      if (res.ok) order = res.body;
      else await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const pu = order?.purchase_units?.[0];
  const item = pu?.items?.[0];
  const capture = pu?.payments?.captures?.[0];
  const paid = pu?.amount?.value ?? null;
  const v: Verification = {
    at: new Date().toISOString(),
    variant,
    quantity: 1,
    expectedTotal: exp.total,
    paidTotal: paid,
    orderId: bot.orderId,
    captureId: capture?.id ?? bot.captureId,
    orderStatus: order?.status ?? null,
    linkIdOnOrder: item?.item_id ?? null,
    variantOnOrder: item?.item_option_selections?.[0]?.select ?? null,
    screenshot: bot.screenshot,
    webhook: null,
    ok: false,
    problems,
    durationMs: Date.now() - started,
  };
  if (!order) problems.push("Couldn't read the order back from PayPal.");
  else {
    if (order.status !== "COMPLETED") problems.push(`Order status is ${order.status}, not COMPLETED.`);
    if (capture?.status !== "COMPLETED") problems.push(`Payment capture is ${capture?.status ?? "missing"}.`);
    if (v.linkIdOnOrder !== row.link!.id) problems.push(`Order belongs to ${v.linkIdOnOrder}, not this link.`);
    if (variant && v.variantOnOrder !== variant) problems.push(`Buyer chose ${variant} but the order says ${v.variantOnOrder}.`);
    if (paid !== exp.total)
      problems.push(`Paid ${paid} but expected ${exp.total} (${exp.unit} + ${exp.shipping} shipping + ${exp.tax} tax).`);
  }
  v.ok = problems.length === 0;
  const ev = findEvent(row.link!.id, v.captureId);
  if (ev) v.webhook = { eventId: ev.eventId, at: ev.receivedAt };
  row.verification = v;
  row.status = v.ok ? "verified" : order ? "mismatch" : "failed";
  row.error = v.ok ? null : problems.join(" ");
  return v;
}

// When the webhook lands after verification, attach it to the row.
onPaymentEvent((ev) => {
  for (const m of migrations.values()) {
    let touched = false;
    for (const r of m.rows) {
      if (r.link?.id === ev.linkId && r.verification && r.verification.captureId === ev.transactionId && !r.verification.webhook) {
        r.verification.webhook = { eventId: ev.eventId, at: ev.receivedAt };
        touched = true;
      }
    }
    if (touched) save(m);
  }
});
