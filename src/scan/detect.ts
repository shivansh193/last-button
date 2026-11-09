// Finds legacy PayPal Website Payments Standard (WPS) buttons in an HTML document
// and classifies each one as affected by the WPS retirement or not.
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import type { ButtonKind, DetectedButton } from "../types.js";

const WEBSCR = /(?:^|\/\/)(?:www\.)?(sandbox\.)?paypal\.com\/cgi-bin\/webscr/i;

export interface RawButton extends Omit<DetectedButton, "id" | "pageUrl" | "pagePath" | "jsInjected"> {}

export function detectButtons(html: string): RawButton[] {
  const $ = cheerio.load(html);
  const out: RawButton[] = [];
  // Document order matters: it is how we find the same button again when patching.
  $("form, a[href]").each((_, node) => {
    const el = node as Element;
    if (el.tagName === "form") {
      const action = $(el).attr("action") ?? "";
      if (!WEBSCR.test(action)) return;
      out.push(fromForm($, el, action));
    } else {
      const href = $(el).attr("href") ?? "";
      if (!WEBSCR.test(href)) return;
      const b = fromLink($, el, href);
      if (b) out.push(b);
    }
  });
  out.forEach((b, i) => (b.index = i));
  return out;
}

function fromForm($: cheerio.CheerioAPI, el: Element, action: string): RawButton {
  const fields: Record<string, string> = {};
  const selectOptions: RawButton["selectOptions"] = {};
  const visibleInputs: string[] = [];
  $(el)
    .find("input[name], select[name], textarea[name]")
    .each((_, n) => {
      const f = $(n);
      const name = f.attr("name")!;
      const tag = (n as Element).tagName;
      if (tag === "select") {
        const opts = f
          .find("option")
          .map((_, o) => ({ value: $(o).attr("value") ?? $(o).text().trim(), text: $(o).text().trim() }))
          .get();
        selectOptions[name] = opts;
        const sel = f.find("option[selected]").attr("value");
        fields[name] = sel ?? opts[0]?.value ?? "";
        visibleInputs.push(name);
        return;
      }
      const type = (f.attr("type") ?? "text").toLowerCase();
      if (type === "image" || type === "submit") return;
      if (type !== "hidden") visibleInputs.push(name);
      fields[name] = f.attr("value") ?? "";
    });
  const img = $(el).find('input[type="image"], img[src*="btn"], button img').first();
  const imageSrc = img.attr("src") ?? null;
  const imageAlt = img.attr("alt") ?? $(el).find('input[type="submit"], button').first().text().trim() ?? null;
  return finish($, el, "form", fields, selectOptions, visibleInputs, imageSrc, imageAlt || null, action);
}

function fromLink($: cheerio.CheerioAPI, el: Element, href: string): RawButton | null {
  let url: URL;
  try {
    url = new URL(href.replace(/&amp;/g, "&"), "https://www.paypal.com/");
  } catch {
    return null;
  }
  const fields: Record<string, string> = {};
  url.searchParams.forEach((v, k) => (fields[k] = v));
  if (!fields.cmd) return null;
  const img = $(el).find("img").first();
  const imageSrc = img.attr("src") ?? null;
  const imageAlt = img.attr("alt") ?? ($(el).text().trim() || null);
  return finish($, el, "link", fields, {}, [], imageSrc, imageAlt, href);
}

function finish(
  $: cheerio.CheerioAPI,
  el: Element,
  element: "form" | "link",
  fields: Record<string, string>,
  selectOptions: RawButton["selectOptions"],
  visibleInputs: string[],
  imageSrc: string | null,
  imageAlt: string | null,
  target: string,
): RawButton {
  const cmd = fields.cmd ?? null;
  const { kind, affected, reason } = classify(fields, imageSrc, imageAlt);
  const html = $.html(el).replace(/\s+/g, " ").trim().slice(0, 4000);
  return {
    index: 0,
    element,
    kind,
    affected,
    reason,
    cmd,
    sandbox: /sandbox\.paypal\.com/i.test(target),
    fields,
    selectOptions,
    visibleInputs,
    imageSrc,
    imageAlt,
    html,
    context: contextFor($, el),
    fingerprint: fingerprint(fields),
  };
}

const imageHint = (src: string | null, alt: string | null) => `${src ?? ""} ${alt ?? ""}`.toLowerCase();

export function classify(
  fields: Record<string, string>,
  imageSrc: string | null,
  imageAlt: string | null,
): { kind: ButtonKind; affected: boolean; reason: string } {
  const cmd = (fields.cmd ?? "").toLowerCase();
  const hint = imageHint(imageSrc, imageAlt);
  switch (cmd) {
    case "_xclick":
      return { kind: "buy_now", affected: true, reason: "Buy Now button (cmd=_xclick). PayPal says it may stop working after January 1, 2027." };
    case "_cart":
      if (fields.display === "1")
        return { kind: "view_cart", affected: true, reason: "View Cart button. It may stop working after January 1, 2027. There is nothing to rebuild: remove it once the products use Payment Links." };
      if (fields.upload === "1")
        return { kind: "cart_upload", affected: true, reason: "Cart upload (cmd=_cart, upload=1). It may stop working after January 1, 2027." };
      return { kind: "add_to_cart", affected: true, reason: "Add to Cart button (cmd=_cart). PayPal says it may stop working after January 1, 2027." };
    case "_donations":
      return { kind: "donate", affected: false, reason: "Donate button. PayPal says Donate buttons are not affected, so we leave it alone." };
    case "_xclick-subscriptions":
    case "_xclick-auto-billing":
      return { kind: "subscribe", affected: false, reason: "Subscribe button. PayPal says Subscribe buttons are not affected, so we leave it alone." };
    case "_s-xclick": {
      if (/donat/.test(hint))
        return { kind: "donate", affected: false, reason: "Saved (hosted) button showing a Donate image. Donate buttons are not affected, so we leave it alone." };
      if (/subscri/.test(hint))
        return { kind: "subscribe", affected: false, reason: "Saved (hosted) button showing a Subscribe image. Subscribe buttons are not affected, so we leave it alone." };
      if (fields.encrypted)
        return { kind: "encrypted", affected: true, reason: "Encrypted button: its product and price are locked inside an encrypted blob, so we read them from the page around it. It may stop working after January 1, 2027." };
      return { kind: "hosted", affected: true, reason: "Saved (hosted) button: its product and price are stored at PayPal, not in the page, so we read them from the page around it. It may stop working after January 1, 2027." };
    }
    default:
      return { kind: "unknown", affected: false, reason: `PayPal form with an unrecognised command (${cmd || "none"}). Not changed; worth a manual look.` };
  }
}

export function fingerprint(f: Record<string, string>): string {
  return [f.cmd, f.hosted_button_id, f.item_name, f.amount, f.item_number, (f.encrypted ?? "").replace(/\s/g, "").slice(20, 60)]
    .map((x) => (x ?? "").trim())
    .join("|");
}

// Text around the button: the closest block with real text, the heading before it,
// and for table cells the whole row. This is what the AI gets to read.
function contextFor($: cheerio.CheerioAPI, el: Element): string {
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  let block: cheerio.Cheerio<AnyNode> = $(el);
  for (let i = 0; i < 5; i++) {
    const parent = block.parent();
    if (!parent.length || ["body", "html"].includes((parent.get(0) as Element).tagName)) break;
    block = parent;
    const tag = (block.get(0) as Element).tagName;
    if (tag === "td" || tag === "th") {
      block = block.closest("tr");
      break;
    }
    const ownText = clean(block.clone().find("form, script, style").remove().end().text());
    if (ownText.length >= 30) break;
  }
  const tag = (block.get(0) as Element)?.tagName;
  const blockText =
    tag === "tr"
      ? block
          .find("td, th")
          .map((_, c) => clean($(c).clone().find("form, script").remove().end().text()))
          .get()
          .filter(Boolean)
          .join(" | ")
      : clean(block.clone().find("script, style").remove().end().text());
  // Heading: one inside the block wins; otherwise the nearest preceding h1-h4.
  let heading = clean(block.find("h1, h2, h3, h4").first().text());
  if (!heading) {
    const all = $("h1, h2, h3, h4, " + tagSelector(block)).toArray();
    const blockNode = block.get(0);
    for (const n of all) {
      if (n === blockNode) break;
      if (/^h[1-4]$/.test((n as Element).tagName)) heading = clean($(n).text());
    }
  }
  // The button image's alt text sometimes names the product and price.
  const alt = clean($(el).find('input[type="image"], img').first().attr("alt") ?? "");
  const altUseful = alt && !/safer, easier way|^pay ?now$|^buy ?now$|^add to (cart|basket)$/i.test(alt) ? alt : "";
  // Table header row helps too.
  let header = "";
  if (tag === "tr") {
    header = clean(block.closest("table").find("tr").first().find("th").map((_, c) => $(c).text()).get().join(" | "));
  }
  return [heading && `Heading: ${heading}`, header && `Table columns: ${header}`, altUseful && `Button image text: ${altUseful}`, `Text: ${blockText}`]
    .filter(Boolean)
    .join("\n")
    .slice(0, 900);
}

function tagSelector(block: cheerio.Cheerio<AnyNode>): string {
  return (block.get(0) as Element)?.tagName ?? "div";
}
