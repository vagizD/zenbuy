/**
 * ZenBuy Content Script
 * Scrapes product data, evaluates IRS, and injects clean UI elements.
 */

(function () {
  let isIntercepted = false;
  let pageLoadTime = Date.now();
  let currentProduct = null;
  let currentEvaluation = null;

  // Resolve platform adapter (Amazon, Sandbox, or Fallback)
  const adapter = (typeof AdapterRegistry !== 'undefined')
    ? AdapterRegistry.getAdapter(window.location)
    : (typeof FallbackAdapter !== 'undefined' ? FallbackAdapter : null);

  function scrapeProduct() {
    if (adapter && typeof adapter.scrapeProduct === 'function') {
      return adapter.scrapeProduct();
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

  function neutralizeDarkPatterns() {
    // 1. Adapter-specific scarcity elements (e.g. Amazon buybox availability leaf spans)
    if (adapter && typeof adapter.getScarcityElements === 'function') {
      const adapterElements = adapter.getScarcityElements();
      adapterElements.forEach(el => applyNeutralization(el, 'Scarcity trigger'));
    }

    // 2. Scan pure leaf elements only (no divs or containers)
    const candidateTags = ['span', 'b', 'strong', 'em', 'p'];
    candidateTags.forEach(tag => {
      document.querySelectorAll(tag).forEach(el => {
        // Must be a pure leaf node without children
        if (el.children.length === 0 && !el.closest('.zenbuy-neutralized-tag') && !el.closest('.zenbuy-modal-card') && !el.closest('.zenbuy-debug-modal-card')) {
          // Never blur inside price, title, or description containers
          if (el.closest('#corePrice_feature_div, #corePriceDisplay_desktop_feature_div, #priceblock_ourprice, .a-price, #productTitle, #title, #productDescription, #feature-bullets, [data-zenbuy-price]')) {
            return;
          }

          const txt = (el.textContent || '').trim();
          // Short scarcity badges only (< 80 chars)
          if (txt.length > 0 && txt.length < 80 && /only\s+\d+\s+left\s+in\s+stock|order\s+soon/i.test(txt)) {
            if (!/\$|price|delivery|shipping/i.test(txt)) {
              applyNeutralization(el, 'Scarcity trigger');
            }
          }
        }
      });
    });

    // 3. Countdown timer text badges (< 40 chars)
    const timerSelectors = ['.countdown', '#timer', '[data-countdown]', '.deal-timer', '#deal_timer'];
    timerSelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        const txt = (el.innerText || el.textContent || '').trim();
        if (txt.length > 0 && txt.length < 40 && !el.closest('#corePrice_feature_div, .a-price, #productTitle')) {
          applyNeutralization(el, 'Artificial countdown');
        }
      });
    });
  }

  function applyNeutralization(element, reason) {
    if (element.hasAttribute('data-zenbuy-neutralized')) return;
    
    // Strict safety guard: Never hide containers or elements with price / description text
    const txt = (element.textContent || '').trim();
    if (txt.length > 80 || (/\$|price/i.test(txt) && !/only\s+\d+\s+left/i.test(txt))) {
      return;
    }

    element.setAttribute('data-zenbuy-neutralized', 'true');
    element.classList.add('zenbuy-darkpattern-hidden');

    const tag = document.createElement('span');
    tag.className = 'zenbuy-neutralized-tag';
    tag.innerHTML = `🛡️ <strong>ZenBuy:</strong> ${reason} hidden <span class="zenbuy-peek-toggle">(view)</span>`;

    const toggle = tag.querySelector('.zenbuy-peek-toggle');
    if (toggle) {
      toggle.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (element.classList.contains('zenbuy-darkpattern-hidden')) {
          element.classList.remove('zenbuy-darkpattern-hidden');
          toggle.textContent = '(hide)';
        } else {
          element.classList.add('zenbuy-darkpattern-hidden');
          toggle.textContent = '(view)';
        }
      });
    }

    element.insertAdjacentElement('afterend', tag);
  }

  function showZenBuyToast({ title, message, duration = 4500 }) {
    const existing = document.querySelector('.zenbuy-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'zenbuy-toast';
    toast.innerHTML = `
      <div class="zenbuy-toast-icon">❄️</div>
      <div class="zenbuy-toast-content">
        <div class="zenbuy-toast-title">${escapeHtml(title)}</div>
        <div class="zenbuy-toast-desc">${escapeHtml(message)}</div>
      </div>
      <button type="button" class="zenbuy-toast-close" aria-label="Close">&times;</button>
    `;

    toast.querySelector('.zenbuy-toast-close').addEventListener('click', () => {
      toast.remove();
    });

    document.body.appendChild(toast);

    setTimeout(() => {
      if (toast.parentElement) {
        toast.classList.add('zenbuy-toast-fading');
        setTimeout(() => toast.remove(), 300);
      }
    }, duration);
  }

  function injectWageBadge(priceElement, hoursOfWork, evaluation) {
    if (document.querySelector('.zenbuy-wage-badge')) return;
    const badge = document.createElement('div');
    badge.className = 'zenbuy-wage-badge';
    badge.textContent = `${hoursOfWork} hours of labor`;

    if (priceElement) {
      priceElement.insertAdjacentElement('afterend', badge);
    }

    if (evaluation) {
      injectDebugBadge(badge, evaluation);
    }
  }

  function injectDebugBadge(afterElement, evaluation) {
    let debugBtn = document.querySelector('.zenbuy-debug-badge');
    if (!debugBtn) {
      debugBtn = document.createElement('button');
      debugBtn.type = 'button';
      debugBtn.className = 'zenbuy-debug-badge';
      afterElement.insertAdjacentElement('afterend', debugBtn);
    }
    const evalData = evaluation || currentEvaluation;
    debugBtn.innerHTML = `IRS: ${evalData?.score ?? '--'} 📊`;
    debugBtn.title = 'Click to inspect IRS score breakdown and diagnostic log';
    debugBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openIrsDebugModal(currentEvaluation || evalData);
    };
  }

  function injectFloatingDebugButton(evaluation) {
    let floatBtn = document.querySelector('.zenbuy-floating-inspector-btn');
    if (!floatBtn) {
      floatBtn = document.createElement('button');
      floatBtn.type = 'button';
      floatBtn.className = 'zenbuy-floating-inspector-btn';
      document.body.appendChild(floatBtn);
    }
    const evalData = evaluation || currentEvaluation;
    floatBtn.innerHTML = `⚡ IRS Inspector: ${evalData?.score ?? '--'}/100`;
    floatBtn.title = 'Inspect IRS breakdown and logs';
    floatBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openIrsDebugModal(currentEvaluation || evalData);
    };
  }

  function openIrsDebugModal(evaluation) {
    const evalData = evaluation || currentEvaluation;
    if (!evalData) {
      console.warn('[ZenBuy] Cannot open debug modal without evaluation data');
      return;
    }

    const existing = document.querySelector('.zenbuy-debug-modal-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'zenbuy-modal-overlay zenbuy-debug-modal-overlay';

    const breakdownRows = (evaluation.breakdown || []).map(item => `
      <tr>
        <td><strong>${escapeHtml(item.dimension)}</strong></td>
        <td><code>${item.rawScore}</code></td>
        <td>${(item.weight * 100).toFixed(0)}%</td>
        <td><code>+${item.weightedContribution}</code></td>
        <td class="zenbuy-table-details">${escapeHtml(item.details)}</td>
      </tr>
    `).join('');

    overlay.innerHTML = `
      <div class="zenbuy-debug-modal-card">
        <div class="zenbuy-debug-header">
          <div class="zenbuy-debug-title-group">
            <div class="zenbuy-debug-tag">ZenBuy Diagnostic Inspector</div>
            <div class="zenbuy-debug-title">${escapeHtml(currentProduct?.title || 'Product Evaluation')}</div>
          </div>
          <button type="button" class="zenbuy-modal-close" id="zenbuy-close-debug" aria-label="Close">&times;</button>
        </div>

        <div class="zenbuy-debug-score-banner">
          <div class="zenbuy-debug-score-box">
            <div class="zenbuy-debug-score-num">${evaluation.score}<span class="zenbuy-score-denom">/100</span></div>
            <div class="zenbuy-debug-score-label">Impulse Risk Score (IRS)</div>
          </div>
          <div class="zenbuy-debug-tier-box">
            <div class="zenbuy-debug-tier-badge ${(evaluation.tier || '').toLowerCase()}">${evaluation.tier || 'TIER_1'}</div>
            <div class="zenbuy-debug-action-label">Action: <strong>${evaluation.action || 'ACTION_PASSIVE_ICE'}</strong></div>
          </div>
        </div>

        <div class="zenbuy-debug-section-title">Mathematical Formula Breakdown</div>
        <div class="zenbuy-debug-table-wrapper">
          <table class="zenbuy-debug-table">
            <thead>
              <tr>
                <th>Dimension</th>
                <th>Raw Score (0-100)</th>
                <th>Weight</th>
                <th>Contribution</th>
                <th>Signals & Details</th>
              </tr>
            </thead>
            <tbody>
              ${breakdownRows}
              <tr class="zenbuy-total-row">
                <td><strong>Total Score</strong></td>
                <td>-</td>
                <td>100%</td>
                <td><strong>${evaluation.score}</strong></td>
                <td><em>Score = Sum(Weight_i × RawScore_i)</em></td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="zenbuy-debug-thresholds-grid">
          <div class="zenbuy-thresh-card">
            <div class="zenbuy-thresh-label">Tier 1 Threshold (Ice Button)</div>
            <div class="zenbuy-thresh-val">≥ ${evaluation.thresholds?.tier1Passive || 30}</div>
          </div>
          <div class="zenbuy-thresh-card">
            <div class="zenbuy-thresh-label">Tier 2 Threshold (Modal Circuit Breaker)</div>
            <div class="zenbuy-thresh-val">≥ ${evaluation.thresholds?.tier2Intercept || 65}</div>
          </div>
          <div class="zenbuy-thresh-card">
            <div class="zenbuy-thresh-label">Configured Cooldown</div>
            <div class="zenbuy-thresh-val">${evaluation.cooldownDurationSeconds}s</div>
          </div>
        </div>

        <div class="zenbuy-debug-log-header">
          <span>Diagnostic JSON Log</span>
          <button type="button" class="zenbuy-btn-copy-log" id="zenbuy-copy-json">📋 Copy Log JSON</button>
        </div>
        <pre class="zenbuy-debug-json"><code>${escapeHtml(JSON.stringify(evaluation, null, 2))}</code></pre>

        <div class="zenbuy-modal-actions">
          <button type="button" class="zenbuy-btn-primary" id="zenbuy-dismiss-debug">Close Inspector</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const closeModal = () => overlay.remove();
    overlay.querySelector('#zenbuy-close-debug').addEventListener('click', closeModal);
    overlay.querySelector('#zenbuy-dismiss-debug').addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });

    const copyBtn = overlay.querySelector('#zenbuy-copy-json');
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(evaluation, null, 2));
        copyBtn.textContent = '✅ Copied!';
        setTimeout(() => {
          copyBtn.textContent = '📋 Copy Log JSON';
        }, 2000);
      } catch (err) {
        copyBtn.textContent = 'Failed to copy';
      }
    });
  }

  function formatDuration(seconds) {
    const s = parseInt(seconds, 10);
    if (!s || isNaN(s) || s <= 0) return '48h';
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    return `${Math.round(s / 3600)}h`;
  }

  function injectIceButton(cartButton) {
    if (!cartButton) return;

    // Check if an existing connected and visible ice button is already attached
    const existing = document.querySelector('.zenbuy-ice-btn');
    if (existing && existing.isConnected && existing.offsetParent !== null) return;
    if (existing) {
      existing.closest('.zenbuy-amazon-ice-wrapper')?.remove() || existing.remove();
    }

    const cooldownSecs = currentEvaluation?.cooldownDurationSeconds || (48 * 3600);
    const durLabel = formatDuration(cooldownSecs);

    const handleIceClick = async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Freezing purchase...';

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

      btn.classList.add('zenbuy-saved');
      btn.textContent = `❄️ On Ice (${durLabel})`;

      freezeBuybox(cooldownSecs * 1000, durLabel);

      showZenBuyToast({
        title: `Quarantined on Ice (${durLabel})!`,
        message: `Purchasing is now frozen on this page for ${durLabel}. Open your ZenBuy extension popup to view your vault or countdown.`
      });
    };

    if (adapter && typeof adapter.injectIceButton === 'function') {
      adapter.injectIceButton(cartButton, {
        label: `Put on Ice (${durLabel})`,
        onClick: handleIceClick
      });
    }
  }

  function freezeBuybox(remainingMs, durLabel) {
    const cartButtons = (adapter && typeof adapter.getCartButtons === 'function')
      ? adapter.getCartButtons()
      : findCartButtons();

    cartButtons.forEach(btn => {
      btn.classList.add('zenbuy-cart-frozen');
      btn.setAttribute('data-zenbuy-frozen', 'true');

      // Visually shadow and gray out the button container (.a-button, .a-button-inner)
      const visualWrapper = btn.closest('.a-button') || btn.closest('.a-button-stack') || btn.closest('#addToCart_feature_div') || btn;
      if (visualWrapper) {
        visualWrapper.classList.add('zenbuy-cart-frozen');
        const inner = visualWrapper.querySelector('.a-button-inner');
        if (inner) inner.classList.add('zenbuy-cart-frozen');
      }

      const clickHandler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        showZenBuyToast({
          title: '❄️ Purchase Frozen on Ice!',
          message: `This item is currently locked in your cooldown vault (${durLabel}). Open the ZenBuy extension popup to manage your vault or unlock when complete.`
        });
      };

      btn.addEventListener('click', clickHandler, true);
      if (visualWrapper && visualWrapper !== btn) {
        visualWrapper.addEventListener('click', clickHandler, true);
      }
    });

    if (document.querySelector('.zenbuy-buybox-frozen-banner')) return;

    const primaryCartBtn = cartButtons[0];
    if (primaryCartBtn) {
      const banner = document.createElement('div');
      banner.className = 'zenbuy-buybox-frozen-banner';
      banner.innerHTML = `
        <div class="zenbuy-frozen-banner-title">❄️ Item Quarantined on Ice</div>
        <div class="zenbuy-frozen-banner-desc">
          Add to Cart & Buy Now are frozen during your cooldown (${durLabel}). Open the ZenBuy Vault popup to monitor your timer or unlock the deal once expired.
        </div>
      `;
      const wrapper = primaryCartBtn.closest('#addToCart_feature_div') || primaryCartBtn.closest('.a-button-stack') || primaryCartBtn.closest('.a-button') || primaryCartBtn;
      if (wrapper && wrapper.parentElement) {
        wrapper.parentElement.insertBefore(banner, wrapper);
      }
    }
  }

  function showAvertedBanner(item) {
    if (document.querySelector('.zenbuy-buybox-averted-banner')) return;
    const cartButtons = (adapter && typeof adapter.getCartButtons === 'function')
      ? adapter.getCartButtons()
      : findCartButtons();
    const primaryCartBtn = cartButtons[0];
    if (primaryCartBtn) {
      const banner = document.createElement('div');
      banner.className = 'zenbuy-buybox-averted-banner';
      banner.innerHTML = `
        <div class="zenbuy-averted-banner-title">🏆 Purchase Already Averted!</div>
        <div class="zenbuy-averted-banner-desc">
          You consciously decided against purchasing this item ($${Number(item.price).toFixed(2)} saved, ${item.hoursOfWork}h labor retained). Stay strong!
        </div>
      `;
      const wrapper = primaryCartBtn.closest('#addToCart_feature_div') || primaryCartBtn.closest('.a-button-stack') || primaryCartBtn.closest('.a-button') || primaryCartBtn;
      if (wrapper && wrapper.parentElement) {
        wrapper.parentElement.insertBefore(banner, wrapper);
      }
    }
  }

  function openInterceptModal() {
    if (document.querySelector('.zenbuy-modal-overlay')) return;

    const cooldownSecs = currentEvaluation?.cooldownDurationSeconds || (48 * 3600);
    const durLabel = formatDuration(cooldownSecs);

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
          <button class="zenbuy-btn-primary" id="zenbuy-confirm-ice">Put on Ice (${durLabel})</button>
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
        price: currentProduct.price,
        categoryBaselinePrice: currentEvaluation?.classification?.categoryBaselinePrice,
        luxuryMultiplier: currentEvaluation?.classification?.luxuryMultiplier
      }
    }).then(res => {
      const nudgeEl = document.getElementById('zenbuy-nudge-text');
      if (nudgeEl) {
        if (res && res.nudge) {
          nudgeEl.textContent = res.nudge;
        } else {
          const hrs = currentEvaluation?.hoursOfWork || (currentProduct.price / 30).toFixed(1);
          nudgeEl.textContent = `This purchase represents ${hrs} hours of your workday. Placing it in your 48-hour vault keeps you aligned with your long-term goals.`;
        }
      }
    }).catch(err => {
      const nudgeEl = document.getElementById('zenbuy-nudge-text');
      if (nudgeEl) {
        const hrs = currentEvaluation?.hoursOfWork || (currentProduct.price / 30).toFixed(1);
        nudgeEl.textContent = `This purchase represents ${hrs} hours of your workday. Placing it in your 48-hour vault keeps you aligned with your long-term goals.`;
      }
    });

    const confirmIceBtn = document.getElementById('zenbuy-confirm-ice');
    if (confirmIceBtn) {
      confirmIceBtn.addEventListener('click', async () => {
        confirmIceBtn.disabled = true;
        confirmIceBtn.textContent = 'Freezing purchase...';

        await chrome.runtime.sendMessage({
          type: 'SAVE_TO_VAULT',
          payload: {
            title: currentProduct.title,
            price: currentProduct.price,
            url: window.location.href,
            imageUrl: currentProduct.image,
            hoursOfWork: currentEvaluation?.hoursOfWork,
            irsScore: currentEvaluation?.score
          }
        });

        overlay.remove();
        freezeBuybox(cooldownSecs * 1000, durLabel);
        showZenBuyToast({
          title: `Quarantined in ${durLabel} Vault!`,
          message: `Cooldown timer started (${durLabel}). Open the ZenBuy extension popup to review status.`
        });
      });
    }

    const bypassBtn = document.getElementById('zenbuy-bypass');
    if (bypassBtn) {
      bypassBtn.addEventListener('click', () => {
        isIntercepted = false; // Allow next click
        overlay.remove();
      });
    }
  }

  function findCartButtons() {
    const selectors = [
      '#addToCart_feature_div #add-to-cart-button',
      '#desktop_qualifiedBuyBox #add-to-cart-button',
      '#add-to-cart-button',
      '#buyNow_feature_div #buy-now-button',
      '#desktop_qualifiedBuyBox #buy-now-button',
      '#buy-now-button',
      '[name="submit.add-to-cart"]',
      '[name="add"]',
      '.zenbuy-add-to-cart',
      'button[data-action="add-to-cart"]'
    ];
    return Array.from(document.querySelectorAll(selectors.join(',')))
      .filter(el => el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0));
  }

  function hookCartButtons() {
    const cartButtons = (adapter && typeof adapter.getCartButtons === 'function')
      ? adapter.getCartButtons()
      : findCartButtons();

    // 1. For High-Risk Tier 2 (IRS >= 65), disable Buy Now (1-click impulse dark pattern)
    const buyNowBtns = document.querySelectorAll(
      '#buyNow_feature_div #buy-now-button, #buy-now-button, input[name="submit.buy-now"], #buyNow_feature_div'
    );
    buyNowBtns.forEach(bn => {
      const wrapper = bn.closest('.a-button') || bn.closest('.a-button-stack') || bn;
      wrapper.classList.add('zenbuy-buynow-disabled');
      wrapper.title = '1-Click impulse buy disabled for high risk item (IRS >= 65)';
      wrapper.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        openInterceptModal();
      }, true);
    });

    // 2. Inject Tier 2 Warning Banner above the Add to Cart stack
    if (!document.querySelector('.zenbuy-tier2-warning-banner') && !document.querySelector('.zenbuy-buybox-frozen-banner')) {
      const primaryCartBtn = cartButtons[0];
      if (primaryCartBtn) {
        const warn = document.createElement('div');
        warn.className = 'zenbuy-tier2-warning-banner';
        warn.innerHTML = `
          <div class="zenbuy-tier2-title">⚡ High Impulse Risk (IRS: ${currentEvaluation.score}/100)</div>
          <div class="zenbuy-tier2-desc">
            1-Click Buy Now is disabled. Add to Cart requires reflection check. Use <strong>Put on Ice</strong> below to sleep on it!
          </div>
        `;
        const wrapper = primaryCartBtn.closest('#addToCart_feature_div') || primaryCartBtn.closest('.a-button-stack') || primaryCartBtn.closest('.a-button') || primaryCartBtn;
        if (wrapper && wrapper.parentElement) {
          wrapper.parentElement.insertBefore(warn, wrapper);
        }
      }
    }

    // 3. Hook all Add to Cart elements (button, outer container, inner container)
    cartButtons.forEach(btn => {
      const elementsToHook = [
        btn,
        btn.closest('.a-button'),
        btn.closest('.a-button-inner'),
        btn.closest('.a-button-stack'),
        btn.closest('#addToCart_feature_div'),
        btn.closest('form')
      ].filter(Boolean);

      elementsToHook.forEach(target => {
        if (target.dataset.zenbuyHooked) return;
        target.dataset.zenbuyHooked = 'true';

        target.addEventListener('click', (e) => {
          if (currentEvaluation && currentEvaluation.action === 'ACTION_INTERCEPT' && !isIntercepted) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            openInterceptModal();
          }
        }, true);
      });
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

  let isEvaluating = false;

  async function init() {
    if (isEvaluating) return;

    const scraped = scrapeProduct();
    if (!scraped || !scraped.price) {
      return;
    }

    // Skip redundant network evaluation if product/price hasn't changed
    if (currentProduct && currentProduct.price === scraped.price && currentProduct.title === scraped.title && currentEvaluation) {
      tryInjectIceButton();
      return;
    }

    isEvaluating = true;
    currentProduct = scraped;

    const dwellTimeSeconds = Math.round((Date.now() - pageLoadTime) / 1000);
    const darkPatterns = detectDarkPatterns();
    const isSocialReferrer = /tiktok|instagram|facebook|pinterest/i.test(document.referrer || '');
    const isDirectSearch = /google|bing|duckduckgo/i.test(document.referrer || '');

    // Allow test page to pass simulated hour
    const simulatedHourAttr = document.body.getAttribute('data-zenbuy-simulated-hour');
    const simulatedHour = simulatedHourAttr ? parseInt(simulatedHourAttr, 10) : undefined;

    try {
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

      // Neutralize dark patterns (low-stock triggers, countdown timers)
      neutralizeDarkPatterns();

      // Find price element to attach wage badge + debug inspector badge
      const priceElem = (adapter && typeof adapter.getPriceElement === 'function')
        ? adapter.getPriceElement()
        : (document.querySelector('[data-zenbuy-price]') || document.querySelector('.a-price'));

      if (priceElem) {
        injectWageBadge(priceElem, evaluation.hoursOfWork, evaluation);
      }

      // Check vault status to see if item is already frozen or archived
      const vaultCheck = await chrome.runtime.sendMessage({
        type: 'CHECK_VAULT_ITEM',
        payload: { url: window.location.href, title: currentProduct.title }
      });

      if (vaultCheck && vaultCheck.found) {
        if (vaultCheck.status === 'FROZEN') {
          const remSecs = Math.ceil(vaultCheck.remainingMs / 1000);
          const dur = formatDuration(remSecs);
          freezeBuybox(vaultCheck.remainingMs, dur);
        } else if (vaultCheck.status === 'ARCHIVED_SAVED') {
          showAvertedBanner(vaultCheck.item);
        }
      }

      // Always inject persistent floating debug inspector button for testing
      injectFloatingDebugButton(evaluation);

      tryInjectIceButton();
      setTimeout(tryInjectIceButton, 400);
      setTimeout(tryInjectIceButton, 1200);
    } catch (err) {
      console.warn('[ZenBuy] Evaluation error:', err);
    } finally {
      isEvaluating = false;
    }
  }

  function tryInjectIceButton() {
    if (!currentEvaluation) return;
    if (currentEvaluation.action !== 'ACTION_PASSIVE_ICE' && currentEvaluation.action !== 'ACTION_INTERCEPT') return;

    // Check if an existing connected and visible ice button is already in place
    const existing = document.querySelector('.zenbuy-ice-btn');
    if (existing && existing.isConnected && existing.offsetParent !== null) return;

    const cartButtons = (adapter && typeof adapter.getCartButtons === 'function')
      ? adapter.getCartButtons()
      : findCartButtons();
    const primaryCartBtn = cartButtons[0];

    if (primaryCartBtn) {
      injectIceButton(primaryCartBtn);
      if (currentEvaluation.action === 'ACTION_INTERCEPT') {
        hookCartButtons();
      }
    }
  }

  function observeDom() {
    let timeout = null;
    const observer = new MutationObserver(() => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        if (!currentEvaluation) {
          init();
        } else {
          neutralizeDarkPatterns();
          tryInjectIceButton();
        }
      }, 250);
    });
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  // Run on page load and observe mutations for dynamic buyboxes
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      init();
      setTimeout(init, 500);
      setTimeout(init, 1500);
      observeDom();
    });
  } else {
    init();
    setTimeout(init, 500);
    setTimeout(init, 1500);
    observeDom();
  }
})();
