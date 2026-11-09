// Spike 3: does any webhook event fire for a Payment Link purchase? And can we read
// the payment back through the API?
//   register <url>     subscribe this app to all events at <url> (public https)
//   events             list webhook events PayPal generated for this app
//                      (they are recorded even when delivery fails)
//   txn [orderOrTxnId] Orders v2 GET, plus Transaction Search over the last 2 days
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { pp } from "../src/paypal/client.js";

mkdirSync("runs", { recursive: true });
const [cmd, arg] = process.argv.slice(2);
const out: any = { at: new Date().toISOString(), cmd };

if (cmd === "register") {
  const list = await pp("GET", "/v1/notifications/webhooks");
  console.log("existing:", list.body?.webhooks?.map((w: any) => w.url));
  const r = await pp("POST", "/v1/notifications/webhooks", { url: arg, event_types: [{ name: "*" }] });
  console.log(r.status, JSON.stringify(r.body, null, 2));
  out.register = r.body;
} else if (cmd === "events") {
  const r = await pp("GET", "/v1/notifications/webhooks-events?page_size=20");
  if (!r.ok) console.log(r.status, JSON.stringify(r.body));
  for (const e of r.body?.events ?? []) console.log(e.create_time, e.event_type, e.resource?.id, e.summary);
  out.events = r.body;
} else if (cmd === "txn") {
  if (arg) {
    const o = await pp("GET", `/v2/checkout/orders/${arg}`);
    console.log("orders GET", o.status, JSON.stringify(o.body).slice(0, 1500));
    out.order = o;
  }
  const end = new Date();
  const start = new Date(end.getTime() - 2 * 86400_000);
  const iso = (d: Date) => d.toISOString().replace(/\.\d+Z$/, "Z");
  const q = new URLSearchParams({ start_date: iso(start), end_date: iso(end), fields: "all", page_size: "50" });
  if (arg) q.set("transaction_id", arg);
  const t = await pp("GET", `/v1/reporting/transactions?${q}`);
  console.log("transaction search", t.status);
  for (const d of t.body?.transaction_details ?? []) {
    const ti = d.transaction_info;
    console.log(ti.transaction_id, ti.transaction_initiation_date, ti.transaction_amount?.value, ti.transaction_status, d.cart_info?.item_details?.map((i: any) => i.item_name));
  }
  if (!t.ok) console.log(JSON.stringify(t.body).slice(0, 800));
  out.txn = t.body;
} else {
  console.log("usage: spike-3 register <url> | events | txn [id]");
}
writeFileSync(`runs/spike3-${cmd}.json`, JSON.stringify(out, null, 2));
