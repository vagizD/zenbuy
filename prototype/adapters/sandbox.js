/**
 * ZenBuy Sandbox Store Platform Adapter
 * Handles scraping, button injection, and urgency detection for the test store.
 */

var SandboxAdapter = {
  name: 'sandbox',

  matches(loc) {
    const path = (loc && loc.pathname) || (window.location && window.location.pathname) || '';
    const host = (loc && loc.hostname) || (window.location && window.location.hostname) || '';
    return path.includes('test-store') || document.querySelector('[data-zenbuy-title]') !== null;
  },

  scrapeProduct() {
    const testTitle = document.querySelector('[data-zenbuy-title]');
    const testPrice = document.querySelector('[data-zenbuy-price]');
    if (!testTitle || !testPrice) return null;

    const title = testTitle.innerText.trim();
    const priceText = testPrice.innerText || testPrice.getAttribute('data-zenbuy-price') || '';
    const match = priceText.replace(/,/g, '').match(/\$?([0-9]+\.?[0-9]*)/);
    const price = match ? parseFloat(match[1]) : null;
    const image = document.querySelector('[data-zenbuy-image]')?.src || '';
    const category = document.querySelector('[data-zenbuy-category]')?.innerText || '';

    return title && price ? { title, price, image, category } : null;
  },

  getPriceElement() {
    return document.querySelector('[data-zenbuy-price]');
  },

  getCartButtons() {
    const selectors = [
      '.zenbuy-add-to-cart',
      '[data-action="add-to-cart"]',
      '#btn-add-to-cart'
    ];
    return Array.from(document.querySelectorAll(selectors.join(',')));
  },

  injectIceButton(cartButton, { label, onClick }) {
    if (document.querySelector('.zenbuy-sandbox-ice-btn')) return null;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'zenbuy-ice-btn zenbuy-sandbox-ice-btn';
    btn.textContent = label;
    btn.style.width = '100%';
    btn.style.margin = '8px 0';
    btn.style.boxShadow = '0 2px 4px rgba(15, 23, 42, 0.08)';

    btn.addEventListener('click', onClick);

    if (cartButton && cartButton.parentElement) {
      cartButton.parentElement.insertBefore(btn, cartButton.nextSibling);
    }

    return btn;
  },

  getScarcityElements() {
    const elements = [];
    const banner = document.querySelector('.urgency-banner, #banner-urgency');
    if (banner) elements.push(banner);
    return elements;
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SandboxAdapter;
}
