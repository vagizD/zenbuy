/**
 * ZenBuy Central Configuration
 * Single source of truth for Gemini models and user defaults.
 * IRS settings are intentionally owned by the selected engine module.
 */

var ZENBUY_CONFIG = {
  // Gemini AI Engine Configuration
  gemini: {
    model: 'gemini-2.5-flash',
    apiKey: '', // Populated only by the local, git-ignored config.local.js

    // Tier 1: Semantic Taxonomy & Necessity Triage
    triage: {
      temperature: 0.2,
      // The structured response is intentionally small; keeping this lean makes
      // the first classification return faster without sacrificing its schema.
      maxOutputTokens: 180,
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
      maxOutputTokens: 48,
      thinkingBudget: 0,
      systemInstruction: `You are ZenBuy, a calm, non-judgmental financial alter-ego.
Give one clear trade-off, then ask a gentle question tied to the user's financial focus.
Write exactly two concise sentences, no more than 36 words total. Do not use emojis or headings.`
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
