// Eval: crawl each fixture site with the real scanner, reconstruct with the real
// mapper + Gemini, and score against fixtures/<site>/truth.json.
//   npm run eval            (detection + reconstruction; needs GEMINI_API_KEY for AI fields)
//   npm run eval -- --no-ai (mapper only, to see what the AI adds)
// Verification pass rate is read from stored verification runs (data/ and fixtures/demo-run).
import "dotenv/config";
import express from "express";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";

process.env.ALLOW_LOCAL_SCAN = "1";
process.env.SCAN_DELAY_MS = "0";
const { scanUrl } = await import("../src/scan/crawl.js");
const { reconstruct } = await import("../src/reconstruct/index.js");
const { closeBrowser } = await import("../src/scan/browser.js");

const useAI = !process.argv.includes("--no-ai");
const SITES = ["demo-site", "wordpress-style", "inline-table", "js-injected"];
const FIELDS = ["name", "price", "currency", "variants", "shipping", "taxPercent", "quantity"] as const;

const app = express();
app.use("/", express.static(path.resolve("fixtures")));
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const normName = (s: string) => s.toLowerCase().replace(/[–—-]/g, " ").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
function nameMatch(got: string | null, want: string) {
  if (!got) return false;
  const a = new Set(normName(got).split(" "));
  const b = normName(want).split(" ");
  const hit = b.filter((w) => a.has(w)).length;
  return hit / b.length >= 0.6; // most of the expected words are present
}
const eqMoney = (a: string | null | undefined, b: string | null | undefined) => (a == null && b == null) || (a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.005);

function fieldOk(field: (typeof FIELDS)[number], spec: any, exp: any): boolean {
  switch (field) {
    case "name": return nameMatch(spec.name.value, exp.name);
    case "price": return eqMoney(spec.price.value, exp.price);
    case "currency": return spec.currency.value === exp.currency;
    case "taxPercent": return eqMoney(spec.taxPercent.value, exp.taxPercent);
    case "quantity": return !!spec.quantity.value?.adjustable === !!exp.quantityAdjustable;
    case "shipping": {
      const s = spec.shipping.value, e = exp.shipping;
      if (!s || !e) return !s && !e;
      return eqMoney(s.first, e.first) && eqMoney(s.additional, e.additional);
    }
    case "variants": {
      const v = spec.variants.value, e = exp.variants;
      if (!v || !e) return !v && !e;
      if (v.options.length !== e.options.length) return false;
      return e.options.every((o: any, i: number) => v.options[i].label === o.label && eqMoney(v.options[i].price ?? null, o.price ?? null));
    }
  }
}

interface Out { site: string; key: string; kind: string; detected: boolean; affectedOk: boolean; fields?: Record<string, boolean>; sources?: Record<string, string>; needsOwner?: string[]; usedAI?: boolean }
const results: Out[] = [];
let falsePositives = 0;
const t0 = Date.now();

for (const site of SITES) {
  const truth = JSON.parse(readFileSync(`fixtures/${site}/truth.json`, "utf8"));
  const scan = await scanUrl(`${base}/${site}/`);
  const used = new Set<string>();
  for (const t of truth.buttons) {
    const b = scan.buttons.find((x) => x.pagePath === t.page && x.index === t.index);
    if (!b) { results.push({ site, key: t.key, kind: t.kind, detected: false, affectedOk: false }); continue; }
    used.add(b.id);
    const o: Out = { site, key: t.key, kind: t.kind, detected: true, affectedOk: b.affected === t.affected };
    if (t.affected && t.expected && b.affected) {
      const r = await reconstruct(b, { useAI });
      o.fields = Object.fromEntries(FIELDS.map((f) => [f, fieldOk(f, r.spec, t.expected)]));
      o.sources = Object.fromEntries(FIELDS.map((f) => [f, (r.spec as any)[f].prov.source]));
      o.needsOwner = r.needsOwner;
      o.usedAI = r.usedAI;
    }
    results.push(o);
  }
  falsePositives += scan.buttons.filter((b) => !used.has(b.id)).length;
  console.log(`${site}: ${scan.pages.length} page(s), ${scan.buttons.length} button(s) found, ${truth.buttons.length} expected`);
}
server.close();
await closeBrowser();

// ---- metrics ----
const affTruth = results.filter((r) => SITES && r.kind && r.kind !== "donate" && r.kind !== "subscribe");
const unaffTruth = results.filter((r) => r.kind === "donate" || r.kind === "subscribe");
const tp = affTruth.filter((r) => r.detected && r.affectedOk).length;
const fn = affTruth.length - tp;
const fpAffected = unaffTruth.filter((r) => r.detected && !r.affectedOk).length + falsePositives;
const precision = tp / (tp + fpAffected || 1);
const recall = tp / (tp + fn || 1);
const leftAlone = unaffTruth.filter((r) => r.detected && r.affectedOk).length;

const scored = results.filter((r) => r.fields);
const fieldAcc: Record<string, { ok: number; n: number }> = {};
const bySource: Record<string, { ok: number; n: number }> = {};
for (const r of scored) for (const f of FIELDS) {
  (fieldAcc[f] ??= { ok: 0, n: 0 }).n++;
  if (r.fields![f]) fieldAcc[f].ok++;
  const src = r.sources![f];
  (bySource[src] ??= { ok: 0, n: 0 }).n++;
  if (r.fields![f]) bySource[src].ok++;
}
const allFields = Object.values(fieldAcc).reduce((a, b) => ({ ok: a.ok + b.ok, n: a.n + b.n }), { ok: 0, n: 0 });
const exactRows = scored.filter((r) => Object.values(r.fields!).every(Boolean)).length;
const routed = scored.filter((r) => r.needsOwner!.length).length;
const hidden = scored.filter((r) => r.kind === "hosted" || r.kind === "encrypted");
const hiddenPriceOk = hidden.filter((r) => r.fields!.price).length;
// A silent error: a wrong field that was NOT sent to the owner.
const silentErrors = scored.flatMap((r) => FIELDS.filter((f) => !r.fields![f] && !r.needsOwner!.includes(f)).map((f) => `${r.site}/${r.key}.${f}`));

// Verification runs
const verifs: { ok: boolean; problems: string[] }[] = [];
// Only the committed demo run counts by default; --all-runs adds local runs in data/.
for (const dir of process.argv.includes("--all-runs") ? ["data/migrations", "fixtures/demo-run"] : ["fixtures/demo-run"]) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const m = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
    for (const r of m.rows ?? []) if (r.verification) verifs.push(r.verification);
  }
}
const vOk = verifs.filter((v) => v.ok).length;

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "n/a");
const summary = {
  at: new Date().toISOString(),
  ai: useAI ? process.env.GEMINI_MODEL : "off",
  sites: SITES.length,
  buttons: results.length,
  detection: { affectedExpected: affTruth.length, truePositives: tp, falseNegatives: fn, falsePositives: fpAffected, precision, recall, donateSubscribeLeftAlone: `${leftAlone}/${unaffTruth.length}` },
  reconstruction: {
    buttonsScored: scored.length,
    fieldAccuracy: Object.fromEntries(Object.entries(fieldAcc).map(([k, v]) => [k, `${v.ok}/${v.n}`])),
    overallFieldAccuracy: pct(allFields.ok, allFields.n),
    bySource: Object.fromEntries(Object.entries(bySource).map(([k, v]) => [k, `${v.ok}/${v.n}`])),
    buttonsAllFieldsCorrect: `${exactRows}/${scored.length}`,
    hiddenButtonsPriceRecovered: `${hiddenPriceOk}/${hidden.length}`,
    routedToOwner: `${routed}/${scored.length} (${pct(routed, scored.length)})`,
    silentErrors,
  },
  verification: { runs: verifs.length, passed: vOk, passRate: pct(vOk, verifs.length), failures: verifs.filter((v) => !v.ok).map((v) => (v.problems[0] ?? "").split("
")[0]) },
  seconds: Math.round((Date.now() - t0) / 1000),
  perButton: results,
};
mkdirSync("eval", { recursive: true });
writeFileSync(`eval/results${useAI ? "" : "-no-ai"}.json`, JSON.stringify(summary, null, 2));
const { perButton, ...short } = summary;
console.log(JSON.stringify(short, null, 2));
