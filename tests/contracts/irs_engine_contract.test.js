const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const engine = require('../engines/weighted_irs_v1_adapter.js');

const fixturePath = path.join(__dirname, '..', 'fixtures', 'irs-tier-scenarios.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const VALID_TIERS = new Set(['TIER_0', 'TIER_1', 'TIER_2']);

test('IRS tier contract fixture remains a balanced 30-scenario suite', () => {
  assert.equal(fixture.scenarios.length, 30);
  for (const tier of VALID_TIERS) {
    assert.equal(
      fixture.scenarios.filter(scenario => scenario.expectedTier === tier).length,
      10,
      `expected ten ${tier} scenarios`
    );
  }
});

for (const scenario of fixture.scenarios) {
  test(`${scenario.id} ${scenario.label}: returns its contract tier`, () => {
    const result = engine.evaluate(scenario.features);

    // This is deliberately the only behavior assertion. Scores, cut-offs,
    // action labels, and diagnostic fields are implementation-specific.
    assert.ok(VALID_TIERS.has(result.tier), 'engine must return a known final tier');
    assert.equal(result.tier, scenario.expectedTier);
  });
}
