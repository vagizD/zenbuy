const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const storeDir = path.join(__dirname, '..', '..', 'prototype', 'test-store');
const sandboxAdapterPath = path.join(__dirname, '..', '..', 'prototype', 'adapters', 'sandbox.js');

function storePage(fileName, query = '') {
  return `${pathToFileURL(path.join(storeDir, fileName)).href}${query}`;
}

async function openWithAdapter(browser, url) {
  const page = await browser.newPage();
  await page.goto(url);
  await page.addScriptTag({ path: sandboxAdapterPath });
  return page;
}

test('sandbox adapter reads a deterministic product page and injects one ice button', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await openWithAdapter(browser, storePage('index.html', '?product=keyboard&hour=23&urgency=1&stock=1'));
  await page.waitForSelector('#prod-price[data-zenbuy-product-id]');

  const observed = await page.evaluate(() => {
    const adapter = window.SandboxAdapter;
    const clicked = { value: false };
    const injected = adapter.injectIceButton(adapter.getCartButtons()[0], {
      label: 'Put on Ice',
      onClick: () => { clicked.value = true; }
    });
    injected.click();
    return {
      matches: adapter.matches(window.location),
      pageKind: adapter.getPageKind(),
      product: adapter.scrapeProduct(),
      cartButtonCount: adapter.getCartButtons().length,
      scarcityCount: adapter.getScarcityElements().length,
      injectedCount: document.querySelectorAll('.zenbuy-sandbox-ice-btn').length,
      clicked: clicked.value
    };
  });

  assert.equal(observed.matches, true);
  assert.equal(observed.pageKind, 'PRODUCT');
  assert.deepEqual(observed.product, {
    title: 'Retro Mechanical Keyboard with RGB Backlight',
    price: 139.99,
    image: '',
    category: 'Electronics > Computer Accessories',
    productId: 'sandbox-keyboard-rgb',
    url: storePage('index.html', '?product=keyboard&hour=23&urgency=1&stock=1')
  });
  assert.equal(observed.cartButtonCount, 2);
  assert.equal(observed.scarcityCount, 2);
  assert.equal(observed.injectedCount, 1);
  assert.equal(observed.clicked, true);
});

test('sandbox adapter only reports a purchase on an order-confirmation page', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());

  const cart = await openWithAdapter(browser, storePage('cart.html', '?product=formula'));
  assert.deepEqual(await cart.evaluate(() => ({
    pageKind: window.SandboxAdapter.getPageKind(),
    confirmation: window.SandboxAdapter.getPurchaseConfirmation()
  })), { pageKind: 'OTHER', confirmation: null });
  await cart.close();

  const confirmation = await openWithAdapter(browser, storePage('confirmation.html', '?product=formula&order=SBX-TEST-100'));
  await confirmation.waitForSelector('[data-zenbuy-confirmation-id]');
  const observed = await confirmation.evaluate(() => ({
    pageKind: window.SandboxAdapter.getPageKind(),
    confirmation: window.SandboxAdapter.getPurchaseConfirmation()
  }));

  assert.deepEqual(observed, {
    pageKind: 'ORDER_CONFIRMATION',
    confirmation: {
      confirmationId: 'SBX-TEST-100',
      source: 'SANDBOX_ORDER_CONFIRMATION',
      purchases: [{
        title: 'Infant Formula Powder 32oz Nutrition Pack',
        productId: 'sandbox-infant-formula-32oz',
        url: storePage('index.html', '?product=formula')
      }]
    }
  });
});
