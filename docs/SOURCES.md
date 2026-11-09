# Sources for the problem statement

Checked 2026-11-10. Quote PayPal's own wording, "may retire", rather than "will".

## PayPal

- **WPS deprecation notice**: https://developer.paypal.com/limited-release/multiparty/wps-deprecation/
  - "PayPal may retire WPS anytime after January 1, 2027."
  - Affects "Buy Now" and "Add to Cart" buttons. Donate and Subscribe buttons "will remain unaffected".
  - "Only critical security issues will be addressed."
- **PayPal Payments Standard (HTML buttons) docs**: https://developer.paypal.com/api/nvp-soap/paypal-payments-standard/web/
  - Marked deprecated: "should not be used for new integrations." It points to **Payment Links and Buttons** as the replacement.
- **Payment Links and Buttons API**: https://developer.paypal.com/api/payment-links-buttons (`POST /v1/checkout/payment-resources`)

## Vendors passing it on to their users

- **Gravity Forms**: https://docs.gravityforms.com/paypal-payments-standard-add-on-end-of-life/. Says WPS integrations will stop working after January 2027 and payments through the add-on will fail.
- **Timely**: https://help.gettimely.com/hc/en-gb/articles/42941175737239-PayPal-integration-ending-in-Timely. Says PayPal payments will stop processing from 1 January 2027.
- **nopCommerce forum**: https://www.nopcommerce.com/es/boards/topic/102732/sritical-paypal-changes. Announces the January 2026 WPS deprecation and notes that Donate and Subscribe are unaffected.
- **Energise (NZ agency) guide**: https://www.energise.co.nz/blog/paypal-buttons-retirement-2027/. Lists who is affected (old static and WordPress sites, single-button checkouts) and the `cgi-bin/webscr` and `cmd=_xclick` markers to look for.

We have not found a public count of affected sites, and we don't make one up.
