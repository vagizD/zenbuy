// ZenBuy Local Configuration Template
// Copy this file to `config.local.js` to set your Gemini API key and local preferences.
// `config.local.js` is ignored by git and will never be committed.

const ZENBUY_LOCAL_CONFIG = {
  gemini: {
    apiKey: '' // Paste your Google AI Studio API key here
  },
  userDefaults: {
    hourlyWage: 30
  },
  vault: {
    cooldownDurationSeconds: 48 * 60 * 60 // 48 hours in production (or e.g. 5 for testing)
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ZENBUY_LOCAL_CONFIG;
}
