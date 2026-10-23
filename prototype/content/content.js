/**
 * ZenBuy Content Script
 * Scrapes product data, evaluates IRS, and injects clean UI elements.
 */

(function () {
  let isIntercepted = false;
  let pageLoadTime = Date.now();
  let currentProduct = null;
  let currentEvaluation = null;

  function parsePrice(text) {
    if (!text) return null;
    const match = text.replace(/,/g, '').match(/\$?([0-9]+\.?[0-9]*)/);
    return match ? parseFloat(match[1]) : null;
  }

  function scrapeProduct() {
    let title = '';
    let price = null;
    let image = '';
    let category = '';

    // Test store selectors
    const testTitle = document.querySelector('[data-zenbuy-title]');
    const testPrice = document.querySelector('[data-zenbuy-price]');
    if (testTitle && testPrice) {
      title = testTitle.innerText.trim();
      price = parsePrice(testPrice.innerText || testPrice.getAttribute('data-zenbuy-price'));
      image = document.querySelector('[data-zenbuy-image]')?.src || '';
      category = document.querySelector('[data-zenbuy-category]')?.innerText || '';
      return { title, price, image, category };
    }

    // Amazon selectors
    const amzTitle = document.querySelector('#productTitle') || document.querySelector('#title');
    if (amzTitle) {
      title = amzTitle.innerText.trim();
      const amzPriceElem = document.querySelector('#corePrice_feature_div .a-offscreen') ||
                           document.querySelector('#priceblock_ourprice') ||
                           document.querySelector('#priceblock_dealprice') ||
                           document.querySelector('.a-price .a-offscreen');
      if (amzPriceElem) {
        price = parsePrice(amzPriceElem.innerText);
      }
      const amzImg = document.querySelector('#landingImage') || document.querySelector('#imgBlkFront');
      if (amzImg) {
        image = amzImg.src;
      }
      const breadcrumb = document.querySelector('#wayfinding-breadcrumbs_feature_div');
      if (breadcrumb) {
        category = breadcrumb.innerText.replace(/\s+/g, ' ').trim();
      }
      return { title, price, image, category };
    }

    // Generic schema.org or OpenGraph selectors
    const metaPrice = document.querySelector('meta[property="product:price:amount"]') ||
                      document.querySelector('meta[itemprop="price"]');
    const h1Title = document.querySelector('h1');
    if (metaPrice && h1Title) {
      title = h1Title.innerText.trim();
      price = parsePrice(metaPrice.getAttribute('content'));
      return { title, price, image, category };
    }

    return null;
  }

  function detectDarkPatterns() {
    const text = document.body ? document.body.innerText : '';
    const deceptiveUrgency = /deal expires|ends in [0-9]+|countdown/i.test(text) ||
                             Boolean(document.querySelector('.countdown, #timer, [data-countdown]'));
    const lowStockAmbiguity = /only [0-9] left in stock|almost gone|limited quantity/i.test(text);
    const fabricatedSocialProof = /people bought this in the last|in high demand/i.test(text);
    const preselection = Boolean(document.querySelector('input[type="checkbox"][checked]:not([disabled])'));

    return {
      deceptiveUrgency,
      lowStockAmbiguity,
      fabricatedSocialProof,
      preselection
    };
  }

  function injectWageBadge(priceElement, hoursOfWork) {
    if (document.querySelector('.zenbuy-wage-badge')) return;
    const badge = document.createElement('div');
    badge.className = 'zenbuy-wage-badge';
    badge.textContent = `${hoursOfWork} hours of labor`;

    if (priceElement && priceElement.parentElement) {
      priceElement.parentElement.appendChild(badge);
    }
  }

  function injectIceButton(cartButton) {
    if (document.querySelector('.zenbuy-ice-btn')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'zenbuy-ice-btn';
    btn.textContent = 'Put on Ice (48h)';

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      btn.disabled = true;
      btn.textContent = 'Saving to vault...';

      await chrome.runtime.sendMessage({
        type: 'SAVE_TO_VAULT',
        payload: {
          title: currentProduct.title,
          price: currentProduct.price,
          url: window.location.href,
          imageUrl: currentProduct.image,
          hoursOfWork: currentEvaluation.hoursOfWork,
          irsScore: currentEvaluation.score
        }
      });

      btn.className = 'zenbuy-ice-btn zenbuy-saved';
      btn.textContent = 'In 48h Vault';
    });

    if (cartButton && cartButton.parentElement) {
      cartButton.parentElement.insertBefore(btn, cartButton.nextSibling);
    }
  }

  function openInterceptModal() {
    if (document.querySelector('.zenbuy-modal-overlay')) return;

    const overlay = document.createElement('div');
    overlay.className = 'zenbuy-modal-overlay';

    overlay.innerHTML = `
      <div class="zenbuy-modal-card">
        <div class="zenbuy-modal-header">ZenBuy Reflection Check</div>
        <div class="zenbuy-modal-title">${escapeHtml(currentProduct.title)}</div>
        
        <div class="zenbuy-modal-metrics">
          <div class="zenbuy-metric-row">
            <span class="zenbuy-metric-label">Price</span>
            <span class="zenbuy-metric-val">$${Number(currentProduct.price).toFixed(2)}</span>
          </div>
          <div class="zenbuy-metric-row">
            <span class="zenbuy-metric-label">Labor cost</span>
            <span class="zenbuy-metric-val">${currentEvaluation.hoursOfWork} working hours</span>
          </div>
          <div class="zenbuy-metric-row">
            <span class="zenbuy-metric-label">Impulse risk index</span>
            <span class="zenbuy-metric-val">${currentEvaluation.score} / 100</span>
          </div>
        </div>

        <div class="zenbuy-modal-nudge" id="zenbuy-nudge-text">
          Loading reflection check...
        </div>

        <div class="zenbuy-modal-actions">
          <button class="zenbuy-btn-primary" id="zenbuy-confirm-ice">Put on Ice (48h)</button>
          <button class="zenbuy-btn-secondary" id="zenbuy-bypass">Continue to Purchase</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Fetch Socratic text
    chrome.runtime.sendMessage({
      type: 'GET_SOCRATIC_NUDGE',
      payload: {
        title: currentProduct.title,
        price: currentProduct.price
      }
    }).then(res => {
      const nudgeEl = document.getElementById('zenbuy-nudge-text');
      if (nudgeEl && res && res.nudge) {
        nudgeEl.textContent = res.nudge;
      }
    });

    document.getElementById('zenbuy-confirm-ice').addEventListener('click', async () => {
      const saveBtn = document.getElementById('zenbuy-confirm-ice');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';

      await chrome.runtime.sendMessage({
        type: 'SAVE_TO_VAULT',
        payload: {
          title: currentProduct.title,
          price: currentProduct.price,
          url: window.location.href,
          imageUrl: currentProduct.image,
          hoursOfWork: currentEvaluation.hoursOfWork,
          irsScore: currentEvaluation.score
        }
      });

      overlay.remove();
      alert('Item quarantined in your 48-hour vault.');
    });

    document.getElementById('zenbuy-bypass').addEventListener('click', () => {
      isIntercepted = false; // Allow next click
      overlay.remove();
    });
  }

  function findCartButtons() {
    const selectors = [
      '#add-to-cart-button',
      '#buy-now-button',
      '[name="submit.add-to-cart"]',
      '[name="add"]',
      '.zenbuy-add-to-cart',
      'button[data-action="add-to-cart"]'
    ];
    return document.querySelectorAll(selectors.join(','));
  }

  function hookCartButtons() {
    const buttons = findCartButtons();
    buttons.forEach(btn => {
      if (btn.dataset.zenbuyHooked) return;
      btn.dataset.zenbuyHooked = 'true';

      btn.addEventListener('click', (e) => {
        if (currentEvaluation && currentEvaluation.action === 'ACTION_INTERCEPT' && !isIntercepted) {
          e.preventDefault();
          e.stopPropagation();
          openInterceptModal();
        }
      }, true);
    });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, function (m) {
      return ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[m];
    });
  }

  async function init() {
    currentProduct = scrapeProduct();
    if (!currentProduct || !currentProduct.price) return;

    const dwellTimeSeconds = Math.round((Date.now() - pageLoadTime) / 1000);
    const darkPatterns = detectDarkPatterns();
    const isSocialReferrer = /tiktok|instagram|facebook|pinterest/i.test(document.referrer || '');
    const isDirectSearch = /google|bing|duckduckgo/i.test(document.referrer || '');

    // Allow test page to pass simulated hour
    const simulatedHourAttr = document.body.getAttribute('data-zenbuy-simulated-hour');
    const simulatedHour = simulatedHourAttr ? parseInt(simulatedHourAttr, 10) : undefined;

    const evaluation = await chrome.runtime.sendMessage({
      type: 'EVALUATE_PRODUCT',
      payload: {
        title: currentProduct.title,
        price: currentProduct.price,
        category: currentProduct.category,
        velocity: {
          dwellTimeSeconds,
          isSocialReferrer,
          isDirectSearch
        },
        darkPatterns,
        simulatedHour
      }
    });

    if (!evaluation || evaluation.error) return;
    currentEvaluation = evaluation;

    // Find price element to attach badge
    const priceElem = document.querySelector('[data-zenbuy-price]') ||
                      document.querySelector('#corePrice_feature_div') ||
                      document.querySelector('#priceblock_ourprice') ||
                      document.querySelector('.a-price');
    if (priceElem) {
      injectWageBadge(priceElem, evaluation.hoursOfWork);
    }

    const cartButtons = findCartButtons();
    const primaryCartBtn = cartButtons[0];

    if (evaluation.action === 'ACTION_PASSIVE_ICE' && primaryCartBtn) {
      injectIceButton(primaryCartBtn);
    } else if (evaluation.action === 'ACTION_INTERCEPT') {
      hookCartButtons();
      if (primaryCartBtn) {
        injectIceButton(primaryCartBtn);
      }
    }
  }

  // Run on page load and observe mutations for single-page apps
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
