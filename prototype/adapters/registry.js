/**
 * ZenBuy Platform Adapter Registry
 * Resolves the appropriate adapter for the current site or falls back gracefully.
 */

var AdapterRegistry = (function () {
  const adapters = [
    AmazonAdapter,
    SandboxAdapter,
    FallbackAdapter
  ];

  return {
    getAdapter(loc = window.location) {
      for (const adapter of adapters) {
        try {
          if (adapter && typeof adapter.matches === 'function' && adapter.matches(loc)) {
            return adapter;
          }
        } catch (e) {
          console.warn('Error matching adapter:', adapter?.name, e);
        }
      }
      return FallbackAdapter;
    },

    getAllAdapters() {
      return adapters;
    }
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AdapterRegistry;
}
