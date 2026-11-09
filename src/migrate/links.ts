// Spec -> PayPal Payment Links request, and link creation (sandbox).
import { createHash } from "node:crypto";
import { pp } from "../paypal/client.js";
import type { LinkSpec } from "../types.js";

const PUBLIC_BASE = () => process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";

export function specToRequest(spec: LinkSpec) {
  const cur = spec.currency.value!;
  const amt = (v: string) => ({ currency_code: cur, value: v });
  const item: Record<string, unknown> = {
    name: spec.name.value!.slice(0, 127),
  };
  if (spec.description.value) item.description = spec.description.value.slice(0, 127);
  const v = spec.variants.value;
  const priced = v?.options.some((o) => o.price);
  if (v && v.options.length) {
    item.variants = {
      dimensions: [
        {
          name: v.dimension.slice(0, 64),
          primary: true,
          options: v.options.map((o) => ({
            label: o.label.slice(0, 64),
            // When options are priced, every option needs a price (fallback: base price).
            ...(priced ? { unit_amount: amt(o.price ?? spec.price.value!) } : {}),
          })),
        },
      ],
    };
  }
  // PayPal rejects a product-level price when the options carry prices (spike 1).
  if (!priced) item.unit_amount = amt(spec.price.value!);
  if (spec.shipping.value) {
    item.shipping = [
      { type: "FLAT", value: spec.shipping.value.first, ...(spec.shipping.value.additional ? { additional_unit_value: spec.shipping.value.additional } : {}) },
    ];
    item.collect_shipping_address = true;
  }
  if (spec.taxPercent.value && Number(spec.taxPercent.value) > 0) item.taxes = [{ name: "Tax", type: "PERCENTAGE", value: spec.taxPercent.value }];
  if (spec.quantity.value?.adjustable) item.adjustable_quantity = { maximum: spec.quantity.value.max ?? 50 };
  const ret = spec.returnUrl.value && /^https:\/\//.test(spec.returnUrl.value) ? spec.returnUrl.value : null;
  const base = PUBLIC_BASE();
  return {
    integration_mode: "LINK",
    type: "BUY_NOW",
    reusable: "MULTIPLE",
    ...(ret ? { return_url: ret } : /^https:/.test(base) ? { return_url: `${base}/thanks` } : {}),
    line_items: [item],
  };
}

// Same spec -> same link: avoids piling up duplicate links on repeat demo runs.
const cache = new Map<string, { id: string; url: string; createdAt: string }>();

export async function createLink(spec: LinkSpec) {
  const request = specToRequest(spec);
  const key = createHash("sha256").update(JSON.stringify(request)).digest("hex");
  const hit = cache.get(key);
  if (hit) return { ...hit, request, reused: true };
  const res = await pp("POST", "/v1/checkout/payment-resources", request);
  if (!res.ok) {
    const details = (res.body?.details ?? []).map((d: any) => `${d.field ?? ""} ${d.issue ?? ""}`.trim()).join("; ");
    throw new Error(`PayPal said ${res.status} ${res.body?.name ?? ""}${details ? `: ${details}` : ""} (debug_id ${res.debugId})`);
  }
  const url = res.body.links?.find((l: any) => l.rel === "payment_link")?.href as string;
  const link = { id: res.body.id as string, url, createdAt: new Date().toISOString() };
  cache.set(key, link);
  return { ...link, request, reused: false };
}

/** Total the buyer should pay for one purchase, the way PayPal computes it (tax on items only). */
export function expectedTotal(spec: LinkSpec, variantLabel: string | null, qty = 1): { unit: string; shipping: string; tax: string; total: string } {
  const opt = spec.variants.value?.options.find((o) => o.label === variantLabel);
  const unit = Number(opt?.price ?? spec.price.value);
  const items = unit * qty;
  const s = spec.shipping.value;
  const shipping = s ? Number(s.first) + Number(s.additional ?? s.first) * (qty - 1) : 0;
  const pct = Number(spec.taxPercent.value ?? 0);
  const tax = Math.round(items * pct + 1e-6) / 100; // cents, half-up
  const r = (n: number) => n.toFixed(2);
  return { unit: r(unit), shipping: r(shipping), tax: r(tax), total: r(items + shipping + tax) };
}
