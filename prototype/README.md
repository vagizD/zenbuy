# ZenBuy Prototype

Client-side Chrome Extension (Manifest V3) prototype implementing the ZenBuy impulse risk engine and Socratic intercept modal.

## Architecture

- `manifest.json`: Manifest V3 extension configuration.
- `shared/irs.js`: Mathematical impulse risk scoring formula (Taxonomy, Velocity, Circadian, Dark Patterns, Financial ratio).
- `shared/gemini.js`: Google Gemini API client for product triage and Socratic nudge copy.
- `background.js`: Service worker managing state, Vault storage, and Gemini routing.
- `content/`: Content scripts and styles for DOM product extraction, wage badges, and intercept modals.
- `popup/`: Extension popup showing 48-Hour Vault, total money saved, hours of work retained, and configuration.
- `test-store/`: Standalone mock store to test scenarios without external dependencies.

## Setup Instructions

1. Open Google Chrome (or any Chromium browser).
2. Navigate to `chrome://extensions`.
3. Enable **Developer mode** (toggle in upper right).
4. Click **Load unpacked** and select the `prototype/` directory.
5. Click the ZenBuy extension icon in your browser toolbar:
   - Enter your hourly wage.
   - Enter your Gemini API key (from Google AI Studio).
6. Open `prototype/test-store/index.html` in Chrome to test different products, dark pattern detections, and purchase intercepts.
