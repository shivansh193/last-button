// Field mapper: WPS HTML fields -> Payment Link spec, with provenance per field.
// Anything it can't read is left for the AI (gaps) or the owner.
import type { DetectedButton, LinkSpec, Provenance, Shipping, SpecField, SpecKey, Variants } from "../types.js";

export const QUANTITY_MAX = 50;

const fromHtml = (field: string, confidence = 0.98, note?: string): Provenance => ({ source: "html_field", field, confidence, note });
const dflt = (confidence: number, note: string): Provenance => ({ source: "default", confidence, note });
const unknown = (note: string): Provenance => ({ source: "unknown", confidence: 0, note });
const f = <T>(value: T | null, prov: Provenance): SpecField<T> => ({ value, prov });

export function money(v: string | undefined | null): string | null {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ""));
  if (!isFinite(n) || String(v).trim() === "") return null;
  return n.toFixed(2);
}

export interface MapResult {
  spec: LinkSpec;
  gaps: SpecKey[]; // fields the AI should try to fill from page context
  ambiguities: string[]; // readable but suspicious: the AI double-checks, the owner confirms
  hardNeedsOwner: SpecKey[]; // can't be expressed automatically
  notes: string[];
}

const SYMBOL_CURRENCY: [RegExp, string][] = [
  [/£/, "GBP"],
  [/€/, "EUR"],
  [/A\$|AU\$/, "AUD"],
  [/C\$|CA\$/, "CAD"],
  [/NZ\$/, "NZD"],
  [/¥/, "JPY"],
  [/₹/, "INR"],
];

export function mapFields(b: DetectedButton): MapResult {
  const x = b.fields;
  const gaps: SpecKey[] = [];
  const ambiguities: string[] = [];
  const hardNeedsOwner: SpecKey[] = [];
  const notes: string[] = [];
  const readable = b.kind !== "hosted" && b.kind !== "encrypted";

  // Name
  const name = x.item_name?.trim() ? f(x.item_name.trim(), fromHtml("item_name")) : f<string>(null, unknown("No item_name in the button."));
  if (!name.value) gaps.push("name");

  // Variants (first option menu; WPS allows several, Payment Links prices one)
  let variants: SpecField<Variants> = f<Variants>(null, readable ? fromHtml("on0", 0.98, "No options on the old button.") : unknown("Saved button: options are not visible."));
  if (!readable) gaps.push("variants");
  const optionAmounts: { label: string; price: string }[] = [];
  for (let i = 0; i < 100 && x[`option_select${i}`] !== undefined; i++) {
    const price = money(x[`option_amount${i}`]);
    if (price) optionAmounts.push({ label: x[`option_select${i}`], price });
  }
  if (x.on0 && b.selectOptions.os0?.length) {
    const opts = b.selectOptions.os0.map((o) => {
      const priced = optionAmounts.find((a) => a.label === o.value);
      return { label: o.value || o.text, price: priced?.price ?? null };
    });
    const field = optionAmounts.length ? "on0, os0, option_select*/option_amount*" : "on0, os0";
    variants = f({ dimension: x.on0, options: opts }, fromHtml(field));
    // Prices written in option text but not set as option_amount: did the owner mean per-option prices?
    if (!optionAmounts.length) {
      const base = money(x.amount);
      const textPrices = b.selectOptions.os0.map((o) => money(o.text.match(/[\d]+(?:\.\d{1,2})?(?=\s*$)|(?<=[$£€]\s?)[\d.]+/)?.[0]));
      if (textPrices.some((p) => p && p !== base)) ambiguities.push("Option text shows prices that differ from the button's amount, but no option prices are set.");
    }
  } else if (x.on0 && x.os0 !== undefined && !b.selectOptions.os0) {
    notes.push(`The old button asked buyers to type "${x.on0}". Payment Links can collect a note at checkout; add one in PayPal if you still need it.`);
  }
  if (x.on1) {
    notes.push(`The old button had a second option menu ("${x.on1}"). Payment Links price only one option menu, so please check it.`);
    hardNeedsOwner.push("variants");
  }

  // Price
  let price: SpecField<string>;
  const priced = variants.value?.options.filter((o) => o.price) ?? [];
  if (priced.length) price = f(priced[0].price!, fromHtml("option_amount0", 0.98, "Each option carries its own price."));
  else if (money(x.amount)) price = f(money(x.amount)!, fromHtml("amount"));
  else {
    price = f<string>(null, unknown(readable ? "No amount: the old button let buyers type their own amount." : "Saved button: price is not visible."));
    if (readable) hardNeedsOwner.push("price");
    else gaps.push("price");
  }

  // Currency
  let currency: SpecField<string>;
  if (x.currency_code) currency = f(x.currency_code.toUpperCase(), fromHtml("currency_code"));
  else if (readable) {
    currency = f("USD", dflt(0.85, "No currency_code on the button; PayPal's default is USD."));
    const sym = SYMBOL_CURRENCY.find(([re]) => re.test(b.context));
    if (sym) ambiguities.push(`The page shows ${sym[1]} prices but the button has no currency_code (PayPal would default to USD).`);
  } else {
    currency = f<string>(null, unknown("Saved button: currency is not visible."));
    gaps.push("currency");
  }

  // Shipping
  let shipping: LinkSpec["shipping"];
  if (money(x.shipping)) shipping = f({ first: money(x.shipping)!, additional: money(x.shipping2) }, fromHtml(x.shipping2 ? "shipping, shipping2" : "shipping"));
  else if (x.no_shipping === "1") shipping = f<Shipping>(null, fromHtml("no_shipping", 0.95, "Old button collected no shipping."));
  else if (readable) shipping = f<Shipping>(null, dflt(0.85, "No shipping on the button. If your PayPal profile adds postage rules, set them on the new link."));
  else {
    shipping = f<Shipping>(null, unknown("Saved button: shipping is not visible."));
    gaps.push("shipping");
  }

  // Tax
  let taxPercent: LinkSpec["taxPercent"];
  if (x.tax_rate) taxPercent = f(Number(x.tax_rate).toFixed(2).replace(/\.?0+$/, "") || "0", fromHtml("tax_rate"));
  else if (money(x.tax) && price.value) {
    const pct = ((Number(money(x.tax)) / Number(price.value)) * 100).toFixed(2);
    taxPercent = f(pct, fromHtml("tax", 0.6, `Old button added a flat ${money(x.tax)} tax. Payment Links use a percentage; ${money(x.tax)} of ${price.value} is ${pct}%.`));
    hardNeedsOwner.push("taxPercent");
  } else if (readable) taxPercent = f<string>(null, dflt(0.85, "No tax on the button. If your PayPal profile adds tax, set it on the new link."));
  else {
    taxPercent = f<string>(null, unknown("Saved button: tax is not visible."));
    gaps.push("taxPercent");
  }

  // Quantity
  let quantity: LinkSpec["quantity"];
  const visibleQty = b.visibleInputs.includes("quantity");
  if (x.undefined_quantity === "1" || visibleQty)
    quantity = f({ adjustable: true, max: QUANTITY_MAX }, fromHtml(visibleQty ? "quantity (visible box)" : "undefined_quantity"));
  else if (x.quantity && Number(x.quantity) > 1) {
    quantity = f({ adjustable: false, max: null }, fromHtml("quantity", 0.5, `Old button sold a fixed bundle of ${x.quantity}. Payment Links can't fix a quantity above 1.`));
    hardNeedsOwner.push("quantity");
  } else quantity = f({ adjustable: false, max: null }, readable ? fromHtml("quantity", 0.95, "One item per purchase.") : dflt(0.8, "One item per purchase."));

  // Return URL
  const ret = x.return && /^https:\/\//i.test(x.return) ? f(x.return, fromHtml("return")) : f<string>(null, dflt(1, "PayPal shows its own confirmation page."));
  if (x.return && !/^https:\/\//i.test(x.return)) notes.push(`The old thank-you page (${x.return}) isn't https, so PayPal's own confirmation page is used instead.`);

  const description = f<string>(null, dflt(1, "Optional."));
  return { spec: { name, description, price, currency, variants, shipping, taxPercent, quantity, returnUrl: ret }, gaps, ambiguities, hardNeedsOwner, notes };
}
