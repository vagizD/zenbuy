/**
 * ZenBuy Background Service Worker (Manifest V3)
 */

importScripts('config/config.js');

// Optionally import local overrides if present
try {
  importScripts('config/config.local.js');
} catch (e) {
  // config.local.js is optional
}

importScripts('engine/irs.js', 'engine/vault_lifecycle.js', 'shared/gemini.js');

const LIFECYCLE_STORAGE_KEY = 'zenbuyLifecycleState';
const LIFECYCLE_MIGRATION_KEY = 'zenbuyLifecycleMigrationV1';
const LEGACY_VAULT_STORAGE_KEY = 'vault';

function lifecycle() {
  if (typeof ZenBuyVaultLifecycle === 'undefined') {
    throw new Error('ZenBuy vault lifecycle is unavailable.');
  }
  return ZenBuyVaultLifecycle;
}

async function ensureLifecycleState() {
  const data = await chrome.storage.local.get([LIFECYCLE_STORAGE_KEY, LIFECYCLE_MIGRATION_KEY]);
  const engine = lifecycle();

  // The prototype stored its old vault as a mixed-status array. This is an
  // intentional clean break: requested legacy records are removed instead of
  // guessing state transitions from incomplete data.
  if (!data[LIFECYCLE_MIGRATION_KEY]) {
    const state = engine.createEmptyState();
    await chrome.storage.local.set({
      [LIFECYCLE_STORAGE_KEY]: state,
      [LIFECYCLE_MIGRATION_KEY]: true
    });
    await chrome.storage.local.remove(LEGACY_VAULT_STORAGE_KEY);
    return state;
  }

  const state = engine.normalizeState(data[LIFECYCLE_STORAGE_KEY]);
  return state;
}

async function loadLifecycleState({ reconcile = true } = {}) {
  const state = await ensureLifecycleState();
  const expired = reconcile ? lifecycle().reconcileExpiredItems(state) : [];
  if (expired.length > 0) await saveLifecycleState(state);
  return state;
}

async function saveLifecycleState(state) {
  await chrome.storage.local.set({ [LIFECYCLE_STORAGE_KEY]: state });
}

function getRuntimeConfig() {
  const base = JSON.parse(JSON.stringify(ZENBUY_CONFIG));
  if (typeof ZENBUY_LOCAL_CONFIG !== 'undefined') {
    if (ZENBUY_LOCAL_CONFIG.gemini?.apiKey) {
      base.gemini.apiKey = ZENBUY_LOCAL_CONFIG.gemini.apiKey;
    }
    if (ZENBUY_LOCAL_CONFIG.userDefaults?.hourlyWage) {
      base.userDefaults.hourlyWage = ZENBUY_LOCAL_CONFIG.userDefaults.hourlyWage;
    }
    if (ZENBUY_LOCAL_CONFIG.vault?.cooldownDurationSeconds !== undefined) {
      base.vault.cooldownDurationSeconds = ZENBUY_LOCAL_CONFIG.vault.cooldownDurationSeconds;
    }
  }
  return base;
}

// Initialize defaults on install
chrome.runtime.onInstalled.addListener(async () => {
  const config = getRuntimeConfig();
  const data = await chrome.storage.local.get(['hourlyWage', 'savingsGoal']);
  const updates = {};
  if (data.hourlyWage === undefined) updates.hourlyWage = config.userDefaults.hourlyWage;
  if (data.savingsGoal === undefined) updates.savingsGoal = config.userDefaults.savingsGoal;
  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }

  await ensureLifecycleState();

  // Older versions exposed this through the settings UI. The runtime now uses
  // only the developer-owned local config, so remove the legacy stored copy.
  await chrome.storage.local.remove('geminiApiKey');
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'EVALUATE_PRODUCT') {
    handleEvaluateProduct(request.payload).then(sendResponse).catch(err => {
      sendResponse({ error: err.message });
    });
    return true; // Keep channel open for async response
  }

  if (request.type === 'GET_SOCRATIC_NUDGE') {
    handleGetSocraticNudge(request.payload).then(sendResponse).catch(err => {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (request.type === 'SAVE_TO_VAULT') {
    handleSaveToVault(request.payload).then(sendResponse).catch(err => {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (request.type === 'GET_VAULT_DATA') {
    handleGetVaultData().then(sendResponse).catch(err => {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (request.type === 'UPDATE_VAULT_ITEM') {
    handleUpdateVaultItem(request.payload).then(sendResponse).catch(err => {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (request.type === 'ARCHIVE_ITEM') {
    handleArchiveItem(request.payload).then(sendResponse).catch(err => {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (request.type === 'CANCEL_PUT_ON_ICE') {
    handleCancelPutOnIce(request.payload).then(sendResponse).catch(err => {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (request.type === 'CONTINUE_TO_PURCHASE') {
    handleContinueToPurchase(request.payload).then(sendResponse).catch(err => {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (request.type === 'REICE_ITEM') {
    handleReiceItem(request.payload).then(sendResponse).catch(err => {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (request.type === 'RECORD_PURCHASE_CONFIRMATION') {
    handleRecordPurchaseConfirmation(request.payload).then(sendResponse).catch(err => {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (request.type === 'CHECK_VAULT_ITEM') {
    handleCheckVaultItem(request.payload).then(sendResponse).catch(err => {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (request.type === 'CLEAR_VAULT') {
    handleClearVault().then(sendResponse).catch(err => {
      sendResponse({ error: err.message });
    });
    return true;
  }
});

const CLASSIFICATION_CACHE_KEY = 'zenbuyTaxonomyCache';
const CLASSIFICATION_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CLASSIFICATION_CACHE_LIMIT = 75;

function getClassificationCacheId(title, category, price) {
  return [title, category, Number(price).toFixed(2)]
    .map(value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' '))
    .join('|');
}

async function getCachedClassification(cacheId) {
  const { [CLASSIFICATION_CACHE_KEY]: rawCache = {} } = await chrome.storage.local.get(CLASSIFICATION_CACHE_KEY);
  const cache = rawCache && typeof rawCache === 'object' ? rawCache : {};
  const entry = cache[cacheId];

  if (!entry || !entry.classification || (Date.now() - entry.createdAt) > CLASSIFICATION_CACHE_TTL_MS) {
    return null;
  }

  return entry.classification;
}

async function cacheClassification(cacheId, classification) {
  const { [CLASSIFICATION_CACHE_KEY]: rawCache = {} } = await chrome.storage.local.get(CLASSIFICATION_CACHE_KEY);
  const cache = rawCache && typeof rawCache === 'object' ? rawCache : {};
  const now = Date.now();

  cache[cacheId] = { classification, createdAt: now };

  const entries = Object.entries(cache)
    .filter(([, entry]) => entry && entry.createdAt && now - entry.createdAt <= CLASSIFICATION_CACHE_TTL_MS)
    .sort(([, a], [, b]) => b.createdAt - a.createdAt)
    .slice(0, CLASSIFICATION_CACHE_LIMIT);

  await chrome.storage.local.set({ [CLASSIFICATION_CACHE_KEY]: Object.fromEntries(entries) });
}

async function handleCheckVaultItem(payload) {
  const itemQuery = payload || {};
  const state = await loadLifecycleState();
  const now = Date.now();
  const match = lifecycle().findItem(state, itemQuery);
  if (!match) return { found: false };

  const remainingMs = match.poi.state === lifecycle().POI_STATE.ACTIVE
    ? Math.max(0, (match.poi.expiresAt || now) - now)
    : 0;

  return {
    found: true,
    item: match,
    poiState: match.poi.state,
    location: match.location,
    purchaseState: match.purchase.state,
    remainingMs,
    isCooldownExpired: match.poi.state === lifecycle().POI_STATE.EXPIRED,
    isFrozen: match.poi.state === lifecycle().POI_STATE.ACTIVE && match.location === lifecycle().COLLECTION.VAULT
  };
}

async function handleEvaluateProduct(payload) {
  const { title, price, category, velocity, darkPatterns, isBnplActive, simulatedHour } = payload;
  const config = getRuntimeConfig();
  const storage = await chrome.storage.local.get(['hourlyWage', 'cooldownDurationSeconds']);
  
  const hourlyWage = Number(storage.hourlyWage) || config.userDefaults.hourlyWage || 30;
  const apiKey = config.gemini.apiKey || '';
  const cooldownDurationSeconds = storage.cooldownDurationSeconds !== undefined
    ? Number(storage.cooldownDurationSeconds)
    : (config.vault?.cooldownDurationSeconds || (48 * 60 * 60));

  const effectiveGeminiConfig = {
    ...config.gemini,
    apiKey
  };

  // AI-driven taxonomy & necessity classification
  let classification = { classification: 'HEDONIC_WANT', hedonicScore: 70, confidence: 0.8 };
  if (apiKey) {
    const cacheId = getClassificationCacheId(title, category, price);
    try {
      const cachedClassification = await getCachedClassification(cacheId);
      if (cachedClassification) {
        classification = cachedClassification;
      } else {
        classification = await classifyProductWithGemini(title, category, price, effectiveGeminiConfig);
        // Keep repeated visits to the same product out of the network path.
        await cacheClassification(cacheId, classification).catch(err => {
          console.warn('Unable to save Gemini classification cache:', err);
        });
      }
    } catch (err) {
      console.warn('Gemini classification error, using fallback score:', err);
    }
  }

  const taxonomyScore = classification.hedonicScore;

  const evalHour = simulatedHour !== undefined ? simulatedHour : new Date().getHours();

  // Compute IRS using the modular calculation engine
  const irsResult = ZenBuyCurrentIRSEngine.evaluate({
    taxonomyScore,
    velocity,
    localHour: evalHour,
    darkPatterns,
    price,
    hourlyWage,
    isBnplActive
  });

  const hoursOfWork = (price / hourlyWage).toFixed(1);
  const irsDefinition = ZenBuyCurrentIRSEngine.getDefinition();
  const weights = irsResult.weights || irsDefinition.weights;
  const thresholds = irsDefinition.thresholds;

  const taxonomyDetails = classification.luxuryMultiplier && classification.luxuryMultiplier > 1.2
    ? `${classification.classification} (Hedonic: ${taxonomyScore}/100, ${classification.luxuryMultiplier.toFixed(1)}x category baseline)`
    : `${classification.classification} (Hedonic Score: ${taxonomyScore}/100, Conf: ${(classification.confidence * 100).toFixed(0)}%)`;

  const breakdown = [
    {
      dimension: 'Taxonomy / Necessity',
      rawScore: irsResult.subScores.taxonomy,
      weight: weights.taxonomy,
      weightedContribution: Number((weights.taxonomy * irsResult.subScores.taxonomy).toFixed(1)),
      details: taxonomyDetails
    },
    {
      dimension: 'Browsing Velocity',
      rawScore: irsResult.subScores.velocity,
      weight: weights.velocity,
      weightedContribution: Number((weights.velocity * irsResult.subScores.velocity).toFixed(1)),
      details: `Dwell: ${velocity?.dwellTimeSeconds || 0}s, Social Ref: ${Boolean(velocity?.isSocialReferrer)}, Direct Search: ${Boolean(velocity?.isDirectSearch)}`
    },
    {
      dimension: 'Circadian State',
      rawScore: irsResult.subScores.circadian,
      weight: weights.circadian,
      weightedContribution: Number((weights.circadian * irsResult.subScores.circadian).toFixed(1)),
      details: `Local Hour ${evalHour}:00 (${getCircadianLabel(evalHour)})`
    },
    {
      dimension: 'Dark Patterns',
      rawScore: irsResult.subScores.darkPattern,
      weight: weights.darkPattern,
      weightedContribution: Number((weights.darkPattern * irsResult.subScores.darkPattern).toFixed(1)),
      details: formatDarkPatternsList(darkPatterns)
    },
    {
      dimension: 'Financial Salience',
      rawScore: irsResult.subScores.financial,
      weight: weights.financial,
      weightedContribution: Number((weights.financial * irsResult.subScores.financial).toFixed(1)),
      details: `Price: $${Number(price).toFixed(2)}, Wage: $${hourlyWage}/h, Labor: ${hoursOfWork}h, BNPL: ${Boolean(isBnplActive)}`
    }
  ];

  return {
    ...irsResult,
    classification,
    hoursOfWork,
    hourlyWage,
    cooldownDurationSeconds,
    breakdown,
    inputs: {
      title,
      price,
      hourlyWage,
      hoursOfWork,
      category,
      evalHour,
      velocity,
      darkPatterns,
      isBnplActive
    },
    weights,
    thresholds,
    timestamp: new Date().toISOString()
  };
}

function getCircadianLabel(hour) {
  if ([23, 0, 1, 2, 3, 4].includes(hour)) return 'Peak Depletion / Late Night';
  if ([21, 22, 5].includes(hour)) return 'Evening Fatigue';
  if ([18, 19, 20].includes(hour)) return 'Post-Work Transition';
  return 'Daytime Baseline';
}

function formatDarkPatternsList(dp) {
  if (!dp) return 'None detected';
  const rules = [
    ['lowStockAmbiguity', 'Low stock / scarcity'],
    ['deceptiveUrgency', 'Countdown / urgency'],
    ['fabricatedSocialProof', 'Social-proof pressure'],
    ['preselection', 'Preselected add-ons']
  ];
  const lines = rules.map(([key, label]) => {
    const evidence = dp.evidence?.[key];
    const matches = Array.isArray(evidence?.matches) ? evidence.matches : [];
    const excerpts = matches
      .map(match => match?.text ? `“${match.text}”` : '')
      .filter(Boolean)
      .join('; ');
    if (dp[key]) return `${label}: detected${excerpts ? ` — ${excerpts}` : ''}`;
    return `${label}: not detected`;
  });
  const availability = Array.isArray(dp.evidence?.availabilityContext)
    ? dp.evidence.availabilityContext.map(match => match?.text).filter(Boolean).join('; ')
    : '';
  if (availability) lines.push(`Availability context: ${availability}`);
  return lines.join('\n');
}

async function handleGetSocraticNudge(payload) {
  const { title, price, categoryBaselinePrice, luxuryMultiplier } = payload;
  const config = getRuntimeConfig();
  const storage = await chrome.storage.local.get(['hourlyWage', 'savingsGoal']);
  
  const hourlyWage = Number(storage.hourlyWage) || config.userDefaults.hourlyWage || 30;
  const savingsGoal = storage.savingsGoal || config.userDefaults.savingsGoal;
  const apiKey = config.gemini.apiKey || '';

  const effectiveGeminiConfig = {
    ...config.gemini,
    apiKey
  };

  const nudge = await generateSocraticReflection({
    productTitle: title,
    price,
    hourlyWage,
    savingsGoal,
    categoryBaselinePrice,
    luxuryMultiplier
  }, effectiveGeminiConfig);

  return { nudge };
}

async function handleSaveToVault(item) {
  const config = getRuntimeConfig();
  const storage = await chrome.storage.local.get('cooldownDurationSeconds');
  const cooldownSecs = storage.cooldownDurationSeconds !== undefined
    ? Number(storage.cooldownDurationSeconds)
    : (config.vault?.cooldownDurationSeconds || (48 * 60 * 60));
  const state = await loadLifecycleState();
  const savedItem = lifecycle().putOnIce(state, item, { cooldownDurationSeconds: cooldownSecs });
  await saveLifecycleState(state);
  return { success: true, item: savedItem };
}

async function handleGetVaultData() {
  const config = getRuntimeConfig();
  const data = await chrome.storage.local.get(['hourlyWage', 'savingsGoal', 'cooldownDurationSeconds']);
  const state = await loadLifecycleState();
  const { activeItems, archiveItems, purchaseHistory } = lifecycle().getCollections(state);
  const sum = (items, key) => items.reduce((total, item) => total + (Number(item.snapshot?.[key]) || 0), 0);

  return {
    schemaVersion: state.schemaVersion,
    items: state.items,
    events: state.events,
    activeItems,
    archiveItems,
    purchaseHistory,
    // Kept temporarily for the existing popup's active-vault semantics.
    vault: activeItems,
    archiveAmount: sum(archiveItems, 'price').toFixed(2),
    archiveHours: sum(archiveItems, 'hoursOfWork').toFixed(1),
    archiveCount: archiveItems.length,
    pendingIceAmount: sum(activeItems, 'price').toFixed(2),
    pendingIceHours: sum(activeItems, 'hoursOfWork').toFixed(1),
    pendingIceCount: activeItems.length,
    purchaseAmount: sum(purchaseHistory, 'price').toFixed(2),
    purchaseHours: sum(purchaseHistory, 'hoursOfWork').toFixed(1),
    purchaseCount: purchaseHistory.length,
    hourlyWage: data.hourlyWage || config.userDefaults.hourlyWage,
    savingsGoal: data.savingsGoal || config.userDefaults.savingsGoal,
    cooldownDurationSeconds: data.cooldownDurationSeconds !== undefined
      ? Number(data.cooldownDurationSeconds)
      : (config.vault?.cooldownDurationSeconds || (48 * 60 * 60))
  };
}

async function handleUpdateVaultItem(payload) {
  const { id, status } = payload;
  if (status === 'ARCHIVED_SAVED') return handleArchiveItem({ id });
  if (status === 'UNLOCKED') return handleContinueToPurchase({ id });
  throw new Error('Unsupported legacy vault status update.');
}

async function handleArchiveItem(payload) {
  const state = await loadLifecycleState();
  const item = lifecycle().archiveItem(state, payload?.id, { reason: 'USER_ARCHIVED' });
  await saveLifecycleState(state);
  return { success: true, item };
}

async function handleCancelPutOnIce(payload) {
  const state = await loadLifecycleState();
  const item = lifecycle().cancelPutOnIce(state, payload?.id, { reason: 'USER_CANCELLED' });
  await saveLifecycleState(state);
  return { success: true, item };
}

async function handleContinueToPurchase(payload) {
  const state = await loadLifecycleState();
  const item = lifecycle().continueToPurchase(state, payload?.id);
  await saveLifecycleState(state);
  return { success: true, item };
}

async function handleReiceItem(payload) {
  const config = getRuntimeConfig();
  const storage = await chrome.storage.local.get('cooldownDurationSeconds');
  const cooldownDurationSeconds = storage.cooldownDurationSeconds !== undefined
    ? Number(storage.cooldownDurationSeconds)
    : (config.vault?.cooldownDurationSeconds || (48 * 60 * 60));
  const state = await loadLifecycleState();
  const existing = lifecycle().getItemById(state, payload?.id);
  if (!existing) throw new Error('Item not found.');
  if (existing.location === lifecycle().COLLECTION.PURCHASE_HISTORY) {
    throw new Error('Purchased items cannot be put back on ice.');
  }

  const item = lifecycle().putOnIce(state, {
    ...existing.product,
    ...existing.snapshot
  }, { cooldownDurationSeconds, reason: 'REICED_FROM_ARCHIVE' });
  await saveLifecycleState(state);
  return { success: true, item };
}

async function handleRecordPurchaseConfirmation(payload) {
  const purchases = Array.isArray(payload?.purchases) ? payload.purchases : [payload];
  const confirmationId = typeof payload?.confirmationId === 'string' ? payload.confirmationId : '';
  const source = typeof payload?.source === 'string' ? payload.source : 'AMAZON_ORDER_CONFIRMATION';
  const state = await loadLifecycleState();
  const recorded = [];

  for (const purchase of purchases) {
    if (!purchase || (!purchase.title && !purchase.url && !purchase.asin && !purchase.productId)) continue;
    recorded.push(lifecycle().recordPurchase(state, purchase, {
      source,
      confirmationId
    }));
  }

  if (recorded.length > 0) await saveLifecycleState(state);
  return { success: true, recorded };
}

async function handleClearVault() {
  await chrome.storage.local.set({ [LIFECYCLE_STORAGE_KEY]: lifecycle().createEmptyState() });
  await chrome.storage.local.remove(LEGACY_VAULT_STORAGE_KEY);
  return { success: true };
}
