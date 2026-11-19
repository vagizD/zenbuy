/**
 * ZenBuy local-first vault lifecycle.
 *
 * This module deliberately has no Chrome API dependency. The extension
 * background worker persists its state, while these functions own the state
 * transitions and make them testable before a hosted API exists.
 */
(function (root) {
  'use strict';

  const SCHEMA_VERSION = 1;
  const MAX_EVENTS = 500;

  const POI_STATE = Object.freeze({
    INACTIVE: 'POI_INACTIVE',
    ACTIVE: 'POI_ACTIVE',
    EXPIRED: 'POI_EXPIRED',
    CANCELLED: 'POI_CANCELLED'
  });

  const COLLECTION = Object.freeze({
    VAULT: 'VAULT',
    ARCHIVE: 'ARCHIVE',
    PURCHASE_HISTORY: 'PURCHASE_HISTORY'
  });

  const PURCHASE_STATE = Object.freeze({
    NONE: 'NOT_PURCHASED',
    PENDING: 'PENDING_CONFIRMATION',
    PURCHASED: 'PURCHASED'
  });

  const PRICE_SEARCH_STATUS = Object.freeze({
    NOT_REQUESTED: 'NOT_REQUESTED'
  });

  function createEmptyState(now = Date.now()) {
    return {
      schemaVersion: SCHEMA_VERSION,
      items: [],
      events: [],
      updatedAt: now
    };
  }

  function text(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function numberOr(value, fallback = null) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function extractProductKey(url, title, asin, productId) {
    const explicitProductId = text(productId);
    if (explicitProductId) return `product_${explicitProductId.toLowerCase()}`;

    const explicitAsin = text(asin).toUpperCase();
    if (/^[A-Z0-9]{10}$/.test(explicitAsin)) return `asin_${explicitAsin}`;

    if (url) {
      try {
        const parsedUrl = new URL(url);
        const asinMatch = parsedUrl.pathname.match(/(?:dp|product|d)\/([A-Z0-9]{10})/i) ||
          parsedUrl.search.match(/asin=([A-Z0-9]{10})/i);
        if (asinMatch) return `asin_${asinMatch[1].toUpperCase()}`;
        return `${parsedUrl.origin}${parsedUrl.pathname.replace(/\/$/, '')}`;
      } catch (error) {
        // A title fallback still gives local-only records a stable identity.
      }
    }

    const normalizedTitle = text(title).toLowerCase().replace(/[^a-z0-9]/g, '');
    return normalizedTitle ? `title_${normalizedTitle.slice(0, 80)}` : null;
  }

  function getAsin(url, asin) {
    const explicitAsin = text(asin).toUpperCase();
    if (/^[A-Z0-9]{10}$/.test(explicitAsin)) return explicitAsin;
    const key = extractProductKey(url, '', '');
    return key && key.startsWith('asin_') ? key.slice(5) : null;
  }

  function createId(prefix, now, index) {
    return `${prefix}_${now}_${index}`;
  }

  function normalizeItem(item, now) {
    if (!item || typeof item !== 'object') return null;
    const product = item.product && typeof item.product === 'object' ? item.product : {};
    const poi = item.poi && typeof item.poi === 'object' ? item.poi : {};
    const purchase = item.purchase && typeof item.purchase === 'object' ? item.purchase : {};
    const snapshot = item.snapshot && typeof item.snapshot === 'object' ? item.snapshot : {};
    const identity = extractProductKey(
      product.url || item.url,
      product.title || item.title,
      product.asin || item.asin,
      product.productId || item.productId
    );
    if (!identity) return null;

    return {
      id: text(item.id) || createId('item', now, 0),
      productKey: identity,
      product: {
        title: text(product.title || item.title),
        productId: text(product.productId || item.productId),
        asin: getAsin(product.url || item.url, product.asin || item.asin),
        url: text(product.url || item.url),
        imageUrl: text(product.imageUrl || item.imageUrl),
        category: text(product.category || item.category)
      },
      snapshot: {
        price: numberOr(snapshot.price !== undefined ? snapshot.price : item.price, 0),
        hoursOfWork: numberOr(snapshot.hoursOfWork !== undefined ? snapshot.hoursOfWork : item.hoursOfWork, 0),
        irsScore: numberOr(snapshot.irsScore !== undefined ? snapshot.irsScore : item.irsScore, null)
      },
      poi: {
        state: Object.values(POI_STATE).includes(poi.state) ? poi.state : POI_STATE.INACTIVE,
        startedAt: numberOr(poi.startedAt, null),
        expiresAt: numberOr(poi.expiresAt, null),
        cooldownDurationSeconds: numberOr(poi.cooldownDurationSeconds, null)
      },
      location: Object.values(COLLECTION).includes(item.location) ? item.location : COLLECTION.ARCHIVE,
      purchase: {
        state: Object.values(PURCHASE_STATE).includes(purchase.state) ? purchase.state : PURCHASE_STATE.NONE,
        observedAt: numberOr(purchase.observedAt, null),
        source: text(purchase.source),
        amazonOrderId: text(purchase.amazonOrderId),
        confirmationId: text(purchase.confirmationId)
      },
      priceSearch: {
        status: PRICE_SEARCH_STATUS.NOT_REQUESTED
      },
      createdAt: numberOr(item.createdAt, now),
      updatedAt: numberOr(item.updatedAt, now)
    };
  }

  function normalizeState(rawState, now = Date.now()) {
    const source = rawState && typeof rawState === 'object' ? rawState : {};
    const seen = new Set();
    const items = Array.isArray(source.items) ? source.items
      .map(item => normalizeItem(item, now))
      .filter(item => item && !seen.has(item.productKey) && seen.add(item.productKey))
      : [];

    const events = Array.isArray(source.events) ? source.events
      .filter(event => event && typeof event === 'object' && text(event.type))
      .slice(-MAX_EVENTS)
      : [];

    return {
      schemaVersion: SCHEMA_VERSION,
      items,
      events,
      updatedAt: numberOr(source.updatedAt, now)
    };
  }

  function stateSummary(item) {
    return {
      poiState: item.poi.state,
      location: item.location,
      purchaseState: item.purchase.state
    };
  }

  function appendEvent(state, item, type, at, details = {}) {
    const event = {
      id: createId('event', at, state.events.length),
      itemId: item.id,
      productKey: item.productKey,
      type,
      at,
      ...details
    };
    state.events.push(event);
    if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
    state.updatedAt = at;
    return event;
  }

  function applyProductSnapshot(item, payload = {}) {
    const product = payload.product && typeof payload.product === 'object' ? payload.product : payload;
    item.product.title = text(product.title) || item.product.title;
    item.product.url = text(product.url) || item.product.url;
    item.product.imageUrl = text(product.imageUrl) || item.product.imageUrl;
    item.product.category = text(product.category) || item.product.category;
    item.product.productId = text(product.productId) || item.product.productId;
    item.product.asin = getAsin(item.product.url, product.asin || item.product.asin);
    item.productKey = extractProductKey(
      item.product.url,
      item.product.title,
      item.product.asin,
      item.product.productId
    ) || item.productKey;

    const price = numberOr(payload.price, null);
    const hoursOfWork = numberOr(payload.hoursOfWork, null);
    const irsScore = numberOr(payload.irsScore, null);
    if (price !== null) item.snapshot.price = price;
    if (hoursOfWork !== null) item.snapshot.hoursOfWork = hoursOfWork;
    if (irsScore !== null) item.snapshot.irsScore = irsScore;
  }

  function createItem(payload, now, index) {
    const productKey = extractProductKey(payload.url, payload.title, payload.asin, payload.productId);
    if (!productKey) throw new Error('A title, ASIN, or URL is required to track an item.');
    const item = normalizeItem({
      id: createId('item', now, index),
      productKey,
      product: payload,
      snapshot: payload,
      poi: { state: POI_STATE.INACTIVE },
      location: COLLECTION.ARCHIVE,
      purchase: { state: PURCHASE_STATE.NONE },
      createdAt: now,
      updatedAt: now
    }, now);
    return item;
  }

  function findItem(state, payload) {
    const productKey = extractProductKey(payload.url, payload.title, payload.asin, payload.productId);
    if (productKey) return state.items.find(item => item.productKey === productKey) || null;

    const normalizedTitle = text(payload.title).toLowerCase().replace(/[^a-z0-9]/g, '');
    return state.items.find(item => text(item.product.title).toLowerCase().replace(/[^a-z0-9]/g, '') === normalizedTitle) || null;
  }

  function getItemById(state, id) {
    return state.items.find(item => item.id === id) || null;
  }

  function ensureItem(state, payload, now) {
    let item = findItem(state, payload);
    if (!item) {
      item = createItem(payload, now, state.items.length);
      state.items.unshift(item);
    }
    applyProductSnapshot(item, payload);
    return item;
  }

  function reconcileExpiredItems(state, now = Date.now()) {
    const expiredItems = [];
    for (const item of state.items) {
      if (item.poi.state !== POI_STATE.ACTIVE || item.location !== COLLECTION.VAULT) continue;
      if (!item.poi.expiresAt || item.poi.expiresAt > now) continue;

      const from = stateSummary(item);
      item.poi.state = POI_STATE.EXPIRED;
      item.location = COLLECTION.ARCHIVE;
      item.updatedAt = now;
      appendEvent(state, item, 'POI_EXPIRED', now, { from, to: stateSummary(item) });
      expiredItems.push(item);
    }
    return expiredItems;
  }

  function putOnIce(state, payload, options = {}) {
    const now = numberOr(options.now, Date.now());
    const cooldownDurationSeconds = numberOr(options.cooldownDurationSeconds, 0);
    if (cooldownDurationSeconds <= 0) throw new Error('A positive cooldown duration is required.');

    reconcileExpiredItems(state, now);
    const item = ensureItem(state, payload, now);
    const from = stateSummary(item);

    item.poi = {
      state: POI_STATE.ACTIVE,
      startedAt: now,
      expiresAt: now + (cooldownDurationSeconds * 1000),
      cooldownDurationSeconds
    };
    item.location = COLLECTION.VAULT;
    item.purchase.state = PURCHASE_STATE.NONE;
    item.priceSearch = { status: PRICE_SEARCH_STATUS.NOT_REQUESTED };
    item.updatedAt = now;

    appendEvent(state, item, 'PUT_ON_ICE', now, {
      from,
      to: stateSummary(item),
      reason: options.reason || 'USER_REQUESTED'
    });
    return item;
  }

  function archiveItem(state, id, options = {}) {
    const now = numberOr(options.now, Date.now());
    reconcileExpiredItems(state, now);
    const item = getItemById(state, id);
    if (!item) throw new Error('Item not found.');
    if (item.location === COLLECTION.PURCHASE_HISTORY) throw new Error('Purchased items stay in purchase history.');

    const from = stateSummary(item);
    if (item.poi.state !== POI_STATE.EXPIRED) item.poi.state = POI_STATE.CANCELLED;
    item.location = COLLECTION.ARCHIVE;
    item.updatedAt = now;
    appendEvent(state, item, 'POI_ARCHIVED', now, {
      from,
      to: stateSummary(item),
      reason: options.reason || 'USER_ARCHIVED'
    });
    return item;
  }

  /**
   * Explicitly ends an active Put on Ice cooldown. Cancelling is distinct from
   * expiry and generic archiving: it records the user's choice and makes the
   * product purchasable again while retaining it in the decision archive.
   */
  function cancelPutOnIce(state, id, options = {}) {
    const now = numberOr(options.now, Date.now());
    reconcileExpiredItems(state, now);
    const item = getItemById(state, id);
    if (!item) throw new Error('Item not found.');
    if (item.location !== COLLECTION.VAULT || item.poi.state !== POI_STATE.ACTIVE) {
      throw new Error('Only an active Put on Ice item can be cancelled.');
    }

    const from = stateSummary(item);
    item.poi.state = POI_STATE.CANCELLED;
    item.location = COLLECTION.ARCHIVE;
    item.purchase.state = PURCHASE_STATE.NONE;
    item.updatedAt = now;
    appendEvent(state, item, 'POI_CANCELLED', now, {
      from,
      to: stateSummary(item),
      reason: options.reason || 'USER_CANCELLED'
    });
    return item;
  }

  function continueToPurchase(state, id, options = {}) {
    const now = numberOr(options.now, Date.now());
    const item = archiveItem(state, id, { now, reason: 'CONTINUE_TO_AMAZON' });
    const from = stateSummary(item);
    item.purchase.state = PURCHASE_STATE.PENDING;
    item.updatedAt = now;
    appendEvent(state, item, 'PURCHASE_CONTINUED', now, { from, to: stateSummary(item) });
    return item;
  }

  function recordPurchase(state, payload, options = {}) {
    const now = numberOr(options.now, Date.now());
    reconcileExpiredItems(state, now);
    const item = ensureItem(state, payload, now);
    const confirmationId = text(options.confirmationId || payload.confirmationId);
    const source = text(options.source) || 'AMAZON_ORDER_CONFIRMATION';

    // Order-confirmation pages may be revisited or refreshed. A confirmation
    // identifier makes the persisted operation idempotent without treating a
    // cart click or a Buy Now button as proof of purchase.
    if (
      confirmationId &&
      item.purchase.state === PURCHASE_STATE.PURCHASED &&
      item.purchase.confirmationId === confirmationId
    ) {
      return item;
    }

    const from = stateSummary(item);

    if (item.poi.state === POI_STATE.ACTIVE) item.poi.state = POI_STATE.CANCELLED;
    item.location = COLLECTION.PURCHASE_HISTORY;
    item.purchase = {
      state: PURCHASE_STATE.PURCHASED,
      observedAt: now,
      source,
      amazonOrderId: text(payload.amazonOrderId),
      confirmationId
    };
    item.updatedAt = now;

    appendEvent(state, item, 'PURCHASE_CONFIRMED', now, {
      from,
      to: stateSummary(item),
      source: item.purchase.source,
      confirmationId: item.purchase.confirmationId
    });
    return item;
  }

  function getCollections(state) {
    const sortByRecent = (a, b) => b.updatedAt - a.updatedAt;
    return {
      activeItems: state.items.filter(item => item.location === COLLECTION.VAULT).sort(sortByRecent),
      archiveItems: state.items.filter(item => item.location === COLLECTION.ARCHIVE).sort(sortByRecent),
      purchaseHistory: state.items.filter(item => item.location === COLLECTION.PURCHASE_HISTORY).sort(sortByRecent)
    };
  }

  root.ZenBuyVaultLifecycle = {
    SCHEMA_VERSION,
    POI_STATE,
    COLLECTION,
    PURCHASE_STATE,
    PRICE_SEARCH_STATUS,
    createEmptyState,
    normalizeState,
    extractProductKey,
    findItem,
    getItemById,
    reconcileExpiredItems,
    putOnIce,
    archiveItem,
    cancelPutOnIce,
    continueToPurchase,
    recordPurchase,
    getCollections
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
