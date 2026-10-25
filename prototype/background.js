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

importScripts('engine/irs.js', 'shared/gemini.js');

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
  const data = await chrome.storage.local.get(['hourlyWage', 'savingsGoal', 'vault', 'geminiApiKey']);
  const updates = {};
  if (data.hourlyWage === undefined) updates.hourlyWage = config.userDefaults.hourlyWage;
  if (data.savingsGoal === undefined) updates.savingsGoal = config.userDefaults.savingsGoal;
  if (data.geminiApiKey === undefined && config.gemini.apiKey) updates.geminiApiKey = config.gemini.apiKey;
  if (!Array.isArray(data.vault)) updates.vault = [];
  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
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

function extractProductKey(url, title) {
  if (url) {
    try {
      const u = new URL(url);
      const asinMatch = u.pathname.match(/(?:dp|product|d)\/([A-Z0-9]{10})/i) ||
                        u.search.match(/asin=([A-Z0-9]{10})/i);
      if (asinMatch) {
        return `asin_${asinMatch[1].toUpperCase()}`;
      }
    } catch (e) {}
  }
  if (title) {
    return `title_${title.trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40)}`;
  }
  if (url) {
    try {
      const u = new URL(url);
      return `${u.origin}${u.pathname.replace(/\/$/, '')}`;
    } catch (e) {}
  }
  return null;
}

function areSameProduct(itemA, itemB) {
  if (!itemA || !itemB) return false;
  const keyA = extractProductKey(itemA.url, itemA.title);
  const keyB = extractProductKey(itemB.url, itemB.title);
  if (keyA && keyB && keyA === keyB) return true;

  if (itemA.title && itemB.title) {
    const tA = itemA.title.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const tB = itemB.title.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (tA === tB) return true;
    const len = Math.min(20, tA.length, tB.length);
    if (len >= 12 && tA.slice(0, len) === tB.slice(0, len)) {
      return true;
    }
  }
  return false;
}

function deduplicateVault(vault) {
  if (!Array.isArray(vault)) return [];
  const seen = new Set();
  const deduped = [];

  for (const item of vault) {
    const key = extractProductKey(item.url, item.title) || item.id;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(item);
    }
  }
  return deduped;
}

async function handleCheckVaultItem(payload) {
  const { url, title } = payload || {};
  const { vault = [] } = await chrome.storage.local.get('vault');
  const now = Date.now();

  const match = vault.find(item => areSameProduct(item, { url, title }));
  if (!match) return { found: false };

  const remainingMs = Math.max(0, match.expiresAt - now);
  const isCooldownExpired = remainingMs === 0;

  return {
    found: true,
    item: match,
    status: match.status,
    remainingMs,
    isCooldownExpired
  };
}

async function handleEvaluateProduct(payload) {
  const { title, price, category, velocity, darkPatterns, isBnplActive, simulatedHour } = payload;
  const config = getRuntimeConfig();
  const storage = await chrome.storage.local.get(['hourlyWage', 'geminiApiKey', 'cooldownDurationSeconds']);
  
  const hourlyWage = Number(storage.hourlyWage) || config.userDefaults.hourlyWage || 30;
  const apiKey = storage.geminiApiKey || config.gemini.apiKey || '';
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
    try {
      classification = await classifyProductWithGemini(title, category, price, effectiveGeminiConfig);
    } catch (err) {
      console.warn('Gemini classification error, using fallback score:', err);
    }
  }

  const taxonomyScore = classification.hedonicScore;

  const evalHour = simulatedHour !== undefined ? simulatedHour : new Date().getHours();

  // Compute IRS using the modular calculation engine
  const irsResult = evaluateIRS({
    taxonomyScore,
    velocity,
    localHour: evalHour,
    darkPatterns,
    price,
    hourlyWage,
    isBnplActive
  }, config.irs);

  const hoursOfWork = (price / hourlyWage).toFixed(1);
  const weights = irsResult.weights || config.irs.weights;
  const thresholds = config.irs.thresholds;

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
  const detected = [];
  if (dp.lowStockAmbiguity) detected.push('Low Stock / Scarcity');
  if (dp.deceptiveUrgency) detected.push('Countdown / Urgency');
  if (dp.fabricatedSocialProof) detected.push('Social Proof Pressure');
  if (dp.preselection) detected.push('Preselected Add-ons');
  return detected.length ? detected.join(', ') : 'None detected';
}

async function handleGetSocraticNudge(payload) {
  const { title, price, categoryBaselinePrice, luxuryMultiplier } = payload;
  const config = getRuntimeConfig();
  const storage = await chrome.storage.local.get(['hourlyWage', 'savingsGoal', 'geminiApiKey']);
  
  const hourlyWage = Number(storage.hourlyWage) || config.userDefaults.hourlyWage || 30;
  const savingsGoal = storage.savingsGoal || config.userDefaults.savingsGoal;
  const apiKey = storage.geminiApiKey || config.gemini.apiKey || '';

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
  const storage = await chrome.storage.local.get(['cooldownDurationSeconds', 'vault']);
  const cooldownSecs = storage.cooldownDurationSeconds !== undefined
    ? Number(storage.cooldownDurationSeconds)
    : (config.vault?.cooldownDurationSeconds || (48 * 60 * 60));
  const cooldownMs = cooldownSecs * 1000;
  const rawVault = Array.isArray(storage.vault) ? storage.vault : [];
  const vault = deduplicateVault(rawVault);
  const now = Date.now();

  // Deduplication check: check if this product is already in the vault
  const existingIndex = vault.findIndex(v => areSameProduct(v, item));

  let savedItem;
  if (existingIndex >= 0) {
    const existing = vault[existingIndex];
    savedItem = {
      ...existing,
      price: item.price !== undefined ? item.price : existing.price,
      hoursOfWork: item.hoursOfWork || existing.hoursOfWork,
      irsScore: item.irsScore || existing.irsScore,
      imageUrl: item.imageUrl || existing.imageUrl,
      url: item.url || existing.url,
      expiresAt: now + cooldownMs,
      cooldownDurationSeconds: cooldownSecs,
      status: 'FROZEN'
    };
    vault.splice(existingIndex, 1);
    vault.unshift(savedItem);
  } else {
    savedItem = {
      id: `item_${now}_${Math.random().toString(36).substr(2, 6)}`,
      title: item.title,
      price: item.price,
      url: item.url,
      imageUrl: item.imageUrl || '',
      hoursOfWork: item.hoursOfWork,
      irsScore: item.irsScore,
      createdAt: now,
      expiresAt: now + cooldownMs,
      cooldownDurationSeconds: cooldownSecs,
      status: 'FROZEN'
    };
    vault.unshift(savedItem);
  }

  await chrome.storage.local.set({ vault });
  return { success: true, item: savedItem };
}

async function handleGetVaultData() {
  const config = getRuntimeConfig();
  const data = await chrome.storage.local.get(['vault', 'hourlyWage', 'savingsGoal', 'geminiApiKey', 'cooldownDurationSeconds']);
  const rawVault = Array.isArray(data.vault) ? data.vault : [];
  const vault = deduplicateVault(rawVault);

  // Auto-prune existing duplicates in storage
  if (vault.length !== rawVault.length) {
    await chrome.storage.local.set({ vault });
  }

  let savedAmount = 0;
  let savedHours = 0;
  let savedCount = 0;

  let pendingIceAmount = 0;
  let pendingIceHours = 0;
  let pendingIceCount = 0;

  let unlockedAmount = 0;
  let unlockedHours = 0;
  let unlockedCount = 0;

  vault.forEach(item => {
    const price = Number(item.price) || 0;
    const hours = Number(item.hoursOfWork) || 0;
    if (item.status === 'ARCHIVED_SAVED') {
      savedAmount += price;
      savedHours += hours;
      savedCount++;
    } else if (item.status === 'UNLOCKED') {
      unlockedAmount += price;
      unlockedHours += hours;
      unlockedCount++;
    } else { // FROZEN / pending
      pendingIceAmount += price;
      pendingIceHours += hours;
      pendingIceCount++;
    }
  });

  return {
    vault,
    savedAmount: savedAmount.toFixed(2),
    savedHours: savedHours.toFixed(1),
    savedCount,
    pendingIceAmount: pendingIceAmount.toFixed(2),
    pendingIceHours: pendingIceHours.toFixed(1),
    pendingIceCount,
    unlockedAmount: unlockedAmount.toFixed(2),
    unlockedHours: unlockedHours.toFixed(1),
    unlockedCount,
    totalSaved: savedAmount.toFixed(2),
    totalHours: savedHours.toFixed(1),
    hourlyWage: data.hourlyWage || config.userDefaults.hourlyWage,
    savingsGoal: data.savingsGoal || config.userDefaults.savingsGoal,
    hasApiKey: Boolean(data.geminiApiKey || config.gemini.apiKey),
    cooldownDurationSeconds: data.cooldownDurationSeconds !== undefined
      ? Number(data.cooldownDurationSeconds)
      : (config.vault?.cooldownDurationSeconds || (48 * 60 * 60))
  };
}

async function handleUpdateVaultItem(payload) {
  const { id, status } = payload;
  const { vault = [] } = await chrome.storage.local.get('vault');
  const updatedVault = vault.map(item => {
    if (item.id === id) {
      return { ...item, status };
    }
    return item;
  });

  await chrome.storage.local.set({ vault: updatedVault });
  return { success: true };
}

async function handleClearVault() {
  await chrome.storage.local.set({ vault: [] });
  return { success: true };
}
