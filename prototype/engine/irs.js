/**
 * ZenBuy weighted IRS v1.
 *
 * This file is a complete engine definition: its formula, component rules,
 * weights, scoring convention, thresholds, tier labels, and action mapping
 * live together. Production code calls `ZenBuyCurrentIRSEngine.evaluate()`;
 * it must not supply thresholds or weights from outside the engine.
 *
 * The exported low-level functions are intentionally retained for focused
 * engine tests and for implementing a future alternative engine.
 */

var CURRENT_IRS_ENGINE_CONFIG = {
  id: 'weighted-irs-v1',
  scoreScale: { min: 0, max: 100 },
  thresholds: {
    // This engine's score convention only. Contract tests assert tiers, not
    // these numeric cut-offs, so another engine can use a different scale.
    tier1Passive: 31,
    tier2Intercept: 65
  },
  actions: {
    TIER_0: 'ACTION_SILENT',
    TIER_1: 'ACTION_PASSIVE_ICE',
    TIER_2: 'ACTION_INTERCEPT'
  },
  weights: {
    taxonomy: 0.50,
    financial: 0.30,
    velocity: 0.10,
    circadian: 0.05,
    darkPattern: 0.05
  },
  wageWeightTiers: [
    {
      maxWage: 20,
      weights: { taxonomy: 0.55, financial: 0.30, velocity: 0.05, circadian: 0.05, darkPattern: 0.05 }
    },
    {
      maxWage: 45,
      weights: { taxonomy: 0.50, financial: 0.30, velocity: 0.10, circadian: 0.05, darkPattern: 0.05 }
    },
    {
      maxWage: 80,
      weights: { taxonomy: 0.45, financial: 0.25, velocity: 0.12, circadian: 0.09, darkPattern: 0.09 }
    },
    {
      maxWage: Infinity,
      weights: { taxonomy: 0.40, financial: 0.20, velocity: 0.15, circadian: 0.15, darkPattern: 0.10 }
    }
  ],
  circadianHours: {
    peakDepletion: [23, 0, 1, 2, 3, 4],
    eveningFatigue: [21, 22, 5],
    postWork: [18, 19, 20],
    daytimeBaseline: [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]
  },
  velocityRules: {
    baseline: 50,
    socialReferrerBonus: 25,
    directSearchDiscount: -25,
    shortDwellSeconds: 30,
    shortDwellBonus: 25,
    longDwellSeconds: 180,
    longDwellDiscount: -25
  },
  darkPatternScores: {
    deceptiveUrgency: 40,
    fabricatedSocialProof: 30,
    lowStockAmbiguity: 30,
    preselection: 25
  },
  financialRules: {
    horizonHours: 12.0,
    bnplBonus: 15.0
  }
};

function cloneCurrentIRSConfig() {
  return {
    id: CURRENT_IRS_ENGINE_CONFIG.id,
    scoreScale: { ...CURRENT_IRS_ENGINE_CONFIG.scoreScale },
    thresholds: { ...CURRENT_IRS_ENGINE_CONFIG.thresholds },
    actions: { ...CURRENT_IRS_ENGINE_CONFIG.actions },
    weights: { ...CURRENT_IRS_ENGINE_CONFIG.weights },
    wageWeightTiers: CURRENT_IRS_ENGINE_CONFIG.wageWeightTiers.map(tier => ({
      maxWage: tier.maxWage,
      weights: { ...tier.weights }
    })),
    circadianHours: Object.fromEntries(
      Object.entries(CURRENT_IRS_ENGINE_CONFIG.circadianHours)
        .map(([name, hours]) => [name, [...hours]])
    ),
    velocityRules: { ...CURRENT_IRS_ENGINE_CONFIG.velocityRules },
    darkPatternScores: { ...CURRENT_IRS_ENGINE_CONFIG.darkPatternScores },
    financialRules: { ...CURRENT_IRS_ENGINE_CONFIG.financialRules }
  };
}

function calculateCircadianScore(hour, circadianConfig) {
  if (circadianConfig.peakDepletion.includes(hour)) return 100;
  if (circadianConfig.eveningFatigue.includes(hour)) return 60;
  if (circadianConfig.postWork.includes(hour)) return 20;
  return 0;
}

function calculateVelocityScore(context, rules) {
  let score = rules.baseline;

  if (context.isSocialReferrer) score += rules.socialReferrerBonus;
  if (context.isDirectSearch) score += rules.directSearchDiscount;
  if (context.dwellTimeSeconds < rules.shortDwellSeconds) {
    score += rules.shortDwellBonus;
  } else if (context.dwellTimeSeconds > rules.longDwellSeconds) {
    score += rules.longDwellDiscount;
  }

  return Math.min(100, Math.max(0, score));
}

function calculateDarkPatternScore(darkPatterns, scores) {
  if (!darkPatterns || typeof darkPatterns !== 'object') return 0;
  const s = scores || {};
  let score = 0;
  if (darkPatterns.deceptiveUrgency) score += (Number(s.deceptiveUrgency) || 40);
  if (darkPatterns.fabricatedSocialProof) score += (Number(s.fabricatedSocialProof) || 30);
  if (darkPatterns.lowStockAmbiguity) score += (Number(s.lowStockAmbiguity) || 30);
  if (darkPatterns.preselection) score += (Number(s.preselection) || 25);
  return Math.min(100, Math.max(0, score));
}

function getDynamicWeights(hourlyWage, irsConfig) {
  const wage = hourlyWage > 0 ? hourlyWage : 30;
  const tiers = irsConfig && irsConfig.wageWeightTiers;
  if (Array.isArray(tiers)) {
    for (const tier of tiers) {
      if (wage <= tier.maxWage) return tier.weights;
    }
  }
  return (irsConfig && irsConfig.weights) || CURRENT_IRS_ENGINE_CONFIG.weights;
}

function calculateFinancialScore(price, hourlyWage, isBnplActive, rules) {
  const wage = hourlyWage > 0 ? hourlyWage : 30;
  const horizon = (rules && rules.horizonHours) || 12.0;
  const laborHours = price / wage;
  let score = (laborHours / horizon) * 100;
  if (isBnplActive) score += ((rules && rules.bnplBonus) || 15);
  return Math.round(Math.min(100, Math.max(0, score)));
}

/**
 * The formula itself remains parameterized so it can be unit-tested and used
 * as a building block by another engine. The registered current engine below
 * is the only production entry point and always supplies its own definition.
 */
function evaluateIRS(inputs, irsConfig) {
  const wage = inputs.hourlyWage || 30;
  const weights = getDynamicWeights(wage, irsConfig);
  const thresholds = irsConfig.thresholds;
  const actions = irsConfig.actions || {
    TIER_0: 'ACTION_SILENT',
    TIER_1: 'ACTION_PASSIVE_ICE',
    TIER_2: 'ACTION_INTERCEPT'
  };

  const sTax = Number(inputs.taxonomyScore !== undefined ? inputs.taxonomyScore : 50) || 0;
  const sVel = Number(calculateVelocityScore(inputs.velocity || {}, irsConfig.velocityRules)) || 0;
  const hour = inputs.localHour !== undefined ? inputs.localHour : new Date().getHours();
  const sCirc = Number(calculateCircadianScore(hour, irsConfig.circadianHours)) || 0;
  const sDark = Number(calculateDarkPatternScore(inputs.darkPatterns || {}, irsConfig.darkPatternScores)) || 0;
  const sFin = Number(calculateFinancialScore(
    inputs.price || 0,
    wage,
    inputs.isBnplActive || false,
    irsConfig.financialRules
  )) || 0;

  const rawScore = (
    (weights.taxonomy * sTax) +
    (weights.financial * sFin) +
    (weights.velocity * sVel) +
    (weights.circadian * sCirc) +
    (weights.darkPattern * sDark)
  );
  const scale = irsConfig.scoreScale || { min: 0, max: 100 };
  const cleanRaw = Number.isNaN(rawScore) ? scale.min : rawScore;
  const score = Math.round(Math.min(scale.max, Math.max(scale.min, cleanRaw)));

  let tier = 'TIER_0';
  if (score >= thresholds.tier2Intercept) {
    tier = 'TIER_2';
  } else if (score >= thresholds.tier1Passive) {
    tier = 'TIER_1';
  }

  return {
    score,
    tier,
    action: actions[tier],
    weights,
    subScores: {
      taxonomy: sTax,
      financial: sFin,
      velocity: sVel,
      circadian: sCirc,
      darkPattern: sDark
    }
  };
}

var ZenBuyCurrentIRSEngine = {
  id: CURRENT_IRS_ENGINE_CONFIG.id,
  evaluate(inputs) {
    return evaluateIRS(inputs || {}, cloneCurrentIRSConfig());
  },
  getDefinition() {
    return cloneCurrentIRSConfig();
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CURRENT_IRS_ENGINE_CONFIG,
    ZenBuyCurrentIRSEngine,
    evaluateIRS,
    getDynamicWeights,
    calculateCircadianScore,
    calculateVelocityScore,
    calculateDarkPatternScore,
    calculateFinancialScore
  };
}
