/**
 * ZenBuy Background Service Worker (Manifest V3)
 */

importScripts('shared/irs.js', 'shared/gemini.js');

// Initialize defaults on install
chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get(['hourlyWage', 'savingsGoal', 'vault']);
  const updates = {};
  if (data.hourlyWage === undefined) updates.hourlyWage = 30;
  if (data.savingsGoal === undefined) updates.savingsGoal = 'Pay down credit card debt';
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
});

async function handleEvaluateProduct(payload) {
  const { title, price, category, velocity, darkPatterns, isBnplActive, simulatedHour } = payload;
  const storage = await chrome.storage.local.get(['hourlyWage', 'geminiApiKey']);
  const hourlyWage = Number(storage.hourlyWage) || 30;
  const apiKey = storage.geminiApiKey || '';

  // Classify taxonomy score
  const classification = await classifyProductWithGemini(title, category, price, apiKey);
  const taxonomyScore = classification.hedonicScore;

  // Compute IRS
  const irsResult = calculateIRS({
    taxonomyScore,
    velocity,
    localHour: simulatedHour !== undefined ? simulatedHour : new Date().getHours(),
    darkPatterns,
    price,
    hourlyWage,
    isBnplActive
  });

  const hoursOfWork = (price / hourlyWage).toFixed(1);

  return {
    ...irsResult,
    classification,
    hoursOfWork,
    hourlyWage
  };
}

async function handleGetSocraticNudge(payload) {
  const { title, price } = payload;
  const storage = await chrome.storage.local.get(['hourlyWage', 'savingsGoal', 'geminiApiKey']);
  const hourlyWage = Number(storage.hourlyWage) || 30;
  const savingsGoal = storage.savingsGoal || 'Build savings';
  const apiKey = storage.geminiApiKey || '';

  const nudge = await generateSocraticReflection({
    productTitle: title,
    price,
    hourlyWage,
    savingsGoal,
    apiKey
  });

  return { nudge };
}

async function handleSaveToVault(item) {
  const { vault = [] } = await chrome.storage.local.get('vault');
  const now = Date.now();
  const newItem = {
    id: `item_${now}_${Math.random().toString(36).substr(2, 6)}`,
    title: item.title,
    price: item.price,
    url: item.url,
    imageUrl: item.imageUrl || '',
    hoursOfWork: item.hoursOfWork,
    irsScore: item.irsScore,
    createdAt: now,
    expiresAt: now + (48 * 60 * 60 * 1000), // 48 hours
    status: 'FROZEN' // FROZEN, ARCHIVED_SAVED, UNLOCKED
  };

  vault.unshift(newItem);
  await chrome.storage.local.set({ vault });
  return { success: true, item: newItem };
}

async function handleGetVaultData() {
  const data = await chrome.storage.local.get(['vault', 'hourlyWage', 'savingsGoal', 'geminiApiKey']);
  const vault = Array.isArray(data.vault) ? data.vault : [];

  let totalSaved = 0;
  let totalHours = 0;

  vault.forEach(item => {
    if (item.status === 'ARCHIVED_SAVED' || item.status === 'FROZEN') {
      totalSaved += Number(item.price) || 0;
      totalHours += Number(item.hoursOfWork) || 0;
    }
  });

  return {
    vault,
    totalSaved: totalSaved.toFixed(2),
    totalHours: totalHours.toFixed(1),
    hourlyWage: data.hourlyWage || 30,
    savingsGoal: data.savingsGoal || '',
    hasApiKey: Boolean(data.geminiApiKey)
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
