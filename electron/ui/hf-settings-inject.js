/**
 * Injects Hugging Face API Key field into the Settings page.
 *
 * The HF token field appears as a native-looking UI element below the
 * Gemini/OpenRouter API key section, inside the same provider card.
 * It uses the same CSS classes as the Gemini field.
 *
 * The field has NO separate Save button. Instead it listens for the
 * native `AKKI-settings-updated` event dispatched by the React
 * Settings page's Save button and auto-saves the HF token.
 */
const HF_SETTINGS_SCRIPT = `
(function() {
  if (document.getElementById('hf-settings-field')) return;

  var EYE_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  var EXT_LINK_SVG = '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';

  /**
   * Locate the provider API key section using stable DOM traversal.
   *
   * Strategy:
   *   1. Find the Gemini input by its unique placeholder.
   *   2. Walk up: input → .parentElement (relative/input-row) → .parentElement (api-key-section).
   *   3. Fall back to the OpenRouter placeholder if Gemini is not visible.
   *
   * This avoids depending on any specific Tailwind/CSS class name.
   */
  function findApiKeySection() {
    var selectors = [
      'input[placeholder="Enter your Gemini API Key"]',
      'input[placeholder="Your Gemini API key"]',
      'input[placeholder="sk-or-v1-..."]'
    ];
    for (var i = 0; i < selectors.length; i++) {
      var input = document.querySelector(selectors[i]);
      if (input && input.parentElement && input.parentElement.parentElement) {
        return input.parentElement.parentElement;
      }
    }
    return null;
  }

  /**
   * Build the Hugging Face field element.
   * Uses the same CSS classes as the native Gemini field for identical styling.
   */
  function createHFField() {
    var div = document.createElement('div');
    div.id = 'hf-settings-field';
    div.style.marginTop = '16px';
    div.className = 'space-y-3';

    var labelRow = document.createElement('div');
    labelRow.className = 'flex items-start justify-between';

    var label = document.createElement('label');
    label.className = 'text-[11px] font-medium text-white/70 uppercase tracking-wider';
    label.textContent = 'Hugging Face Token';

    var link = document.createElement('a');
    link.href = '#';
    link.className = 'flex items-center gap-1 text-[10px] text-j-cyan/70 hover:text-j-cyan transition-colors';
    link.onclick = function(e) {
      e.preventDefault();
      window.electronAPI.invoke('open-external-link', 'https://huggingface.co/settings/tokens');
    };
    link.innerHTML = 'Get Token ' + EXT_LINK_SVG;

    labelRow.appendChild(label);
    labelRow.appendChild(link);

    var inputRow = document.createElement('div');
    inputRow.className = 'relative';

    var input = document.createElement('input');
    input.id = 'hf-api-key-input';
    input.type = 'password';
    input.placeholder = 'Enter Hugging Face API Key';
    input.className = 'w-full bg-black/40 border border-white/8 rounded-xl px-4 py-3 text-white text-sm font-mono focus:outline-none focus:border-j-cyan/30 focus:ring-1 focus:ring-j-cyan/10 transition-all pr-12 placeholder:text-white/20';

    // Cache typed value across React re-renders
    input.addEventListener('input', function() {
      window._hfValue = input.value;
    });

    var toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'absolute right-3 top-1/2 -translate-y-1/2 p-1.5 text-white/25 hover:text-white/70 transition-colors';
    toggleBtn.innerHTML = EYE_SVG;
    var shown = false;
    toggleBtn.onclick = function() {
      shown = !shown;
      input.type = shown ? 'text' : 'password';
      toggleBtn.innerHTML = shown ? EYE_OFF_SVG : EYE_SVG;
    };

    inputRow.appendChild(input);
    inputRow.appendChild(toggleBtn);

    div.appendChild(labelRow);
    div.appendChild(inputRow);

    return div;
  }

  /**
   * Load the saved HF key and restore any cached (unsaved) value.
   */
  function loadOrRestoreValue() {
    var input = document.getElementById('hf-api-key-input');
    if (!input) return;

    // If the user had typed a value that was never saved, restore it
    if (window._hfValue !== undefined) {
      input.value = window._hfValue;
      return;
    }

    var invokeFn = window.electronAPI && window.electronAPI.invoke;
    if (!invokeFn) return;

    invokeFn('read-hf-key').then(function(key) {
      if (key) {
        input.value = key;
        window._hfValue = key;
      }
    }).catch(function() {
      invokeFn('get-huggingface-token').then(function(key) {
        if (key) {
          input.value = key;
          window._hfValue = key;
        }
      }).catch(function() {});
    });
  }

  /**
   * Register listeners for saving the Hugging Face token.
   */
  function setupAutoSave() {
    function saveToken() {
      var input = document.getElementById('hf-api-key-input');
      if (!input) return;
      var key = input.value.trim();
      var invokeFn = window.electronAPI && window.electronAPI.invoke;
      if (invokeFn) {
        invokeFn('save-huggingface-token', key).catch(function() {});
      }
    }
    window.addEventListener('AKKI-settings-updated', saveToken);
  }

  /**
   * Inject the HF field into the provider card.
   * Returns true if the field was injected, false if the target was not found.
   */
  function inject() {
    if (document.getElementById('hf-settings-field')) return true;

    var section = findApiKeySection();
    if (!section) return false;

    var outer = section.parentElement;
    if (!outer) return false;

    var hfField = createHFField();
    outer.insertBefore(hfField, section.nextSibling);

    // Load saved token every time Settings opens (runs on first inject and
    // every re-inject after React unmount/remount). Only the event listener
    // registration is guarded to avoid duplicate listeners.
    loadOrRestoreValue();
    if (!window._hfInitialized) {
      setupAutoSave();
      window._hfInitialized = true;
    }

    return true;
  }

  // Immediate attempt — the Settings page may already be rendered
  inject();

  // Persistent observer — React re-renders the provider card whenever the
  // user switches between Gemini, OpenRouter or OpenAI Codex, which removes
  // our injected DOM.  The observer re-injects on every DOM change so the
  // HF field always reappears, no matter how many times the card swaps.
  if (!window._hfObserver) {
    window._hfObserver = new MutationObserver(inject);
    window._hfObserver.observe(document.body, { childList: true, subtree: true });
  }
})();

// ──────────────────────────────────────────────────────────────────────────
//  SOFTWARE UPDATES CARD (Check for Updates)
//  Uses the existing electron-updater pipeline exposed through the main
//  preload: electronAPI.checkForUpdates() / onUpdateStatus() / installUpdate().
//  This is NOT a second updater — it is a manual trigger + status readout for
//  the Electron autoUpdater that is already wired to the Cloudflare Worker /
//  latest.yml generic provider.
// ──────────────────────────────────────────────────────────────────────────
;(function() {
  if (document.getElementById('akki-ai-update-card')) return;
  if (!window.electronAPI || typeof window.electronAPI.checkForUpdates !== 'function') return;

  var UPDATE_STATE = { state: 'idle', version: null, error: null, progress: null };

  function findSettingsAnchor() {
    var hf = document.getElementById('hf-settings-field');
    if (hf && hf.parentElement) return hf;
    var selectors = [
      'input[placeholder="Enter your Gemini API Key"]',
      'input[placeholder="Your Gemini API key"]',
      'input[placeholder="sk-or-v1-..."]'
    ];
    for (var i = 0; i < selectors.length; i++) {
      var input = document.querySelector(selectors[i]);
      if (input && input.parentElement && input.parentElement.parentElement) {
        return input.parentElement.parentElement;
      }
    }
    return null;
  }

  function render() {
    var statusEl = document.getElementById('akki-ai-update-status');
    var installBtn = document.getElementById('akki-ai-update-install-btn');
    var text = 'Click "Check for Updates" to look for a newer version.';
    if (UPDATE_STATE.state === 'checking') text = 'Checking for updates\u2026';
    else if (UPDATE_STATE.state === 'available') text = 'Update available: v' + UPDATE_STATE.version + '. Downloading will begin automatically.';
    else if (UPDATE_STATE.state === 'downloading') text = 'Downloading v' + UPDATE_STATE.version + '\u2026 ' + (UPDATE_STATE.progress != null ? UPDATE_STATE.progress + '%' : '');
    else if (UPDATE_STATE.state === 'downloaded') text = 'Update v' + UPDATE_STATE.version + ' downloaded. Click restart to install.';
    else if (UPDATE_STATE.state === 'unavailable') text = 'You are running the latest version.';
    else if (UPDATE_STATE.state === 'error') text = 'Update check failed: ' + (UPDATE_STATE.error || 'unknown error');
    if (statusEl) statusEl.textContent = text;
    if (installBtn) installBtn.style.display = (UPDATE_STATE.state === 'downloaded') ? '' : 'none';
  }

  function handleUpdateStatus(data) {
    if (!data || !data.status) return;
    var s = String(data.status);
    if (s === 'checking') UPDATE_STATE.state = 'checking';
    else if (s === 'available') { UPDATE_STATE.state = 'available'; UPDATE_STATE.version = data.version || null; }
    else if (s === 'not-available') { UPDATE_STATE.state = 'unavailable'; }
    else if (s === 'downloading') { UPDATE_STATE.state = 'downloading'; if (data.percent != null) UPDATE_STATE.progress = Math.round(data.percent); }
    else if (s === 'downloaded') { UPDATE_STATE.state = 'downloaded'; if (data.version) UPDATE_STATE.version = data.version; }
    else if (s === 'error') { UPDATE_STATE.state = 'error'; UPDATE_STATE.error = (data.message) || 'Unknown update error'; }
    render();
  }

  function injectUpdates() {
    if (document.getElementById('akki-ai-update-card')) return true;
    var anchor = findSettingsAnchor();
    if (!anchor) return false;

    var card = document.createElement('div');
    card.id = 'akki-ai-update-card';
    card.style.marginTop = '16px';
    card.className = 'space-y-3';

    var label = document.createElement('div');
    label.className = 'text-[11px] font-medium text-white/70 uppercase tracking-wider';
    label.textContent = 'Software Updates';
    card.appendChild(label);

    var row = document.createElement('div');
    row.className = 'flex items-center gap-3';

    var checkBtn = document.createElement('button');
    checkBtn.id = 'akki-ai-update-btn';
    checkBtn.type = 'button';
    checkBtn.className = 'rounded-lg bg-j-cyan/10 hover:bg-j-cyan/20 border border-j-cyan/20 text-white text-xs px-4 py-2 transition-colors';
    checkBtn.textContent = 'Check for Updates';
    checkBtn.onclick = function() {
      UPDATE_STATE.state = 'checking';
      render();
      try { window.electronAPI.checkForUpdates(); } catch (e) {
        UPDATE_STATE.state = 'error';
        UPDATE_STATE.error = 'Unable to trigger update check';
        render();
      }
    };
    row.appendChild(checkBtn);

    var installBtn = document.createElement('button');
    installBtn.id = 'akki-ai-update-install-btn';
    installBtn.type = 'button';
    installBtn.style.display = 'none';
    installBtn.className = 'rounded-lg bg-j-cyan text-black text-xs px-4 py-2 font-semibold transition-colors';
    installBtn.textContent = 'Restart & Install';
    installBtn.onclick = function() { try { window.electronAPI.installUpdate(); } catch (e) {} };
    row.appendChild(installBtn);

    card.appendChild(row);

    var status = document.createElement('div');
    status.id = 'akki-ai-update-status';
    status.className = 'text-xs text-white/60';
    card.appendChild(status);

    anchor.parentElement.insertBefore(card, anchor.nextSibling);

    if (!window._akkiUpdateListener) {
      try {
        window.electronAPI.onUpdateStatus(handleUpdateStatus);
        window._akkiUpdateListener = true;
      } catch (e) {}
    }
    render();
    return true;
  }

  injectUpdates();
  if (!window._akkiUpdateObserver) {
    window._akkiUpdateObserver = new MutationObserver(injectUpdates);
    window._akkiUpdateObserver.observe(document.body, { childList: true, subtree: true });
  }
})();
`;

module.exports = { HF_SETTINGS_SCRIPT };
