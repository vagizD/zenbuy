/**
 * ZenBuy Impulse Risk Scoring (IRS) Engine
 * Modular mathematical calculation engine.
 * Swappable with alternative formulas or scoring strategies.
 */

function calculateCircadianScore(hour, circadianConfig) {
  if (circadianConfig.peakDepletion.includes(hour)) return 100;
  if (circadianConfig.eveningFatigue.includes(hour)) return 60;
  if (circadianConfig.postWork.includes(hour)) return 20;
  return 0;
}

function calculateVelocityScore(context, rules) {
  let score = rules.baseline;

  if (context.isSocialReferrer) {
    score += rules.socialReferrerBonus;
  }
  if (context.isDirectSearch) {
    score += rules.directSearchDiscount;
  }
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
      if (wage <= tier.maxWage) {
        return tier.weights;
      }
    }
  }
  return (irsConfig && irsConfig.weights) || {
    taxonomy: 0.50,
    financial: 0.30,
    velocity: 0.10,
    circadian: 0.05,
    darkPattern: 0.05
  };
}

function calculateFinancialScore(price, hourlyWage, isBnplActive, rules) {
  const wage = hourlyWage > 0 ? hourlyWage : 30;
  const horizon = (rules && rules.horizonHours) || 12.0;
  const laborHours = price / wage;

  // Linear labor commitment benchmarked to 12h horizon (1.5 workdays = 100)
  let score = (laborHours / horizon) * 100;
  if (isBnplActive) {
    score += ((rules && rules.bnplBonus) || 15);
  }
  return Math.round(Math.min(100, Math.max(0, score)));
}

/**
 * Primary IRS Formula Evaluator
 * Normalized between 0 and 100 with wage-dependent dynamic weighting.
 *
 * @param {Object} inputs Raw shopping interaction signals
 * @param {Object} irsConfig IRS section from ZENBUY_CONFIG
 * @returns {Object} { score, tier, action, weights, subScores }
 */
function evaluateIRS(inputs, irsConfig) {
  const wage = inputs.hourlyWage || 30;
  const weights = getDynamicWeights(wage, irsConfig);
  const thresholds = irsConfig.thresholds;

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

  // Pure linear weighted sum (Sum(w_i * S_i))
  const rawScore = (
    (weights.taxonomy * sTax) +
    (weights.financial * sFin) +
    (weights.velocity * sVel) +
    (weights.circadian * sCirc) +
    (weights.darkPattern * sDark)
  );

  const cleanRaw = isNaN(rawScore) ? 0 : rawScore;
  const score = Math.round(Math.min(100, Math.max(0, cleanRaw)));

  let tier = 'TIER_0';
  let action = 'ACTION_SILENT';

  if (score >= thresholds.tier2Intercept) {
    tier = 'TIER_2';
    action = 'ACTION_INTERCEPT';
  } else if (score >= thresholds.tier1Passive) {
    tier = 'TIER_1';
    action = 'ACTION_PASSIVE_ICE';
  }

  return {
    score,
    tier,
    action,
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    evaluateIRS,
    getDynamicWeights,
    calculateCircadianScore,
    calculateVelocityScore,
    calculateDarkPatternScore,
    calculateFinancialScore
  };
}
