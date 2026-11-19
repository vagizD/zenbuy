(function (root) {
  'use strict';

  const PRODUCTS = Object.freeze({
    keyboard: {
      id: 'sandbox-keyboard-rgb', emoji: '⌨️', price: 139.99,
      title: 'Retro Mechanical Keyboard with RGB Backlight',
      category: 'Electronics > Computer Accessories',
      description: 'A playful mechanical keyboard designed for a dramatic desk setup.'
    },
    formula: {
      id: 'sandbox-infant-formula-32oz', emoji: '🍼', price: 32.5,
      title: 'Infant Formula Powder 32oz Nutrition Pack',
      category: 'Baby Care > Nutrition & Feeding',
      description: 'A practical household staple for routine feeding.'
    },
    headphones: {
      id: 'sandbox-noise-cancelling-earbuds', emoji: '🎧', price: 89,
      title: 'Noise Cancelling Wireless Earbuds',
      category: 'Electronics > Audio',
      description: 'Compact wireless earbuds for commuting and focus time.'
    },
    projector: {
      id: 'sandbox-galaxy-lamp', emoji: '🌌', price: 45,
      title: 'Viral Galaxy Star Ambient Lamp',
      category: 'Home & Kitchen > Novelty Lighting',
      description: 'A social-media novelty lamp with vivid room-filling stars.'
    },
    weekender: {
      id: 'sandbox-designer-weekender', emoji: '👜', price: 680,
      title: 'Designer Leather Weekender Bag',
      category: 'Fashion > Luxury Accessories',
      description: 'A premium travel bag designed as a deterministic Tier 2 reflection scenario.'
    },
    watch: {
      id: 'sandbox-luxury-watch', emoji: '⌚', price: 950,
      title: 'Luxury Automatic Watch',
      category: 'Fashion > Luxury Accessories',
      description: 'A premium watch designed as a deterministic Tier 2 Put on Ice scenario.'
    }
  });

  function query() { return new URLSearchParams(window.location.search); }
  function selectedProduct() { return PRODUCTS[query().get('product')] || PRODUCTS.keyboard; }
  function price(value) { return `$${Number(value).toFixed(2)}`; }
  function productKey(product) { return Object.keys(PRODUCTS).find(key => PRODUCTS[key] === product) || 'keyboard'; }
  function productUrl(product) {
    return new URL(`index.html?product=${encodeURIComponent(productKey(product))}`, window.location.href).href;
  }
  function route(page, product, extra = {}) {
    const params = new URLSearchParams({ product: productKey(product), ...extra });
    return `${page}?${params.toString()}`;
  }
  function orderId() { return `SBX-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`; }
  function setText(id, value) { const element = document.getElementById(id); if (element) element.textContent = value; return element; }

  function renderProductPage() {
    const product = selectedProduct();
    const params = query();
    const hour = params.get('hour') || '23';
    const urgency = params.get('urgency') !== '0';
    const stock = params.get('stock') !== '0';
    document.body.setAttribute('data-zenbuy-simulated-hour', hour);

    const selector = document.getElementById('preset-select');
    selector.value = productKey(product);
    selector.addEventListener('change', () => {
      window.location.href = route('index.html', PRODUCTS[selector.value], { hour, urgency: urgency ? '1' : '0', stock: stock ? '1' : '0' });
    });
    const timeSelector = document.getElementById('time-select');
    timeSelector.value = hour;
    timeSelector.addEventListener('change', () => {
      window.location.href = route('index.html', product, { hour: timeSelector.value, urgency: urgency ? '1' : '0', stock: stock ? '1' : '0' });
    });
    const urgencyToggle = document.getElementById('toggle-urgency');
    const stockToggle = document.getElementById('toggle-stock');
    urgencyToggle.checked = urgency;
    stockToggle.checked = stock;
    urgencyToggle.addEventListener('change', () => {
      window.location.href = route('index.html', product, { hour, urgency: urgencyToggle.checked ? '1' : '0', stock: stock ? '1' : '0' });
    });
    stockToggle.addEventListener('change', () => {
      window.location.href = route('index.html', product, { hour, urgency: urgency ? '1' : '0', stock: stockToggle.checked ? '1' : '0' });
    });

    setText('product-emoji', product.emoji);
    const category = setText('prod-category', product.category);
    const title = setText('prod-title', product.title);
    const amount = setText('prod-price', price(product.price));
    setText('prod-description', product.description);
    category?.setAttribute('data-zenbuy-category', '');
    title?.setAttribute('data-zenbuy-title', '');
    title?.setAttribute('data-zenbuy-product-id', product.id);
    amount?.setAttribute('data-zenbuy-price', String(product.price));
    amount?.setAttribute('data-zenbuy-product-id', product.id);
    document.getElementById('banner-urgency')?.classList.toggle('hidden', !urgency);
    document.getElementById('banner-stock')?.classList.toggle('hidden', !stock);

    document.getElementById('add-to-cart-button').addEventListener('click', () => {
      window.location.href = route('cart.html', product, { hour });
    });
    document.getElementById('buy-now-button').addEventListener('click', () => {
      window.location.href = route('confirmation.html', product, { order: orderId() });
    });
  }

  function renderCartPage() {
    const product = selectedProduct();
    setText('cart-product-title', product.title);
    setText('cart-product-price', price(product.price));
    document.getElementById('place-order-button').addEventListener('click', () => {
      window.location.href = route('confirmation.html', product, { order: orderId() });
    });
    document.getElementById('back-to-product').href = route('index.html', product);
  }

  function renderConfirmationPage() {
    const product = selectedProduct();
    const id = query().get('order') || 'SBX-TEST-ORDER';
    const confirmation = document.getElementById('sandbox-confirmation');
    confirmation.setAttribute('data-zenbuy-confirmation-id', id);
    setText('confirmation-order-id', id);
    const item = document.getElementById('purchased-item');
    item.setAttribute('data-zenbuy-title', product.title);
    item.setAttribute('data-zenbuy-product-id', product.id);
    item.setAttribute('data-zenbuy-product-url', productUrl(product));
    setText('purchased-item-title', product.title);
    setText('purchased-item-price', price(product.price));
    document.getElementById('back-to-product').href = route('index.html', product);
  }

  root.ZenBuySandboxStore = { PRODUCTS, renderProductPage, renderCartPage, renderConfirmationPage };
})(window);
