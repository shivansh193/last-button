// Spike 1: create a sandbox Payment Link with a variant dropdown (per-option prices),
// flat shipping and percentage tax. Saves the request/response to runs/spike1.json.
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { pp, tokenScopes } from "../src/paypal/client.js";

mkdirSync("runs", { recursive: true });

const scopes = await tokenScopes();
const relevant = scopes.filter((s) => /payment|checkout|button|ncp|webhook|reporting|transaction/i.test(s));
console.log("token scopes (relevant):", relevant);

const requests: Record<string, any> = {
  // The case that matters: a T-shirt with per-size prices, flat shipping, 8.25% tax.
  variants: {
    integration_mode: "LINK",
    type: "BUY_NOW",
    reusable: "MULTIPLE",
    return_url: (process.env.PUBLIC_BASE_URL ?? "https://example.com") + "/thanks",
    line_items: [
      {
        name: "Spike: Cast T-shirt",
        description: "Last Button spike 1: per-size price, flat shipping, percentage tax",
        unit_amount: { currency_code: "USD", value: "18.00" },
        variants: {
          dimensions: [
            {
              name: "Size",
              primary: true,
              options: [
                { label: "Small", unit_amount: { currency_code: "USD", value: "18.00" } },
                { label: "Medium", unit_amount: { currency_code: "USD", value: "18.00" } },
                { label: "XL", unit_amount: { currency_code: "USD", value: "21.00" } },
              ],
            },
          ],
        },
        shipping: [{ type: "FLAT", value: "4.50" }],
        taxes: [{ name: "Sales tax", type: "PERCENTAGE", value: "8.25" }],
        collect_shipping_address: true,
      },
    ],
  },
  // A plain ticket with adjustable quantity (raffle-style).
  quantity: {
    integration_mode: "LINK",
    type: "BUY_NOW",
    reusable: "MULTIPLE",
    line_items: [
      {
        name: "Spike: Raffle ticket",
        unit_amount: { currency_code: "USD", value: "2.00" },
        adjustable_quantity: { maximum: 50 },
      },
    ],
  },
};

const out: Record<string, any> = { at: new Date().toISOString(), scopes: relevant, results: {} };
for (const [key, req] of Object.entries(requests)) {
  const res = await pp("POST", "/v1/checkout/payment-resources", req);
  const link = res.body?.links?.find((l: any) => l.rel === "payment_link")?.href;
  console.log(`\n[${key}] HTTP ${res.status} debug_id=${res.debugId}`);
  console.log(link ? `payment_link: ${link}` : JSON.stringify(res.body, null, 2).slice(0, 2000));
  out.results[key] = { request: req, status: res.status, debugId: res.debugId, response: res.body, link };
  if (res.ok && res.body?.id) {
    const got = await pp("GET", `/v1/checkout/payment-resources/${res.body.id}`);
    out.results[key].roundTrip = got.body;
  }
}
writeFileSync("runs/spike1.json", JSON.stringify(out, null, 2));
console.log("\nwrote runs/spike1.json");
