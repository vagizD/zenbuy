const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright');

const projectRoot = path.join(__dirname, '..', '..');
const prototypeRoot = path.join(projectRoot, 'prototype');

function makeTemporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function stageExtensionWithoutLocalSecrets() {
  const destination = makeTemporaryDirectory('zenbuy-extension-');
  fs.cpSync(prototypeRoot, destination, {
    recursive: true,
    filter(source) {
      return !source.endsWith('/config.local.js') && !source.endsWith('/config.local.json');
    }
  });
  return destination;
}

async function startSandboxServer() {
  const mimeTypes = { '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png' };
  const server = http.createServer((request, response) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://sandbox').pathname);
    } catch {
      response.writeHead(400).end();
      return;
    }

    let target = path.resolve(prototypeRoot, `.${pathname}`);
    if (!target.startsWith(prototypeRoot)) {
      response.writeHead(403).end();
      return;
    }

    try {
      if (fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
      response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(target)] || 'application/octet-stream' });
      response.end(fs.readFileSync(target));
    } catch {
      response.writeHead(404).end();
    }
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

test('the unpacked extension injects ZenBuy UI into the local sandbox', async t => {
  const stagedExtension = stageExtensionWithoutLocalSecrets();
  const browserProfile = makeTemporaryDirectory('zenbuy-browser-');
  const { server, port } = await startSandboxServer();
  let context;

  t.after(async () => {
    if (context) await context.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(stagedExtension, { recursive: true, force: true });
    fs.rmSync(browserProfile, { recursive: true, force: true });
  });

  context = await chromium.launchPersistentContext(browserProfile, {
    executablePath: chromium.executablePath(),
    headless: true,
    args: [
      `--disable-extensions-except=${stagedExtension}`,
      `--load-extension=${stagedExtension}`
    ]
  });

  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/test-store/?product=keyboard&hour=23`);
  await page.waitForSelector('.zenbuy-wage-badge', { timeout: 10_000 });
  await page.waitForSelector('.zenbuy-sandbox-ice-btn', { timeout: 10_000 });

  assert.equal(await page.locator('.zenbuy-insight-card').count(), 1);
  assert.equal(await page.locator('.zenbuy-sandbox-ice-btn').count(), 1);

  await page.locator('.zenbuy-sandbox-ice-btn').click();
  await page.waitForSelector('.zenbuy-buybox-frozen-banner', { timeout: 5_000 });
  assert.equal(await page.locator('[data-zenbuy-frozen="true"]').count() > 0, true);
  assert.equal(await page.locator('.zenbuy-cancel-poi-btn').count(), 1);

  // A refresh must preserve the product's active state in both behavior and
  // wording. It must not offer a second "Put on Ice" action.
  await page.reload();
  await page.waitForFunction(() => {
    const button = document.querySelector('.zenbuy-sandbox-ice-btn');
    return button?.disabled && /on ice/i.test(button.textContent || '');
  }, { timeout: 10_000 });
  assert.match(await page.locator('.zenbuy-sandbox-ice-btn').textContent(), /On Ice/i);
  assert.equal(await page.locator('.zenbuy-sandbox-ice-btn').isDisabled(), true);
  assert.equal(await page.locator('.zenbuy-cancel-poi-btn').count(), 1);

  // The popup opens on navigation only. Cards are not rendered until a user
  // chooses a storage space, and archive cards offer only a product link.
  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) serviceWorker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popup.waitForSelector('[data-storage="vault"]', { timeout: 5_000 });
  assert.equal(await popup.locator('.vault-item').count(), 0);
  assert.equal((await popup.locator('#vault-title').textContent()).trim(), 'Vault');
  assert.equal(await popup.locator('.settings-icon').count(), 1);
  await popup.locator('#toggle-settings').click();
  assert.equal(await popup.locator('#toggle-settings').getAttribute('aria-expanded'), 'true');
  assert.equal(await popup.locator('#settings-panel.hidden').count(), 0);
  await popup.locator('#toggle-settings').click();

  await popup.locator('[data-storage="vault"]').click();
  await popup.waitForSelector('.vault-item', { timeout: 5_000 });
  assert.equal((await popup.locator('#storage-detail-name').textContent()).trim(), 'Vault');
  assert.equal(await popup.getByText('Cancel Put on Ice', { exact: true }).count(), 1);
  await popup.locator('[data-action="cancel-poi"]').click();
  await popup.locator('#storage-back').click();
  await popup.locator('[data-storage="archive"]').click();
  await popup.waitForSelector('[data-action="open-product"]', { timeout: 5_000 });
  assert.equal(await popup.getByText('Put on ice again', { exact: true }).count(), 0);
  assert.equal(await popup.getByText('Product page', { exact: true }).count(), 1);

  // Tier 1 offers Put on Ice, but leaves normal purchase actions unblocked.
  const tierOnePage = await context.newPage();
  await tierOnePage.goto(`http://127.0.0.1:${port}/test-store/?product=headphones&hour=23`);
  await tierOnePage.waitForSelector('.zenbuy-sandbox-ice-btn', { timeout: 10_000 });
  assert.equal(await tierOnePage.locator('#add-to-cart-button.zenbuy-purchase-paused').count(), 0);
  await Promise.all([
    tierOnePage.waitForURL(/\/test-store\/cart\.html/, { timeout: 5_000 }),
    tierOnePage.locator('#add-to-cart-button').click()
  ]);

  // The high-price sandbox product deterministically reaches Tier 2. Purchase
  // controls look paused but remain clickable, opening a closable 15-second
  // reflection gate. Continuing preserves the Buy Now route.
  const tierTwoPage = await context.newPage();
  await tierTwoPage.goto(`http://127.0.0.1:${port}/test-store/?product=weekender&hour=23`);
  await tierTwoPage.waitForSelector('.zenbuy-tier2-warning-banner', { timeout: 10_000 });
  assert.equal(await tierTwoPage.locator('#add-to-cart-button.zenbuy-purchase-paused').count(), 1);
  assert.equal(await tierTwoPage.locator('#buy-now-button.zenbuy-purchase-paused').count(), 1);
  assert.deepEqual(
    await tierTwoPage.locator('#add-to-cart-button').evaluate(element => {
      const style = getComputedStyle(element);
      return { cursor: style.cursor, opacity: style.opacity };
    }),
    { cursor: 'pointer', opacity: '1' }
  );
  assert.match(
    await tierTwoPage.locator('.zenbuy-tier2-warning-banner').textContent(),
    /Choose a purchase button for a quick check/i
  );

  // ZenBuy's own surrounding UI must never behave like a retail purchase
  // control. The score button opens its own inspector, not the reflection
  // gate; inert card and banner clicks do nothing.
  await tierTwoPage.locator('.zenbuy-insight-header').click();
  await tierTwoPage.locator('.zenbuy-tier2-warning-banner').click();
  assert.equal(await tierTwoPage.locator('#zenbuy-confirm-ice').count(), 0);
  await tierTwoPage.locator('.zenbuy-insight-inspector').click();
  await tierTwoPage.waitForSelector('.zenbuy-debug-modal-overlay', { timeout: 5_000 });
  assert.equal(await tierTwoPage.locator('#zenbuy-confirm-ice').count(), 0);
  assert.equal(await tierTwoPage.locator('.zenbuy-dark-pattern-row').count(), 4);
  assert.match(
    await tierTwoPage.locator('#zenbuy-dark-pattern-log').textContent(),
    /Detected[\s\S]*Low stock \/ scarcity[\s\S]*Only 2 left in stock/i
  );
  assert.match(
    await tierTwoPage.locator('#zenbuy-dark-pattern-log').textContent(),
    /Countdown \/ urgency[\s\S]*Deal expires in 04:32/i
  );
  await tierTwoPage.locator('#zenbuy-close-debug').click();

  await tierTwoPage.locator('#add-to-cart-button').click();
  await tierTwoPage.waitForSelector('.zenbuy-modal-overlay', { timeout: 5_000 });
  await tierTwoPage.waitForFunction(() => /Does it support your goal to .+\?$/.test(document.querySelector('#zenbuy-nudge-text')?.textContent || ''), { timeout: 5_000 });
  assert.match(await tierTwoPage.locator('#zenbuy-nudge-text').textContent(), /^This purchase is .+ hours of work \(.+% of monthly income\)\. Does it support your goal to .+\?$/);
  assert.ok(Number(await tierTwoPage.locator('#zenbuy-nudge-text').evaluate(element => getComputedStyle(element).fontWeight)) >= 700);
  assert.equal(await tierTwoPage.locator('#zenbuy-confirm-ice').isDisabled(), true);
  assert.equal(await tierTwoPage.locator('#zenbuy-bypass').isDisabled(), true);
  await tierTwoPage.locator('#zenbuy-reflection-close').click();
  assert.equal(await tierTwoPage.locator('.zenbuy-modal-overlay').count(), 0);

  await tierTwoPage.locator('#buy-now-button').click();
  await tierTwoPage.waitForFunction(() => {
    const putOnIce = document.querySelector('#zenbuy-confirm-ice');
    const continuePurchase = document.querySelector('#zenbuy-bypass');
    return putOnIce && continuePurchase && !putOnIce.disabled && !continuePurchase.disabled;
  }, { timeout: 20_000 });
  await Promise.all([
    tierTwoPage.waitForURL(/\/test-store\/confirmation\.html/, { timeout: 5_000 }),
    tierTwoPage.locator('#zenbuy-bypass').click()
  ]);

  // Put on Ice is an explicit ZenBuy action, even at Tier 2. It starts the
  // vault cooldown immediately and never opens the reflection gate.
  const tierTwoPoiPage = await context.newPage();
  await tierTwoPoiPage.goto(`http://127.0.0.1:${port}/test-store/?product=weekender&hour=23`);
  await tierTwoPoiPage.waitForSelector('.zenbuy-tier2-warning-banner', { timeout: 10_000 });
  await tierTwoPoiPage.waitForSelector('.zenbuy-sandbox-ice-btn', { timeout: 10_000 });
  await tierTwoPoiPage.locator('.zenbuy-sandbox-ice-btn').click();
  await tierTwoPoiPage.waitForSelector('.zenbuy-buybox-frozen-banner', { timeout: 5_000 });
  assert.equal(await tierTwoPoiPage.locator('.zenbuy-modal-overlay').count(), 0);
  assert.equal(await tierTwoPoiPage.locator('.zenbuy-tier2-warning-banner').count(), 0);
  assert.equal(await tierTwoPoiPage.locator('#add-to-cart-button').getAttribute('title'), 'Cancel first');
  assert.equal(
    await tierTwoPoiPage.locator('#add-to-cart-button').evaluate(element => getComputedStyle(element).cursor),
    'not-allowed'
  );
  await tierTwoPoiPage.locator('#add-to-cart-button').click();
  assert.equal(await tierTwoPoiPage.locator('.zenbuy-modal-overlay').count(), 0);
  assert.match(tierTwoPoiPage.url(), /\/test-store\/(?:index\.html)?/);
  await tierTwoPoiPage.locator('.zenbuy-cancel-poi-btn').click();
  await tierTwoPoiPage.waitForFunction(() => !document.querySelector('.zenbuy-buybox-frozen-banner'), { timeout: 5_000 });
  assert.equal(await tierTwoPoiPage.locator('[data-zenbuy-frozen="true"]').count(), 0);
  assert.equal(await tierTwoPoiPage.locator('.zenbuy-sandbox-ice-btn').isDisabled(), false);
  assert.match(await tierTwoPoiPage.locator('.zenbuy-sandbox-ice-btn').textContent(), /Put on Ice/i);
});
