/**
 * ZenBuy Impulse Risk Scoring (IRS) Engine
 * Implements the mathematical specification:
 * IRS = (0.35 * STaxonomy) + (0.20 * SVelocity) + (0.15 * SCircadian) + (0.15 * SDarkPattern) + (0.15 * SFinancial)
 */

const IRS_WEIGHTS = {
  taxonomy: 0.35,
  velocity: 0.20,
  circadian: 0.15,
  darkPattern: 0.15,
  financial: 0.15
};

function calculateCircadianScore(hour) {
  if ([23, 0, 1, 2, 3, 4].includes(hour)) {
    return 100; // Peak ego depletion
  }
  if ([21, 22, 5].includes(hour)) {
    return 60;  // Late evening fatigue
  }
  if ([18, 19, 20].includes(hour)) {
    return 20;  // Post-work transition
  }
  return 0;     // Daytime rational baseline
}

function calculateVelocityScore(context) {
  let score = 50; // Neutral baseline

  // Social media referrer (+35)
  if (context.isSocialReferrer) {
    score += 35;
  }
  // Direct search intent (-30)
  if (context.isDirectSearch) {
    score -= 30;
  }
  // Dwell time < 30 seconds (+25)
  if (context.dwellTimeSeconds < 30) {
    score += 25;
  } else if (context.dwellTimeSeconds > 240) {
    // Dwell time > 4 minutes (-20)
    score -= 20;
  }

  return Math.min(100, Math.max(0, score));
}

function calculateDarkPatternScore(darkPatterns) {
  let score = 0;
  if (darkPatterns.deceptiveUrgency) score += 40;
  if (darkPatterns.fabricatedSocialProof) score += 25;
  if (darkPatterns.lowStockAmbiguity) score += 20;
  if (darkPatterns.preselection) score += 25;
  return Math.min(100, score);
}

function calculateFinancialScore(price, hourlyWage, isBnplActive) {
  let score = 0;
  const ratio = hourlyWage > 0 ? (price / hourlyWage) : (price / 25);

  if (ratio >= 5.0) {
    score += 40;
  } else if (ratio >= 2.0) {
    score += 25;
  }

  if (isBnplActive) {
    score += 30;
  }

  if (price >= 150) {
    score += 20;
  }

  return Math.min(100, score);
}

function calculateIRS(params) {
  const sTaxonomy = params.taxonomyScore ?? 60;
  const sVelocity = calculateVelocityScore(params.velocity || {});
  const hour = params.localHour !== undefined ? params.localHour : new Date().getHours();
  const sCircadian = calculateCircadianScore(hour);
  const sDarkPattern = calculateDarkPatternScore(params.darkPatterns || {});
  const sFinancial = calculateFinancialScore(
    params.price || 0,
    params.hourlyWage || 25,
    params.isBnplActive || false
  );

  const rawScore = (
    (IRS_WEIGHTS.taxonomy * sTaxonomy) +
    (IRS_WEIGHTS.velocity * sVelocity) +
    (IRS_WEIGHTS.circadian * sCircadian) +
    (IRS_WEIGHTS.darkPattern * sDarkPattern) +
    (IRS_WEIGHTS.financial * sFinancial)
  );

  const score = Math.round(Math.min(100, Math.max(0, rawScore)));

  let tier = 'TIER_0';
  let action = 'ACTION_SILENT';

  if (score >= 65) {
    tier = 'TIER_2';
    action = 'ACTION_INTERCEPT';
  } else if (score >= 30) {
    tier = 'TIER_1';
    action = 'ACTION_PASSIVE_ICE';
  }

  return {
    score,
    tier,
    action,
    subScores: {
      taxonomy: sTaxonomy,
      velocity: sVelocity,
      circadian: sCircadian,
      darkPattern: sDarkPattern,
      financial: sFinancial
    }
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    calculateIRS,
    calculateCircadianScore,
    calculateVelocityScore,
    calculateDarkPatternScore,
    calculateFinancialScore
  };
}
