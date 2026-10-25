/**
 * ZenBuy Gemini AI Integration
 * All model parameters, prompts, and options are controlled via ZENBUY_CONFIG.
 */

// Memory cache for product classifications to avoid duplicate API calls
const taxonomyCache = new Map();

async function callGeminiApi(prompt, systemInstruction, config, jsonMode = false) {
  const apiKey = config.apiKey;
  if (!apiKey) {
    throw new Error('Gemini API key is not configured');
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${apiKey}`;

  const body = {
    contents: [
      {
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature: config.temperature,
      maxOutputTokens: config.maxOutputTokens,
      topP: 0.85
    }
  };

  if (config.thinkingBudget !== undefined) {
    body.generationConfig.thinkingConfig = {
      thinkingBudget: config.thinkingBudget
    };
  }

  if (systemInstruction) {
    body.systemInstruction = {
      parts: [{ text: systemInstruction }]
    };
  }

  if (jsonMode) {
    body.generationConfig.responseMimeType = 'application/json';
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const candidate = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!candidate) {
    throw new Error('Empty response from Gemini');
  }

  return candidate.trim();
}

/**
 * Tier 1: Classifies product into necessity vs hedonic want index (0 to 100)
 * Controlled entirely by config.gemini.triage.
 */
async function classifyProductWithGemini(productTitle, category, price, geminiConfig) {
  const cacheKey = `${productTitle}_${price}`.toLowerCase();
  if (taxonomyCache.has(cacheKey)) {
    return taxonomyCache.get(cacheKey);
  }

  const triageCfg = {
    ...geminiConfig.triage,
    model: geminiConfig.model,
    apiKey: geminiConfig.apiKey
  };

  const prompt = `Classify this product:
Title: "${productTitle}"
Category: "${category || 'General'}"
Price: $${price}`;

  const text = await callGeminiApi(prompt, triageCfg.systemInstruction, triageCfg, true);
  const result = JSON.parse(text);

  // Normalize structure
  const classification = {
    classification: result.classification || 'HEDONIC_WANT',
    hedonicScore: typeof result.hedonicScore === 'number' ? result.hedonicScore : 65,
    confidence: typeof result.confidence === 'number' ? result.confidence : 0.8,
    categoryBaselinePrice: typeof result.categoryBaselinePrice === 'number' ? result.categoryBaselinePrice : null,
    luxuryMultiplier: typeof result.luxuryMultiplier === 'number' ? result.luxuryMultiplier : null,
    reasoning: result.reasoning || ''
  };

  taxonomyCache.set(cacheKey, classification);
  return classification;
}

/**
 * Tier 2: Socratic copy generator
 * Controlled entirely by config.gemini.socratic.
 */
async function generateSocraticReflection(params, geminiConfig) {
  const { productTitle, price, hourlyWage, savingsGoal, categoryBaselinePrice, luxuryMultiplier } = params;
  const hours = hourlyWage > 0 ? (price / hourlyWage).toFixed(1) : (price / 30).toFixed(1);
  const monthlySalary = hourlyWage > 0 ? (hourlyWage * 160) : 4800;
  const monthlyPercent = ((price / monthlySalary) * 100).toFixed(0);

  if (!geminiConfig.apiKey) {
    const alternativeNote = categoryBaselinePrice ? ` when functional alternatives are ~$${categoryBaselinePrice}` : '';
    return `This purchase represents ${hours} hours of your workday (${monthlyPercent}% of monthly income)${alternativeNote}. Placing it in your 48-hour vault keeps you aligned with your goal to ${savingsGoal || 'build savings'}.`;
  }

  const socraticCfg = {
    ...geminiConfig.socratic,
    model: geminiConfig.model,
    apiKey: geminiConfig.apiKey
  };

  const luxuryContext = luxuryMultiplier && luxuryMultiplier > 1.5
    ? `Standard functional alternatives in this category cost around $${categoryBaselinePrice} (making this a ${luxuryMultiplier.toFixed(1)}x luxury premium).`
    : '';

  const prompt = `The user is considering purchasing "${productTitle}" for $${price}.
Their hourly wage is $${hourlyWage} (representing approximately ${hours} hours of labor, or ${monthlyPercent}% of their monthly income).
${luxuryContext}
Their stated financial focus is: "${savingsGoal || 'Build personal savings'}".
Generate the 2-sentence reality check.`;

  return await callGeminiApi(prompt, socraticCfg.systemInstruction, socraticCfg, false);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    classifyProductWithGemini,
    generateSocraticReflection
  };
}
