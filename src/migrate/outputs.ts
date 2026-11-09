// Outputs for the owner: patched HTML, a one-line runtime swap script, CSV/JSON export.
import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { detectButtons } from "../scan/detect.js";
import type { Migration, MigrationRow } from "../types.js";

const BTN_STYLE =
  "display:inline-block;background:#ffc439;color:#111;font:600 15px/1 Helvetica,Arial,sans-serif;padding:11px 22px;border-radius:22px;text-decoration:none;border:0";

export function buttonLabel(row: MigrationRow) {
  return row.button.kind === "add_to_cart" ? "Buy with PayPal" : "Pay with PayPal";
}

export function replacementHtml(row: MigrationRow): string {
  const url = row.link!.url;
  const name = (row.recon?.spec.name.value ?? "").replace(/"/g, "&quot;");
  return `<a class="last-button-paypal" href="${url}" target="_blank" rel="noopener" title="${name}" style="${BTN_STYLE}">${buttonLabel(row)}</a>`;
}

/** Replace each migrated button in this page's HTML, matched by document order. */
export function patchHtml(html: string, rows: MigrationRow[]): { html: string; replaced: number } {
  const byIndex = new Map(rows.filter((r) => r.link).map((r) => [r.button.index, r]));
  const $ = cheerio.load(html);
  const detected = detectButtons(html);
  let i = 0;
  let replaced = 0;
  $("form, a[href]").each((_, node) => {
    const el = node as Element;
    const target = el.tagName === "form" ? $(el).attr("action") ?? "" : $(el).attr("href") ?? "";
    if (!/paypal\.com\/cgi-bin\/webscr/i.test(target)) return;
    const d = detected[i];
    const row = byIndex.get(i);
    i++;
    // Only replace when the fingerprint still matches (the page may have changed since the scan).
    if (row && d && d.fingerprint === row.button.fingerprint) {
      $(el).replaceWith(`<!-- Last Button: replaced a legacy PayPal ${row.button.kind.replace(/_/g, " ")} button -->\n${replacementHtml(row)}`);
      replaced++;
    }
  });
  return { html: $.html(), replaced };
}

/** A script the owner can paste once into their template; it swaps buttons in the browser. */
export function swapScript(m: Migration): string {
  const map: Record<string, string> = {};
  for (const r of m.rows) if (r.link) map[r.button.fingerprint] = r.link.url;
  return `/* Last Button runtime swap for migration ${m.id}. Replaces legacy PayPal buttons with Payment Links. */
(function () {
  var MAP = ${JSON.stringify(map)};
  var STYLE = ${JSON.stringify(BTN_STYLE)};
  function fp(f) {
    var enc = (f.encrypted || "").replace(/\\s/g, "").slice(20, 60);
    return [f.cmd, f.hosted_button_id, f.item_name, f.amount, f.item_number, enc].map(function (x) { return (x || "").trim(); }).join("|");
  }
  function swap() {
    var nodes = document.querySelectorAll('form[action*="cgi-bin/webscr"], a[href*="cgi-bin/webscr"]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i], f = {};
      if (el.tagName === "FORM") {
        var ins = el.querySelectorAll("input[name]");
        for (var j = 0; j < ins.length; j++) if (ins[j].type !== "image" && ins[j].type !== "submit") f[ins[j].name] = ins[j].value;
      } else {
        try { new URL(el.href).searchParams.forEach(function (v, k) { f[k] = v; }); } catch (e) {}
      }
      var url = MAP[fp(f)];
      if (!url) continue;
      var a = document.createElement("a");
      a.href = url; a.target = "_blank"; a.rel = "noopener";
      a.className = "last-button-paypal"; a.setAttribute("style", STYLE);
      a.textContent = f.cmd === "_cart" ? "Buy with PayPal" : "Pay with PayPal";
      el.parentNode.replaceChild(a, el);
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", swap); else swap();
})();
`;
}

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function exportRows(m: Migration) {
  return m.rows.map((r) => {
    const s = r.recon?.spec;
    return {
      page: r.button.pagePath,
      old_type: r.button.kind,
      affected: r.button.affected,
      reason: r.button.reason,
      name: s?.name.value ?? "",
      price: s?.price.value ?? "",
      currency: s?.currency.value ?? "",
      variants: s?.variants.value ? `${s.variants.value.dimension}: ${s.variants.value.options.map((o) => `${o.label}${o.price ? ` ${o.price}` : ""}`).join(", ")}` : "",
      shipping: s?.shipping.value ? `${s.shipping.value.first}${s.shipping.value.additional ? ` (+${s.shipping.value.additional} each extra)` : ""}` : "",
      tax_percent: s?.taxPercent.value ?? "",
      status: r.status,
      link_id: r.link?.id ?? "",
      link_url: r.link?.url ?? "",
      verified_order_id: r.verification?.orderId ?? "",
      paid_total: r.verification?.paidTotal ?? "",
      expected_total: r.verification?.expectedTotal ?? "",
    };
  });
}

export function toCsv(m: Migration): string {
  const rows = exportRows(m);
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell((r as any)[c])).join(","))].join("\n") + "\n";
}

/** JSON-LD Product/Offer markup so AI shopping agents can find the new links. */
export function jsonLd(m: Migration): string {
  const offers = m.rows
    .filter((r) => r.link && r.recon)
    .map((r) => {
      const s = r.recon!.spec;
      return {
        "@context": "https://schema.org",
        "@type": "Product",
        name: s.name.value,
        offers: (s.variants.value?.options.length ? s.variants.value.options : [{ label: null, price: s.price.value }]).map((o) => ({
          "@type": "Offer",
          ...(o.label ? { name: `${s.name.value} - ${o.label}` } : {}),
          price: o.price ?? s.price.value,
          priceCurrency: s.currency.value,
          url: r.link!.url,
          availability: "https://schema.org/InStock",
        })),
      };
    });
  return `<script type="application/ld+json">\n${JSON.stringify(offers.length === 1 ? offers[0] : offers, null, 2)}\n</script>`;
}
