// Run the whole demo on a deployment (default: the live Render URL) and save the
// verified result to fixtures/demo-run/, so it can be shown after a cold restart.
//   npx tsx scripts/snapshot-demo.ts [baseUrl]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const BASE = (process.argv[2] ?? "https://last-button.onrender.com").replace(/\/$/, "");
const j = async (p: string, body?: unknown) => {
  const r = await fetch(BASE + p, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const t: any = await r.json();
  if (!r.ok) throw new Error(`${p}: ${t.error ?? r.status}`);
  return t;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log("scanning", `${BASE}/demo-site/`);
const { id } = await j("/api/scan", { url: `${BASE}/demo-site/` });
let m = await j(`/api/m/${id}`);
console.log(`migration ${id}: ${m.rows.length} buttons`, m.rows.map((r: any) => r.status).join(", "));
for (const r of m.rows.filter((r: any) => r.status === "needs_owner")) m = await j(`/api/m/${id}/rows/${r.button.id}/confirm`, {});
m = await j(`/api/m/${id}/links`, {});
console.log("links:", m.rows.filter((r: any) => r.link).length);
m = await j(`/api/m/${id}/verify`, {});
const t0 = Date.now();
while (Date.now() - t0 < 20 * 60_000) {
  await sleep(10_000);
  m = await j(`/api/m/${id}`);
  const v = m.rows.filter((r: any) => r.status === "verifying").length;
  process.stdout.write(`\r${Math.round((Date.now() - t0) / 1000)}s: ${m.rows.filter((r: any) => r.status === "verified").length} verified, ${v} to go   `);
  if (!v) break;
}
// Give the webhooks a minute to land.
for (let i = 0; i < 9; i++) {
  if (m.rows.filter((r: any) => r.verification?.ok).every((r: any) => r.verification.webhook)) break;
  await sleep(10_000);
  m = await j(`/api/m/${id}`);
}
console.log();
for (const r of m.rows) console.log(r.button.id, r.status, r.verification ? `${r.verification.paidTotal}/${r.verification.expectedTotal} webhook=${!!r.verification.webhook}` : "", r.error ?? "");

const out = "fixtures/demo-run";
mkdirSync(path.join(out, "screens"), { recursive: true });
delete m.queue;
writeFileSync(path.join(out, "migration.json"), JSON.stringify(m, null, 1));
for (const r of m.rows) {
  const s = r.verification?.screenshot;
  if (!s) continue;
  const res = await fetch(`${BASE}/screens/${encodeURIComponent(s)}`);
  if (res.ok) writeFileSync(path.join(out, "screens", s), Buffer.from(await res.arrayBuffer()));
}
console.log(`saved ${out}/migration.json (${BASE}/m/${id})`);
