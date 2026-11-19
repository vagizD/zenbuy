# Retailer adapter contract

Every retailer adapter exposes the methods listed in `contract.js`.

- `getPageKind()` returns `PRODUCT`, `ORDER_CONFIRMATION`, or `OTHER`.
- `scrapeProduct()` returns a product only on a product page. Use a stable `productId` when the retailer has one; Amazon uses its ASIN.
- `getPurchaseConfirmation()` returns `null` except on a confirmed order page, where it returns `{ confirmationId, source, purchases }`.

The confirmation identifier must be stable for a page reload. The vault lifecycle uses it to make confirmation recording idempotent. Cart and Buy Now actions are never confirmation evidence.

`sandbox.js` is the reference implementation and is exercised by the browser tests. An Amazon adapter should be changed atomically—one selector or extractor at a time—while keeping this same contract.
