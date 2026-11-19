/**
 * ZenBuy deterministic local-store adapter.
 *
 * The sandbox uses the same adapter surface as a retailer: product scraping,
 * purchase controls, scarcity detection, and an order-confirmation signal.
 * That lets its atomic operations be swapped for Amazon without rewriting
 * lifecycle or content-script behavior.
 */

var SandboxAdapter = {
  name: 'sandbox',

  matches(loc) {
    const documentAvailable = typeof document !== 'undefined';
    const platform = documentAvailable
      ? document.querySelector('[data-zenbuy-platform="sandbox"]')
      : null;
    const path = (loc && loc.pathname) || '';
    return Boolean(platform) || /\/test-store\//.test(path);
  },

  getPageKind() {
    const page = document.querySelector('[data-zenbuy-page]')?.getAttribute('data-zenbuy-page');
    if (page === 'product') return 'PRODUCT';
    if (page === 'confirmation') return 'ORDER_CONFIRMATION';
    return 'OTHER';
  },

  scrapeProduct() {
    if (this.getPageKind() !== 'PRODUCT') return null;

    const titleElement = document.querySelector('[data-zenbuy-title]');
    const priceElement = document.querySelector('[data-zenbuy-price]');
    if (!titleElement || !priceElement) return null;

    const title = (titleElement.innerText || titleElement.textContent || '').trim();
    const priceText = priceElement.innerText || priceElement.textContent || priceElement.getAttribute('data-zenbuy-price') || '';
    const priceMatch = priceText.replace(/,/g, '').match(/\$?([0-9]+\.?[0-9]*)/);
    const price = priceMatch ? parseFloat(priceMatch[1]) : null;
    const image = document.querySelector('[data-zenbuy-image]')?.src || '';
    const category = (document.querySelector('[data-zenbuy-category]')?.textContent || '').trim();
    const productId = priceElement.getAttribute('data-zenbuy-product-id') ||
      titleElement.getAttribute('data-zenbuy-product-id') || '';

    return title && Number.isFinite(price) ? {
      title,
      price,
      image,
      category,
      productId,
      url: window.location.href
    } : null;
  },

  getPriceElement() {
    return document.querySelector('[data-zenbuy-price]');
  },

  /**
   * A confirmation is the only sandbox event that should enter purchase
   * history. Cart pages and Buy Now buttons intentionally return null.
   */
  getPurchaseConfirmation() {
    if (this.getPageKind() !== 'ORDER_CONFIRMATION') return null;

    const confirmation = document.querySelector('[data-zenbuy-order-confirmation]');
    const confirmationId = confirmation?.getAttribute('data-zenbuy-confirmation-id') || '';
    if (!confirmation || !confirmationId) return null;

    const purchases = Array.from(document.querySelectorAll('[data-zenbuy-purchased-item]'))
      .map(element => {
        const title = element.getAttribute('data-zenbuy-title') ||
          element.querySelector('[data-zenbuy-purchased-title]')?.textContent || '';
        const productId = element.getAttribute('data-zenbuy-product-id') || '';
        const url = element.getAttribute('data-zenbuy-product-url') || '';
        return { title: title.trim(), productId, url };
      })
      .filter(purchase => purchase.title || purchase.productId || purchase.url);

    return purchases.length ? {
      confirmationId,
      source: 'SANDBOX_ORDER_CONFIRMATION',
      purchases
    } : null;
  },

  getCartButtons() {
    const selectors = [
      '.zenbuy-add-to-cart',
      '[data-action="add-to-cart"]',
      '#btn-add-to-cart',
      '[data-action="buy-now"]'
    ];
    return Array.from(document.querySelectorAll(selectors.join(',')));
  },

  injectIceButton(cartButton, { label, onClick }) {
    const existing = document.querySelector('.zenbuy-sandbox-ice-btn');
    if (existing) return existing;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'zenbuy-ice-btn zenbuy-sandbox-ice-btn';
    button.textContent = label;
    button.style.width = '100%';
    button.style.margin = '8px 0';
    button.style.boxShadow = '0 2px 4px rgba(15, 23, 42, 0.08)';
    button.addEventListener('click', onClick);

    if (cartButton?.parentElement) {
      cartButton.parentElement.insertBefore(button, cartButton.nextSibling);
      return button;
    }
    return null;
  },

  getScarcityElements() {
    return Array.from(document.querySelectorAll('.urgency-banner, #banner-urgency, #banner-stock'));
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SandboxAdapter;
}
