/**
 * Claude.ai RTL Fix — Popup Script
 * Manages the enable/disable toggle and syncs state with the content script.
 */

const STORAGE_KEY = 'rtlfix_enabled';

const toggleEl  = document.getElementById('toggle');
const chipEl    = document.getElementById('chip');
const chipText  = document.getElementById('chipText');

// ── Load persisted state on popup open ─────────────────────────────────────

chrome.storage.local.get(STORAGE_KEY, result => {
  const enabled = result[STORAGE_KEY] !== false; // default: true
  setUI(enabled);
});

// ── Handle toggle change ────────────────────────────────────────────────────

toggleEl.addEventListener('change', () => {
  const enabled = toggleEl.checked;

  // Persist
  chrome.storage.local.set({ [STORAGE_KEY]: enabled });

  // Notify content script on the active Claude.ai tab
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (tab?.id && tab.url?.includes('claude.ai')) {
      chrome.tabs.sendMessage(tab.id, { type: 'SET_ENABLED', enabled })
        .catch(() => {
          // Content script not yet injected (e.g. extension just installed).
          // State will be picked up on next page load via chrome.storage.local.
        });
    }
  });

  setUI(enabled);
});

// ── Update popup UI ─────────────────────────────────────────────────────────

function setUI(enabled) {
  toggleEl.checked = enabled;

  if (enabled) {
    chipEl.className = 'chip on';
    chipText.textContent = 'Active — RTL detection running';
  } else {
    chipEl.className = 'chip off';
    chipText.textContent = 'Paused — click to re-enable';
  }
}
