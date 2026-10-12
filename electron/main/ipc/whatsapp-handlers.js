const { app, ipcMain } = require('electron');
const { exec } = require('child_process');
const fs = require('fs');

const WhatsAppManager = require('../../services/whatsapp-manager');
const { createPaths } = require('../shared/paths');
const { isWindows, isMac, macOpenApplication } = require('../../services/platform-utils');

function loadRobotModule() {
  return require('@jitsi/robotjs');
}

function registerWhatsAppHandlers({ getMainWindow, getWhatsAppManager, setWhatsAppManager }) {
  const paths = createPaths(app);

  ipcMain.handle('whatsapp-init', async () => {
    try {
      let manager = getWhatsAppManager();
      if (!manager) {
        manager = new WhatsAppManager(getMainWindow(), app);
        setWhatsAppManager(manager);
      } else {
        manager.updateMainWindow(getMainWindow());
      }
      await manager.initialize();
      return { success: true, state: manager.getState() };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('whatsapp-get-state', async () => {
    try {
      const manager = getWhatsAppManager();
      if (!manager) {
        return {
          status: 'disconnected',
          reason: null,
          isReady: false,
          isInitializing: false,
          qrCode: null,
          reconnectAttempts: 0,
        };
      }
      return manager.getState();
    } catch (_error) {
      return {
        status: 'disconnected',
        reason: 'state-read-failed',
        isReady: false,
        isInitializing: false,
        qrCode: null,
        reconnectAttempts: 0,
      };
    }
  });

  ipcMain.handle('get-whatsapp-settings', async () => {
    try {
      const p = paths.getWhatsAppSettingsPath();
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
      return { autoConnect: true };
    } catch (_error) {
      return { autoConnect: true };
    }
  });

  ipcMain.handle('save-whatsapp-settings', async (_event, settings) => {
    try {
      const settingsPath = paths.getWhatsAppSettingsPath();
      const currentSettings = fs.existsSync(settingsPath)
        ? JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
        : {};
      const mergedSettings = { ...currentSettings, ...(settings || {}) };
      fs.writeFileSync(settingsPath, JSON.stringify(mergedSettings, null, 2));
      return true;
    } catch (_error) {
      return false;
    }
  });

  ipcMain.handle('whatsapp-logout', async () => {
    try {
      const manager = getWhatsAppManager();
      if (manager) {
        await manager.logout();
      }
      return { success: true, state: manager ? manager.getState() : null };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('whatsapp-send-reply', async (_event, { chatId, message }) => {
    try {
      const manager = getWhatsAppManager();
      if (manager) {
        const sent = await manager.sendReply(chatId, message);
        if (sent) return { success: true };
        return { success: false, error: 'WhatsApp client is not ready or message failed to send.' };
      }
      return { success: false, error: 'WhatsApp Manager not initialized' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('remote-access-status', async () => ({ isRunning: false }));

  ipcMain.handle('send-whatsapp-keyboard', async (_event, args) => {
    try {
      const name = String(args?.name || '').trim();
      // Collapse newlines into spaces so a multi-line message can never trigger an
      // early Enter that sends it half-typed. This is a quick ONE-shot sender.
      const message = String(args?.message || '').replace(/[\r\n]+/g, ' ').trim();

      if (!name || !message) {
        console.error('[WhatsApp Robot] Missing name or message:', { name, message });
        return { success: false, error: 'Contact name and message are required' };
      }

      // ═══════════════════════════════════════════════════════════════════
      //  macOS path — AppleScript via osascript
      //  WhatsApp for Mac is a Mac Catalyst app whose custom UI elements
      //  do NOT reliably accept pure-keyboard navigation (Tab / Down Arrow /
      //  Enter) through search results. The only reliable way to:
      //    a) select a search result, and
      //    b) focus the message compose box
      //  …is to CLICK them using window-relative mouse coordinates.
      //
      //  The AppleScript below:
      //    1. Activates WhatsApp
      //    2. Opens search (Cmd+F), clears it, types the contact name
      //    3. Clicks the first search result (relative to window position)
      //    4. Clicks the message compose input area
      //    5. Types the message and presses Enter to send
      // ═══════════════════════════════════════════════════════════════════
      if (isMac) {
        console.log('[WhatsApp Robot macOS] Using AppleScript approach for:', name);

        // Escape single quotes in name and message for AppleScript string safety
        const escapedName = name.replace(/'/g, "'\\''");
        const escapedMessage = message.replace(/'/g, "'\\''");

        const appleScript = `
tell application "WhatsApp" to activate
delay 3

tell application "System Events"
  tell process "WhatsApp"
    -- 1. Open search with Cmd+F
    keystroke "f" using command down
    delay 0.8

    -- 2. Clear any previous search text
    keystroke "a" using command down
    delay 0.2
    key code 51 -- Backspace/Delete
    delay 0.3

    -- 3. Type contact name
    keystroke "${escapedName}"
    delay 2.5

    -- 4. Get window geometry so we can click relative positions
    set winPos to position of window 1
    set winSize to size of window 1
    set winX to item 1 of winPos
    set winY to item 2 of winPos
    set winW to item 1 of winSize
    set winH to item 2 of winSize

    -- 5. Click the first search result
    --    The chat list is on the left side. The first result sits at
    --    roughly x = sidebar_width/2 ≈ 38% of window width,
    --    y = search_bar_height + first_result_center ≈ 25% of window height.
    set clickX to winX + round(winW * 0.35)
    set clickY to winY + round(winH * 0.28)
    do shell script "cliclick c:" & clickX & "," & clickY
    delay 1.5

    -- 6. Click the message compose box
    --    The compose/input area is at the bottom-right of the window,
    --    roughly x = 70% of width (center of chat area), y = 95% of height.
    set msgX to winX + round(winW * 0.7)
    set msgY to winY + round(winH * 0.95)
    do shell script "cliclick c:" & msgX & "," & msgY
    delay 0.5

    -- 7. Type the message and send
    keystroke "${escapedMessage}"
    delay 0.8
    key code 36 -- Enter/Return to send
    delay 0.3
  end tell
end tell
`;

        // Try AppleScript first. If cliclick is not installed, fall back to
        // a pure-RobotJS mouse-click approach.
        const { execPromise: execP } = require('../../services/platform-utils');
        try {
          await execP(`osascript -e '${appleScript.replace(/'/g, "'\\''")}'`, { timeout: 30000 });
          console.log('[WhatsApp Robot macOS] AppleScript completed successfully');
          return {
            success: true,
            output: 'Message sent successfully using AppleScript (macOS)',
            method: 'applescript_native',
          };
        } catch (asErr) {
          console.warn('[WhatsApp Robot macOS] AppleScript failed:', asErr.message);
          console.log('[WhatsApp Robot macOS] Falling back to RobotJS mouse-click approach');

          // ── Fallback: RobotJS mouse-click approach ──
          // If cliclick is not installed we can do the same with RobotJS.
          let robot;
          try {
            robot = loadRobotModule();
          } catch (rbErr) {
            return { success: false, error: 'Neither cliclick nor RobotJS available on macOS.' };
          }

          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          try { robot.setKeyboardDelay(12); } catch (_) {}

          // 1. Activate WhatsApp
          try { await execP('osascript -e \'tell application "WhatsApp" to activate\'', { timeout: 10000 }); } catch (_) {}
          await sleep(3000);

          // 2. Get window geometry via AppleScript
          let winX = 0, winY = 0, winW = 800, winH = 600;
          try {
            const geoScript = `tell application "System Events" to tell process "WhatsApp" to return (position of window 1) & "||" & (size of window 1)`;
            const geoOut = await execP(`osascript -e '${geoScript}'`, { timeout: 5000 });
            const parts = geoOut.split('||');
            if (parts.length >= 2) {
              const posParts = parts[0].split(',').map(Number);
              const sizeParts = parts[1].split(',').map(Number);
              winX = posParts[0] || 0;
              winY = posParts[1] || 0;
              winW = sizeParts[0] || 800;
              winH = sizeParts[1] || 600;
            }
          } catch (_) {
            console.warn('[WhatsApp Robot macOS] Could not get window geometry, using defaults');
          }
          console.log(`[WhatsApp Robot macOS] Window: x=${winX}, y=${winY}, w=${winW}, h=${winH}`);

          // 3. Search: Cmd+F, clear, type name
          robot.keyTap('f', 'command');
          await sleep(800);
          robot.keyTap('a', 'command');
          await sleep(200);
          robot.keyTap('backspace');
          await sleep(300);
          robot.typeString(name);
          await sleep(2500);

          // 4. Click first search result (left panel, ~35% x, ~28% y)
          const resultX = Math.round(winX + winW * 0.35);
          const resultY = Math.round(winY + winH * 0.28);
          console.log(`[WhatsApp Robot macOS] Clicking first result at: ${resultX}, ${resultY}`);
          robot.moveMouse(resultX, resultY);
          await sleep(100);
          robot.mouseClick('left');
          await sleep(1500);

          // 5. Click message compose box (right panel, ~70% x, ~95% y)
          const composeX = Math.round(winX + winW * 0.70);
          const composeY = Math.round(winY + winH * 0.95);
          console.log(`[WhatsApp Robot macOS] Clicking compose box at: ${composeX}, ${composeY}`);
          robot.moveMouse(composeX, composeY);
          await sleep(100);
          robot.mouseClick('left');
          await sleep(500);

          // 6. Type message and send
          robot.typeString(message);
          await sleep(800);
          robot.keyTap('enter');
          await sleep(300);

          return {
            success: true,
            output: 'Message sent successfully using RobotJS mouse-click fallback (macOS)',
            method: 'robotjs_mouse_mac',
          };
        }
      }

      // ═══════════════════════════════════════════════════════════════════
      //  Windows path — original RobotJS keyboard-only approach
      //  (unchanged — this has always worked reliably on Windows)
      // ═══════════════════════════════════════════════════════════════════
      let robot;
      try {
        robot = loadRobotModule();
      } catch (error) {
        console.error('[WhatsApp Robot] RobotJS not available:', error.message);
        return {
          success: false,
          error: 'RobotJS module not installed. Run: npm install robotjs',
        };
      }

      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      try { robot.setKeyboardDelay(12); } catch (_) {}

      // 1. Bring WhatsApp Desktop to the foreground.
      exec('start whatsapp:', (error) => {
        if (error) console.warn('[WhatsApp Robot] Could not open via protocol:', error.message);
      });

      // 2. Give it a generous cold-start window.
      await sleep(7000);

      // 3. Open chat search (Ctrl+F) and clear.
      robot.keyTap('f', 'control');
      await sleep(1800);
      robot.keyTap('a', 'control');
      await sleep(200);
      robot.keyTap('backspace');
      await sleep(400);

      // 4. Type the contact name and let search results settle.
      robot.typeString(name);
      await sleep(2500);

      // 5. Open the first (best) match.
      robot.keyTap('enter');
      await sleep(1800);

      // 6. Type the message and send.
      robot.typeString(message);
      await sleep(1000);
      robot.keyTap('enter');
      await sleep(400);

      return {
        success: true,
        output: 'Message sent successfully using RobotJS',
        method: 'robotjs_native',
      };
    } catch (error) {
      console.error(error);
      return {
        success: false,
        error: error.message,
      };
    }
  });

  ipcMain.handle('keyboard-press', async (_event, { key }) => {
    const startTime = Date.now();
    try {
      let robot;
      try {
        robot = loadRobotModule();
      } catch (_error) {
        return {
          success: false,
          toolName: 'keyboard_press',
          error: 'RobotJS module not available. Keyboard control requires @jitsi/robotjs.',
          errorCode: 'MODULE_NOT_AVAILABLE',
          errorCategory: 'config',
          retryable: false,
          debugInfo: { executionTimeMs: Date.now() - startTime },
        };
      }

      const lowerKey = key.toLowerCase().trim();
      if (lowerKey.includes('+')) {
        const parts = lowerKey.split('+');
        const mainKey = parts.pop();
        const modifiers = parts;
        const modMap = { ctrl: 'control', alt: 'alt', shift: 'shift', cmd: 'command', win: 'command' };
        const robotModifiers = modifiers.map((modifier) => modMap[modifier] || modifier);

        robot.keyTap(mainKey, robotModifiers);
        console.log(`[Keyboard] Pressed: ${robotModifiers.join('+')}+${mainKey}`);
        return {
          success: true,
          toolName: 'keyboard_press',
          result: `Pressed ${key}`,
          debugInfo: { executionTimeMs: Date.now() - startTime },
        };
      }

      const keyMap = {
        enter: 'enter',
        return: 'enter',
        tab: 'tab',
        escape: 'escape',
        esc: 'escape',
        backspace: 'backspace',
        delete: 'delete',
        space: 'space',
        up: 'up',
        down: 'down',
        left: 'left',
        right: 'right',
        home: 'home',
        end: 'end',
        pageup: 'pageup',
        pagedown: 'pagedown',
        f1: 'f1',
        f2: 'f2',
        f3: 'f3',
        f4: 'f4',
        f5: 'f5',
        f6: 'f6',
        f7: 'f7',
        f8: 'f8',
        f9: 'f9',
        f10: 'f10',
        f11: 'f11',
        f12: 'f12',
        printscreen: 'printscreen',
        insert: 'insert',
        capslock: 'capslock',
        numlock: 'numlock',
        scrolllock: 'scrolllock',
      };

      const robotKey = keyMap[lowerKey] || lowerKey;
      robot.keyTap(robotKey);
      console.log(`[Keyboard] Pressed: ${robotKey}`);

      return {
        success: true,
        toolName: 'keyboard_press',
        result: `Pressed ${key}`,
        debugInfo: { executionTimeMs: Date.now() - startTime },
      };
    } catch (error) {
      console.error('[Keyboard] Press failed:', error.message);
      return {
        success: false,
        toolName: 'keyboard_press',
        error: `Key press failed: ${error.message}`,
        errorCode: 'UNKNOWN_ERROR',
        errorCategory: 'transient',
        retryable: true,
        retrySuggestion: 'Make sure the target window is focused and try again.',
        debugInfo: { executionTimeMs: Date.now() - startTime, key },
      };
    }
  });

  ipcMain.handle('keyboard-type', async (_event, { text, pressEnter }) => {
    const startTime = Date.now();
    try {
      let robot;
      try {
        robot = loadRobotModule();
      } catch (_error) {
        return {
          success: false,
          toolName: 'simulate_keyboard_press',
          error: 'RobotJS module not available. Keyboard control requires @jitsi/robotjs.',
          errorCode: 'MODULE_NOT_AVAILABLE',
          errorCategory: 'config',
          retryable: false,
          debugInfo: { executionTimeMs: Date.now() - startTime },
        };
      }

      if (text && text.length > 0) {
        robot.typeString(text);
        console.log(`[Keyboard] Typed: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}" (${text.length} chars)`);
      }

      if (pressEnter) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        robot.keyTap('enter');
        console.log('[Keyboard] Pressed Enter after typing');
      }

      return {
        success: true,
        toolName: 'simulate_keyboard_press',
        result: `Typed "${text}"${pressEnter ? ' and pressed Enter' : ''}`,
        data: { charCount: text?.length || 0, enterPressed: !!pressEnter },
        debugInfo: { executionTimeMs: Date.now() - startTime },
      };
    } catch (error) {
      console.error('[Keyboard] Type failed:', error.message);
      return {
        success: false,
        toolName: 'simulate_keyboard_press',
        error: `Typing failed: ${error.message}`,
        errorCode: 'UNKNOWN_ERROR',
        errorCategory: 'transient',
        retryable: true,
        retrySuggestion: 'Make sure the target input is focused. Try clicking on it first, then type.',
        debugInfo: { executionTimeMs: Date.now() - startTime, textLength: text?.length },
      };
    }
  });
}

module.exports = { registerWhatsAppHandlers };
