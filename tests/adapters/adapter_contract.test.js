const assert = require('node:assert/strict');
const test = require('node:test');
const Contract = require('../../prototype/adapters/contract.js');
const AmazonAdapter = require('../../prototype/adapters/amazon.js');
const SandboxAdapter = require('../../prototype/adapters/sandbox.js');
const FallbackAdapter = require('../../prototype/adapters/fallback.js');

test('every registered retailer adapter satisfies the shared contract', () => {
  [AmazonAdapter, SandboxAdapter, FallbackAdapter].forEach(adapter => {
    const result = Contract.validate(adapter);
    assert.equal(result.valid, true, `${adapter.name} is missing: ${result.missing.join(', ')}`);
  });
});

test('adapter contract exposes only supported page kinds', () => {
  assert.deepEqual(Object.values(Contract.PAGE_KIND).sort(), ['ORDER_CONFIRMATION', 'OTHER', 'PRODUCT']);
});
