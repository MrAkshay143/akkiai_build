/**
 * ═══════════════════════════════════════════════════
 *  Desktop Manager Service (Backend)
 * ═══════════════════════════════════════════════════
 * 
 * Handles OS-level desktop automation in the Main Process.
 * Uses @jitsi/robotjs for mouse/keyboard and screenshot-desktop
 * for screen capture. Pattern mirrors browser-manager.js.
 * 
 * CRITICAL: Screenshots are compressed (resized + JPEG) before
 * sending to AI to avoid token limit overflow. Raw PNGs can be
 * 2-5MB which translates to millions of text tokens. Compressed
 * JPEG at 1280px max width = ~50-100KB = safe for Gemini API.
 */

const { ipcMain, nativeImage, desktopCapturer, screen } = require('electron');
const { exec } = require('child_process');
const path = require('path');
const { isMac, macOpenApplication, macGetActiveWindow, macListWindows } = require('./platform-utils');

// Lazy-load robotjs to handle environments where native modules may fail
let robot = null;
function getRobot() {
    if (!robot) {
        try {
            robot = require('@jitsi/robotjs');
        } catch (err) {
            console.error('[DesktopManager] Failed to load @jitsi/robotjs:', err.message);
            throw new Error('RobotJS module not available. Mouse/keyboard control requires @jitsi/robotjs.');
        }
    }
    return robot;
}

// Lazy-load screenshot-desktop
let screenshot = null;
function getScreenshot() {
    if (!screenshot) {
        try {
            screenshot = require('screenshot-desktop');
        } catch (err) {
            console.error('[DesktopManager] Failed to load screenshot-desktop:', err.message);
            throw new Error('screenshot-desktop module not available.');
        }
    }
    return screenshot;
}

// Helper: promisified exec
function execPromise(command, options = {}) {
    return new Promise((resolve, reject) => {
        exec(command, { timeout: 15000, ...options }, (error, stdout, stderr) => {
            if (error) {
                reject(error);
            } else {
                resolve(stdout.toString().trim());
            }
        });
    });
}

// Helper: sleep (non-blocking)
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


/**
 * Register all Desktop Control IPC handlers
 */
function registerDesktopHandlers() {
    console.log('[DesktopManager] Registering desktop control handlers...');

    // ═══════════════════════════════════════════════
    //  DESKTOP SCREENSHOT (Compressed for AI)
    // ═══════════════════════════════════════════════
    ipcMain.handle('desktop-screenshot', async (event, args = {}) => {
        try {
            let rawBuffer = null;

            // ── METHOD 1: screenshot-desktop (preferred — full screen, multi-monitor) ──
            try {
                const screenshotFn = getScreenshot();
                const options = { format: 'png' };

                // Multi-monitor support
                if (args.displayId !== undefined && args.displayId !== null) {
                    const displays = await screenshotFn.listDisplays();
                    if (displays && displays.length > args.displayId) {
                        options.screen = displays[args.displayId].id;
                    }
                }

                rawBuffer = await screenshotFn(options);
                console.log('[DesktopManager] Screenshot captured via screenshot-desktop');
            } catch (sdErr) {
                console.warn('[DesktopManager] screenshot-desktop failed, trying desktopCapturer fallback:', sdErr.message);
            }

            // ── METHOD 2: Electron desktopCapturer fallback ──
            if (!rawBuffer) {
                try {
                    const sources = await desktopCapturer.getSources({
                        types: ['screen'],
                        thumbnailSize: { width: 1920, height: 1080 }
                    });

                    if (sources && sources.length > 0) {
                        const sourceIndex = (args.displayId && args.displayId < sources.length) ? args.displayId : 0;
                        const thumbnail = sources[sourceIndex].thumbnail;
                        rawBuffer = thumbnail.toPNG();
                        console.log('[DesktopManager] Screenshot captured via desktopCapturer fallback');
                    } else {
                        throw new Error('No screen sources found from desktopCapturer');
                    }
                } catch (dcErr) {
                    console.error('[DesktopManager] desktopCapturer fallback also failed:', dcErr.message);
                    return { success: false, error: `Screenshot failed: All capture methods exhausted. Last error: ${dcErr.message}` };
                }
            }

            // ──────────────────────────────────────────────────────
            // CRITICAL: Compress screenshot using Electron's native
            // nativeImage API — no external deps like Jimp needed.
            // Raw PNG screenshot = 2-5MB = millions of text tokens
            // Compressed JPEG at 1280px = ~50-100KB = safe for AI
            // ──────────────────────────────────────────────────────
            const img = nativeImage.createFromBuffer(rawBuffer);
            const size = img.getSize();

            let finalImg = img;
            if (size.width > 1280) {
                const scaleFactor = 1280 / size.width;
                finalImg = img.resize({
                    width: 1280,
                    height: Math.round(size.height * scaleFactor)
                });
            }

            // Convert to JPEG with medium quality (0-100 scale)
            const compressedBuffer = finalImg.toJPEG(50);
            const finalSize = finalImg.getSize();

            console.log(`[DesktopManager] Screenshot compressed: ${(rawBuffer.length / 1024).toFixed(0)}KB PNG → ${(compressedBuffer.length / 1024).toFixed(0)}KB JPEG`);

            return {
                success: true,
                data: compressedBuffer.toString('base64'),
                mimeType: 'image/jpeg',
                resolution: { width: finalSize.width, height: finalSize.height }
            };
        } catch (err) {
            console.error('[DesktopManager] Screenshot failed:', err.message);
            console.error('[DesktopManager] Stack:', err.stack);
            return { success: false, error: `Screenshot failed: ${err.message}` };
        }
    });

    // ═══════════════════════════════════════════════
    //  MOUSE MOVE
    // ═══════════════════════════════════════════════
    ipcMain.handle('desktop-mouse-move', async (event, { x, y, smooth }) => {
        try {
            const r = getRobot();
            const targetX = Math.round(x);
            const targetY = Math.round(y);

            if (smooth) {
                // Smooth animated movement
                r.moveMouseSmooth(targetX, targetY);
            } else {
                r.moveMouse(targetX, targetY);
            }

            const pos = r.getMousePos();
            return {
                success: true,
                result: `Mouse moved to (${pos.x}, ${pos.y})`,
                position: { x: pos.x, y: pos.y }
            };
        } catch (err) {
            console.error('[DesktopManager] Mouse move failed:', err.message);
            return { success: false, error: `Mouse move failed: ${err.message}` };
        }
    });

    // ═══════════════════════════════════════════════
    //  MOUSE CLICK
    // ═══════════════════════════════════════════════
    ipcMain.handle('desktop-mouse-click', async (event, { x, y, button, doubleClick }) => {
        try {
            const r = getRobot();

            // Move to coordinates if provided
            if (x !== undefined && y !== undefined && x !== null && y !== null) {
                r.moveMouse(Math.round(x), Math.round(y));
                // Small delay to ensure cursor has moved before clicking
                await sleep(50);
            }

            const mouseButton = button || 'left';

            if (doubleClick) {
                r.mouseClick(mouseButton, true); // true = double click
            } else {
                r.mouseClick(mouseButton);
            }

            const pos = r.getMousePos();
            return {
                success: true,
                result: `${doubleClick ? 'Double-clicked' : 'Clicked'} ${mouseButton} button at (${pos.x}, ${pos.y})`,
                position: { x: pos.x, y: pos.y }
            };
        } catch (err) {
            console.error('[DesktopManager] Mouse click failed:', err.message);
            return { success: false, error: `Mouse click failed: ${err.message}` };
        }
    });

    // ═══════════════════════════════════════════════
    //  MOUSE DRAG
    // ═══════════════════════════════════════════════
    ipcMain.handle('desktop-mouse-drag', async (event, { startX, startY, endX, endY, button }) => {
        try {
            const r = getRobot();
            const mouseButton = button || 'left';

            // Move to start position
            r.moveMouse(Math.round(startX), Math.round(startY));
            await sleep(100);

            // Press mouse button down
            r.mouseToggle('down', mouseButton);
            await sleep(100);

            // Move to end position (smooth for better drag behavior)
            r.moveMouseSmooth(Math.round(endX), Math.round(endY));
            await sleep(100);

            // Release mouse button
            r.mouseToggle('up', mouseButton);

            return {
                success: true,
                result: `Dragged from (${startX}, ${startY}) to (${endX}, ${endY}) using ${mouseButton} button`
            };
        } catch (err) {
            console.error('[DesktopManager] Mouse drag failed:', err.message);
            return { success: false, error: `Mouse drag failed: ${err.message}` };
        }
    });

    // ═══════════════════════════════════════════════
    //  DESKTOP SCROLL
    // ═══════════════════════════════════════════════
    ipcMain.handle('desktop-scroll', async (event, { direction, amount, x, y }) => {
        try {
            const r = getRobot();
            const scrollAmount = amount || 5;

            // Move to position if coordinates provided
            if (x !== undefined && y !== undefined && x !== null && y !== null) {
                r.moveMouse(Math.round(x), Math.round(y));
                await sleep(50);
            }

            // RobotJS scrollMouse: positive = up, negative = down
            const scrollValue = direction === 'up' ? scrollAmount : -scrollAmount;
            r.scrollMouse(0, scrollValue);

            return {
                success: true,
                result: `Scrolled ${direction} by ${scrollAmount} clicks`
            };
        } catch (err) {
            console.error('[DesktopManager] Scroll failed:', err.message);
            return { success: false, error: `Scroll failed: ${err.message}` };
        }
    });

    // ═══════════════════════════════════════════════
    //  GET ACTIVE WINDOW
    // ═══════════════════════════════════════════════
    ipcMain.handle('desktop-get-active-window', async () => {
        try {
            // macOS: AppleScript via platform-utils (needs Accessibility permission)
            if (isMac) {
                const windowInfo = await macGetActiveWindow();
                return {
                    success: true,
                    result: `Active window: "${windowInfo.title}" (${windowInfo.processName}) — Position: (${windowInfo.x}, ${windowInfo.y}), Size: ${windowInfo.width}x${windowInfo.height}`,
                    data: windowInfo
                };
            }

            // PowerShell command to get active window info
            const psCommand = `
        Add-Type @"
          using System;
          using System.Runtime.InteropServices;
          using System.Text;
          public class Win32 {
            [DllImport("user32.dll")]
            public static extern IntPtr GetForegroundWindow();
            [DllImport("user32.dll")]
            public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
            [DllImport("user32.dll")]
            public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
            [DllImport("user32.dll")]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
          }
          public struct RECT {
            public int Left, Top, Right, Bottom;
          }
"@
        $hwnd = [Win32]::GetForegroundWindow()
        $sb = New-Object System.Text.StringBuilder 256
        [Win32]::GetWindowText($hwnd, $sb, 256) | Out-Null
        $title = $sb.ToString()
        $pid = 0
        [Win32]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null
        $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
        $rect = New-Object RECT
        [Win32]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
        @{
          title = $title
          processName = $proc.ProcessName
          pid = $pid
          x = $rect.Left
          y = $rect.Top
          width = $rect.Right - $rect.Left
          height = $rect.Bottom - $rect.Top
        } | ConvertTo-Json
      `;

            const output = await execPromise(`powershell -NoProfile -Command "${psCommand.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { timeout: 10000 });
            const windowInfo = JSON.parse(output);

            return {
                success: true,
                result: `Active window: "${windowInfo.title}" (${windowInfo.processName}) — Position: (${windowInfo.x}, ${windowInfo.y}), Size: ${windowInfo.width}x${windowInfo.height}`,
                data: windowInfo
            };
        } catch (err) {
            console.error('[DesktopManager] Get active window failed:', err.message);
            return { success: false, error: `Failed to get active window: ${err.message}` };
        }
    });

    // ═══════════════════════════════════════════════
    //  LIST ALL WINDOWS
    // ═══════════════════════════════════════════════
    ipcMain.handle('desktop-list-windows', async () => {
        try {
            // macOS: AppleScript via platform-utils (needs Accessibility permission)
            if (isMac) {
                const windowList = await macListWindows();
                const summary = windowList.map((w, i) => `${i + 1}. [${w.processName}] ${w.title}`).join('\n');
                return {
                    success: true,
                    result: `Found ${windowList.length} open windows:\n${summary}`,
                    data: windowList
                };
            }

            const psCommand = `Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object ProcessName, Id, MainWindowTitle | ConvertTo-Json -Compress`;

            const output = await execPromise(`powershell -NoProfile -Command "${psCommand}"`, { timeout: 10000 });

            let windows = [];
            try {
                const parsed = JSON.parse(output);
                // PowerShell returns single object (not array) if only 1 window
                windows = Array.isArray(parsed) ? parsed : [parsed];
            } catch (e) {
                return { success: false, error: 'Failed to parse window list' };
            }

            const windowList = windows.map(w => ({
                title: w.MainWindowTitle,
                processName: w.ProcessName,
                pid: w.Id
            }));

            const summary = windowList.map((w, i) => `${i + 1}. [${w.processName}] ${w.title}`).join('\n');

            return {
                success: true,
                result: `Found ${windowList.length} open windows:\n${summary}`,
                data: windowList
            };
        } catch (err) {
            console.error('[DesktopManager] List windows failed:', err.message);
            return { success: false, error: `Failed to list windows: ${err.message}` };
        }
    });

    // ═══════════════════════════════════════════════
    //  OPEN APPLICATION
    // ═══════════════════════════════════════════════
    ipcMain.handle('desktop-open-application', async (event, { appName }) => {
        try {
            // macOS: `open -a` via platform-utils (own app-name mapping)
            if (isMac) {
                await macOpenApplication(appName);
                await sleep(1000);
                return {
                    success: true,
                    result: `Application "${appName}" launched successfully`
                };
            }

            const name = appName.toLowerCase().trim();

            // Common app mapping: friendly name → launch command
            const appMap = {
                'notepad': 'notepad',
                'calculator': 'calc',
                'calc': 'calc',
                'paint': 'mspaint',
                'mspaint': 'mspaint',
                'chrome': 'start chrome',
                'google chrome': 'start chrome',
                'firefox': 'start firefox',
                'edge': 'start msedge',
                'microsoft edge': 'start msedge',
                'explorer': 'explorer',
                'file explorer': 'explorer',
                'cmd': 'start cmd',
                'command prompt': 'start cmd',
                'powershell': 'start powershell',
                'terminal': 'start wt',
                'windows terminal': 'start wt',
                'settings': 'start ms-settings:',
                'task manager': 'taskmgr',
                'control panel': 'control',
                'word': 'start winword',
                'microsoft word': 'start winword',
                'excel': 'start excel',
                'microsoft excel': 'start excel',
                'powerpoint': 'start powerpnt',
                'microsoft powerpoint': 'start powerpnt',
                'outlook': 'start outlook',
                'onenote': 'start onenote',
                'teams': 'start msteams:',
                'microsoft teams': 'start msteams:',
                'vs code': 'start code',
                'vscode': 'start code',
                'visual studio code': 'start code',
                'spotify': 'start spotify:',
                'discord': 'start discord:',
                'slack': 'start slack:',
                'zoom': 'start zoommtg:',
                'whatsapp': 'start whatsapp:',
                'telegram': 'start tg:',
                'snipping tool': 'snippingtool',
                'snip & sketch': 'start ms-screenclip:',
                'obs': 'start obs64',
                'obs studio': 'start obs64',
                'steam': 'start steam:',
                'vlc': 'start vlc',
                'gimp': 'start gimp',
                'blender': 'start blender'
            };

            const command = appMap[name] || `start "" "${appName}"`;

            await execPromise(command, { timeout: 10000, shell: 'cmd.exe' });

            // Give the app a moment to open
            await sleep(1000);

            return {
                success: true,
                result: `Application "${appName}" launched successfully`
            };
        } catch (err) {
            // Even if exec "fails" (some start commands exit non-zero), the app may have opened
            // Check if we can be more lenient
            console.warn('[DesktopManager] Open application warning:', err.message);
            return {
                success: true,
                result: `Attempted to launch "${appName}". The application should be opening.`
            };
        }
    });

    console.log('[DesktopManager] ✅ All 8 desktop control handlers registered successfully');
}

module.exports = { registerDesktopHandlers };
