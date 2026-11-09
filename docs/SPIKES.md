# Day-1 spikes (2026-11-10)

All runs used the PayPal **sandbox** with a US-region business app (Payment Links & Buttons enabled) and a US sandbox personal buyer. Raw outputs are in `runs/` (git-ignored).

## Spike 1: create a Payment Link with variants, shipping and tax ✅

`POST /v1/checkout/payment-resources` works. The token carries the `https://uri.paypal.com/services/checkout/payment-resources` scope.

| Link | Shape | Result |
|---|---|---|
| `PLB-X8KUQGNSMQPG` | T-shirt, `Size` dimension (Small $18, Medium $18, XL $21), flat shipping $4.50, 8.25% tax, collect address | 201, round-trips intact |
| `PLB-TJ365V4CU2X2` | Raffle ticket $2.00, `adjustable_quantity.maximum = 50` | 201 |

The API rejected two things on the first try:
- `UNIT_AMOUNT_PRODUCT_AND_VARIANT_CONFLICT`: when options carry their own `unit_amount`, the line item must **not** also set `unit_amount`.
- `INVALID_URL_FORMAT` on `return_url: http://localhost:3000/...`: the return URL must be public https.

Mapping consequences for WPS buttons:
- `option_select*` / `option_amount*` map to `variants.dimensions[].options[].unit_amount`.
- `shipping` maps to `shipping: [{type: FLAT, value, additional_unit_value}]`, so `shipping2` becomes `additional_unit_value`.
- `tax_rate` maps to `taxes: [{type: PERCENTAGE}]`.
- A WPS `quantity` field maps to `adjustable_quantity`.

**Tax is charged on the item price only, not on shipping.** XL: 21.00 + 4.50 + round(21.00 × 8.25%) = 21.00 + 4.50 + 1.73 = **27.23**. WPS `tax_rate` also applies to the item amount only, so the semantics match.

## Spike 2: buyer bot pays through the link ✅

`scripts/spike-2-buyer-bot.ts` (Playwright 1.64, headless Chromium) does the following:
1. Opens `https://www.sandbox.paypal.com/ncp/payment/PLB-…`.
2. Picks `XL` from the native `<select name="variant-dropdown-0">`. The page then shows $27.23.
3. Clicks the PayPal smart button (inside an iframe), which opens a popup.
4. Logs in as the sandbox buyer and clicks the pay button.

Result: the confirmation page reads "Thank you for your purchase of $27.23!" with "Size: XL" and transaction ID `8Y91309165665340T`. The whole run takes about 40 s.

Notes:
- The checkout popup URL carries the **Orders v2 order ID** as `?token=` (`89R51891XU0917509`), so we know it before payment.
- After payment the link page goes to `/ncp/payment/{PLB-id}/{orderId}`.
- `waitUntil: "networkidle"` never settles on the sandbox page; wait for `load` plus the select or iframe instead.
- The login form keeps a hidden `#btnNext` that is `type=submit`, so click `#btnLogin` explicitly once the spinner clears.
- `buyerCountry=IN` comes from the laptop's IP. The US buyer still paid in USD with no issue.

## Spike 3: how does the app learn about the payment?

| Path | Result |
|---|---|
| **Orders v2 `GET /v2/checkout/orders/{id}`** with our app credentials | ✅ **200, status `COMPLETED`**, amount 27.23 with breakdown item 21.00 / shipping 4.50 / tax 1.73, `items[0].item_id = PLB-X8KUQGNSMQPG`, `item_option_selections: [{Size: XL}]`, capture `8Y91309165665340T` COMPLETED. This works even though PayPal's own hosted page created the order. |
| `GET /v2/checkout/orders/{captureId}` | 404, as expected; the capture ID is not an order ID. |
| Transaction Search `/v1/reporting/transactions` | ❌ 403 `NOT_AUTHORIZED`. Not enabled on the app, and not needed. |
| **Webhook** (subscribed to `*` at `https://last-button.onrender.com/api/paypal/webhook`) | ✅ **`CHECKOUT.PAYMENT-RESOURCE.PAYMENT-COMPLETED`** arrived at our Render server **about 40 s** after payment. The resource carries `payment_resource_id` (PLB id), `transaction_id` (equals the capture ID), `gross_amount`, `amount_breakdown` (item / shipping / tax), `transaction_status`, and `items[].unit_amount` / `quantity`. No other event types were delivered to our app for this purchase. |
| **Return URL** | ✅ When `return_url` is reachable, the buyer lands on `…/thanks?cc=USD&amt=23.99&tx=<captureId>&st=COMPLETED`. Useful as a signal, but it is unsigned query text, so we never trust it alone. |

A second purchase (Medium, `9RL0367691893592J` / capture `2FC38010VG588450L`, $23.99 = 18.00 + 4.50 + 1.49) showed the same three IDs lining up across the order, the return URL and the webhook.

**Decision: three independent confirmations per verified link**
1. **Buyer bot**: Playwright pays and records the order ID (checkout `?token=`) and a screenshot of the confirmation.
2. **Orders v2 GET** (source of truth) checks:
   - `status == COMPLETED`;
   - `items[0].item_id == <our PLB id>`;
   - `item_option_selections` match the variant paid for;
   - `amount == unit + shipping + round(unit × tax%)`.
3. **Webhook**: `CHECKOUT.PAYMENT-RESOURCE.PAYMENT-COMPLETED` with a matching `payment_resource_id` and `transaction_id`. Signatures are verified with `POST /v1/notifications/verify-webhook-signature` (still to build).

A row goes green on 1 + 2. The webhook adds a third tick when it lands, usually within a minute. A wrong amount or variant turns the row red.

## Conclusion

Payment Links and Buttons is a viable target. **No need to fall back to Orders v2 + JS SDK buttons.** Everything a WPS Buy Now / Add to Cart button carries maps onto it:
- price;
- a priced option dropdown;
- flat shipping, with an extra-item amount;
- percentage tax;
- adjustable quantity;
- return URL.

Known gaps to handle in the mapper:
- **One dimension carries the price.** A WPS button with **two** priced option menus can't be expressed as two priced dimensions. Route it to owner confirmation.
- **A link is one product.** A WPS `_cart` button becomes a single-item Buy Now link, so the cart behaviour is lost. The change notes must say so plainly.
- **Currencies:** USD is verified. Others are unverified until tested.

## Environment notes

- Render service `last-button` (`srv-dbp1hluk1f9s73apf2d0`, free plan, Oregon): https://last-button.onrender.com. Auto-deploys from `main`.
- Webhook ID `3F855307RT0100206` is registered on the sandbox app.
- Playwright is pinned to 1.64.0 to match the locally installed Chromium 1248.
- Gemini: `gemini-3.5-flash` works with structured JSON output (`responseSchema`). `gemini-3.8-flash` was returning 503 (high demand) and `gemini-2.5-flash` is closed to new keys, so the provider falls back to `gemini-3.1-flash-lite`.
