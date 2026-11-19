/**
 * Shared retailer-adapter contract.
 *
 * Product pages, cart pages, and order-confirmation pages can differ wildly
 * between retailers. The content script only relies on this small surface,
 * so an adapter can be exercised against the sandbox before its selectors are
 * replaced with Amazon selectors.
 */

var ZenBuyAdapterContract = (function () {
  const PAGE_KIND = Object.freeze({
    PRODUCT: 'PRODUCT',
    ORDER_CONFIRMATION: 'ORDER_CONFIRMATION',
    OTHER: 'OTHER'
  });

  const REQUIRED_METHODS = Object.freeze([
    'matches',
    'getPageKind',
    'scrapeProduct',
    'getPurchaseConfirmation',
    'getPriceElement',
    'getCartButtons',
    'injectIceButton',
    'getScarcityElements'
  ]);

  function validate(adapter) {
    const missing = REQUIRED_METHODS.filter(method => typeof adapter?.[method] !== 'function');
    return {
      valid: missing.length === 0 && typeof adapter?.name === 'string' && adapter.name.length > 0,
      missing
    };
  }

  return { PAGE_KIND, REQUIRED_METHODS, validate };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ZenBuyAdapterContract;
}
