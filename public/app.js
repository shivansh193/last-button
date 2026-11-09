/* Last Button migration page: AG Grid of old buttons vs new PayPal Payment Links. */
const $ = (s) => document.querySelector(s);
const id = location.pathname.split("/").pop();
let M = null;
let grid = null;
let pollTimer = null;
let openRowId = null;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const sym = (c) => ({ USD: "$", GBP: "£", EUR: "€", CAD: "C$", AUD: "A$" })[c] ?? "";
const money = (v, c) => (v == null ? "—" : `${sym(c)}${v}${sym(c) ? "" : " " + (c ?? "")}`);

function toast(msg, err) {
  const t = document.createElement("div");
  t.className = "toast" + (err ? " err" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), err ? 6000 : 3000);
}

async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}

const KIND = {
  buy_now: ["Buy Now", "amber"],
  add_to_cart: ["Add to Cart", "amber"],
  view_cart: ["View Cart", "amber"],
  cart_upload: ["Cart upload", "amber"],
  hosted: ["Saved button", "amber"],
  encrypted: ["Encrypted button", "amber"],
  donate: ["Donate", "grey"],
  subscribe: ["Subscribe", "grey"],
  unknown: ["Unknown", "grey"],
};
const STATUS = {
  unaffected: ["Left alone", "grey"],
  needs_owner: ["Needs your OK", "amber"],
  ready: ["Ready for a link", "blue"],
  link_created: ["Link made, not verified", "blue"],
  verifying: ["Verifying…", "blue"],
  verified: ["Verified", "green"],
  mismatch: ["Mismatch", "red"],
  failed: ["Failed", "red"],
  not_migratable: ["Nothing to rebuild", "grey"],
};

function provBadge(field, row) {
  const p = field.prov;
  const needs = row.recon?.needsOwner?.includes(field._key);
  if (needs) return `<span class="pv owner" title="${esc(p.note || "Please check this")}">needs your OK</span>`;
  if (p.confirmed || p.source === "owner") return `<span class="pv yes" title="${esc(p.note || "Confirmed by you")}">confirmed</span>`;
  if (p.source === "html_field") return `<span class="pv html" title="From the old button's ${esc(p.field || "")} field">HTML</span>`;
  if (p.source === "page_context") return `<span class="pv ai" title="${esc(p.quote ? `Gemini quoted: "${p.quote}"` : p.note || "Read from the page")} · confidence ${Math.round(p.confidence * 100)}%">AI · page</span>`;
  if (p.source === "default") return `<span class="pv dflt" title="${esc(p.note || "")}">default</span>`;
  return `<span class="pv unk" title="${esc(p.note || "")}">unknown</span>`;
}

function withKeys(spec) {
  for (const k of Object.keys(spec)) spec[k]._key = k;
  return spec;
}

function specLines(row) {
  if (!row.recon) return row.button.affected ? `<span class="k">${esc(row.error || "Not rebuilt")}</span>` : `<span class="k">${esc(row.button.reason)}</span>`;
  const s = withKeys(row.recon.spec);
  const cur = s.currency.value;
  const line = (lbl, val, f) => `<div class="spec-line"><span class="lbl">${lbl}</span><span class="val">${val} ${provBadge(f, row)}</span></div>`;
  const out = [line("Name", esc(s.name.value ?? "?"), s.name), line("Price", `${esc(money(s.price.value, cur))} <span class="k">${esc(cur ?? "?")}</span>`, s.price)];
  if (s.variants.value?.options?.length)
    out.push(line(esc(s.variants.value.dimension), esc(s.variants.value.options.map((o) => `${o.label} ${o.price ? money(o.price, cur) : ""}`.trim()).join(" · ")), s.variants));
  else if (s.variants.prov.source !== "html_field") out.push(line("Options", "none", s.variants));
  out.push(line("Postage", s.shipping.value ? `${esc(money(s.shipping.value.first, cur))}${s.shipping.value.additional ? ` +${esc(money(s.shipping.value.additional, cur))}/extra` : ""}` : "none", s.shipping));
  out.push(line("Tax", s.taxPercent.value ? `${esc(s.taxPercent.value)}%` : "none", s.taxPercent));
  if (s.quantity.value?.adjustable) out.push(line("Qty", `buyer picks (≤${s.quantity.value.max})`, s.quantity));
  return `<div class="cell-stack">${out.join("")}</div>`;
}

function oldCell(row) {
  const b = row.button;
  const [label, tone] = KIND[b.kind] || KIND.unknown;
  const f = b.fields;
  const keys = ["item_name", "amount", "currency_code", "on0", "option_amount0", "option_amount1", "shipping", "shipping2", "tax_rate", "tax", "undefined_quantity", "quantity", "hosted_button_id", "a3", "t3"];
  const shown = keys.filter((k) => f[k] !== undefined && f[k] !== "").map((k) => `${k}=${esc(String(f[k]).slice(0, 40))}`);
  if (f.encrypted) shown.push("encrypted=<i>[locked]</i>");
  if (b.selectOptions?.os0?.length) shown.push(`os0=[${esc(b.selectOptions.os0.map((o) => o.value).join(", "))}]`);
  return `<div class="cell-stack"><div><span class="pill ${tone}">${label}</span>${b.jsInjected ? ' <span class="pill outline" title="Added to the page by JavaScript">JS</span>' : ""}</div><div class="old-fields">${shown.join(" ") || "<span class=k>no readable fields</span>"}</div></div>`;
}

function confidenceOf(row) {
  if (!row.recon) return null;
  const s = row.recon.spec;
  return Math.min(...["name", "price", "currency"].map((k) => (s[k].prov.confirmed || s[k].prov.source === "owner" ? 1 : s[k].prov.confidence)));
}

function confCell(row) {
  const c = confidenceOf(row);
  if (c == null) return "";
  const pct = Math.round(c * 100);
  const cls = c >= 0.8 ? "" : c >= 0.5 ? "mid" : "low";
  return `<div class="conf"><div class="conf-bar ${cls}"><i style="width:${pct}%"></i></div><span class="k">${pct}%</span></div>`;
}

function okCell(row) {
  if (!row.button.affected) return `<span class="k">Not affected</span>`;
  if (!row.recon) return "";
  if (row.status === "needs_owner")
    return `<div class="cell-stack"><button class="btn small" data-act="confirm" data-row="${row.button.id}">Confirm</button><button class="btn secondary small" data-act="edit" data-row="${row.button.id}">Edit</button></div>`;
  return `<div class="cell-stack"><span class="pill green"><span class="dot"></span> OK</span><button class="linkish" data-act="edit" data-row="${row.button.id}">edit</button></div>`;
}

function linkCell(row) {
  if (!row.link) return `<span class="k">—</span>`;
  return `<div class="cell-stack linkcell"><a href="${esc(row.link.url)}" target="_blank" rel="noopener">${esc(row.link.id)}</a><span class="k">sandbox Payment Link</span></div>`;
}

function verifCell(row) {
  const [label, tone] = STATUS[row.status] || ["?", "grey"];
  const v = row.verification;
  const spin = row.status === "verifying" ? '<span class="spin" style="width:10px;height:10px;border-width:2px"></span>' : '<span class="dot"></span>';
  let html = `<span class="pill ${tone}">${spin} ${label}</span>`;
  if (v) {
    if (v.orderId) html += `<span class="amt">order ${esc(v.orderId)}</span>`;
    if (v.paidTotal) html += `<span class="amt">paid ${esc(v.paidTotal)} · expected ${esc(v.expectedTotal)} ${v.paidTotal === v.expectedTotal ? "✓" : "✗"}</span>`;
    if (v.variant) html += `<span class="k">bought: ${esc(v.variant)}</span>`;
    if (v.webhook) html += `<span class="k">webhook received ✓</span>`;
    else if (v.ok) html += `<span class="k">webhook pending</span>`;
    if (!v.ok && v.problems?.length) html += `<span class="problems">${esc(v.problems[0])}</span>`;
  } else if (row.error && row.status !== "needs_owner") html += `<span class="problems">${esc(row.error)}</span>`;
  return `<div class="verif">${html}</div>`;
}

function columns() {
  const auto = { autoHeight: true, wrapText: true, sortable: false };
  return [
    { headerName: "Page", field: "button.pagePath", width: 124, ...auto, cellRenderer: (p) => `<span class="mono">${esc(p.value)}</span>` },
    { headerName: "Old button", minWidth: 230, flex: 1.1, ...auto, cellRenderer: (p) => oldCell(p.data) },
    { headerName: "New Payment Link (what we'll create)", minWidth: 320, flex: 1.6, ...auto, cellRenderer: (p) => specLines(p.data) },
    { headerName: "Confidence", width: 112, ...auto, cellRenderer: (p) => confCell(p.data), comparator: (a, b, na, nb) => (confidenceOf(na.data) ?? 2) - (confidenceOf(nb.data) ?? 2), sortable: true },
    { headerName: "Your OK", width: 118, ...auto, cellRenderer: (p) => okCell(p.data) },
    { headerName: "New link", width: 170, ...auto, cellRenderer: (p) => linkCell(p.data) },
    { headerName: "Verified payment", minWidth: 220, flex: 1, ...auto, cellRenderer: (p) => verifCell(p.data) },
  ];
}

function counts() {
  const r = M.rows;
  return {
    found: r.length,
    affected: r.filter((x) => x.button.affected).length,
    alone: r.filter((x) => !x.button.affected).length,
    owner: r.filter((x) => x.status === "needs_owner").length,
    ready: r.filter((x) => x.status === "ready").length,
    links: r.filter((x) => x.link).length,
    unverified: r.filter((x) => x.link && ["link_created", "failed", "mismatch"].includes(x.status)).length,
    verifying: r.filter((x) => x.status === "verifying").length,
    verified: r.filter((x) => x.status === "verified").length,
    mismatch: r.filter((x) => x.status === "mismatch").length,
  };
}

function render() {
  const c = counts();
  const input = M.scan.input;
  $("#scanned").textContent = input.kind === "url" ? input.url : input.label;
  $("#title").textContent = M.isDemo ? "Millbrook Players (demo site)" : "Your PayPal buttons";
  const pages = M.scan.pages.length;
  $("#subtitle").textContent = `${pages} page${pages === 1 ? "" : "s"} read${M.scan.pages.some((p) => p.rendered) ? ", JavaScript run where buttons are built by script" : ""}. ${c.affected} button${c.affected === 1 ? "" : "s"} may stop working after January 1, 2027.`;
  const tile = (n, l, cls = "") => `<div class="tile ${cls}"><b>${n}</b><span>${l}</span></div>`;
  $("#tiles").innerHTML = [
    tile(c.found, "buttons found"),
    tile(c.affected, "may stop working", c.affected ? "amber" : ""),
    tile(c.alone, "left alone"),
    tile(c.owner, "need your OK", c.owner ? "amber" : ""),
    tile(c.links, "links made"),
    tile(c.verified, "verified", c.verified ? "green" : ""),
  ].join("");

  let next;
  if (!c.found) next = "No PayPal buttons found on these pages. If your buttons are on another page, scan that page's address directly.";
  else if (!c.affected) next = "Nothing here is affected. Donate and Subscribe buttons keep working.";
  else if (c.owner) next = `<b>Step 1:</b> check ${c.owner} button${c.owner > 1 ? "s" : ""} marked <span class="pv owner">needs your OK</span>. We rebuilt them from your page text, so a person should look before anyone is charged.`;
  else if (c.ready) next = `<b>Step 2:</b> create ${c.ready} PayPal Payment Link${c.ready > 1 ? "s" : ""} (sandbox).`;
  else if (c.verifying) next = `<b>Verifying:</b> a test buyer is paying through each link (about 30 seconds each). Rows turn green when PayPal confirms the order and the amount matches.`;
  else if (c.unverified) next = `<b>Step 3:</b> prove ${c.unverified} link${c.unverified > 1 ? "s" : ""} work: a test buyer pays through each one and we check the order with PayPal.`;
  else if (c.verified) next = `<b>Done.</b> ${c.verified} of ${c.links} links verified with a real sandbox payment${c.mismatch ? `, ${c.mismatch} mismatch` : ""}. Swap them in below.`;
  else next = "";
  $("#next-step").innerHTML = next;

  $("#confirm-all").hidden = c.owner < 2;
  $("#make-links").disabled = !c.ready;
  $("#make-links").hidden = !c.ready && c.links > 0;
  $("#verify").hidden = !c.links || (!c.unverified && !c.verifying);
  $("#make-links").textContent = c.ready ? `Create ${c.ready} Payment Link${c.ready > 1 ? "s" : ""}` : "Create Payment Links";
  $("#verify").disabled = !c.unverified || c.verifying > 0;
  $("#verify").innerHTML = c.verifying ? `<span class="spin"></span> Verifying ${c.verifying}…` : c.unverified ? `Verify ${c.unverified} link${c.unverified > 1 ? "s" : ""}` : "Run verification";

  if (!grid) {
    grid = agGrid.createGrid($("#grid"), {
      columnDefs: columns(),
      rowData: M.rows,
      getRowId: (p) => p.data.button.id,
      getRowClass: (p) => (p.data.button.affected ? "" : "row-unaffected"),
      suppressCellFocus: true,
      domLayout: "autoHeight",
      onRowClicked: (e) => {
        if (e.event?.target?.closest("[data-act]")) return;
        openDrawer(e.data.button.id);
      },
    });
    // Row heights depend on web fonts; measure again once they have loaded.
    document.fonts?.ready.then(() => grid.resetRowHeights());
    setTimeout(() => grid.resetRowHeights(), 600);
  } else {
    grid.setGridOption("rowData", M.rows);
    requestAnimationFrame(() => grid.resetRowHeights());
  }

  renderOutputs(c);
  if (openRowId) openDrawer(openRowId, true);
  clearTimeout(pollTimer);
  if (c.verifying || M.queue) pollTimer = setTimeout(load, 3000);
}


function renderOutputs(c) {
  $("#outputs").hidden = !c.links;
  if (!c.links) return;
  const pages = [...new Set(M.rows.filter((r) => r.link).map((r) => r.button.pagePath))];
  $("#patched-list").innerHTML = pages
    .map((p) => {
      const n = M.rows.filter((r) => r.link && r.button.pagePath === p).length;
      const js = M.rows.filter((r) => r.link && r.button.pagePath === p && r.button.jsInjected).length;
      return `<a href="/api/m/${id}/patched?page=${encodeURIComponent(p)}">Download ${esc(p)} (${n} button${n > 1 ? "s" : ""})</a>${js ? `<span class="k">${js} built by JavaScript: use the script instead</span>` : ""}`;
    })
    .join("");
  $("#swap-line").textContent = `<script src="${location.origin}/api/m/${id}/swap.js" defer></script>`;
  $("#csv").href = `/api/m/${id}/export.csv`;
  $("#json").href = `/api/m/${id}/export.json`;
}

function plain(k, v) {
  if (v == null) return "none";
  if (k === "shipping") return `${v.first}${v.additional ? `, then ${v.additional} per extra item` : ""}`;
  if (k === "quantity") return v.adjustable ? `buyer picks, up to ${v.max}` : "1 per purchase";
  if (k === "variants") return `${v.dimension}: ${v.options.map((o) => `${o.label}${o.price ? ` ${o.price}` : ""}`).join(", ")}`;
  if (k === "taxPercent") return `${v}%`;
  return String(v);
}

function openDrawer(rowId, refresh) {
  const row = M.rows.find((r) => r.button.id === rowId);
  if (!row) return;
  openRowId = rowId;
  const b = row.button;
  const s = row.recon?.spec;
  const [label] = KIND[b.kind] || KIND.unknown;
  let h = `<span class="pill ${(STATUS[row.status] || ["", "grey"])[1]}">${(STATUS[row.status] || [row.status])[0]}</span>
    <h2>${esc(s?.name.value || b.fields.item_name || label)}</h2>
    <p class="sub">${esc(label)} on <span class="mono">${esc(b.pagePath)}</span>. ${esc(b.reason)}</p>`;
  if (row.recon?.notes?.length) h += `<h3>What changes</h3><ul>${row.recon.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`;
  if (s) {
    withKeys(s);
    const rows = ["name", "price", "currency", "variants", "shipping", "taxPercent", "quantity", "returnUrl"].map((k) => {
      const f = s[k];
      const val = plain(k, f.value);
      const where = f.prov.source === "page_context" && f.prov.quote ? `<span class="quote">“${esc(f.prov.quote)}”</span>` : esc(f.prov.field || f.prov.note || "");
      return `<tr><td><b>${k}</b></td><td class="mono">${esc(val)}</td><td>${provBadge(f, row)}<br>${where}</td></tr>`;
    });
    h += `<h3>Where each value came from</h3><table><tr><th>Field</th><th>Value</th><th>Source</th></tr>${rows.join("")}</table>`;
    if (row.recon.usedAI) h += `<p class="k" style="margin-top:6px">Gaps filled by ${esc(row.recon.aiModel || "AI")}. Values without a quote found on the page are thrown away.</p>`;
    if (row.recon.aiError) h += `<p class="k">AI unavailable: ${esc(row.recon.aiError)}</p>`;
  }
  if (row.diff?.length) h += `<h3>Old vs new</h3><table><tr><th>Field</th><th>Old button</th><th>New link</th></tr>${row.diff.map((d) => `<tr><td>${esc(d.field)}</td><td class="mono">${esc(d.old)}</td><td class="mono">${esc(d.new)}</td></tr>`).join("")}</table>`;
  if (row.link) h += `<h3>New link</h3><p><a href="${esc(row.link.url)}" target="_blank" rel="noopener">${esc(row.link.url)}</a></p>`;
  const v = row.verification;
  if (v) {
    h += `<h3>Verification</h3><table>
      <tr><td>Result</td><td>${v.ok ? '<span class="pill green">payment matched</span>' : '<span class="pill red">problem</span>'}</td></tr>
      <tr><td>Bought</td><td>${esc(v.variant || "the product")} × ${v.quantity}</td></tr>
      <tr><td>Expected</td><td class="mono">${esc(v.expectedTotal)}</td></tr>
      <tr><td>Paid (from PayPal)</td><td class="mono">${esc(v.paidTotal ?? "—")}</td></tr>
      <tr><td>Order</td><td class="mono">${esc(v.orderId ?? "—")} · ${esc(v.orderStatus ?? "")}</td></tr>
      <tr><td>Capture</td><td class="mono">${esc(v.captureId ?? "—")}</td></tr>
      <tr><td>Order's link / option</td><td class="mono">${esc(v.linkIdOnOrder ?? "—")} / ${esc(v.variantOnOrder ?? "—")}</td></tr>
      <tr><td>Webhook</td><td>${v.webhook ? `received ${esc(v.webhook.at.slice(11, 19))} UTC` : "not yet"}</td></tr>
      <tr><td>Took</td><td>${Math.round(v.durationMs / 1000)} s</td></tr></table>`;
    if (v.problems?.length) h += `<ul>${v.problems.map((p) => `<li style="color:var(--red)">${esc(p)}</li>`).join("")}</ul>`;
    if (v.screenshot) h += `<img class="shot" src="/screens/${encodeURIComponent(v.screenshot)}" alt="PayPal sandbox confirmation page after the test payment" loading="lazy" />`;
  }
  h += `<h3>Old button code</h3><pre class="code">${esc(b.html)}</pre>`;
  if (b.context) h += `<h3>Page text the AI could read</h3><pre class="code">${esc(b.context)}</pre>`;
  $("#drawer-body").innerHTML = h;
  const d = $("#drawer");
  d.classList.add("open");
  d.setAttribute("aria-hidden", "false");
}
$("#drawer-close").onclick = () => {
  openRowId = null;
  $("#drawer").classList.remove("open");
  $("#drawer").setAttribute("aria-hidden", "true");
};
document.addEventListener("keydown", (e) => e.key === "Escape" && $("#drawer-close").click());

// ---- actions ----
document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-act]");
  if (t) {
    e.stopPropagation();
    const rowId = t.dataset.row;
    if (t.dataset.act === "confirm") {
      t.disabled = true;
      try {
        M = await api(`/api/m/${id}/rows/${rowId}/confirm`, {});
        render();
      } catch (err) {
        toast(err.message, true);
        t.disabled = false;
      }
    } else if (t.dataset.act === "edit") openEdit(rowId);
  }
  const cp = e.target.closest("[data-copy]");
  if (cp) {
    await navigator.clipboard.writeText($("#" + cp.dataset.copy).textContent).catch(() => {});
    toast("Copied");
  }
});

$("#confirm-all").onclick = async () => {
  const ids = M.rows.filter((r) => r.status === "needs_owner").map((r) => r.button.id);
  for (const r of ids) M = await api(`/api/m/${id}/rows/${r}/confirm`, {}).catch((e) => (toast(e.message, true), M));
  render();
};
$("#make-links").onclick = async () => {
  const b = $("#make-links");
  b.disabled = true;
  b.innerHTML = '<span class="spin"></span> Creating…';
  try {
    M = await api(`/api/m/${id}/links`, {});
    const failed = M.rows.filter((r) => r.status === "failed" && !r.verification).length;
    toast(failed ? `${failed} link(s) failed: see the table` : "Payment Links created in the PayPal sandbox", !!failed);
  } catch (e) {
    toast(e.message, true);
  }
  render();
};
$("#verify").onclick = async () => {
  try {
    M = await api(`/api/m/${id}/verify`, {});
    toast("Verification queued. A test buyer is paying through each link.");
  } catch (e) {
    toast(e.message, true);
  }
  render();
};
$("#jsonld-btn").onclick = async () => {
  const pre = $("#jsonld");
  pre.textContent = await (await fetch(`/api/m/${id}/jsonld`)).text();
  pre.hidden = false;
};

// ---- edit dialog ----
function openEdit(rowId) {
  const row = M.rows.find((r) => r.button.id === rowId);
  const s = row.recon.spec;
  const needs = new Set(row.recon.needsOwner);
  $("#edit-sub").textContent = `${(KIND[row.button.kind] || KIND.unknown)[0]} on ${row.button.pagePath}. Fields marked in amber are the ones we weren't sure about.`;
  const v = s.variants.value;
  const fld = (key, label, value, hint, wide) =>
    `<label class="${wide ? "wide" : ""}">${label}${hint ? ` <span class="hint">${hint}</span>` : ""}<input name="${key}" value="${esc(value ?? "")}" class="${needs.has(key.split(".")[0]) ? "flag" : ""}" /></label>`;
  $("#edit-fields").innerHTML = [
    fld("name", "Product name", s.name.value, "", true),
    fld("price", "Price", s.price.value, "e.g. 18.00"),
    fld("currency", "Currency", s.currency.value, "USD, GBP…"),
    fld("shipping.first", "Postage", s.shipping.value?.first, "blank = none"),
    fld("shipping.additional", "Postage per extra item", s.shipping.value?.additional, "optional"),
    fld("taxPercent", "Tax %", s.taxPercent.value, "blank = none"),
    fld("variants.dimension", "Option name", v?.dimension, "e.g. Size"),
    fld("variants.options", "Options", v?.options.map((o) => (o.price ? `${o.label}=${o.price}` : o.label)).join(", "), "Small=18.00, XL=21.00", true),
  ].join("");
  const dlg = $("#edit");
  dlg.dataset.row = rowId;
  dlg.showModal();
}
$("#edit-form").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "save") return;
  e.preventDefault();
  const rowId = $("#edit").dataset.row;
  const row = M.rows.find((r) => r.button.id === rowId);
  const s = row.recon.spec;
  const val = (n) => $("#edit-fields").querySelector(`[name="${n}"]`).value.trim();
  const edits = {};
  const changed = (k, nv) => JSON.stringify(nv) !== JSON.stringify(s[k].value) && (edits[k] = nv);
  changed("name", val("name") || null);
  changed("price", val("price") ? Number(val("price")).toFixed(2) : null);
  changed("currency", val("currency").toUpperCase() || null);
  changed("taxPercent", val("taxPercent") || null);
  const ship = val("shipping.first") ? { first: Number(val("shipping.first")).toFixed(2), additional: val("shipping.additional") ? Number(val("shipping.additional")).toFixed(2) : null } : null;
  changed("shipping", ship);
  const opts = val("variants.options")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const [label, price] = x.split("=").map((y) => y.trim());
      return { label, price: price ? Number(price).toFixed(2) : null };
    });
  changed("variants", opts.length ? { dimension: val("variants.dimension") || "Option", options: opts } : null);
  try {
    M = await api(`/api/m/${id}/rows/${rowId}/confirm`, { edits });
    $("#edit").close();
    render();
  } catch (err) {
    toast(err.message, true);
  }
});

async function load() {
  try {
    M = await api(`/api/m/${id}`);
    render();
  } catch (e) {
    $("#scanned").textContent = "";
    $("#title").textContent = "Not found";
    $("#subtitle").textContent = e.message;
  }
}
load();
