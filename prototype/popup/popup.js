/**
 * ZenBuy Popup Logic
 */

document.addEventListener('DOMContentLoaded', async () => {
  const wageInput = document.getElementById('hourly-wage');
  const goalInput = document.getElementById('savings-goal');
  const keyInput = document.getElementById('gemini-key');
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
  const vaultList = document.getElementById('vault-list');

  function formatDuration(seconds) {
    if (!seconds || seconds <= 0) return '48h';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    return `${Math.round(seconds / 3600)}h`;
  }

  function updateMetricsDisplay(data) {
    if (!data) return;
    if (statSaved) statSaved.textContent = `$${data.savedAmount || '0.00'}`;
    if (statHours) statHours.textContent = `${data.savedHours || '0.0'}h labor saved`;
    if (statIce) statIce.textContent = `$${data.pendingIceAmount || '0.00'}`;
    if (statIceCount) statIceCount.textContent = `${data.pendingIceCount || 0} item${data.pendingIceCount === 1 ? '' : 's'} cooling`;
    if (statUnlocked) statUnlocked.textContent = `$${data.unlockedAmount || '0.00'}`;
    if (statUnlockedCount) statUnlockedCount.textContent = `${data.unlockedCount || 0} deliberate`;
  }

  // Load state from background
  const data = await chrome.runtime.sendMessage({ type: 'GET_VAULT_DATA' });

  if (data) {
    updateMetricsDisplay(data);
    wageInput.value = data.hourlyWage || 30;
    goalInput.value = data.savingsGoal || '';
    if (data.hasApiKey) {
      keyInput.placeholder = 'Key configured (enter new to replace)';
    }

    if (data.cooldownDurationSeconds !== undefined) {
      if (vaultTitle) {
        vaultTitle.textContent = `${formatDuration(data.cooldownDurationSeconds)} Vault`;
      }
      if (cooldownSelect) {
        const valStr = String(data.cooldownDurationSeconds);
        if (![...cooldownSelect.options].some(opt => opt.value === valStr)) {
          const opt = document.createElement('option');
          opt.value = valStr;
          opt.textContent = `${data.cooldownDurationSeconds}s (Custom)`;
          cooldownSelect.appendChild(opt);
        }
        cooldownSelect.value = valStr;
      }
    }

    let currentVault = data.vault || [];
    renderVault(currentVault);

    // Live countdown update every second
    setInterval(() => {
      renderVault(currentVault);
    }, 1000);
  }

  // Toggle settings panel
  toggleBtn.addEventListener('click', () => {
    settingsPanel.classList.toggle('hidden');
  });

  // Save settings
  saveBtn.addEventListener('click', async () => {
    const wage = parseFloat(wageInput.value) || 30;
    const goal = goalInput.value.trim();
    const key = keyInput.value.trim();
    const cooldownSecs = cooldownSelect ? parseInt(cooldownSelect.value, 10) : undefined;

    const updates = {
      hourlyWage: wage,
      savingsGoal: goal
    };

    if (key) {
      updates.geminiApiKey = key;
    }

    if (cooldownSecs !== undefined && !isNaN(cooldownSecs)) {
      updates.cooldownDurationSeconds = cooldownSecs;
      if (vaultTitle) {
        vaultTitle.textContent = `${formatDuration(cooldownSecs)} Vault`;
      }
    }

    await chrome.storage.local.set(updates);

    statusMsg.classList.remove('hidden');
    setTimeout(() => {
      statusMsg.classList.add('hidden');
    }, 2000);
  });

  function renderVault(items) {
    vaultCount.textContent = `${items.length} item${items.length === 1 ? '' : 's'}`;

    if (!items.length) {
      vaultList.innerHTML = '<div class="empty-state">No quarantined purchases yet.</div>';
      return;
    }

    const now = Date.now();
    vaultList.innerHTML = items.map(item => {
      const remainingMs = Math.max(0, item.expiresAt - now);
      const remainingHours = Math.floor(remainingMs / (1000 * 60 * 60));
      const remainingMins = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
      const remainingSecs = Math.floor((remainingMs % (1000 * 60)) / 1000);
      
      let timeLabel = 'Cooldown complete';
      if (remainingMs > 0) {
        if (remainingHours > 0) {
          timeLabel = `${remainingHours}h ${remainingMins}m remaining`;
        } else if (remainingMins > 0) {
          timeLabel = `${remainingMins}m ${remainingSecs}s remaining`;
        } else {
          timeLabel = `${remainingSecs}s remaining`;
        }
      }
      const isArchived = item.status === 'ARCHIVED_SAVED';
      const isUnlocked = item.status === 'UNLOCKED';

      let statusBadge = '';
      if (isArchived) {
        statusBadge = '<span class="status-badge badge-saved">🏆 Impulse Averted</span>';
      } else if (isUnlocked) {
        statusBadge = '<span class="status-badge badge-unlocked">🔓 Unlocked</span>';
      } else if (remainingMs > 0) {
        statusBadge = '<span class="status-badge badge-frozen">❄️ On Ice</span>';
      } else {
        statusBadge = '<span class="status-badge badge-ready">Ready to Decide</span>';
      }

      return `
        <div class="vault-item" data-id="${item.id}">
          <div class="vault-item-header">
            <div class="vault-item-title">${escapeHtml(item.title)}</div>
            ${statusBadge}
          </div>
          <div class="vault-item-meta">
            <span>$${Number(item.price).toFixed(2)} (${item.hoursOfWork}h labor)</span>
            <span>${timeLabel}</span>
          </div>
          <div class="vault-item-actions">
            ${isArchived ? `
              <span class="btn-item btn-saved-pill">Permanently Saved ($${Number(item.price).toFixed(2)})</span>
            ` : isUnlocked ? `
              <button class="btn-item btn-archive" data-action="archive">Archive & Save Instead</button>
              <a href="${escapeHtml(item.url || '#')}" target="_blank" class="btn-item btn-unlock">Open Deal Page</a>
            ` : remainingMs > 0 ? `
              <button class="btn-item btn-archive" data-action="archive">Archive & Save Now</button>
              <button class="btn-item btn-locked" disabled title="Quarantined during cooldown">Locked (${timeLabel})</button>
            ` : `
              <button class="btn-item btn-archive" data-action="archive">Archive & Save</button>
              <button class="btn-item btn-unlock" data-action="unlock" data-url="${escapeHtml(item.url || '#')}">Unlock Deal</button>
            `}
          </div>
        </div>
      `;
    }).join('');

    // Attach click listeners for Archive
    vaultList.querySelectorAll('[data-action="archive"]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const itemEl = e.target.closest('.vault-item');
        const id = itemEl.getAttribute('data-id');
        btn.disabled = true;
        btn.textContent = 'Saving...';

        await chrome.runtime.sendMessage({
          type: 'UPDATE_VAULT_ITEM',
          payload: { id, status: 'ARCHIVED_SAVED' }
        });

        // Refresh data
        const refreshed = await chrome.runtime.sendMessage({ type: 'GET_VAULT_DATA' });
        updateMetricsDisplay(refreshed);
        renderVault(refreshed.vault || []);
      });
    });

    // Attach click listeners for Unlock
    vaultList.querySelectorAll('[data-action="unlock"]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const itemEl = e.target.closest('.vault-item');
        const id = itemEl.getAttribute('data-id');
        const targetUrl = btn.getAttribute('data-url');
        btn.disabled = true;
        btn.textContent = 'Unlocking...';

        await chrome.runtime.sendMessage({
          type: 'UPDATE_VAULT_ITEM',
          payload: { id, status: 'UNLOCKED' }
        });

        // Refresh data
        const refreshed = await chrome.runtime.sendMessage({ type: 'GET_VAULT_DATA' });
        updateMetricsDisplay(refreshed);
        renderVault(refreshed.vault || []);

        if (targetUrl && targetUrl !== '#') {
          chrome.tabs.create({ url: targetUrl });
        }
      });
    });
  }

  // Clear Vault Handlers (Testing Utilities)
  async function performClearVault(btn) {
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Clearing...';
    }

    await chrome.runtime.sendMessage({ type: 'CLEAR_VAULT' });
    const refreshed = await chrome.runtime.sendMessage({ type: 'GET_VAULT_DATA' });
    updateMetricsDisplay(refreshed);
    renderVault([]);

    if (btn) {
      btn.textContent = '✅ Cleared!';
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = btn.id === 'quick-clear-vault' ? 'Clear' : '🗑️ Clear Vault & Reset Items';
      }, 1400);
    }
  }

  const clearBtn = document.getElementById('clear-vault-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (confirm('Clear all items from the vault and reset metrics?')) {
        performClearVault(clearBtn);
      }
    });
  }

  const quickClearBtn = document.getElementById('quick-clear-vault');
  if (quickClearBtn) {
    quickClearBtn.addEventListener('click', () => {
      if (confirm('Quick-clear all vault items?')) {
        performClearVault(quickClearBtn);
      }
    });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, function (m) {
      return ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[m];
    });
  }
});
