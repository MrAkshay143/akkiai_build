/**
 * ═══════════════════════════════════════════════════
 *  macOS Permissions Bootstrap
 * ═══════════════════════════════════════════════════
 *
 * Proactively triggers the standard macOS permission prompts the app
 * needs, so the user sees clean system popups on first launch instead
 * of silent feature failures later:
 *
 *   - Microphone        → voice assistant + wake word
 *   - Accessibility     → robotjs mouse/keyboard + AppleScript window control
 *   - Screen Recording  → desktop screenshots (status logged; macOS only
 *                         shows this prompt on the first actual capture)
 *
 * No-op on Windows/Linux. Never throws — permission denial must never
 * crash the app; the related tools degrade gracefully instead.
 */

const { systemPreferences } = require('electron');
const { isMac } = require('./platform-utils');

const PREFIX = '[macOS Permissions]';

async function bootstrapMacPermissions() {
  if (!isMac) return;

  // ── Microphone ──
  try {
    const micStatus = systemPreferences.getMediaAccessStatus('microphone');
    console.log(`${PREFIX} Microphone: ${micStatus}`);
    if (micStatus !== 'granted') {
      const granted = await systemPreferences.askForMediaAccess('microphone');
      console.log(`${PREFIX} Microphone prompt result: ${granted ? 'granted' : 'denied'}`);
    }
  } catch (err) {
    console.warn(`${PREFIX} Microphone check failed: ${err.message}`);
  }

  // ── Accessibility (mouse/keyboard control + window titles) ──
  // Passing true makes macOS show the "add this app in System Settings →
  // Privacy & Security → Accessibility" dialog when not yet trusted.
  try {
    const trusted = systemPreferences.isTrustedAccessibilityClient(true);
    console.log(`${PREFIX} Accessibility trusted: ${trusted}`);
    if (!trusted) {
      console.warn(`${PREFIX} Desktop automation (mouse/keyboard/window control) needs Accessibility permission. macOS has shown the dialog — enable the app in System Settings.`);
    }
  } catch (err) {
    console.warn(`${PREFIX} Accessibility check failed: ${err.message}`);
  }

  // ── Screen Recording (screenshots) ──
  // macOS shows this prompt automatically on the first real capture;
  // there is no API to trigger it early. We only log the status here.
  try {
    const screenStatus = systemPreferences.getMediaAccessStatus('screen');
    console.log(`${PREFIX} Screen Recording: ${screenStatus}`);
    if (screenStatus !== 'granted') {
      console.warn(`${PREFIX} Desktop screenshots will trigger a Screen Recording permission prompt on first use.`);
    }
  } catch (err) {
    console.warn(`${PREFIX} Screen Recording check failed: ${err.message}`);
  }
}

module.exports = { bootstrapMacPermissions };
