/**
 * Engine-specific translator for the reusable IRS tier contract scenarios.
 *
 * Contract fixtures use a product/financial/interaction vocabulary so they do
 * not inherit this engine's score scale or parameter names. A future engine
 * gets its own adapter; the contract test remains unchanged.
 */

const { ZenBuyCurrentIRSEngine } = require('../../prototype/engine/irs.js');

function mapSourceToVelocity(source, dwellTimeSeconds) {
  const sourceName = String(source || 'UNKNOWN');
  return {
    dwellTimeSeconds: Number(dwellTimeSeconds) || 0,
    isSocialReferrer: sourceName === 'SOCIAL_AD' || sourceName === 'SOCIAL_LINK',
    isDirectSearch: sourceName === 'DIRECT_SEARCH' || sourceName === 'DIRECT_BOOKMARK'
  };
}

function mapDarkPatterns(patterns) {
  const selected = new Set(Array.isArray(patterns) ? patterns : []);
  return {
    deceptiveUrgency: selected.has('deceptiveUrgency'),
    fabricatedSocialProof: selected.has('fabricatedSocialProof'),
    lowStockAmbiguity: selected.has('lowStockAmbiguity'),
    preselection: selected.has('preselection')
  };
}

function translateScenarioFeatures(features) {
  const product = features.product || {};
  const financial = features.financial || {};
  const interaction = features.interaction || {};

  return {
    // The taxonomy classifier is tested separately with recorded classifier
    // responses. This deterministic risk value lets the IRS suite stay offline.
    taxonomyScore: Number(product.taxonomyRisk) || 0,
    // A hidden recurring charge uses its meaningful financial commitment, not
    // merely a teaser price. Standard products use their listed price.
    price: Number(financial.amount !== undefined ? financial.amount : product.price) || 0,
    hourlyWage: Number(financial.hourlyWage) || 30,
    isBnplActive: Boolean(financial.isBnplActive),
    localHour: Number(interaction.localHour),
    velocity: mapSourceToVelocity(interaction.source, interaction.dwellTimeSeconds),
    darkPatterns: mapDarkPatterns(features.darkPatterns)
  };
}

module.exports = {
  id: ZenBuyCurrentIRSEngine.id,
  evaluate(features) {
    return ZenBuyCurrentIRSEngine.evaluate(translateScenarioFeatures(features));
  },
  translateScenarioFeatures
};
