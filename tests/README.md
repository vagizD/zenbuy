# ZenBuy test suites

Install the one browser-test dependency once, then run every deterministic suite:

```bash
npm install
npm test
```

`npm run test:backend` tests Vault state-machine invariants and confirms that each retailer adapter implements the common contract. `npm run test:sandbox` tests both the local product → cart → confirmation adapter flow and the real unpacked extension injecting its ZenBuy UI into that store; no retailer account, API key, or payment is involved.

Run the IRS layer alone with:

```bash
npm run test:irs
```

`contracts/irs_engine_contract.test.js` is the product-level benchmark. It reads the 30 scenario fixtures and asserts only the final `TIER_0`, `TIER_1`, or `TIER_2` result. It has no assertion about a 0–100 score, a threshold, or an action label, so a new IRS engine can use its own formula and scale by providing an adapter for the common scenario features.

`engines/weighted_irs_v1.test.js` is intentionally separate. It tests this engine's formula, exact score convention, weights, thresholds, component rules, and actions. Those are not requirements for another engine.

The tier fixtures are offline and deterministic. `taxonomyRisk` is a recorded classifier outcome, not a live Gemini request. Gemini taxonomy tests will be a separate mocked-classifier suite, so a model/network change cannot make the IRS benchmark flaky.
