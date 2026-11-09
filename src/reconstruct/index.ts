// Reconstruction = field mapper first, then the AI fills only the gaps from page
// context. Every AI value must come with a verbatim quote from the page, or it is
// thrown away. Low confidence or unknown fields go to the owner. Nothing is guessed silently.
import { z } from "zod";
import { mapFields, money, QUANTITY_MAX } from "./map.js";
import { GeminiProvider } from "../ai/gemini.js";
import type { LLMProvider } from "../ai/provider.js";
import type { DetectedButton, LinkSpec, Reconstruction, SpecKey } from "../types.js";

export const CONFIDENCE_THRESHOLD = 0.8;
const REQUIRED: SpecKey[] = ["name", "price", "currency"];

let provider: LLMProvider = new GeminiProvider();
export const setProvider = (p: LLMProvider) => (provider = p);

const quoted = z.object({ quote: z.string().nullable(), confidence: z.number().min(0).max(1) });
const AiOut = z.object({
  name: quoted.extend({ value: z.string().nullable() }),
  price: quoted.extend({ value: z.string().nullable() }),
  currency: quoted.extend({ value: z.string().nullable() }),
  variants: quoted.extend({
    value: z.object({ dimension: z.string(), options: z.array(z.object({ label: z.string(), price: z.string().nullable() })) }).nullable(),
  }),
  shipping: quoted.extend({ value: z.object({ first: z.string(), additional: z.string().nullable() }).nullable() }),
  tax_percent: quoted.extend({ value: z.string().nullable() }),
  explanation: z.string(),
});
type AiOut = z.infer<typeof AiOut>;

const q = (value: Record<string, unknown>) => ({
  type: "OBJECT",
  properties: { value, quote: { type: "STRING", nullable: true }, confidence: { type: "NUMBER" } },
  required: ["value", "quote", "confidence"],
});
const SCHEMA = {
  type: "OBJECT",
  properties: {
    name: q({ type: "STRING", nullable: true }),
    price: q({ type: "STRING", nullable: true, description: "Decimal, e.g. 54.00" }),
    currency: q({ type: "STRING", nullable: true, description: "ISO 4217 code, e.g. USD" }),
    variants: q({
      type: "OBJECT",
      nullable: true,
      properties: {
        dimension: { type: "STRING" },
        options: { type: "ARRAY", items: { type: "OBJECT", properties: { label: { type: "STRING" }, price: { type: "STRING", nullable: true } }, required: ["label", "price"] } },
      },
      required: ["dimension", "options"],
    }),
    shipping: q({ type: "OBJECT", nullable: true, properties: { first: { type: "STRING" }, additional: { type: "STRING", nullable: true } }, required: ["first", "additional"] }),
    tax_percent: q({ type: "STRING", nullable: true }),
    explanation: { type: "STRING" },
  },
  required: ["name", "price", "currency", "variants", "shipping", "tax_percent", "explanation"],
};

const SYSTEM = `You help a small-business owner replace an old PayPal button on their website.
The button's own settings are hidden (a saved or encrypted PayPal button) or ambiguous, so you
read the text around it on the page and say what the button most likely sold.

Rules:
- Only use what the page text says. Never invent a product, price, currency, option, shipping or tax.
- For every non-null value, "quote" must be copied EXACTLY, character for character, from the page text given (a short phrase, under 120 characters) and must contain the evidence (for a price, the number itself).
- If the page shows several prices, pick the one this button charges (not a comparison, "was" or "if bought separately" price), and lower your confidence if it is unclear.
- If something is not mentioned, return null for value and quote. If the page says there is none (e.g. "postage is free"), return null with that quote.
- currency: ISO code. A bare "$" on an English-language page usually means USD; say so in the explanation and use confidence <= 0.85.
- confidence: 0.9+ only when the quote states it plainly; 0.5-0.8 when you are inferring.
- explanation: one or two plain sentences for the owner.`;

function norm(s: string) {
  return s.toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
}

/** Keep an AI field only if its quote really appears in the context (and, for money, contains the number). */
function checkQuote(context: string, quote: string | null, value: string | null, isMoney: boolean): { ok: boolean; why?: string } {
  if (value == null) return { ok: true };
  if (!quote) return { ok: false, why: "no supporting quote from the page" };
  if (!norm(context).includes(norm(quote))) return { ok: false, why: "its quote isn't on the page" };
  if (isMoney) {
    const n = Number(value);
    const nums = (quote.match(/\d+(?:[.,]\d{1,2})?/g) ?? []).map((x) => Number(x.replace(",", ".")));
    if (!nums.some((m) => Math.abs(m - n) < 0.005)) return { ok: false, why: "the quote doesn't contain that amount" };
  }
  return { ok: true };
}

function buildPrompt(b: DetectedButton, spec: LinkSpec, gaps: SpecKey[], ambiguities: string[]): string {
  const known = Object.entries(spec)
    .filter(([, v]) => v.prov.source === "html_field" && v.value != null)
    .map(([k, v]) => `${k}: ${JSON.stringify(v.value)}`)
    .join("\n");
  return `Button type: ${b.kind} (cmd=${b.cmd})
Button image: ${b.imageSrc ?? "none"}
Fields we could read from the HTML:
${known || "(none: the settings are stored at PayPal or encrypted)"}

What we need from you: ${gaps.length ? gaps.join(", ") : "double-check the fields above"}.
${ambiguities.length ? `Concerns to resolve: ${ambiguities.join(" ")}` : ""}

Page text around the button:
"""
${b.context}
"""`;
}

export async function reconstruct(b: DetectedButton, opts: { useAI?: boolean } = {}): Promise<Reconstruction> {
  const m = mapFields(b);
  const spec = m.spec;
  const needsOwner = new Set<SpecKey>(m.hardNeedsOwner);
  const notes = [...m.notes];
  let usedAI = false;
  let aiModel: string | undefined;
  let aiError: string | undefined;
  const askAI = (m.gaps.length > 0 || m.ambiguities.length > 0) && opts.useAI !== false;

  if (askAI) {
    try {
      const res = await provider.generateJson({ system: SYSTEM, prompt: buildPrompt(b, spec, m.gaps, m.ambiguities), schema: SCHEMA, validate: AiOut });
      usedAI = true;
      aiModel = res.model;
      mergeAI(b, spec, res.value, m.gaps, m.ambiguities, needsOwner, notes);
    } catch (e: any) {
      aiError = e.message;
      notes.push("The AI couldn't be reached, so the missing details need to be filled in by hand.");
    }
  }

  // Readable buttons with ambiguities always get an owner look, even when the AI agreed.
  if (m.ambiguities.length) {
    if (m.ambiguities.some((a) => /currency/i.test(a))) needsOwner.add("currency");
    if (m.ambiguities.some((a) => /option/i.test(a))) needsOwner.add("variants");
  }
  for (const k of REQUIRED) if (spec[k].value == null) needsOwner.add(k);
  // Policy: a price read by the AI is never charged without the owner's click.
  if (spec.price.prov.source === "page_context") needsOwner.add("price");
  for (const [k, v] of Object.entries(spec) as [SpecKey, LinkSpec[SpecKey]][]) {
    if (v.prov.source === "unknown" && !["description", "returnUrl"].includes(k)) needsOwner.add(k);
    if (v.prov.source !== "owner" && v.prov.confidence < CONFIDENCE_THRESHOLD && v.prov.source !== "unknown") needsOwner.add(k);
  }
  return { spec, needsOwner: [...needsOwner], notes: [...changeNotes(b, spec), ...notes], usedAI, aiModel, aiError };
}

function mergeAI(b: DetectedButton, spec: LinkSpec, ai: AiOut, gaps: SpecKey[], ambiguities: string[], needsOwner: Set<SpecKey>, notes: string[]) {
  const ctx = b.context;
  const take = <K extends SpecKey>(key: K, aiField: { value: any; quote: string | null; confidence: number }, valueForCheck: string | null, isMoney: boolean, value: LinkSpec[K]["value"]) => {
    const chk = checkQuote(ctx, aiField.quote, valueForCheck, isMoney);
    if (!chk.ok) {
      (spec[key] as any) = { value: null, prov: { source: "unknown", confidence: 0, note: `The AI suggested a value but ${chk.why}, so we didn't use it.` } };
      needsOwner.add(key);
      return;
    }
    const confidence = Math.min(aiField.confidence, 0.95);
    (spec[key] as any) = {
      value,
      prov: { source: "page_context", quote: aiField.quote ?? undefined, confidence, note: value == null ? (aiField.quote ? "Page says there is none." : "Not mentioned on the page.") : undefined },
    };
    // "None" answers without any quote are an absence of evidence: owner decides.
    if (value == null && !aiField.quote && confidence < 0.9) needsOwner.add(key);
  };

  if (gaps.includes("name")) take("name", ai.name, ai.name.value, false, ai.name.value?.trim() || null);
  if (gaps.includes("price")) {
    const p = money(ai.price.value);
    take("price", ai.price, p, true, p);
  }
  if (gaps.includes("currency") || ambiguities.some((a) => /currency/i.test(a))) {
    const c = ai.currency.value?.toUpperCase().slice(0, 3) ?? null;
    // A currency is often implied by a symbol, so the quote just needs to be on the page.
    take("currency", ai.currency, c, false, c);
  }
  if (gaps.includes("shipping")) {
    const s = ai.shipping.value ? { first: money(ai.shipping.value.first)!, additional: money(ai.shipping.value.additional) } : null;
    take("shipping", ai.shipping, s?.first ?? null, true, s);
  }
  if (gaps.includes("taxPercent")) take("taxPercent", ai.tax_percent, ai.tax_percent.value, true, ai.tax_percent.value);
  if (gaps.includes("variants") || ambiguities.some((a) => /option/i.test(a))) {
    const v = ai.variants.value;
    if (v && v.options.length) {
      const chk = checkQuote(ctx, ai.variants.quote, v.options[0].label, false);
      if (chk.ok) {
        spec.variants = {
          value: { dimension: v.dimension, options: v.options.map((o) => ({ label: o.label, price: money(o.price) })) },
          prov: { source: "page_context", quote: ai.variants.quote ?? undefined, confidence: Math.min(ai.variants.confidence, 0.95) },
        };
        needsOwner.add("variants");
      }
    } else if (gaps.includes("variants")) {
      spec.variants = { value: null, prov: { source: "page_context", confidence: ai.variants.confidence, note: "No options mentioned on the page." } };
    }
  }
  if (ai.explanation) notes.push(`AI: ${ai.explanation}`);
}

function fmt(v: string | null | undefined, cur: string | null) {
  if (v == null) return "?";
  const sym = cur === "USD" ? "$" : cur === "GBP" ? "£" : cur === "EUR" ? "€" : "";
  return sym ? `${sym}${v}` : `${v} ${cur ?? ""}`.trim();
}

/** Plain-English notes about what changes for the buyer. */
export function changeNotes(b: DetectedButton, s: LinkSpec): string[] {
  const cur = s.currency.value;
  const out: string[] = [];
  const kindNote: Record<string, string> = {
    buy_now: "Was a Buy Now button. Now a PayPal Payment Link: buyers click it and pay on PayPal's own checkout page.",
    add_to_cart: "Was an Add to Cart button. Payment Links sell one product per checkout, so buyers will pay for this item on its own rather than adding it to a basket.",
    cart_upload: "Was a cart upload. Each product now gets its own Payment Link.",
    hosted: "Was a saved PayPal button whose settings live inside PayPal and can't be read from your page. We rebuilt it from the text around it, so please check the details.",
    encrypted: "Was an encrypted PayPal button: its settings are scrambled in the page. We rebuilt it from the text and image around it, so please check the details.",
  };
  if (kindNote[b.kind]) out.push(kindNote[b.kind]);
  if (s.variants.value?.options.length) {
    const opts = s.variants.value.options.map((o) => `${o.label} ${fmt(o.price ?? s.price.value, cur)}`).join(", ");
    out.push(`${s.variants.value.dimension} choices carry over: ${opts}.`);
  }
  if (s.shipping.value)
    out.push(`Postage stays ${fmt(s.shipping.value.first, cur)}${s.shipping.value.additional ? `, plus ${fmt(s.shipping.value.additional, cur)} for each extra item` : ""}.`);
  if (s.taxPercent.value) out.push(`Tax of ${s.taxPercent.value}% is added to the item price (not the postage).`);
  if (s.quantity.value?.adjustable) out.push(`Buyers can still choose how many they want (up to ${s.quantity.value.max ?? QUANTITY_MAX}).`);
  return out;
}
