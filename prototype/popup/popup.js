/**
 * ZenBuy Vault popup.
 * The popup is a local view over the lifecycle service in background.js.
 */

document.addEventListener('DOMContentLoaded', async () => {
  const wageInput = document.getElementById('hourly-wage');
  const goalInput = document.getElementById('savings-goal');
  const cooldownSelect = document.getElementById('cooldown-duration');
  const saveBtn = document.getElementById('save-settings');
  const statusMsg = document.getElementById('status-msg');
  const toggleBtn = document.getElementById('toggle-settings');
  const settingsPanel = document.getElementById('settings-panel');

  const statSaved = document.getElementById('stat-saved');
  const statHours = document.getElementById('stat-hours');
  const statIce = document.getElementById('stat-ice');
  const statIceCount = document.getElementById('stat-ice-count');
  const statUnlocked = document.getElementById('stat-unlocked');
  const statUnlockedCount = document.getElementById('stat-unlocked-count');
  const vaultTitle = document.getElementById('vault-title');
  const vaultCount = document.getElementById('vault-count');
  const archiveCount = document.getElementById('archive-count');
  const purchaseCount = document.getElementById('purchase-count');
  const storageMenu = document.getElementById('storage-menu');
  const storageDetail = document.getElementById('storage-detail');
  const storageDetailKicker = document.getElementById('storage-detail-kicker');
  const storageDetailName = document.getElementById('storage-detail-name');
  const storageDetailCount = document.getElementById('storage-detail-count');
  const storageDetailList = document.getElementById('storage-detail-list');
  const storageBack = document.getElementById('storage-back');
  const storageButtons = document.querySelectorAll('[data-storage]');
  let selectedStorage = null;
  let collections = { vault: [], archive: [], purchase: [] };
  let itemsById = new Map();

  function formatRemaining(expiresAt) {
    const remainingMs = Math.max(0, Number(expiresAt || 0) - Date.now());
    const hours = Math.floor(remainingMs / (1000 * 60 * 60));
    const minutes = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((remainingMs % (1000 * 60)) / 1000);
    if (hours > 0) return `${hours}h ${minutes}m remaining`;
    if (minutes > 0) return `${minutes}m ${seconds}s remaining`;
    return `${seconds}s remaining`;
  }

  function countLabel(count) {
    return `${count} item${count === 1 ? '' : 's'}`;
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[character]);
  }

  function itemMeta(item) {
    const price = Number(item.snapshot?.price || 0).toFixed(2);
    const hours = Number(item.snapshot?.hoursOfWork || 0).toFixed(1);
    return `$${price} · ${hours}h work time`;
  }

  function emptyState(message) {
    return `<div class="empty-state"><span class="empty-icon">✦</span>${message}</div>`;
  }

  function itemCard(item, kind) {
    const product = item.product || {};
    const title = escapeHtml(product.title || 'Untitled item');
    const id = escapeHtml(item.id);

    if (kind === 'active') {
      return `
        <article class="vault-item" data-id="${id}">
          <div class="vault-item-header">
            <div class="vault-item-title">${title}</div>
            <span class="status-badge badge-frozen">On ice</span>
          </div>
          <div class="vault-item-meta"><span>${itemMeta(item)}</span><span>${formatRemaining(item.poi?.expiresAt)}</span></div>
          <div class="vault-item-actions">
            <button type="button" class="btn-item btn-cancel-poi" data-action="cancel-poi">Cancel Put on Ice</button>
          </div>
        </article>`;
    }

    if (kind === 'archive') {
      const isExpired = item.poi?.state === 'POI_EXPIRED';
      const statusText = isExpired ? 'Cooldown complete' : 'Set aside';
      return `
        <article class="vault-item" data-id="${id}">
          <div class="vault-item-header">
            <div class="vault-item-title">${title}</div>
            <span class="status-badge badge-ready">${statusText}</span>
          </div>
          <div class="vault-item-meta"><span>${itemMeta(item)}</span><span>Price search: later</span></div>
          <div class="vault-item-actions">
            <button type="button" class="btn-item btn-archive" data-action="open-product">Product page</button>
          </div>
        </article>`;
    }

    const date = item.purchase?.observedAt ? new Date(item.purchase.observedAt).toLocaleDateString() : 'Confirmed';
    return `
      <article class="vault-item" data-id="${id}">
        <div class="vault-item-header">
          <div class="vault-item-title">${title}</div>
          <span class="status-badge badge-unlocked">Purchased</span>
        </div>
        <div class="vault-item-meta"><span>${itemMeta(item)}</span><span>${escapeHtml(date)}</span></div>
      </article>`;
  }

  function renderCollection(list, items, kind, emptyMessage) {
    list.innerHTML = items.length ? items.map(item => itemCard(item, kind)).join('') : emptyState(emptyMessage);
  }

  function attachItemActions() {
    document.querySelectorAll('[data-action="cancel-poi"]').forEach(button => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        await chrome.runtime.sendMessage({
          type: 'CANCEL_PUT_ON_ICE',
          payload: { id: button.closest('[data-id]').dataset.id }
        });
        await refresh();
      });
    });

    document.querySelectorAll('[data-action="open-product"]').forEach(button => {
      button.addEventListener('click', async () => {
        const id = button.closest('[data-id]').dataset.id;
        const url = itemsById.get(id)?.product?.url;
        if (url) await chrome.tabs.create({ url });
      });
    });
  }

  function storageMeta(storage) {
    const metadata = {
      vault: {
        kicker: 'Cooling off',
        name: 'Vault',
        kind: 'active',
        emptyMessage: 'Nothing is on ice.'
      },
      archive: {
        kicker: 'Decision archive',
        name: 'Saved for later',
        kind: 'archive',
        emptyMessage: 'No saved decisions yet.'
      },
      purchase: {
        kicker: 'Observed purchases',
        name: 'Purchase history',
        kind: 'purchase',
        emptyMessage: 'No purchases yet.'
      }
    };
    return metadata[storage];
  }

  function renderSelectedStorage() {
    const detail = selectedStorage && storageMeta(selectedStorage);
    const isDetailVisible = Boolean(detail);
    storageMenu.classList.toggle('hidden', isDetailVisible);
    storageMenu.setAttribute('aria-hidden', String(isDetailVisible));
    storageDetail.classList.toggle('hidden', !isDetailVisible);

    if (!detail) return;

    const items = collections[selectedStorage] || [];
    storageDetailKicker.textContent = detail.kicker;
    storageDetailName.textContent = detail.name;
    storageDetailCount.textContent = countLabel(items.length);
    renderCollection(storageDetailList, items, detail.kind, detail.emptyMessage);
    attachItemActions();
  }

  function render(data) {
    const activeItems = data.activeItems || [];
    const archiveItems = data.archiveItems || [];
    const purchaseHistory = data.purchaseHistory || [];

    statSaved.textContent = `$${data.archiveAmount || '0.00'}`;
    statHours.textContent = `${data.archiveCount || 0} item${data.archiveCount === 1 ? '' : 's'} saved`;
    statIce.textContent = `$${data.pendingIceAmount || '0.00'}`;
    statIceCount.textContent = `${data.pendingIceCount || 0} item${data.pendingIceCount === 1 ? '' : 's'} cooling`;
    statUnlocked.textContent = `$${data.purchaseAmount || '0.00'}`;
    statUnlockedCount.textContent = `${data.purchaseCount || 0} confirmed`;

    vaultCount.textContent = countLabel(activeItems.length);
    archiveCount.textContent = countLabel(archiveItems.length);
    purchaseCount.textContent = countLabel(purchaseHistory.length);
    collections = { vault: activeItems, archive: archiveItems, purchase: purchaseHistory };
    itemsById = new Map(
      [...activeItems, ...archiveItems, ...purchaseHistory].map(item => [String(item.id), item])
    );
    renderSelectedStorage();
  }

  function applyPreferences(data) {
    wageInput.value = data.hourlyWage || 30;
    goalInput.value = data.savingsGoal || '';
    if (data.cooldownDurationSeconds === undefined) return;

    // The Vault is a place, not a timer label. Individual cards show their
    // own remaining cooldown where that information matters.
    vaultTitle.textContent = 'Vault';
    const selectedValue = String(data.cooldownDurationSeconds);
    if (![...cooldownSelect.options].some(option => option.value === selectedValue)) {
      const option = document.createElement('option');
      option.value = selectedValue;
      option.textContent = `${data.cooldownDurationSeconds}s (Custom)`;
      cooldownSelect.appendChild(option);
    }
    cooldownSelect.value = selectedValue;
  }

  async function refresh() {
    const data = await chrome.runtime.sendMessage({ type: 'GET_VAULT_DATA' });
    if (!data || data.error) return;
    applyPreferences(data);
    render(data);
  }

  await refresh();

  // Quietly reconciles a short test timer while the popup is open. Otherwise
  // expiry happens on the next normal ZenBuy interaction, without alerts.
  setInterval(refresh, 1000);

  storageButtons.forEach(button => {
    button.addEventListener('click', () => {
      selectedStorage = button.dataset.storage;
      renderSelectedStorage();
    });
  });

  storageBack.addEventListener('click', () => {
    selectedStorage = null;
    renderSelectedStorage();
  });

  toggleBtn.addEventListener('click', () => {
    settingsPanel.classList.toggle('hidden');
    toggleBtn.setAttribute('aria-expanded', String(!settingsPanel.classList.contains('hidden')));
  });

  saveBtn.addEventListener('click', async () => {
    const wage = parseFloat(wageInput.value) || 30;
    const cooldownDurationSeconds = parseInt(cooldownSelect.value, 10);
    await chrome.storage.local.set({
      hourlyWage: wage,
      savingsGoal: goalInput.value.trim(),
      cooldownDurationSeconds
    });
    statusMsg.classList.remove('hidden');
    setTimeout(() => statusMsg.classList.add('hidden'), 2000);
    await refresh();
  });

  const clearBtn = document.getElementById('clear-vault-btn');
  clearBtn.addEventListener('click', async () => {
    if (!confirm('Clear every locally stored ZenBuy item, including archive and purchase history?')) return;
    clearBtn.disabled = true;
    clearBtn.textContent = 'Clearing…';
    await chrome.runtime.sendMessage({ type: 'CLEAR_VAULT' });
    await refresh();
    clearBtn.disabled = false;
    clearBtn.textContent = 'Clear all local ZenBuy data';
  });
});
