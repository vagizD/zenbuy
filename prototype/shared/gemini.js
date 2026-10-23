/**
 * ZenBuy Gemini API Integration
 * Handles Tier 1 product triage and Tier 2 Socratic copy generation.
 */

const GEMINI_MODEL = 'gemini-2.5-flash';

async function callGemini(prompt, systemInstruction, apiKey, jsonMode = false) {
  if (!apiKey) {
    throw new Error('Missing Gemini API key');
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const body = {
    contents: [
      {
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature: 0.35,
      maxOutputTokens: jsonMode ? 200 : 120,
      topP: 0.85
    }
  };

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
 * Tier 1: Classifies product into hedonic vs utilitarian index (0-100)
 */
async function classifyProductWithGemini(productTitle, category, price, apiKey) {
  if (!apiKey) {
    return fallbackClassification(productTitle, price);
  }

  const systemInstruction = `You are an e-commerce taxonomy classifier for consumer impulse spending evaluation.
Respond strictly in JSON format matching this schema:
{
  "classification": "ESSENTIAL_STAPLE" | "PRACTICAL_REPLACEMENT" | "HEDONIC_WANT" | "VIRAL_TREND",
  "hedonicScore": number, // 0 to 100
  "confidence": number // 0.0 to 1.0
}
Score guidelines:
- Essential/Staples/Medical: 0-15
- Practical tools/replacements: 20-40
- Discretionary wants: 50-75
- Hedonic luxury/novelty/fads: 76-100`;

  const prompt = `Classify this product:
Title: "${productTitle}"
Category: "${category || 'General'}"
Price: $${price}`;

  try {
    const text = await callGemini(prompt, systemInstruction, apiKey, true);
    return JSON.parse(text);
  } catch (err) {
    console.warn('Gemini triage fallback triggered:', err);
    return fallbackClassification(productTitle, price);
  }
}

/**
 * Tier 2: Socratic copy generator
 */
async function generateSocraticReflection(params) {
  const { productTitle, price, hourlyWage, savingsGoal, apiKey } = params;
  const hours = hourlyWage > 0 ? (price / hourlyWage).toFixed(1) : (price / 25).toFixed(1);

  if (!apiKey) {
    return `This purchase represents ${hours} hours of your working day. Freeze this in your 48-hour vault to confirm if it still serves your long-term goals.`;
  }

  const systemInstruction = `You are ZenBuy, a calm, non-judgmental financial alter-ego.
Reframe purchase desires into labor hours and long-term financial freedom.
Never shame or scold. Acknowledge the desire, present the trade-off, and recommend a 48h vault freeze.
Strictly 2 concise sentences. Do not use emojis or exclamation marks.`;

  const prompt = `The user is considering purchasing "${productTitle}" for $${price}.
Their hourly wage is $${hourlyWage} (representing approximately ${hours} hours of labor).
Their stated financial focus is: "${savingsGoal || 'Build personal financial freedom'}".
Generate the 2-sentence reality check.`;

  try {
    return await callGemini(prompt, systemInstruction, apiKey, false);
  } catch (err) {
    console.warn('Gemini Socratic fallback triggered:', err);
    return `This purchase represents ${hours} hours of your working day. Freeze this in your 48-hour vault to confirm if it still serves your long-term goals.`;
  }
}

function fallbackClassification(title, price) {
  const lower = (title || '').toLowerCase();

  // Basic heuristic keyword check
  const essentials = ['diaper', 'baby', 'soap', 'milk', 'bread', 'cable', 'battery', 'medicine', 'prescription'];
  const hedonic = ['mechanical keyboard', 'rgb', 'gaming', 'perfume', 'luxury', 'drone', 'watch', 'sunglasses'];

  for (const word of essentials) {
    if (lower.includes(word)) {
      return { classification: 'ESSENTIAL_STAPLE', hedonicScore: 10, confidence: 0.8 };
    }
  }

  for (const word of hedonic) {
    if (lower.includes(word)) {
      return { classification: 'HEDONIC_WANT', hedonicScore: 85, confidence: 0.85 };
    }
  }

  const hedonicScore = price > 100 ? 75 : 55;
  return {
    classification: 'HEDONIC_WANT',
    hedonicScore,
    confidence: 0.7
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    classifyProductWithGemini,
    generateSocraticReflection,
    fallbackClassification
  };
}
