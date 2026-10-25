/**
 * ZenBuy Amazon Platform Adapter
 * Handles scraping, native button injection, and scarcity element detection for Amazon.
 */

var AmazonAdapter = {
  name: 'amazon',

  matches(loc) {
    const host = (loc && loc.hostname) || (window.location && window.location.hostname) || '';
    return /amazon\.(com|co\.uk|de|fr|es|it|ca|co\.jp)/i.test(host);
  },

  scrapeProduct() {
    let title = '';
    let price = null;
    let image = '';
    let category = '';

    const amzTitle = document.querySelector('#productTitle') || document.querySelector('#title');
    if (amzTitle) {
      title = amzTitle.innerText.trim();
    }

    const amzPriceElem = document.querySelector('#corePrice_feature_div .a-offscreen') ||
                         document.querySelector('#corePriceDisplay_desktop_feature_div .a-offscreen') ||
                         document.querySelector('.priceToPay .a-offscreen') ||
                         document.querySelector('.apexPriceToPay .a-offscreen') ||
                         document.querySelector('#apex_desktop .a-offscreen') ||
                         document.querySelector('#priceblock_ourprice') ||
                         document.querySelector('#priceblock_dealprice') ||
                         document.querySelector('#price_inside_buybox') ||
                         document.querySelector('#newBuyBoxPrice') ||
                         document.querySelector('.a-price .a-offscreen') ||
                         document.querySelector('#corePrice_feature_div') ||
                         document.querySelector('.a-price');
    if (amzPriceElem) {
      const match = (amzPriceElem.innerText || amzPriceElem.textContent || '').replace(/,/g, '').match(/\$?([0-9]+\.?[0-9]*)/);
      price = match ? parseFloat(match[1]) : null;
    }

    const amzImg = document.querySelector('#landingImage') || document.querySelector('#imgBlkFront');
    if (amzImg) {
      image = amzImg.src;
    }

    const breadcrumb = document.querySelector('#wayfinding-breadcrumbs_feature_div');
    if (breadcrumb) {
      category = breadcrumb.innerText.replace(/\s+/g, ' ').trim();
    }

    return title && price ? { title, price, image, category } : null;
  },

  getPriceElement() {
    return document.querySelector('#corePrice_feature_div') ||
           document.querySelector('#corePriceDisplay_desktop_feature_div') ||
           document.querySelector('.priceToPay') ||
           document.querySelector('.apexPriceToPay') ||
           document.querySelector('#priceblock_ourprice') ||
           document.querySelector('#price_inside_buybox') ||
           document.querySelector('.a-price');
  },

  getCartButtons() {
    // 1. Specifically target primary buybox buttons (Add to Cart & Buy Now)
    const primarySelectors = [
      '#addToCart_feature_div #add-to-cart-button',
      '#desktop_qualifiedBuyBox #add-to-cart-button',
      '#desktop_buybox #add-to-cart-button',
      '#buybox #add-to-cart-button',
      '#add-to-cart-button',
      '#buyNow_feature_div #buy-now-button',
      '#desktop_qualifiedBuyBox #buy-now-button',
      '#desktop_buybox #buy-now-button',
      '#buy-now-button'
    ];

    const primaryElements = Array.from(document.querySelectorAll(primarySelectors.join(',')))
      .filter(el => el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0));

    if (primaryElements.length > 0) {
      // Ensure buy-now button is included so both are shadowed
      const buyNow = document.querySelector('#buyNow_feature_div #buy-now-button, #desktop_qualifiedBuyBox #buy-now-button, #buy-now-button');
      if (buyNow && !primaryElements.includes(buyNow)) {
        primaryElements.push(buyNow);
      }
      return primaryElements;
    }

    // 2. Buybox container inputs/buttons inside qualified buybox
    const buyboxContainers = document.querySelectorAll(
      '#addToCart_feature_div, #buyNow_feature_div, #desktop_qualifiedBuyBox, #desktop_buybox, #buybox'
    );
    for (const box of buyboxContainers) {
      const btns = Array.from(box.querySelectorAll('input[type="submit"], button'))
        .filter(el => el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0));
      if (btns.length > 0) return btns;
    }

    // 3. Fallbacks
    const fallbackSelectors = [
      'input[name="submit.add-to-cart"]',
      '#buybox-see-all-buying-choices',
      '#see-all-buying-choices'
    ];
    return Array.from(document.querySelectorAll(fallbackSelectors.join(',')))
      .filter(el => el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0));
  },

  /**
   * Injects the secondary button using Amazon's standard `.a-button` architecture
   * so it automatically inherits Amazon's native box-shadow, pill radius, and border.
   */
  injectIceButton(cartButton, { label, onClick }) {
    const existing = document.querySelector('.zenbuy-amazon-ice-wrapper');
    if (existing && existing.isConnected && existing.offsetParent !== null) {
      return existing.querySelector('.zenbuy-ice-btn');
    }
    if (existing) existing.remove();

    if (!cartButton || !cartButton.isConnected) return null;

    // Outer wrapper matching Amazon's secondary button stack
    const wrapper = document.createElement('span');
    wrapper.className = 'a-button a-button-base a-button-stack zenbuy-amazon-ice-wrapper';
    wrapper.style.display = 'block';
    wrapper.style.margin = '8px 0';
    wrapper.style.width = '100%';

    const inner = document.createElement('span');
    inner.className = 'a-button-inner';
    inner.style.borderRadius = '20px';
    inner.style.boxShadow = '0 2px 5px 0 rgba(213,217,217,.5)';
    inner.style.background = '#ffffff';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'a-button-text zenbuy-ice-btn zenbuy-amazon-btn';
    btn.textContent = label;
    btn.style.width = '100%';
    btn.style.height = '29px';
    btn.style.lineHeight = '29px';
    btn.style.fontSize = '13px';
    btn.style.fontWeight = '500';
    btn.style.textAlign = 'center';
    btn.style.color = '#0f1111';
    btn.style.background = 'transparent';
    btn.style.border = 'none';
    btn.style.cursor = 'pointer';

    btn.addEventListener('click', onClick);

    inner.appendChild(btn);
    wrapper.appendChild(inner);

    // Primary insertion target: after the Add to Cart button container
    const buttonSpan = cartButton.closest('.a-button') || cartButton.closest('.a-button-stack');
    const featureDiv = cartButton.closest('#addToCart_feature_div') || cartButton.closest('#addToCart');

    const target = buttonSpan || featureDiv || cartButton;
    if (target && target.parentElement) {
      target.insertAdjacentElement('afterend', wrapper);
      return btn;
    }

    // Secondary fallback: insert before Buy Now button or container
    const buyNow = document.querySelector('#buyNow_feature_div, #buy-now-button');
    if (buyNow && buyNow.parentElement) {
      buyNow.parentElement.insertBefore(wrapper, buyNow);
      return btn;
    }

    return null;
  },

  getScarcityElements() {
    const elements = [];
    // Target strictly the innermost leaf text spans (e.g. .a-color-price) within availability
    const candidateSpans = document.querySelectorAll(
      '#availability span, #availabilityInsideBuyBox_feature_div span, #availability .a-color-price'
    );

    candidateSpans.forEach(span => {
      // Must be a pure leaf node with short text specific to stock scarcity
      if (span.children.length === 0) {
        const txt = (span.innerText || span.textContent || '').trim();
        if (txt.length > 0 && txt.length < 80 && /only\s+\d+\s+left|order\s+soon|almost\s+gone/i.test(txt)) {
          // Guard against price, delivery or description elements
          if (!/\$|delivery|shipping|price/i.test(txt)) {
            elements.push(span);
          }
        }
      }
    });

    return elements;
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AmazonAdapter;
}
