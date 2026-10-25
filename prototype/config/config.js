/**
 * ZenBuy Central Configuration
 * Single source of truth for IRS weights, thresholds, Gemini models, and user defaults.
 */

var ZENBUY_CONFIG = {
  // Impulse Risk Scoring Engine Parameters
  irs: {
    // Action thresholds (0-100)
    thresholds: {
      tier1Passive: 30, // Score >= 30: inject secondary "Put on Ice" button
      tier2Intercept: 65 // Score >= 65: trigger Socratic modal circuit breaker
    },

    // Default reference dimension weights (sum = 1.00)
    weights: {
      taxonomy: 0.50,
      financial: 0.30,
      velocity: 0.10,
      circadian: 0.05,
      darkPattern: 0.05
    },

    // Dynamic Wage-Dependent Weight Tiers (The lower the wage, the higher the weight for Taxonomy & Financial)
    wageWeightTiers: [
      {
        maxWage: 20, // Low wage (<= $20/h): 85% intrinsic necessity & wage protection
        weights: { taxonomy: 0.55, financial: 0.30, velocity: 0.05, circadian: 0.05, darkPattern: 0.05 }
      },
      {
        maxWage: 45, // Standard wage ($21 - $45/h, e.g. baseline $30/h): 80% intrinsic
        weights: { taxonomy: 0.50, financial: 0.30, velocity: 0.10, circadian: 0.05, darkPattern: 0.05 }
      },
      {
        maxWage: 80, // Upper-middle wage ($46 - $80/h): 70% intrinsic
        weights: { taxonomy: 0.45, financial: 0.25, velocity: 0.12, circadian: 0.09, darkPattern: 0.09 }
      },
      {
        maxWage: Infinity, // High wage (> $80/h): 60% intrinsic, 40% contextual impulse
        weights: { taxonomy: 0.40, financial: 0.20, velocity: 0.15, circadian: 0.15, darkPattern: 0.10 }
      }
    ],

    // Circadian state hour mapping
    circadianHours: {
      peakDepletion: [23, 0, 1, 2, 3, 4], // Score = 100
      eveningFatigue: [21, 22, 5],        // Score = 60
      postWork: [18, 19, 20],             // Score = 20
      daytimeBaseline: [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17] // Score = 0
    },

    // Browsing velocity scoring adjustments
    velocityRules: {
      baseline: 50,
      socialReferrerBonus: 25,
      directSearchDiscount: -25,
      shortDwellSeconds: 30,
      shortDwellBonus: 25,
      longDwellSeconds: 180,
      longDwellDiscount: -25
    },

    // Dark pattern detection scores
    darkPatternScores: {
      deceptiveUrgency: 40,
      fabricatedSocialProof: 30,
      lowStockAmbiguity: 30,
      preselection: 25
    },

    // Financial salience scoring (Linear labor commitment benchmarked to 12h horizon = 1.5 workdays)
    financialRules: {
      horizonHours: 12.0, // Benchmark: 12 hours of labor = 100% financial strain
      bnplBonus: 15.0     // Hazard adjustment for installment debt trap
    }
  },

  // Gemini AI Engine Configuration
  gemini: {
    model: 'gemini-2.5-flash',
    apiKey: '', // Populated via config.local.js or popup settings

    // Tier 1: Semantic Taxonomy & Necessity Triage
    triage: {
      temperature: 0.2,
      maxOutputTokens: 500,
      thinkingBudget: 0,
      systemInstruction: `You are an e-commerce taxonomy classifier for consumer impulse spending evaluation.
Analyze the product title, category, and price to determine whether this purchase is a functional necessity or a hedonic/luxury splurge.

CRITICAL: EVALUATE CATEGORY-RELATIVE LUXURY & PRICE MULTIPLIER:
- Compare the product price against the functional commodity baseline for its category.
- Example 1: Bed sheets have a standard commodity baseline of $25-$40. A $380+ 100% Mulberry Silk sheet set is a 10x-15x luxury markup over functional utility. Even though "bed sheets" are household goods, this specific item is an extreme LUXURY_SPLURGE (hedonicScore: 92-98).
- Example 2: Pillows baseline is $15-$25. A $100 luxury pillow is a 5x luxury markup (hedonicScore: 85-92).
- Example 3: A smartphone baseline is $150-$300. A $100 smartphone is budget utility (hedonicScore: 15-25, PRACTICAL_REPLACEMENT).
- Example 4: A winter coat baseline is $60-$100. A $900 designer jacket is an extreme LUXURY_SPLURGE (hedonicScore: 95-100).

Respond strictly in JSON format matching this schema:
{
  "classification": "ESSENTIAL_STAPLE" | "PRACTICAL_REPLACEMENT" | "HEDONIC_WANT" | "LUXURY_SPLURGE" | "VIRAL_TREND",
  "hedonicScore": number, // 0 to 100 (0 = absolute survival necessity, 100 = pure extravagant luxury/fad)
  "confidence": number, // 0.0 to 1.0
  "categoryBaselinePrice": number, // Estimated standard functional alternative price (e.g. 30 for sheets, 20 for pillows)
  "luxuryMultiplier": number, // price / categoryBaselinePrice
  "reasoning": string // 1 brief sentence explaining the necessity vs luxury verdict
}
Score guidelines:
- Essential/Staples/Medical (baby supplies, medicine, groceries): 0-15
- Practical tools/budget replacements (cables, winter boots, textbooks, budget phone): 20-40
- Discretionary wants (board games, casual headphones): 50-70
- Hedonic luxury / viral gadgets / luxury-tier upgrades (silk sheets, $100 pillows, designer goods): 75-100`
    },

    // Tier 2: Socratic Reality-Check Copy Generation
    socratic: {
      temperature: 0.35,
      maxOutputTokens: 1000,
      thinkingBudget: 0,
      systemInstruction: `You are ZenBuy, a calm, non-judgmental financial alter-ego.
Reframe purchase desires into labor hours, monthly budget percentage, and long-term financial freedom.
When relevant, contrast luxury pricing against functional alternatives (e.g., standard sheets or pillows vs luxury silk) without being condescending.
Never shame or scold. Acknowledge the desire, present the trade-off, and recommend a 48h vault freeze.
Write strictly 2 concise, complete sentences. Finish both sentences completely. Do not use emojis.`
    }
  },

  // User Profile Defaults
  userDefaults: {
    hourlyWage: 30,
    savingsGoal: 'Pay down credit card debt'
  },

  // Vault / Cooldown Configuration
  vault: {
    cooldownDurationSeconds: 48 * 60 * 60 // 48 hours (set to 5 for quick local testing)
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ZENBUY_CONFIG;
}
