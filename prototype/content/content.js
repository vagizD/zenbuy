/**
 * ZenBuy Content Script
 * Scrapes product data, evaluates IRS, and injects clean UI elements.
 */

(function () {
  let isIntercepted = false;
  let pageLoadTime = Date.now();
  let currentProduct = null;
  let currentEvaluation = null;
  // The page can be reloaded while an item is still cooling off. Keep the
  // lifecycle lookup alongside the product evaluation so the injected action
  // describes the real state instead of offering a duplicate action.
  let currentVaultStatus = null;
  let recordedPurchaseFingerprint = null;
  let frozenBuyboxBindings = [];
  let frozenBuyboxElements = new Set();
  let frozenBuyboxTitles = new Map();
  const REFLECTION_GATE_SECONDS = 15;

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

  async function recordObservedPurchase() {
    if (!adapter || typeof adapter.getPurchaseConfirmation !== 'function') return;
    const observed = adapter.getPurchaseConfirmation();
    const confirmation = Array.isArray(observed)
      ? { purchases: observed, source: 'AMAZON_ORDER_CONFIRMATION' }
      : observed;
    const purchases = confirmation?.purchases;
    if (!Array.isArray(purchases) || purchases.length === 0) return;

    const fingerprint = [confirmation.confirmationId || 'unidentified-confirmation']
      .concat(purchases.map(purchase => purchase.productId || purchase.asin || purchase.url || purchase.title))
      .sort()
      .join('|');
    if (!fingerprint || fingerprint === recordedPurchaseFingerprint) return;
    recordedPurchaseFingerprint = fingerprint;

    try {
      await chrome.runtime.sendMessage({
        type: 'RECORD_PURCHASE_CONFIRMATION',
        payload: {
          confirmationId: confirmation.confirmationId || '',
          source: confirmation.source || `${String(adapter.name || 'UNKNOWN').toUpperCase()}_ORDER_CONFIRMATION`,
          purchases
        }
      });
    } catch (error) {
      // A purchase confirmation must never interfere with the retailer's page.
      console.warn('[ZenBuy] Unable to record purchase confirmation:', error);
    }
  }

  function compactEvidenceText(value, limit = 160) {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    return normalized.length > limit ? `${normalized.slice(0, limit - 1).trimEnd()}…` : normalized;
  }

  function isVisibleForDarkPatternScan(element) {
    if (!element || element.closest('.zenbuy-wage-badge, .zenbuy-tier2-warning-banner, .zenbuy-buybox-frozen-banner, .zenbuy-modal-overlay, .zenbuy-floating-inspector-btn, .zenbuy-ice-btn, .zenbuy-neutralized-tag')) {
      return false;
    }
    return element.getClientRects().length > 0;
  }

  function visibleLeafTextElements() {
    if (!document.body) return [];
    return Array.from(document.body.querySelectorAll('*')).filter(element => (
      element.children.length === 0 &&
      isVisibleForDarkPatternScan(element) &&
      compactEvidenceText(element.textContent)
    ));
  }

  function collectTextEvidence(pattern, source = 'Visible page text') {
    const seen = new Set();
    const matches = [];
    visibleLeafTextElements().forEach(element => {
      const text = compactEvidenceText(element.textContent);
      if (pattern.test(text) && !seen.has(text)) {
        seen.add(text);
        matches.push({ source, text });
      }
    });
    return matches.slice(0, 3);
  }

  function collectSelectorEvidence(selector, source) {
    const seen = new Set();
    const matches = [];
    document.querySelectorAll(selector).forEach(element => {
      if (!isVisibleForDarkPatternScan(element)) return;
      const text = compactEvidenceText(element.innerText || element.textContent) || selector;
      const key = `${source}:${text}`;
      if (!seen.has(key)) {
        seen.add(key);
        matches.push({ source, text });
      }
    });
    return matches.slice(0, 3);
  }

  function detectDarkPatterns() {
    const urgencyText = collectTextEvidence(/deal expires|ends in [0-9]+|countdown/i);
    const urgencyTimer = collectSelectorEvidence('.countdown, #timer, [data-countdown]', 'Countdown element');
    const stockText = collectTextEvidence(/only\s+[0-9]+\s+left\s+in\s+stock|almost gone|limited quantity/i);
    const socialProofText = collectTextEvidence(/people bought this in the last|in high demand/i);
    const checkedBoxes = Array.from(document.querySelectorAll('input[type="checkbox"]'))
      .filter(input => input.checked && !input.disabled && isVisibleForDarkPatternScan(input))
      .slice(0, 3)
      .map(input => ({
        source: 'Checked checkbox',
        text: compactEvidenceText(input.closest('label')?.innerText || input.getAttribute('name') || input.id || 'Unnamed option')
      }));
    const availabilityContext = collectSelectorEvidence(
      '#availability, #availabilityInsideBuyBox_feature_div, [data-zenbuy-availability], .availability, #banner-stock',
      'Availability context'
    );

    const deceptiveUrgency = urgencyText.length > 0 || urgencyTimer.length > 0;
    const lowStockAmbiguity = stockText.length > 0;
    const fabricatedSocialProof = socialProofText.length > 0;
    const preselection = checkedBoxes.length > 0;

    return {
      deceptiveUrgency,
      lowStockAmbiguity,
      fabricatedSocialProof,
      preselection,
      // Evidence is diagnostic only. The IRS engine continues to receive the
      // same four boolean inputs, preserving its independent contract.
      evidence: {
        scanScope: 'Visible page text only; ZenBuy UI excluded.',
        deceptiveUrgency: {
          detected: deceptiveUrgency,
          rule: 'Matches expiry/countdown language or a countdown element.',
          matches: [...urgencyText, ...urgencyTimer].slice(0, 3)
        },
        lowStockAmbiguity: {
          detected: lowStockAmbiguity,
          rule: 'Matches “only N left in stock,” “almost gone,” or “limited quantity.”',
          matches: stockText
        },
        fabricatedSocialProof: {
          detected: fabricatedSocialProof,
          rule: 'Matches recent-purchases or high-demand language.',
          matches: socialProofText
        },
        preselection: {
          detected: preselection,
          rule: 'Finds a visible, enabled checkbox that is already selected.',
          matches: checkedBoxes
        },
        availabilityContext
      }
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
      <div class="zenbuy-toast-icon" aria-hidden="true">✦</div>
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

  function getPriceElement() {
    return (adapter && typeof adapter.getPriceElement === 'function')
      ? adapter.getPriceElement()
      : (document.querySelector('[data-zenbuy-price]') || document.querySelector('.a-price'));
  }

  function getRiskLabel(evaluation) {
    if (evaluation.action === 'ACTION_INTERCEPT') return 'Reflection recommended';
    if (evaluation.action === 'ACTION_PASSIVE_ICE') return 'Pause suggested';
    return 'Low impulse risk';
  }

  function waitForPreviewPaint() {
    // A double animation frame gives the browser a chance to present the
    // skeleton card before the background request begins.
    return new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  }

  function injectWageBadge(priceElement, hoursOfWork, evaluation) {
    let card = document.querySelector('.zenbuy-wage-badge');
    if (!card) {
      card = document.createElement('section');
      card.className = 'zenbuy-wage-badge zenbuy-insight-card is-loading';
      card.setAttribute('aria-live', 'polite');
      card.setAttribute('aria-busy', 'true');
      card.innerHTML = `
        <div class="zenbuy-insight-header">
          <div class="zenbuy-insight-brand"><span class="zenbuy-insight-snowflake">✦</span> ZenBuy insight</div>
          <span class="zenbuy-insight-status"><span class="zenbuy-status-dot"></span><span class="zenbuy-status-text">Analyzing</span></span>
        </div>
        <div class="zenbuy-insight-metrics">
          <div class="zenbuy-insight-metric">
            <span class="zenbuy-insight-label">Your work time</span>
            <strong class="zenbuy-insight-value zenbuy-hours-value"><span class="zenbuy-skeleton zenbuy-skeleton-hours"></span><span class="zenbuy-loading-text">Calculating</span></strong>
          </div>
          <div class="zenbuy-insight-divider"></div>
          <div class="zenbuy-insight-metric">
            <span class="zenbuy-insight-label">Impulse risk</span>
            <strong class="zenbuy-insight-value zenbuy-score-value"><span class="zenbuy-skeleton zenbuy-skeleton-score"></span><span class="zenbuy-loading-text">Reading signals</span></strong>
          </div>
        </div>
        <button type="button" class="zenbuy-insight-inspector" disabled>
          Score details will appear here
        </button>
      `;

      if (priceElement) {
        priceElement.insertAdjacentElement('afterend', card);
      }
    }

    if (!evaluation) return card;

    card.classList.remove('is-loading');
    card.setAttribute('aria-busy', 'false');
    card.querySelector('.zenbuy-status-text').textContent = getRiskLabel(evaluation);
    card.querySelector('.zenbuy-hours-value').textContent = `${hoursOfWork}h`;
    card.querySelector('.zenbuy-score-value').innerHTML = `${evaluation.score}<small>/100</small>`;

    const status = card.querySelector('.zenbuy-insight-status');
    status.classList.remove('is-calm', 'is-pause', 'is-reflect');
    status.classList.add(evaluation.action === 'ACTION_INTERCEPT'
      ? 'is-reflect'
      : evaluation.action === 'ACTION_PASSIVE_ICE' ? 'is-pause' : 'is-calm');

    const detailsButton = card.querySelector('.zenbuy-insight-inspector');
    detailsButton.disabled = false;
    detailsButton.textContent = 'View score details';
    detailsButton.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openIrsDebugModal(currentEvaluation || evaluation);
    };

    return card;
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
    const isLoading = !evalData;
    floatBtn.classList.toggle('is-loading', isLoading);
    floatBtn.disabled = isLoading;
    floatBtn.innerHTML = isLoading
      ? '<span class="zenbuy-floating-pulse"></span> ZenBuy is analyzing'
      : `✦ IRS score: ${evalData.score}/100`;
    floatBtn.title = isLoading ? 'ZenBuy is evaluating this purchase' : 'Inspect IRS score breakdown and logs';
    floatBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (currentEvaluation || evalData) {
        openIrsDebugModal(currentEvaluation || evalData);
      }
    };
  }

  function renderDarkPatternEvidence(darkPatterns) {
    const rules = [
      ['lowStockAmbiguity', 'Low stock / scarcity'],
      ['deceptiveUrgency', 'Countdown / urgency'],
      ['fabricatedSocialProof', 'Social-proof pressure'],
      ['preselection', 'Preselected add-ons']
    ];
    const evidence = darkPatterns?.evidence || {};
    const rows = rules.map(([key, label]) => {
      const item = evidence[key] || {};
      const detected = Boolean(darkPatterns?.[key]);
      const matches = Array.isArray(item.matches) ? item.matches : [];
      const matchText = matches.length
        ? matches.map(match => `${match.source || 'Page'}: “${match.text || ''}”`).join(' · ')
        : (detected ? 'No excerpt was retained.' : 'No matching signal found.');
      return `
        <div class="zenbuy-dark-pattern-row ${detected ? 'is-detected' : 'is-clear'}">
          <div class="zenbuy-dark-pattern-row-title">
            <span class="zenbuy-dark-pattern-status">${detected ? 'Detected' : 'Clear'}</span>
            <strong>${escapeHtml(label)}</strong>
          </div>
          <div class="zenbuy-dark-pattern-rule">${escapeHtml(item.rule || 'No detector rule recorded.')}</div>
          <div class="zenbuy-dark-pattern-match">${escapeHtml(matchText)}</div>
        </div>`;
    }).join('');

    const availability = Array.isArray(evidence.availabilityContext) ? evidence.availabilityContext : [];
    const availabilityText = availability.map(match => match?.text).filter(Boolean).join(' · ');
    const context = availabilityText
      ? `<div class="zenbuy-dark-pattern-context"><strong>Availability context:</strong> ${escapeHtml(availabilityText)}</div>`
      : '';
    return `${rows}${context}`;
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
    const darkPatternEvidence = renderDarkPatternEvidence(evaluation.inputs?.darkPatterns);

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

        <div class="zenbuy-debug-section-title">Dark-pattern detector</div>
        <div class="zenbuy-dark-pattern-log" id="zenbuy-dark-pattern-log">
          ${darkPatternEvidence}
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

  function currentProductVaultPayload() {
    return {
      title: currentProduct.title,
      productId: currentProduct.productId,
      asin: currentProduct.asin,
      price: currentProduct.price,
      url: currentProduct.url || window.location.href,
      imageUrl: currentProduct.image,
      category: currentProduct.category,
      hoursOfWork: currentEvaluation?.hoursOfWork,
      irsScore: currentEvaluation?.score
    };
  }

  function markIceButtonActive(button, durationLabel) {
    if (!button) return;
    button.disabled = true;
    button.classList.add('zenbuy-saved', 'zenbuy-ice-active');
    button.textContent = `✦ On Ice · ${durationLabel}`;
    button.setAttribute('aria-label', `Already on ice for ${durationLabel}`);
    button.title = 'This item is already in your cooling-off vault.';
  }

  function injectIceButton(cartButton, { onIce = false, durationLabel = null } = {}) {
    if (!cartButton) return;

    // Check if an existing connected and visible ice button is already attached
    const existing = document.querySelector('.zenbuy-ice-btn');
    if (existing && existing.isConnected && existing.offsetParent !== null) {
      if (onIce) markIceButtonActive(existing, durationLabel);
      return existing;
    }
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

      const result = await chrome.runtime.sendMessage({
        type: 'SAVE_TO_VAULT',
        payload: currentProductVaultPayload()
      });

      currentVaultStatus = {
        found: true,
        item: result?.item,
        isFrozen: true,
        remainingMs: cooldownSecs * 1000
      };
      markIceButtonActive(btn, durLabel);

      freezeBuybox(cooldownSecs * 1000, durLabel);

      showZenBuyToast({
        title: 'Purchase is on ice',
        message: `Buying is paused for ${durLabel}.`
      });
    };

    if (adapter && typeof adapter.injectIceButton === 'function') {
      const button = adapter.injectIceButton(cartButton, {
        label: onIce ? `✦ On Ice · ${durationLabel}` : `✦ Put on Ice · ${durLabel}`,
        onClick: handleIceClick
      });
      if (onIce) markIceButtonActive(button, durationLabel);
      return button;
    }

    return null;
  }

  function unfreezeBuybox() {
    frozenBuyboxBindings.forEach(({ target, handler }) => target.removeEventListener('click', handler, true));
    frozenBuyboxBindings = [];
    frozenBuyboxElements.forEach(element => {
      element.classList.remove('zenbuy-cart-frozen');
      element.removeAttribute('data-zenbuy-frozen');
      const originalTitle = frozenBuyboxTitles.get(element);
      if (originalTitle === null) element.removeAttribute('title');
      else if (originalTitle !== undefined) element.setAttribute('title', originalTitle);
    });
    frozenBuyboxElements = new Set();
    frozenBuyboxTitles = new Map();
    document.querySelector('.zenbuy-buybox-frozen-banner')?.remove();
  }

  function resetIceButton() {
    const existing = document.querySelector('.zenbuy-ice-btn');
    if (existing) existing.closest('.zenbuy-amazon-ice-wrapper')?.remove() || existing.remove();
    tryInjectIceButton();
  }

  async function cancelPutOnIce(cancelButton) {
    const itemId = currentVaultStatus?.item?.id;
    if (!itemId) return;

    const originalLabel = cancelButton.textContent;
    cancelButton.disabled = true;
    cancelButton.textContent = 'Cancelling…';
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'CANCEL_PUT_ON_ICE',
        payload: { id: itemId }
      });
      if (!result?.success) throw new Error(result?.error || 'Unable to cancel Put on Ice.');

      currentVaultStatus = {
        found: true,
        item: result.item,
        poiState: result.item?.poi?.state,
        location: result.item?.location,
        isFrozen: false,
        remainingMs: 0
      };
      unfreezeBuybox();
      resetIceButton();
      showZenBuyToast({
        title: 'Put on Ice cancelled',
        message: 'Buying actions are available again. The item is saved in your decision archive.'
      });
    } catch (error) {
      cancelButton.disabled = false;
      cancelButton.textContent = originalLabel;
      showZenBuyToast({
        title: 'Could not cancel Put on Ice',
        message: 'Please try again from your ZenBuy Vault.'
      });
    }
  }

  function freezeBuybox(remainingMs, durLabel) {
    if (frozenBuyboxElements.size > 0 || document.querySelector('.zenbuy-buybox-frozen-banner')) return;

    // A reflection warning describes a choice that is no longer available.
    // Replace it with the cooldown banner below while this POI is active.
    document.querySelector('.zenbuy-tier2-warning-banner')?.remove();

    const cartButtons = (adapter && typeof adapter.getCartButtons === 'function')
      ? adapter.getCartButtons()
      : findCartButtons();

    const freezeElement = element => {
      if (!element) return;
      if (!frozenBuyboxTitles.has(element)) {
        frozenBuyboxTitles.set(element, element.getAttribute('title'));
      }
      element.classList.add('zenbuy-cart-frozen');
      element.setAttribute('data-zenbuy-frozen', 'true');
      // Keep the native tooltip short and specific.  The control remains
      // hoverable for this explanation, but its capture handler blocks every
      // retail and ZenBuy purchase action while the POI is active.
      element.title = 'Cancel first';
      frozenBuyboxElements.add(element);
    };

    cartButtons.forEach(btn => {
      freezeElement(btn);

      // Visually shadow and gray out the button container (.a-button, .a-button-inner)
      const visualWrapper = btn.closest('.a-button') || btn.closest('.a-button-stack') || btn.closest('#addToCart_feature_div') || btn;
      if (visualWrapper) {
        freezeElement(visualWrapper);
        const inner = visualWrapper.querySelector('.a-button-inner');
        if (inner) {
          freezeElement(inner);
        }
      }

      const clickHandler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        showZenBuyToast({
          title: 'Purchase is on ice',
          message: `This item is currently locked in your cooldown vault (${durLabel}). Cancel Put on Ice when you are ready to buy.`
        });
      };

      btn.addEventListener('click', clickHandler, true);
      frozenBuyboxBindings.push({ target: btn, handler: clickHandler });
      if (visualWrapper && visualWrapper !== btn) {
        visualWrapper.addEventListener('click', clickHandler, true);
        frozenBuyboxBindings.push({ target: visualWrapper, handler: clickHandler });
      }
    });

    const primaryCartBtn = cartButtons[0];
    if (primaryCartBtn) {
      const banner = document.createElement('div');
      banner.className = 'zenbuy-buybox-frozen-banner';
      banner.innerHTML = `
        <div class="zenbuy-frozen-banner-header">
          <span class="zenbuy-frozen-banner-mark" aria-hidden="true">✦</span>
          <div class="zenbuy-frozen-banner-copy">
            <div class="zenbuy-frozen-banner-eyebrow">ZenBuy cooldown</div>
            <div class="zenbuy-frozen-banner-title">Purchase is on ice</div>
          </div>
          <span class="zenbuy-frozen-banner-time">${durLabel} left</span>
        </div>
        <div class="zenbuy-frozen-banner-desc">
          Buying is paused while this item is on ice.
        </div>
        <button type="button" class="zenbuy-cancel-poi-btn">Cancel Put on Ice</button>
      `;
      const wrapper = primaryCartBtn.closest('#addToCart_feature_div') || primaryCartBtn.closest('.a-button-stack') || primaryCartBtn.closest('.a-button') || primaryCartBtn;
      if (wrapper && wrapper.parentElement) {
        wrapper.parentElement.insertBefore(banner, wrapper);
        banner.querySelector('.zenbuy-cancel-poi-btn')?.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          cancelPutOnIce(event.currentTarget);
        });
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
        <div class="zenbuy-averted-banner-header">
          <span class="zenbuy-averted-banner-mark" aria-hidden="true">✦</span>
          <div class="zenbuy-averted-banner-copy">
            <div class="zenbuy-averted-banner-eyebrow">ZenBuy decision</div>
            <div class="zenbuy-averted-banner-title">Purchase set aside</div>
          </div>
          <span class="zenbuy-averted-banner-status">Saved</span>
        </div>
        <div class="zenbuy-averted-banner-desc">
          You chose not to buy this item. $${Number(item.price).toFixed(2)} and ${item.hoursOfWork}h of work time stay with you.
        </div>
      `;
      const wrapper = primaryCartBtn.closest('#addToCart_feature_div') || primaryCartBtn.closest('.a-button-stack') || primaryCartBtn.closest('.a-button') || primaryCartBtn;
      if (wrapper && wrapper.parentElement) {
        wrapper.parentElement.insertBefore(banner, wrapper);
      }
    }
  }

  function openInterceptModal(purchaseButton) {
    if (document.querySelector('.zenbuy-modal-overlay')) return;

    const cooldownSecs = currentEvaluation?.cooldownDurationSeconds || (48 * 3600);
    const durLabel = formatDuration(cooldownSecs);

    const overlay = document.createElement('div');
    overlay.className = 'zenbuy-modal-overlay';

    overlay.innerHTML = `
      <div class="zenbuy-modal-card" role="dialog" aria-modal="true" aria-labelledby="zenbuy-reflection-title">
        <button type="button" class="zenbuy-reflection-close" id="zenbuy-reflection-close" aria-label="Close reflection check">×</button>
        <div class="zenbuy-modal-header">ZenBuy pause</div>
        <div class="zenbuy-modal-title" id="zenbuy-reflection-title">${escapeHtml(currentProduct.title)}</div>
        <div class="zenbuy-modal-nudge" id="zenbuy-nudge-text">
          One quick question…
        </div>
        <div class="zenbuy-modal-metrics">
          <div class="zenbuy-metric-row">
            <span class="zenbuy-metric-label">Cost</span>
            <span class="zenbuy-metric-val">$${Number(currentProduct.price).toFixed(2)}</span>
          </div>
          <div class="zenbuy-metric-row">
            <span class="zenbuy-metric-label">Work</span>
            <span class="zenbuy-metric-val">${currentEvaluation.hoursOfWork}h</span>
          </div>
          <div class="zenbuy-metric-row">
            <span class="zenbuy-metric-label">Risk</span>
            <span class="zenbuy-metric-val">${currentEvaluation.score} / 100</span>
          </div>
        </div>

        <div class="zenbuy-modal-actions">
          <div class="zenbuy-reflection-countdown" id="zenbuy-reflection-countdown" aria-live="polite">
            Choose in <strong>${REFLECTION_GATE_SECONDS}s</strong>. Close anytime.
          </div>
          <button type="button" class="zenbuy-btn-primary" id="zenbuy-confirm-ice" disabled>✦ Put on Ice</button>
          <button type="button" class="zenbuy-btn-secondary" id="zenbuy-bypass" disabled>Continue</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const confirmIceBtn = overlay.querySelector('#zenbuy-confirm-ice');
    const bypassBtn = overlay.querySelector('#zenbuy-bypass');
    const countdownEl = overlay.querySelector('#zenbuy-reflection-countdown');
    const closeBtn = overlay.querySelector('#zenbuy-reflection-close');
    const unlocksAt = Date.now() + (REFLECTION_GATE_SECONDS * 1000);
    let countdownTimer = null;

    function closeModal() {
      if (countdownTimer) window.clearInterval(countdownTimer);
      document.removeEventListener('keydown', closeOnEscape);
      overlay.remove();
    }

    function closeOnEscape(event) {
      if (event.key === 'Escape') closeModal();
    }

    function updateReflectionGate() {
      const remainingSeconds = Math.max(0, Math.ceil((unlocksAt - Date.now()) / 1000));
      if (remainingSeconds > 0) {
        countdownEl.innerHTML = `Choose in <strong>${remainingSeconds}s</strong>. Close anytime.`;
        return;
      }

      confirmIceBtn.disabled = false;
      bypassBtn.disabled = false;
      countdownEl.textContent = 'Ready when you are.';
      if (countdownTimer) window.clearInterval(countdownTimer);
    }

    closeBtn.addEventListener('click', closeModal);
    document.addEventListener('keydown', closeOnEscape);
    countdownTimer = window.setInterval(updateReflectionGate, 250);
    updateReflectionGate();

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
      const nudgeEl = overlay.querySelector('#zenbuy-nudge-text');
      if (nudgeEl) {
        if (res && res.nudge) {
          nudgeEl.textContent = res.nudge;
        } else {
          const hrs = currentEvaluation?.hoursOfWork || (currentProduct.price / 30).toFixed(1);
          nudgeEl.textContent = `This costs ${hrs} hours of work. Is it worth it today?`;
        }
      }
    }).catch(err => {
      const nudgeEl = overlay.querySelector('#zenbuy-nudge-text');
      if (nudgeEl) {
        const hrs = currentEvaluation?.hoursOfWork || (currentProduct.price / 30).toFixed(1);
        nudgeEl.textContent = `This costs ${hrs} hours of work. Is it worth it today?`;
      }
    });

    if (confirmIceBtn) {
      confirmIceBtn.addEventListener('click', async () => {
        confirmIceBtn.disabled = true;
        confirmIceBtn.textContent = 'Adding to Ice…';

        const result = await chrome.runtime.sendMessage({
          type: 'SAVE_TO_VAULT',
          payload: currentProductVaultPayload()
        });

        currentVaultStatus = {
          found: true,
          item: result?.item,
          isFrozen: true,
          remainingMs: cooldownSecs * 1000
        };
        markIceButtonActive(document.querySelector('.zenbuy-ice-btn'), durLabel);
        closeModal();
        freezeBuybox(cooldownSecs * 1000, durLabel);
        showZenBuyToast({
          title: 'Purchase is on ice',
          message: `Cooldown timer started (${durLabel}). Open the ZenBuy extension popup to review status.`
        });
      });
    }

    if (bypassBtn) {
      bypassBtn.addEventListener('click', () => {
        closeModal();
        if (!purchaseButton?.isConnected) return;

        // The original action (Add to Cart versus Buy Now) stays intact. The
        // interception listeners see this one synthetic click and stand down;
        // the retailer then handles it exactly as it normally would.
        isIntercepted = true;
        try {
          purchaseButton.click();
        } finally {
          window.setTimeout(() => { isIntercepted = false; }, 0);
        }
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

    // Tier 2 keeps every purchase control visible and clickable, but presents
    // it in a paused state. The reflection check opens before the retailer can
    // run the original action; "Continue purchase" later replays that exact
    // control, so Add to Cart and Buy Now remain distinct flows.
    const itemIsFrozen = Boolean(currentVaultStatus?.isFrozen);
    cartButtons.forEach(button => {
      const wrapper = button.closest('.a-button') || button.closest('.a-button-stack') || button;
      if (itemIsFrozen) {
        // Do not turn an active POI back into a Tier 2 reflection control on
        // a reload. The frozen state is authoritative until the user cancels.
        button.title = 'Cancel first';
        wrapper.title = 'Cancel first';
        return;
      }

      button.title = 'Open ZenBuy reflection check';
      // Amazon places its human-readable label beside a submit input whose
      // fallback value is often "Submit". Style the surrounding native button
      // shell, never that input itself, so Amazon keeps rendering "Buy Now".
      const visualTarget = button.matches('input') && wrapper !== button ? wrapper : button;
      visualTarget.classList.add('zenbuy-purchase-paused');
      wrapper.classList.add('zenbuy-purchase-paused');
      wrapper.title = 'Open ZenBuy reflection check';
    });

    // 2. Inject Tier 2 Warning Banner above the Add to Cart stack
    if (!document.querySelector('.zenbuy-tier2-warning-banner') && !document.querySelector('.zenbuy-buybox-frozen-banner')) {
      const primaryCartBtn = cartButtons[0];
      if (primaryCartBtn) {
        const warn = document.createElement('div');
        warn.className = 'zenbuy-tier2-warning-banner';
        warn.innerHTML = `
          <div class="zenbuy-tier2-warning-header">
            <span class="zenbuy-tier2-warning-mark" aria-hidden="true">✦</span>
            <div class="zenbuy-tier2-warning-copy">
              <div class="zenbuy-tier2-warning-eyebrow">ZenBuy reflection</div>
              <div class="zenbuy-tier2-title">Reflection recommended</div>
            </div>
            <span class="zenbuy-tier2-score">${currentEvaluation.score}/100</span>
          </div>
          <div class="zenbuy-tier2-desc">
            <strong>Choose a purchase button for a quick check.</strong>
          </div>
        `;
        const wrapper = primaryCartBtn.closest('#addToCart_feature_div') || primaryCartBtn.closest('.a-button-stack') || primaryCartBtn.closest('.a-button') || primaryCartBtn;
        if (wrapper && wrapper.parentElement) {
          wrapper.parentElement.insertBefore(warn, wrapper);
        }
      }
    }

    // 3. Hook only the retail button and its own visual shell. Do not attach
    // to broad buy-box containers or forms: those also contain ZenBuy cards,
    // banners, and score controls that must remain independent.
    cartButtons.forEach(btn => {
      const elementsToHook = [...new Set([
        btn,
        btn.closest('.a-button'),
        btn.closest('.a-button-inner')
      ].filter(Boolean))];

      elementsToHook.forEach(target => {
        if (target.dataset.zenbuyHooked) return;
        target.dataset.zenbuyHooked = 'true';

        target.addEventListener('click', (e) => {
          // The POI control is ZenBuy's own explicit opt-in. It may live
          // inside Amazon's add-to-cart container, which is also observed for
          // retailer purchase actions, but it must never trigger reflection.
          if (e.target instanceof Element && e.target.closest('.zenbuy-ice-btn, .zenbuy-cancel-poi-btn')) return;

          // An active Put on Ice is a strict lock. Tier 2's reflective flow
          // applies only before that explicit POI choice, never while frozen.
          if (currentVaultStatus?.isFrozen || (e.target instanceof Element && e.target.closest('.zenbuy-cart-frozen'))) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            return;
          }

          if (currentEvaluation && currentEvaluation.action === 'ACTION_INTERCEPT' && !isIntercepted) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            openInterceptModal(btn);
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

    // On Amazon's order-confirmation page this creates a history record. It is
    // deliberately fire-and-forget so the normal product-page experience does
    // not wait for local persistence.
    recordObservedPurchase();

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
    const productBeingEvaluated = currentProduct;
    currentEvaluation = null;
    currentVaultStatus = null;
    isIntercepted = false;

    // Make ZenBuy visible immediately. Gemini still owns the final score and
    // decision, but the page no longer waits on the network before showing
    // where those answers will land.
    const priceElem = getPriceElement();
    injectWageBadge(priceElem);
    injectFloatingDebugButton();

    // Do not begin the Gemini-dependent evaluation until the loading card has
    // had a frame to paint. This turns request time into visible progress.
    await waitForPreviewPaint();

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
          title: productBeingEvaluated.title,
          price: productBeingEvaluated.price,
          category: productBeingEvaluated.category,
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

      const latestProduct = scrapeProduct();
      if (latestProduct && (latestProduct.price !== productBeingEvaluated.price || latestProduct.title !== productBeingEvaluated.title)) {
        return;
      }
      currentEvaluation = evaluation;

      // Neutralize dark patterns (low-stock triggers, countdown timers)
      neutralizeDarkPatterns();

      // Fill the already-visible preview with the final IRS evaluation.
      if (priceElem) {
        injectWageBadge(priceElem, evaluation.hoursOfWork, evaluation);
      }

      // Only an active cooldown changes the product page. Expired and archived
      // items stay quiet; users revisit those intentionally from the Vault.
      const vaultCheck = await chrome.runtime.sendMessage({
        type: 'CHECK_VAULT_ITEM',
        payload: {
          url: currentProduct.url || window.location.href,
          title: currentProduct.title,
          productId: currentProduct.productId,
          asin: currentProduct.asin
        }
      });

      currentVaultStatus = vaultCheck?.found ? vaultCheck : null;
      if (currentVaultStatus) {
        if (currentVaultStatus.isFrozen) {
          const remSecs = Math.ceil(currentVaultStatus.remainingMs / 1000);
          const dur = formatDuration(remSecs);
          freezeBuybox(currentVaultStatus.remainingMs, dur);
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

      // A SPA may have swapped products while Gemini was responding. Re-read
      // the page once so an old evaluation cannot remain attached to a new one.
      const latest = scrapeProduct();
      if (latest && (latest.price !== currentProduct?.price || latest.title !== currentProduct?.title)) {
        init();
      }
    }
  }

  function tryInjectIceButton() {
    if (!currentEvaluation) return;
    if (currentEvaluation.action !== 'ACTION_PASSIVE_ICE' && currentEvaluation.action !== 'ACTION_INTERCEPT') return;

    // Check if an existing connected and visible ice button is already in place
    const existing = document.querySelector('.zenbuy-ice-btn');
    const itemIsOnIce = Boolean(currentVaultStatus?.isFrozen);
    const remainingLabel = itemIsOnIce
      ? formatDuration(Math.ceil(currentVaultStatus.remainingMs / 1000))
      : null;
    if (existing && existing.isConnected && existing.offsetParent !== null) {
      if (itemIsOnIce) markIceButtonActive(existing, remainingLabel);
      return;
    }

    const cartButtons = (adapter && typeof adapter.getCartButtons === 'function')
      ? adapter.getCartButtons()
      : findCartButtons();
    const primaryCartBtn = cartButtons[0];

    if (primaryCartBtn) {
      injectIceButton(primaryCartBtn, { onIce: itemIsOnIce, durationLabel: remainingLabel });
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
