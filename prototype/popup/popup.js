/**
 * ZenBuy Popup Logic
 */

document.addEventListener('DOMContentLoaded', async () => {
  const wageInput = document.getElementById('hourly-wage');
  const goalInput = document.getElementById('savings-goal');
  const keyInput = document.getElementById('gemini-key');
  const saveBtn = document.getElementById('save-settings');
  const statusMsg = document.getElementById('status-msg');
  const toggleBtn = document.getElementById('toggle-settings');
  const settingsPanel = document.getElementById('settings-panel');

  const statSaved = document.getElementById('stat-saved');
  const statHours = document.getElementById('stat-hours');
  const vaultCount = document.getElementById('vault-count');
  const vaultList = document.getElementById('vault-list');

  // Load state from background
  const data = await chrome.runtime.sendMessage({ type: 'GET_VAULT_DATA' });

  if (data) {
    statSaved.textContent = `$${data.totalSaved}`;
    statHours.textContent = `${data.totalHours}h`;
    wageInput.value = data.hourlyWage || 30;
    goalInput.value = data.savingsGoal || '';
    if (data.hasApiKey) {
      keyInput.placeholder = 'Key configured (enter new to replace)';
    }

    renderVault(data.vault || []);
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

    const updates = {
      hourlyWage: wage,
      savingsGoal: goal
    };

    if (key) {
      updates.geminiApiKey = key;
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
      
      const isExpired = remainingMs === 0;
      const timeLabel = isExpired ? 'Cooldown complete' : `${remainingHours}h ${remainingMins}m remaining`;
      const isArchived = item.status === 'ARCHIVED_SAVED';

      return `
        <div class="vault-item" data-id="${item.id}">
          <div class="vault-item-title">${escapeHtml(item.title)}</div>
          <div class="vault-item-meta">
            <span>$${Number(item.price).toFixed(2)} (${item.hoursOfWork}h labor)</span>
            <span>${timeLabel}</span>
          </div>
          <div class="vault-item-actions">
            ${isArchived ? `
              <span class="btn-item btn-unlock" style="cursor: default;">Archived & Saved</span>
            ` : `
              <button class="btn-item btn-archive" data-action="archive">Archive & Save</button>
              <a href="${escapeHtml(item.url || '#')}" target="_blank" class="btn-item btn-unlock" data-action="unlock">Unlock Deal</a>
            `}
          </div>
        </div>
      `;
    }).join('');

    // Attach click listeners
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
        statSaved.textContent = `$${refreshed.totalSaved}`;
        statHours.textContent = `${refreshed.totalHours}h`;
        renderVault(refreshed.vault || []);
      });
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
