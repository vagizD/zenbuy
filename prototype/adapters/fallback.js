/**
 * ZenBuy Fallback Generic E-Commerce Platform Adapter
 * Handles generic Shopify, WooCommerce, Schema.org, and OpenGraph pages.
 */

var FallbackAdapter = {
  name: 'fallback',

  matches() {
    return true; // Catch-all fallback
  },

  scrapeProduct() {
    let title = '';
    let price = null;
    let image = '';
    let category = '';

    // 1. Check Schema.org JSON-LD or microdata
    const schemaScript = document.querySelector('script[type="application/ld+json"]');
    if (schemaScript) {
      try {
        const json = JSON.parse(schemaScript.textContent);
        const product = json['@type'] === 'Product' ? json : (json['@graph']?.find(i => i['@type'] === 'Product'));
        if (product) {
          title = product.name || '';
          image = Array.isArray(product.image) ? product.image[0] : (product.image || '');
          const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers;
          if (offers && offers.price) {
            price = parseFloat(offers.price);
          }
          category = product.category || '';
        }
      } catch (e) {
        // Fall through to DOM meta tags
      }
    }

    // 2. OpenGraph / Meta tags
    if (!title) {
      const ogTitle = document.querySelector('meta[property="og:title"]') || document.querySelector('meta[name="twitter:title"]');
      if (ogTitle) title = ogTitle.getAttribute('content') || '';
    }

    if (!price) {
      const metaPrice = document.querySelector('meta[property="product:price:amount"]') ||
                        document.querySelector('meta[itemprop="price"]');
      if (metaPrice) {
        price = parseFloat(metaPrice.getAttribute('content'));
      }
    }

    if (!image) {
      const ogImg = document.querySelector('meta[property="og:image"]');
      if (ogImg) image = ogImg.getAttribute('content') || '';
    }

    // 3. Common DOM Headings
    if (!title) {
      const h1 = document.querySelector('h1.product-title, h1.product__title, h1');
      if (h1) title = h1.innerText.trim();
    }

    return title && price ? { title, price, image, category } : null;
  },

  getPriceElement() {
    return document.querySelector('.price, .product-price, [data-product-price], .current-price, .price-item');
  },

  getCartButtons() {
    const selectors = [
      'button[name="add"]',
      'button[type="submit"].add-to-cart',
      '.single_add_to_cart_button',
      '#add-to-cart',
      '.btn-add-to-cart',
      '[data-action="add-to-cart"]'
    ];
    return Array.from(document.querySelectorAll(selectors.join(',')));
  },

  injectIceButton(cartButton, { label, onClick }) {
    if (document.querySelector('.zenbuy-fallback-ice-btn')) return null;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'zenbuy-ice-btn zenbuy-fallback-ice-btn';
    btn.textContent = label;
    btn.style.width = '100%';
    btn.style.margin = '8px 0';
    btn.style.boxShadow = '0 2px 5px rgba(0, 0, 0, 0.08)';

    btn.addEventListener('click', onClick);

    if (cartButton && cartButton.parentElement) {
      cartButton.parentElement.insertBefore(btn, cartButton.nextSibling);
    }

    return btn;
  },

  getScarcityElements() {
    const elements = [];
    const candidateTags = ['span', 'div', 'p', 'b', 'strong'];
    candidateTags.forEach(tag => {
      document.querySelectorAll(tag).forEach(el => {
        if (el.children.length <= 1 && !el.closest('.zenbuy-neutralized-tag') && !el.closest('.zenbuy-modal-card')) {
          const txt = el.textContent || '';
          if (/only\s+\d+\s+left|almost\s+gone|limited\s+stock/i.test(txt)) {
            elements.push(el);
          }
        }
      });
    });
    return elements;
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = FallbackAdapter;
}
