const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ZenBuyCurrentIRSEngine,
  calculateCircadianScore,
  calculateVelocityScore,
  calculateDarkPatternScore,
  calculateFinancialScore,
  getDynamicWeights
} = require('../../prototype/engine/irs.js');

function lowContext(overrides = {}) {
  return {
    taxonomyScore: 0,
    price: 0,
    hourlyWage: 30,
    isBnplActive: false,
    localHour: 12,
    velocity: { dwellTimeSeconds: 200, isSocialReferrer: false, isDirectSearch: true },
    darkPatterns: {},
    ...overrides
  };
}

test('weighted IRS v1 owns a complete, independent definition', () => {
  const definition = ZenBuyCurrentIRSEngine.getDefinition();

  assert.equal(ZenBuyCurrentIRSEngine.id, 'weighted-irs-v1');
  assert.deepEqual(definition.scoreScale, { min: 0, max: 100 });
  assert.deepEqual(definition.thresholds, { tier1Passive: 31, tier2Intercept: 65 });
  assert.deepEqual(definition.actions, {
    TIER_0: 'ACTION_SILENT',
    TIER_1: 'ACTION_PASSIVE_ICE',
    TIER_2: 'ACTION_INTERCEPT'
  });

  definition.thresholds.tier1Passive = -1;
  assert.equal(ZenBuyCurrentIRSEngine.getDefinition().thresholds.tier1Passive, 31);
});

test('weighted IRS v1 component rules produce their configured values', () => {
  const definition = ZenBuyCurrentIRSEngine.getDefinition();

  assert.equal(calculateCircadianScore(2, definition.circadianHours), 100);
  assert.equal(calculateCircadianScore(21, definition.circadianHours), 60);
  assert.equal(calculateCircadianScore(19, definition.circadianHours), 20);
  assert.equal(calculateCircadianScore(12, definition.circadianHours), 0);

  assert.equal(calculateVelocityScore({ dwellTimeSeconds: 10, isSocialReferrer: true }, definition.velocityRules), 100);
  assert.equal(calculateVelocityScore({ dwellTimeSeconds: 220, isDirectSearch: true }, definition.velocityRules), 0);
  assert.equal(calculateDarkPatternScore({ deceptiveUrgency: true, fabricatedSocialProof: true, lowStockAmbiguity: true, preselection: true }, definition.darkPatternScores), 100);
  assert.equal(calculateFinancialScore(180, 30, false, definition.financialRules), 50);
  assert.equal(calculateFinancialScore(180, 30, true, definition.financialRules), 65);
});

test('weighted IRS v1 selects its wage-specific weights at boundaries', () => {
  const definition = ZenBuyCurrentIRSEngine.getDefinition();
  assert.equal(getDynamicWeights(20, definition).taxonomy, 0.55);
  assert.equal(getDynamicWeights(21, definition).taxonomy, 0.50);
  assert.equal(getDynamicWeights(45, definition).taxonomy, 0.50);
  assert.equal(getDynamicWeights(46, definition).taxonomy, 0.45);
  assert.equal(getDynamicWeights(81, definition).taxonomy, 0.40);
});

test('weighted IRS v1 maps its exact score boundaries to tiers and actions', () => {
  const justBelowPassive = ZenBuyCurrentIRSEngine.evaluate(lowContext({ taxonomyScore: 60 }));
  const atPassive = ZenBuyCurrentIRSEngine.evaluate(lowContext({ taxonomyScore: 62 }));
  const justBelowIntercept = ZenBuyCurrentIRSEngine.evaluate(lowContext({ taxonomyScore: 100, price: 172.8 }));
  const atIntercept = ZenBuyCurrentIRSEngine.evaluate(lowContext({ taxonomyScore: 100, price: 180 }));

  assert.deepEqual([justBelowPassive.score, justBelowPassive.tier, justBelowPassive.action], [30, 'TIER_0', 'ACTION_SILENT']);
  assert.deepEqual([atPassive.score, atPassive.tier, atPassive.action], [31, 'TIER_1', 'ACTION_PASSIVE_ICE']);
  assert.deepEqual([justBelowIntercept.score, justBelowIntercept.tier, justBelowIntercept.action], [64, 'TIER_1', 'ACTION_PASSIVE_ICE']);
  assert.deepEqual([atIntercept.score, atIntercept.tier, atIntercept.action], [65, 'TIER_2', 'ACTION_INTERCEPT']);
});

test('weighted IRS v1 returns a bounded, complete result for degenerate input', () => {
  const result = ZenBuyCurrentIRSEngine.evaluate(lowContext({
    taxonomyScore: Number.NaN,
    price: -10,
    hourlyWage: 0,
    localHour: 99,
    velocity: {}
  }));

  assert.ok(Number.isFinite(result.score));
  assert.ok(result.score >= 0 && result.score <= 100);
  assert.ok(['TIER_0', 'TIER_1', 'TIER_2'].includes(result.tier));
  assert.ok(result.weights && result.subScores);
});
