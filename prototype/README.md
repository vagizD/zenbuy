# ZenBuy Prototype

Client-side Chrome Extension (Manifest V3) prototype implementing the ZenBuy impulse risk engine and Socratic intercept modal.

## Architecture

- `config/config.js`: Central configuration for IRS weights, action thresholds, Gemini models/prompts, and user defaults.
- `config/config.local.js`: Optional git-ignored local overrides (e.g. personal Gemini API key).
- `engine/irs.js`: Isolated, swappable mathematical calculation engine ($IRS \in [0, 100]$).
- `shared/gemini.js`: Gemini 2.5 Flash client for structured taxonomy triage and Socratic reality-check copy.
- `background.js`: Service worker managing state, Vault storage, and API routing.
- `content/`: Content scripts and styles for DOM product extraction, wage badges, and intercept modals.
- `popup/`: Extension popup showing 48-Hour Vault, total money saved, hours of work retained, and configuration.
- `test-store/`: Standalone mock store to test scenarios without external dependencies.

## Setup Instructions

1. Open Google Chrome (or any Chromium browser).
2. Navigate to `chrome://extensions`.
3. Enable **Developer mode** (toggle in upper right).
4. Click **Load unpacked** and select the `prototype/` directory.
5. Click the ZenBuy extension icon in your browser toolbar to adjust settings if needed.
6. Open `prototype/test-store/index.html` in Chrome to test different products, dark pattern detections, and purchase intercepts.
