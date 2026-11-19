const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const modulePath = path.join(__dirname, '..', '..', 'prototype', 'engine', 'vault_lifecycle.js');
const sandbox = { URL, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(modulePath, 'utf8'), sandbox, { filename: modulePath });
const Lifecycle = sandbox.ZenBuyVaultLifecycle;

function product(overrides = {}) {
  return {
    title: 'Noise Cancelling Headphones',
    url: 'https://www.amazon.com/dp/B012345678',
    asin: 'B012345678',
    price: 89,
    hoursOfWork: 3,
    irsScore: 71,
    ...overrides
  };
}

function counts(state) {
  const collections = Lifecycle.getCollections(state);
  return {
    active: collections.activeItems.length,
    archive: collections.archiveItems.length,
    purchases: collections.purchaseHistory.length
  };
}

function assertExclusiveCollections(state) {
  const collections = Lifecycle.getCollections(state);
  const all = [...collections.activeItems, ...collections.archiveItems, ...collections.purchaseHistory];
  assert.equal(all.length, state.items.length, 'every item belongs to one collection');
  assert.equal(new Set(all.map(item => item.id)).size, state.items.length, 'an item cannot appear in two collections');
}

test('put on ice expires quietly into the archive', () => {
  const state = Lifecycle.createEmptyState(1_000);
  const iced = Lifecycle.putOnIce(state, product(), { now: 1_000, cooldownDurationSeconds: 5 });

  assert.equal(iced.poi.state, Lifecycle.POI_STATE.ACTIVE);
  assert.equal(iced.location, Lifecycle.COLLECTION.VAULT);
  assert.deepEqual(counts(state), { active: 1, archive: 0, purchases: 0 });

  const expired = Lifecycle.reconcileExpiredItems(state, 6_001);
  assert.equal(expired.length, 1);
  assert.equal(iced.poi.state, Lifecycle.POI_STATE.EXPIRED);
  assert.equal(iced.location, Lifecycle.COLLECTION.ARCHIVE);
  assert.equal(iced.priceSearch.status, Lifecycle.PRICE_SEARCH_STATUS.NOT_REQUESTED);
  assert.deepEqual(counts(state), { active: 0, archive: 1, purchases: 0 });
  assertExclusiveCollections(state);
});

test('expiration reconciliation is idempotent', () => {
  const state = Lifecycle.createEmptyState();
  Lifecycle.putOnIce(state, product(), { now: 1_000, cooldownDurationSeconds: 1 });

  assert.equal(Lifecycle.reconcileExpiredItems(state, 2_001).length, 1);
  assert.equal(Lifecycle.reconcileExpiredItems(state, 3_001).length, 0);
  assert.equal(state.events.filter(event => event.type === 'POI_EXPIRED').length, 1);
});

test('cancelling Put on Ice ends only an active cooldown and moves the item to archive', () => {
  const state = Lifecycle.createEmptyState();
  const iced = Lifecycle.putOnIce(state, product(), { now: 1_000, cooldownDurationSeconds: 60 });
  const cancelled = Lifecycle.cancelPutOnIce(state, iced.id, { now: 2_000 });

  assert.equal(cancelled.poi.state, Lifecycle.POI_STATE.CANCELLED);
  assert.equal(cancelled.location, Lifecycle.COLLECTION.ARCHIVE);
  assert.equal(cancelled.purchase.state, Lifecycle.PURCHASE_STATE.NONE);
  assert.equal(state.events.at(-1).type, 'POI_CANCELLED');
  assert.deepEqual(counts(state), { active: 0, archive: 1, purchases: 0 });
  assert.throws(() => Lifecycle.cancelPutOnIce(state, iced.id, { now: 3_000 }), /Only an active/);
  assertExclusiveCollections(state);
});

test('an archived item can be put on ice again without losing identity or events', () => {
  const state = Lifecycle.createEmptyState();
  const first = Lifecycle.putOnIce(state, product(), { now: 1_000, cooldownDurationSeconds: 1 });
  Lifecycle.reconcileExpiredItems(state, 2_001);

  const reiced = Lifecycle.putOnIce(state, product({ price: 79 }), {
    now: 3_000,
    cooldownDurationSeconds: 60,
    reason: 'REICED_FROM_ARCHIVE'
  });

  assert.equal(reiced.id, first.id);
  assert.equal(reiced.poi.state, Lifecycle.POI_STATE.ACTIVE);
  assert.equal(reiced.location, Lifecycle.COLLECTION.VAULT);
  assert.equal(reiced.snapshot.price, 79);
  assert.equal(state.events.filter(event => event.type === 'PUT_ON_ICE').length, 2);
  assertExclusiveCollections(state);
});

test('continue to purchase archives the item but never marks it purchased', () => {
  const state = Lifecycle.createEmptyState();
  const iced = Lifecycle.putOnIce(state, product(), { now: 1_000, cooldownDurationSeconds: 60 });
  const pending = Lifecycle.continueToPurchase(state, iced.id, { now: 2_000 });

  assert.equal(pending.poi.state, Lifecycle.POI_STATE.CANCELLED);
  assert.equal(pending.location, Lifecycle.COLLECTION.ARCHIVE);
  assert.equal(pending.purchase.state, Lifecycle.PURCHASE_STATE.PENDING);
  assert.deepEqual(counts(state), { active: 0, archive: 1, purchases: 0 });
  assertExclusiveCollections(state);
});

test('a confirmation moves a matching item to purchase history and is idempotent', () => {
  const state = Lifecycle.createEmptyState();
  const iced = Lifecycle.putOnIce(state, product(), { now: 1_000, cooldownDurationSeconds: 60 });
  Lifecycle.continueToPurchase(state, iced.id, { now: 2_000 });

  const first = Lifecycle.recordPurchase(state, product({ price: 74.5 }), {
    now: 3_000,
    source: 'SANDBOX_ORDER_CONFIRMATION',
    confirmationId: 'SBX-ORDER-100'
  });
  const replay = Lifecycle.recordPurchase(state, product({ price: 74.5 }), {
    now: 4_000,
    source: 'SANDBOX_ORDER_CONFIRMATION',
    confirmationId: 'SBX-ORDER-100'
  });

  assert.equal(first.id, iced.id);
  assert.equal(replay.id, first.id);
  assert.equal(first.location, Lifecycle.COLLECTION.PURCHASE_HISTORY);
  assert.equal(first.purchase.state, Lifecycle.PURCHASE_STATE.PURCHASED);
  assert.equal(first.purchase.confirmationId, 'SBX-ORDER-100');
  assert.deepEqual(counts(state), { active: 0, archive: 0, purchases: 1 });
  assert.equal(state.events.filter(event => event.type === 'PURCHASE_CONFIRMED').length, 1);
  assertExclusiveCollections(state);
});

test('a confirmation can create purchase history for an unseen product', () => {
  const state = Lifecycle.createEmptyState();
  const bought = Lifecycle.recordPurchase(state, product({
    title: 'USB-C Cable',
    url: 'https://www.amazon.com/dp/B098765432',
    asin: 'B098765432',
    price: 12.5
  }), { now: 10_000, confirmationId: 'AMZ-ORDER-222' });

  assert.equal(bought.poi.state, Lifecycle.POI_STATE.INACTIVE);
  assert.equal(bought.location, Lifecycle.COLLECTION.PURCHASE_HISTORY);
  assert.deepEqual(counts(state), { active: 0, archive: 0, purchases: 1 });
  assertExclusiveCollections(state);
});

test('sandbox products keep distinct identities even though they share a page URL', () => {
  const state = Lifecycle.createEmptyState();
  const sharedUrl = 'http://localhost:3000/test-store/index.html';
  Lifecycle.putOnIce(state, product({
    title: 'Retro Mechanical Keyboard', productId: 'sandbox-keyboard-rgb', url: sharedUrl, asin: ''
  }), { now: 1_000, cooldownDurationSeconds: 60 });
  Lifecycle.putOnIce(state, product({
    title: 'Infant Formula Pack', productId: 'sandbox-infant-formula-32oz', url: sharedUrl, asin: ''
  }), { now: 2_000, cooldownDurationSeconds: 60 });

  assert.equal(state.items.length, 2);
  assert.notEqual(state.items[0].productKey, state.items[1].productKey);
  assert.deepEqual(counts(state), { active: 2, archive: 0, purchases: 0 });
  assertExclusiveCollections(state);
});

test('purchase history is terminal for archive and re-ice transitions', () => {
  const state = Lifecycle.createEmptyState();
  const bought = Lifecycle.recordPurchase(state, product(), { now: 1_000, confirmationId: 'AMZ-ORDER-333' });

  assert.throws(() => Lifecycle.archiveItem(state, bought.id, { now: 2_000 }), /Purchased items stay/);
  assert.equal(bought.location, Lifecycle.COLLECTION.PURCHASE_HISTORY);
  assertExclusiveCollections(state);
});
