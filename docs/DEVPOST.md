# Devpost draft: Last Button

**Title:** Last Button

**Tagline:** PayPal may retire its old copy-paste buttons after Jan 1, 2027. Paste your site's address: AI rebuilds every button as a PayPal Payment Link and a test buyer proves each one works.

**Built with:** paypal, paypal-payment-links, paypal-orders-api, paypal-webhooks, gemini, google-ai-studio, playwright, ag-grid, render, typescript, node.js, express, cheerio

**Links:**
- Live: https://last-button.onrender.com
- Repo: https://github.com/shivansh193/last-button
- Video: https://youtu.be/23sDp25akxE

---

## Inspiration

PayPal is retiring Website Payments Standard, the HTML Buy Now and Add to Cart buttons people pasted into their sites for twenty years. PayPal's notice says it "may retire WPS anytime after January 1, 2027", and that only critical security fixes happen until then. Plugin makers are already telling their users: Gravity Forms says payments through its PayPal Standard add-on will fail, and Timely says PayPal payments stop processing on 1 January 2027.

Nobody tells the people who pasted the button themselves:
- the community theatre selling tickets;
- the church taking bookings for a harvest supper;
- the potter with a "Buy Now" under each mug.

Many of those buttons are *saved* or *encrypted* PayPal buttons, so even a developer can't read the price from the page source. PayPal's recommended replacement is Payment Links and Buttons, but someone still has to rebuild every button by hand and hope they got the postage and tax right.

## What it does

You paste your website's address (or the HTML of a page).

1. **Finds every old PayPal button**: Buy Now, Add to Cart, saved and encrypted. It crawls up to 30 pages on the same site, respects robots.txt, and runs JavaScript where buttons are built by script. **Donate and Subscribe buttons are detected and left alone**, because PayPal says they aren't affected.
2. **Rebuilds each one as a PayPal Payment Link** with the same product, the same priced option menu (S/M/L $18, XL $21), the same postage (including "+$1 per extra item"), the same percentage tax, and the same adjustable quantity.
   - Readable fields are copied exactly.
   - For saved and encrypted buttons, **Gemini reads the page around the button** and proposes name, price and currency. Each value must come with a word-for-word quote from the page, and the server checks that quote is really there (and contains the number) before using it.
   - Every field shows where it came from: HTML, AI with its quote, default, or you.
   - Anything uncertain, and any price the AI found, waits for **one click** from the owner. Nothing is guessed silently.
3. **Proves each new link works.**
   - A Playwright test buyer pays through every new link in the PayPal sandbox, choosing the dearest option.
   - Last Button then reads the order back with **PayPal Orders v2** and checks it: completed, it's our link, the right option, and **paid = price + postage + tax**.
   - Only then does the row turn green in the AG Grid table. A mismatch turns it red with the reason.
   - The **PayPal webhook** `CHECKOUT.PAYMENT-RESOURCE.PAYMENT-COMPLETED` (signature verified) adds a third tick.
4. **Hands you the swap.** Pick whichever suits you:
   - a patched copy of each page;
   - a one-line `<script>` for your template;
   - a CSV of every link;
   - schema.org Product markup, so AI shopping agents can find a working checkout too.

## How we built it

- **PayPal Payment Links and Buttons API** (`POST /v1/checkout/payment-resources`): one link per product, with variant dimensions carrying per-option prices, `FLAT` shipping with `additional_unit_value`, `PERCENTAGE` taxes and `adjustable_quantity`.
- **PayPal Orders v2** (`GET /v2/checkout/orders/{id}`): the source of truth for verification. Our day-1 spike found that orders created by PayPal's hosted Payment Link page can be read with the merchant app's own credentials. They include the link ID as `item_id` and the buyer's option choice.
- **PayPal webhooks** with `verify-webhook-signature`.
- **Gemini** through Google AI Studio behind a small provider interface:
  - structured JSON output with a response schema;
  - validation with zod and one retry with the validation error;
  - automatic fallback to a second model on 429/503.
- **Playwright**: renders JS-built buttons during the scan, and runs the sandbox buyer bot.
- **AG Grid**: the migration table (old button / new spec with provenance badges / confidence / confirm / link / verified payment).
- **Express + TypeScript**, deployed on **Render** with headless Chromium.

## Eval

`npm run eval` scores the real scanner and reconstruction against hand-written ground truth on four fixture sites:
- the demo theatre;
- a WordPress-style shop;
- a church events table with saved buttons;
- a club page with JavaScript-injected buttons.

21 buttons, 17 affected:
- detection precision/recall 1.00/1.00;
- 4/4 Donate/Subscribe left alone;
- 119/119 fields correct;
- 6/6 hidden prices recovered from page text;
- 41% of buttons routed to the owner for a click;
- 0 wrong values that weren't flagged.

On the hosted demo, 7/7 new links were paid by the test buyer and matched to the cent.

The fixtures are small and I wrote them myself, so treat this as a regression test, not a benchmark.

## Challenges

- **Where to read the payment back.** Payment Links don't hand you an order ID. The spike showed three paths: the checkout URL's `token`, the return URL's `tx`, and the webhook. Orders v2 with our own credentials became the source of truth.
- **Rejected requests.** PayPal rejects a product-level price when the options carry prices, and rejects `http://localhost` return URLs. Both came out of the spike before any UI existed.
- **Tax rounding.** PayPal taxes the item price, not postage, and rounds half-up per cent. We reproduce that exactly, so a 1-cent difference would show as a mismatch.
- **Keeping the AI honest.** The demo's season-pass paragraph deliberately contains a decoy ("$64 if you bought single adult tickets") next to the real $54 price. Gemini picked $54 in our runs, but we don't rely on that. Requiring a verbatim quote, checking that it contains the number, and making every AI price wait for a human click mean a wrong pick can't reach a buyer unnoticed.
- **The sandbox occasionally shows "Things don't appear to be working".** The bot retries once, but only if no order was created yet.

## What's next

- Live mode with the owner's own PayPal app: same flow, real links.
- Owner email/PDF report.
- CMS plugins (WordPress) that apply the swap without touching files.
- Multi-item carts via Orders v2 + JS SDK for sites that genuinely need a basket.
