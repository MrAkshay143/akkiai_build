/**
 * ═══════════════════════════════════════════════════
 *  Browser Manager Service (Backend) - PRODUCTION GRADE
 *  46 Total Browser Tools (upgraded from 19)
 * ═══════════════════════════════════════════════════
 *
 * All methods return STRUCTURED JSON responses.
 *
 * Response Format:
 * {
 *   success: boolean,
 *   toolName: string,
 *   result?: string,        // Human-readable summary
 *   data?: any,             // Structured data
 *   error?: string,         // Error message
 *   errorCode?: string,     // ELEMENT_NOT_FOUND, NAVIGATION_TIMEOUT, etc.
 *   errorCategory?: string, // transient, permanent, config, timeout, not_found
 *   retryable?: boolean,
 *   retrySuggestion?: string,
 *   debugInfo?: object
 * }
 */
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const { app, ipcMain } = require('electron');
const { findBundledChromiumExecutable, getDefaultUserAgent } = require('./platform-utils');

let _chromium = null;
function getChromium() {
  if (!_chromium) {
    const { chromium } = require('playwright');
    _chromium = chromium;
  }
  return _chromium;
}

const BROWSER_DATA_DIR = path.join(app.getPath('userData'), 'browser-data');
const DOWNLOAD_DIR = app.getPath('downloads');

// ═══════════════════════════════════════════════════════════════
//  Dynamic CDP Port Resolution
//
//  Port 9222 is the conventional Chrome DevTools port, but OTHER apps
//  also use it — Adobe Premiere Pro (Adobe UXP/CEF) binds 127.0.0.1:9222
//  when running, which used to break the entire Voice-Assistant ↔ Hermes
//  shared-browser flow with "CDP WebSocket connect failed: 400 Bad Request".
//
//  Strategy: scan 9222..9252 at app startup. A port is chosen when it is
//  either FREE (we reserve it until Chromium launches) or already serving
//  a Chrome-family CDP endpoint (a leftover Akki Chromium we can share).
//  Foreign CDP-lookalikes (Browser: "Adobe UXP" etc.) are skipped.
//  The chosen port flows to every consumer: Chromium launch args, both
//  Hermes bridges (BROWSER_CDP_URL), and the Agent Town server env.
// ═══════════════════════════════════════════════════════════════

const CDP_PORT_SCAN_START = 9222;
const CDP_PORT_SCAN_END = 9252;

let resolvedCdpPort = null;       // number once resolved
let cdpPortReservation = null;    // net.Server holding the port until Chromium launch
let cdpPortPromise = null;        // in-flight resolution promise

function isChromeFamilyBrowser(browserField) {
    const b = String(browserField || '').toLowerCase();
    return b.includes('chrome') || b.includes('chromium') || b.includes('edg');
}

// Probe http://127.0.0.1:<port>/json/version → { reachable, chromeFamily, browser }
function probeCdpEndpoint(port, timeoutMs = 1500) {
    return new Promise((resolve) => {
        const req = http.get(
            { host: '127.0.0.1', port, path: '/json/version', timeout: timeoutMs },
            (res) => {
                let body = '';
                res.on('data', (c) => { body += c; });
                res.on('end', () => {
                    try {
                        const json = JSON.parse(body);
                        resolve({
                            reachable: true,
                            chromeFamily: isChromeFamilyBrowser(json.Browser),
                            browser: json.Browser || '(unknown)',
                        });
                    } catch {
                        resolve({ reachable: true, chromeFamily: false, browser: '(non-CDP HTTP service)' });
                    }
                });
            }
        );
        req.on('timeout', () => { req.destroy(); resolve({ reachable: false, chromeFamily: false, browser: null }); });
        req.on('error', () => resolve({ reachable: false, chromeFamily: false, browser: null }));
    });
}

// Try to bind a port. On success, KEEP the server listening (reservation)
// so no other app can steal the port before Chromium launches.
function tryReservePort(port) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', () => resolve(null));
        server.listen(port, '127.0.0.1', () => resolve(server));
    });
}

async function resolveCdpPort() {
    if (resolvedCdpPort !== null) return resolvedCdpPort;
    if (cdpPortPromise) return cdpPortPromise;

    cdpPortPromise = (async () => {
        // Phase 1: Try parallel reserve on first 8 ports (most common range)
        const ports = [];
        for (let p = CDP_PORT_SCAN_START; p <= CDP_PORT_SCAN_END; p++) ports.push(p);

        const reserveResults = await Promise.all(ports.map(p =>
            tryReservePort(p).then(server => ({ port: p, server }))
        ));

        // Pick the first free port
        for (const { port, server } of reserveResults) {
            if (server) {
                resolvedCdpPort = port;
                cdpPortReservation = server;
                if (port !== CDP_PORT_SCAN_START) {
                    console.warn(`[BrowserService] ⚠️ Default CDP port ${CDP_PORT_SCAN_START} unavailable — using port ${port} instead.`);
                } else {
                    console.log(`[BrowserService] CDP port ${port} reserved.`);
                }
                return port;
            }
        }

        // Phase 2: All ports occupied — probe concurrently with short timeout
        const probeResults = await Promise.all(ports.map(p =>
            probeCdpEndpoint(p, 1000).then(result => ({ port: p, ...result }))
        ));

        const chromePort = probeResults.find(r => r.reachable && r.chromeFamily);
        if (chromePort) {
            console.log(`[BrowserService] Reusing existing Chrome-family CDP on port ${chromePort.port} (Browser: ${chromePort.browser}).`);
            resolvedCdpPort = chromePort.port;
            return chromePort.port;
        }

        // Nothing free in the whole range (extremely unlikely) — fall back.
        console.error(`[BrowserService] ❌ No free CDP port in ${CDP_PORT_SCAN_START}-${CDP_PORT_SCAN_END}; falling back to ${CDP_PORT_SCAN_START}.`);
        resolvedCdpPort = CDP_PORT_SCAN_START;
        return resolvedCdpPort;
    })();

    return cdpPortPromise;
}

// Sync getter for consumers that run after startup (bridge spawn paths).
function getCdpPort() {
    return resolvedCdpPort || CDP_PORT_SCAN_START;
}

function releaseCdpPortReservation() {
    if (cdpPortReservation) {
        try { cdpPortReservation.close(); } catch { /* already closed */ }
        cdpPortReservation = null;
    }
}

function safeReadJson(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function safeWriteJson(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function setDeep(obj, keys, value) {
    let node = obj;
    for (const key of keys.slice(0, -1)) {
        const next = node[key];
        if (!next || typeof next !== 'object' || Array.isArray(next)) {
            node[key] = {};
        }
        node = node[key];
    }
    node[keys[keys.length - 1]] = value;
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeFilename(filename) {
    return String(filename || '')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .trim();
}

function extensionFromUrl(rawUrl) {
    try {
        const { pathname } = new URL(rawUrl);
        const ext = path.extname(pathname || '');
        return ext && ext.length <= 10 ? ext : '';
    } catch {
        return '';
    }
}

function resolveDownloadFilename(download) {
    const suggested = sanitizeFilename(download.suggestedFilename());
    const fallbackName = suggested || `download_${Date.now()}`;
    const inferredExt = path.extname(fallbackName) ? '' : extensionFromUrl(download.url());
    return inferredExt ? `${fallbackName}${inferredExt}` : fallbackName;
}

function ensureStandardDownloadPrefs(userDataDir, downloadDir) {
    const preferencesPath = path.join(userDataDir, 'Default', 'Preferences');
    const prefs = safeReadJson(preferencesPath) || {};

    setDeep(prefs, ['download', 'default_directory'], downloadDir);
    setDeep(prefs, ['download', 'directory_upgrade'], true);
    setDeep(prefs, ['download', 'prompt_for_download'], false);
    setDeep(prefs, ['savefile', 'default_directory'], downloadDir);
    setDeep(prefs, ['profile', 'default_content_setting_values', 'automatic_downloads'], 1);

    safeWriteJson(preferencesPath, prefs);
}

function findMatchingDownloadPath(filename, earliestMtimeMs = 0) {
    if (!fs.existsSync(DOWNLOAD_DIR)) return null;

    const parsed = path.parse(filename);
    const matcher = new RegExp(
        `^${escapeRegExp(parsed.name)}(?: \\((\\d+)\\))?${escapeRegExp(parsed.ext)}$`,
        'i'
    );

    const matches = fs.readdirSync(DOWNLOAD_DIR, { withFileTypes: true })
        .filter((entry) => entry.isFile() && matcher.test(entry.name))
        .map((entry) => {
            const fullPath = path.join(DOWNLOAD_DIR, entry.name);
            const stats = fs.statSync(fullPath);
            return { fullPath, mtimeMs: stats.mtimeMs };
        })
        .filter((entry) => entry.mtimeMs >= earliestMtimeMs)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

    return matches[0]?.fullPath || null;
}

// Common devices for emulation
const KNOWN_DEVICES = {
    'iPhone 12': { viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1' },
    'iPhone 14': { viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
    'iPad Pro': { viewport: { width: 1024, height: 1366 }, userAgent: 'Mozilla/5.0 (iPad; CPU OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1' },
    'Samsung Galaxy S20': { viewport: { width: 412, height: 915 }, userAgent: 'Mozilla/5.0 (Linux; Android 10; SM-G981B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.162 Mobile Safari/537.36' },
    'Pixel 5': { viewport: { width: 393, height: 851 }, userAgent: 'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36' },
    'Desktop 1280': { viewport: { width: 1280, height: 720 }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' },
    'Desktop 1920': { viewport: { width: 1920, height: 1080 }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' },
};

// ═══════════════════════════════════════════════════════════════
//  OpenClaw Role Classification (from snapshot-roles.ts)
//  3-tier system for precise element classification
// ═══════════════════════════════════════════════════════════════

/** Roles that represent user-interactive elements — always get a ref. */
const INTERACTIVE_ROLES = new Set([
    'button', 'checkbox', 'combobox', 'link', 'listbox', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'searchbox',
    'slider', 'spinbutton', 'switch', 'tab', 'textbox', 'treeitem',
]);

/** Roles that carry meaningful content — get a ref when named. */
const CONTENT_ROLES = new Set([
    'article', 'cell', 'columnheader', 'gridcell', 'heading',
    'listitem', 'main', 'navigation', 'region', 'rowheader',
]);

/** Structural/container roles — skipped in compact mode. */
const STRUCTURAL_ROLES = new Set([
    'application', 'directory', 'document', 'generic', 'grid', 'group',
    'ignored', 'list', 'menu', 'menubar', 'none', 'presentation',
    'row', 'rowgroup', 'table', 'tablist', 'toolbar', 'tree', 'treegrid',
]);

// ═══════════════════════════════════════════════════════════════
//  AI-Friendly Error Converter (from pw-tools-core.shared.ts)
//  Converts cryptic Playwright errors into actionable hints
// ═══════════════════════════════════════════════════════════════

function toAIFriendlyError(error, selector) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('strict mode violation')) {
        const countMatch = message.match(/resolved to (\d+) elements/);
        const count = countMatch ? countMatch[1] : 'multiple';
        return `Element "${selector}" matched ${count} elements. Run browser_snapshot to get updated refs.`;
    }

    if ((message.includes('Timeout') || message.includes('waiting for')) &&
        (message.includes('to be visible') || message.includes('not visible'))) {
        return `Element "${selector}" not found or not visible. Run browser_snapshot to see current page elements.`;
    }

    if (message.includes('intercepts pointer events') ||
        message.includes('not visible') ||
        message.includes('not receive pointer events')) {
        return `Element "${selector}" is not interactable (hidden or covered by overlay). Try browser_scroll_into_view first, or close any overlays, then re-snapshot.`;
    }

    return message;
}

class BrowserManagerService {
    constructor() {
        this.browser = null;
        this.context = null;
        this.activePage = null;
        this.akkiWin = null; // Reference to the themed window
        this.elementMap = new Map();
        this._pendingFileChooser = null;  // Captured during click for upload tools
        this._pendingFileChooserTimeout = null;
        this.isInitialized = false;
        this.consoleMessages = [];   // Console log capture
        this.pageErrors = [];        // JS error capture
        this._dialogHandler = null;  // Pending dialog handler
        this._isRelaunching = false; // Prevents concurrent relaunch attempts
    }

    // ─── HEALTH CHECK: Verify browser context is alive ──────────────
    _isBrowserAlive() {
        try {
            if (!this.context) return false;
            // Playwright's context.pages() returns a CACHED JS array even
            // after the Chrome process has died (user closed the window
            // manually), so it lies "alive=true" on dead browsers. The
            // canonical Playwright probe is browser.isConnected(), which
            // queries the actual underlying CDP/pipe connection state.
            if (this.browser && typeof this.browser.isConnected === 'function') {
                if (!this.browser.isConnected()) return false;
            }
            const pages = this.context.pages();
            return Array.isArray(pages);
        } catch {
            return false;
        }
    }

    // ─── FORCE CLOSE: Safely cleanup even when browser is dead ──────
    async _forceClose() {
        console.log('[BrowserService] Force-closing browser (cleaning up dead/stale state)...');
        this.isInitialized = false;
        this.activePage = null;
        this.consoleMessages = [];
        this.pageErrors = [];

        if (this._pendingFileChooserTimeout) {
            clearTimeout(this._pendingFileChooserTimeout);
            this._pendingFileChooserTimeout = null;
        }
        this._pendingFileChooser = null;

        // Try closing context — if already dead, just catch and move on
        if (this.context) {
            try {
                await this.context.close();
            } catch (closeErr) {
                console.warn('[BrowserService] Context close error (expected if browser was killed):', closeErr.message);
            }
            this.context = null;
        }
        this.browser = null;
    }

    // ─── AUTO-RECOVERY WRAPPER: Retry operation once on browser death ─
    //
    // Wraps every browser tool call. If the operation fails because the
    // user closed the browser window, we:
    //   1. Force-close the dead context
    //   2. Relaunch a fresh browser
    //   3. Retry the operation ONE time
    //
    async _withAutoRecovery(toolName, fn) {
        try {
            return await fn();
        } catch (firstError) {
            const msg = String(firstError?.message || firstError || '');
            const isBrowserDead =
                msg.includes('Target closed') ||
                msg.includes('browser has been closed') ||
                msg.includes('Browser closed') ||
                msg.includes('Session closed') ||
                msg.includes('Target page, context or browser has been closed') ||
                msg.includes('Connection closed') ||
                msg.includes('Protocol error') ||
                msg.includes('Execution context was destroyed') ||
                msg.includes('context or browser has been closed') ||
                !this._isBrowserAlive();

            if (!isBrowserDead) throw firstError;

            // Browser was closed by user — recover
            console.warn(`[BrowserService] Browser died during ${toolName}. Auto-recovering...`);

            if (this._isRelaunching) {
                // Another recovery is in progress — wait for it
                await new Promise(r => setTimeout(r, 3000));
                if (!this._isBrowserAlive()) {
                    return {
                        success: false,
                        toolName,
                        error: 'Browser recovery in progress. Please try again in a few seconds.',
                        errorCode: 'BROWSER_RECOVERING',
                        errorCategory: 'transient',
                        retryable: true,
                    };
                }
            }

            try {
                this._isRelaunching = true;
                await this._forceClose();
                // Small pause to let OS release resources
                await new Promise(r => setTimeout(r, 1000));
                await this.launch();
                console.log(`[BrowserService] ✅ Browser recovered! Retrying ${toolName}...`);
            } catch (relaunchErr) {
                console.error('[BrowserService] Relaunch failed:', relaunchErr.message);
                return {
                    success: false,
                    toolName,
                    error: `Browser was closed and could not be restarted: ${relaunchErr.message}`,
                    errorCode: 'BROWSER_RELAUNCH_FAILED',
                    errorCategory: 'permanent',
                    retryable: false,
                };
            } finally {
                this._isRelaunching = false;
            }

            // Retry the original operation once
            try {
                return await fn();
            } catch (retryError) {
                console.error(`[BrowserService] Retry of ${toolName} also failed:`, retryError.message);
                throw retryError;
            }
        }
    }

    async resolveBrowserDownloadPath(download, startedAt, timeoutMs = 10000) {
        const filename = resolveDownloadFilename(download);
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            const resolvedPath = findMatchingDownloadPath(filename, startedAt - 2000);
            if (resolvedPath) {
                return {
                    filename: path.basename(resolvedPath),
                    path: resolvedPath,
                };
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
        }

        const fallbackPath = path.join(DOWNLOAD_DIR, filename);
        return {
            filename: path.basename(fallbackPath),
            path: fallbackPath,
        };
    }

    async launch() {
        // If marked as initialized but browser is actually dead, clean up first
        if (this.isInitialized && this.context) {
            if (this._isBrowserAlive()) {
                return; // Already running and healthy
            }
            // Browser was closed by user or crashed — force cleanup
            console.warn('[BrowserService] Browser was marked as initialized but is dead. Cleaning up...');
            await this._forceClose();
        }

        // Cleanup any stale state from previous dead contexts
        if (this.context && !this._isBrowserAlive()) {
            console.warn('[BrowserService] Found stale context. Cleaning up before launch...');
            await this._forceClose();
        }

        if (!fs.existsSync(DOWNLOAD_DIR)) {
            fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
        }

        const isFirstRun = !fs.existsSync(BROWSER_DATA_DIR);
        if (isFirstRun) {
            console.log('[BrowserService] Creating persistent browser profile...');
        } else {
            console.log('[BrowserService] Loading saved browser profile...');
        }

        ensureStandardDownloadPrefs(BROWSER_DATA_DIR, DOWNLOAD_DIR);

        let executablePath = undefined;

        // 1. Production bundle check
        const bundledBrowserPath = path.join(process.resourcesPath, 'browsers', 'chromium-1208', 'chrome-win64', 'chrome.exe');
        if (fs.existsSync(bundledBrowserPath)) {
            console.log('[BrowserService] Using BUNDLED browser binary:', bundledBrowserPath);
            executablePath = bundledBrowserPath;
        } else {
            const devBrowserPath = path.join(__dirname, '../../browsers/chromium-1208/chrome-win64/chrome.exe');
            if (fs.existsSync(devBrowserPath)) {
                console.log('[BrowserService] Using LOCAL DEV browser binary:', devBrowserPath);
                executablePath = devBrowserPath;
            } else {
                // Cross-platform scan: any chromium-<rev> folder with this
                // platform's executable (macOS .app bundle, Linux, or a
                // Windows build with a different revision number).
                const scannedPath = findBundledChromiumExecutable([
                    process.resourcesPath ? path.join(process.resourcesPath, 'browsers') : null,
                    path.join(__dirname, '../../browsers'),
                ]);
                if (scannedPath) {
                    console.log('[BrowserService] Using bundled browser binary (platform scan):', scannedPath);
                    executablePath = scannedPath;
                } else {
                    console.log('[BrowserService] Using SYSTEM installed browser (fallback).');
                }
            }
        }

        const cdpPort = await resolveCdpPort();
        // Release the reservation just before Chromium binds the port itself
        releaseCdpPortReservation();
        console.log(`[BrowserService] Launching Chromium with CDP port ${cdpPort}...`);

        this.context = await getChromium().launchPersistentContext(BROWSER_DATA_DIR, {
            executablePath: executablePath,
            headless: false,
            viewport: null,
            userAgent: getDefaultUserAgent(),
            acceptDownloads: true,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-first-run',
                '--no-default-browser-check',
                `--remote-debugging-port=${cdpPort}`,
            ],
        });

        // Verify the DevTools server actually bound OUR port (it silently
        // fails to bind when another app grabbed it during the race window).
        probeCdpEndpoint(cdpPort, 3000).then((probe) => {
            if (probe.reachable && probe.chromeFamily) {
                console.log(`[BrowserService] ✅ CDP verified on port ${cdpPort} (Browser: ${probe.browser}).`);
            } else {
                console.error(`[BrowserService] ❌ CDP on port ${cdpPort} is NOT our Chromium (got: ${probe.browser || 'no response'}). Hermes browser sharing may fail — restart the app.`);
            }
        });

        this.browser = this.context.browser();

        const pages = this.context.pages();
        if (pages.length > 0) {
            this.activePage = pages[0];
        } else {
            this.activePage = await this.context.newPage();
        }

        // ─── Console & Error Listeners ────────────────────────────────
        this._attachPageListeners(this.activePage);

        // ─── Download auto-save ───────────────────────────────────────
        this.isInitialized = true;
        console.log('[BrowserService] ✅ Browser launched successfully.');
    }

    // ─── ATTACH PAGE LISTENERS (extracted for reuse after recovery) ──
    _attachPageListeners(page) {
        if (!page) return;

        page.on('console', (msg) => {
            this.consoleMessages.push({
                level: msg.type(),
                text: msg.text(),
                timestamp: new Date().toISOString()
            });
            // Keep max 500 messages
            if (this.consoleMessages.length > 500) {
                this.consoleMessages.shift();
            }
        });

        page.on('pageerror', (error) => {
            this.pageErrors.push({
                message: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });
            if (this.pageErrors.length > 200) {
                this.pageErrors.shift();
            }
        });
    }

    async getPage() {
        // Check if browser context is alive — if dead, relaunch
        if (!this.context || !this._isBrowserAlive()) {
            console.warn('[BrowserService] Browser context is dead or missing. Relaunching...');
            await this._forceClose();
            await new Promise(r => setTimeout(r, 500));
            await this.launch();
        }

        try {
            if (!this.activePage || this.activePage.isClosed()) {
                const pages = this.context.pages();
                if (pages.length > 0) {
                    this.activePage = pages[0];
                } else {
                    this.activePage = await this.context.newPage();
                    this._attachPageListeners(this.activePage);
                }
            }
        } catch (pageErr) {
            // Context might have died between our check and page access
            console.warn('[BrowserService] getPage() failed — browser likely closed. Relaunching...');
            await this._forceClose();
            await new Promise(r => setTimeout(r, 500));
            await this.launch();
        }

        return this.activePage;
    }

    // ─── ELEMENT RESOLVER (OpenClaw refLocator — pw-session.ts:519) ────────────
    //
    // KEY DIFFERENCE from old code:
    //   OLD: getByRole().first().or(getByPlaceholder).or(getByLabel)... → WRONG ELEMENT
    //   NEW: getByRole(role, {name, exact:true}).nth(n) → PRECISE MATCH
    //
    // Supports ref formats: e1, e2, @e3, ref=e4, [5], 5, and CSS selectors
    // ──────────────────────────────────────────────────────────────────────────
    resolveElement(page, selectorOrRef) {
        const raw = String(selectorOrRef).trim();
        if (!raw) return null;

        // 1. OpenClaw e-format: e1, e2, @e3, ref=e4
        const eMatch = raw.match(/^(?:@|ref=)?(e\d+)$/i);
        // 2. Legacy numeric format: [5], 5
        const numMatch = !eMatch && raw.match(/^\[?(\d+)\]?$/);
        const ref = eMatch ? eMatch[1].toLowerCase() : (numMatch ? `e${numMatch[1]}` : null);

        if (ref) {
            const info = this.elementMap.get(ref);
            if (!info) return null;

            // OpenClaw's exact matching — no .first() guessing
            const locator = info.name
                ? page.getByRole(info.role, { name: info.name, exact: true })
                : page.getByRole(info.role);

            // nth() picks exact duplicate instance — no ambiguity
            return (info.nth !== undefined && info.nth !== null) ? locator.nth(info.nth) : locator;
        }

        // 3. CSS selector fallback
        try {
            return page.locator(raw).first();
        } catch (e) {
            return null;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  1. NAVIGATION
    // ═══════════════════════════════════════════════════════════════

    async navigate(url) {
        const startTime = Date.now();
        const page = await this.getPage();
        if (!url.startsWith('http')) url = 'https://' + url;

        console.log(`[BrowserService] Navigating to ${url}`);

        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch (e) { }

            // Sync the themed window if it exists
            console.log('[BrowserService] Emitting sync signal for URL:', page.url());
            app.emit('sync-akki-neural-browser', page.url());
            app.emit('sync-akki-neural-browser', page.url());

            const title = await page.title();
            return {
                success: true,
                toolName: 'browser_navigate',
                result: `Navigated to: ${title} (${page.url()})`,
                data: { title, url: page.url() },
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_navigate',
                error: `Navigation failed: ${e.message}`,
                errorCode: 'NAVIGATION_TIMEOUT',
                errorCategory: 'transient',
                retryable: true,
                retrySuggestion: 'Check if the URL is correct. Also try adding https:// prefix.',
                debugInfo: { executionTimeMs: Date.now() - startTime, url }
            };
        }
    }

    async goBack() {
        const startTime = Date.now();
        const page = await this.getPage();
        try {
            await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 });
            
            // Sync the themed window
            app.emit('sync-akki-neural-browser', page.url());
            app.emit('sync-akki-neural-browser', page.url());

            const title = await page.title();
            return {
                success: true,
                toolName: 'browser_go_back',
                result: `Went back to: ${title} (${page.url()})`,
                data: { title, url: page.url() },
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_go_back',
                error: `Go back failed: ${e.message}`,
                errorCode: 'NAVIGATION_TIMEOUT',
                errorCategory: 'transient',
                retryable: true,
                retrySuggestion: 'There may be no previous page in history.',
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    async goForward() {
        const startTime = Date.now();
        const page = await this.getPage();
        try {
            await page.goForward({ waitUntil: 'domcontentloaded', timeout: 10000 });

            // Sync the themed window
            app.emit('sync-akki-neural-browser', page.url());
            app.emit('sync-akki-neural-browser', page.url());

            const title = await page.title();
            return {
                success: true,
                toolName: 'browser_go_forward',
                result: `Went forward to: ${title} (${page.url()})`,
                data: { title, url: page.url() },
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_go_forward',
                error: `Go forward failed: ${e.message}`,
                errorCode: 'NAVIGATION_TIMEOUT',
                errorCategory: 'transient',
                retryable: true,
                retrySuggestion: 'There may be no next page in history.',
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    async reload() {
        const startTime = Date.now();
        const page = await this.getPage();
        try {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
            try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch (e) { }
            
            // Sync the themed window
            app.emit('sync-akki-neural-browser', page.url());
            app.emit('sync-akki-neural-browser', page.url());

            const title = await page.title();
            return {
                success: true,
                toolName: 'browser_reload',
                result: `Page reloaded: ${title}`,
                data: { title, url: page.url() },
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_reload',
                error: `Reload failed: ${e.message}`,
                errorCode: 'NAVIGATION_TIMEOUT',
                errorCategory: 'transient',
                retryable: true,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  2. SNAPSHOT & CONTENT
    // ═══════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════
    //  SNAPSHOT — OpenClaw ariaSnapshot() Engine
    //  (from pw-tools-core.snapshot.ts + pw-role-snapshot.ts)
    //
    //  OLD: CDP Accessibility.getFullAXTree → flat list, no nth, 14 roles
    //  NEW: Playwright ariaSnapshot() → tree structure, nth disambiguation,
    //       17+10+19 role classification, compact mode
    // ═══════════════════════════════════════════════════════════════

    async snapshot() {
        const startTime = Date.now();
        const page = await this.getPage();
        this.elementMap.clear();

        try {
            // ─── Step 1: Get ARIA snapshot via Playwright ──────────────
            let ariaText;
            try {
                ariaText = await page.locator(':root').ariaSnapshot();
            } catch (ariaErr) {
                // Fallback to CDP if ariaSnapshot() not available
                ariaText = await this._fallbackCdpSnapshot(page);
            }

            if (!ariaText || !ariaText.trim()) {
                return {
                    success: true,
                    toolName: 'browser_snapshot',
                    result: 'Page has no accessible elements. The page may still be loading.',
                    data: { elementCount: 0 },
                    debugInfo: { executionTimeMs: Date.now() - startTime }
                };
            }

            // ─── Step 2: Parse & assign refs (OpenClaw's buildRoleSnapshotFromAriaSnapshot) ──
            const lines = ariaText.split('\n');
            const resultLines = [];
            let counter = 0;
            const roleCounts = {};  // "role:name" → count (nth disambiguation)
            let interactiveCount = 0;

            for (const line of lines) {
                // Parse Playwright ARIA format: "  - role \"name\" ..."
                const match = line.match(/^(\s*-\s*)(\w+)(?:\s+"([^"]*)")?(.*)$/);
                if (!match) {
                    resultLines.push(line);
                    continue;
                }

                const [, prefix, roleRaw, name, suffix] = match;
                if (roleRaw.startsWith('/')) {
                    resultLines.push(line);
                    continue;
                }

                const role = roleRaw.toLowerCase();
                const isInteractive = INTERACTIVE_ROLES.has(role);
                const isContent = CONTENT_ROLES.has(role);
                const isStructural = STRUCTURAL_ROLES.has(role);

                // Compact mode: skip unnamed structural elements (less noise for AI)
                if (isStructural && !name) continue;

                // Assign ref if interactive or named content
                const shouldHaveRef = isInteractive || (isContent && name);
                if (shouldHaveRef) {
                    counter++;
                    const ref = `e${counter}`;
                    const key = `${role}:${name || ''}`;
                    const nth = roleCounts[key] || 0;
                    roleCounts[key] = nth + 1;

                    // Store in elementMap — OpenClaw format with nth
                    this.elementMap.set(ref, {
                        role,
                        name: name || null,
                        nth: nth > 0 ? nth : undefined,
                    });

                    if (isInteractive) interactiveCount++;

                    // Build enhanced line with [ref=eN]
                    let enhanced = `${prefix}${roleRaw}`;
                    if (name) enhanced += ` "${name}"`;
                    enhanced += ` [ref=${ref}]`;
                    if (nth > 0) enhanced += ` [nth=${nth}]`;
                    if (suffix && suffix.includes('[')) enhanced += suffix;
                    resultLines.push(enhanced);
                } else {
                    resultLines.push(line);
                }
            }

            // ─── Step 3: Compact tree — remove structural branches without refs ──
            const compactedLines = [];
            for (let i = 0; i < resultLines.length; i++) {
                const line = resultLines[i];
                if (line.includes('[ref=')) {
                    compactedLines.push(line);
                    continue;
                }
                if (line.includes(':') && !line.trimEnd().endsWith(':')) {
                    compactedLines.push(line);
                    continue;
                }
                // Check if this structural line has children with refs
                const currentIndent = Math.floor((line.match(/^(\s*)/)?.[1]?.length || 0) / 2);
                let hasRelevantChildren = false;
                for (let j = i + 1; j < resultLines.length; j++) {
                    const childIndent = Math.floor((resultLines[j].match(/^(\s*)/)?.[1]?.length || 0) / 2);
                    if (childIndent <= currentIndent) break;
                    if (resultLines[j].includes('[ref=')) {
                        hasRelevantChildren = true;
                        break;
                    }
                }
                if (hasRelevantChildren) compactedLines.push(line);
            }

            // ─── Step 4: Build final output ───────────────────────────
            const title = await page.title();
            const snapshotText = `SNAPSHOT — "${title}" (${page.url()})\n${compactedLines.join('\n')}\n\n${interactiveCount} interactive elements. Use [ref=eN] to interact (e.g. browser_click with ref "e3").`;

            return {
                success: true,
                toolName: 'browser_snapshot',
                result: snapshotText,
                data: {
                    title,
                    url: page.url(),
                    elementCount: counter,
                    interactiveCount,
                },
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_snapshot',
                error: `Snapshot failed: ${e.message}`,
                errorCode: 'PAGE_CRASHED',
                errorCategory: 'transient',
                retryable: true,
                retrySuggestion: 'The page may still be loading. Wait a moment and try again.',
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    // ─── Fallback CDP Snapshot (when Playwright ariaSnapshot() not available) ──
    async _fallbackCdpSnapshot(page) {
        try {
            const cdpSession = await page.context().newCDPSession(page);
            const { nodes } = await cdpSession.send('Accessibility.getFullAXTree');
            await cdpSession.detach();
            if (!nodes || nodes.length === 0) return '';

            const lines = [];
            for (const node of nodes) {
                if (node.ignored) continue;
                const role = String(node.role?.value || '').toLowerCase();
                const name = String(node.name?.value || '').trim();
                if (!role || role === 'none' || role === 'generic') continue;
                if (!name && !INTERACTIVE_ROLES.has(role)) continue;

                let line = `- ${role}`;
                if (name) line += ` "${name.substring(0, 120)}"`;
                lines.push(line);
                if (lines.length >= 600) break;
            }
            return lines.join('\n');
        } catch (e) {
            return '';
        }
    }

    async getHtml(selector, maxChars = 100000) {
        const startTime = Date.now();
        const page = await this.getPage();
        try {
            let html;
            if (selector) {
                const locator = await this.resolveElement(page, selector);
                if (!locator) {
                    return {
                        success: false,
                        toolName: 'browser_get_html',
                        error: `Element "${selector}" not found.`,
                        errorCode: 'ELEMENT_NOT_FOUND',
                        errorCategory: 'not_found',
                        retryable: true,
                        retrySuggestion: 'Take a browser_snapshot to find the correct element ref.',
                        debugInfo: { executionTimeMs: Date.now() - startTime }
                    };
                }
                html = await locator.innerHTML();
            } else {
                html = await page.evaluate(() => document.documentElement.outerHTML);
            }
            const truncated = html.substring(0, maxChars);
            return {
                success: true,
                toolName: 'browser_get_html',
                result: truncated,
                data: { chars: truncated.length, truncated: html.length > maxChars },
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_get_html',
                error: `Get HTML failed: ${e.message}`,
                errorCode: 'UNKNOWN_ERROR',
                errorCategory: 'transient',
                retryable: true,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    async querySelector(selector, limit = 20, maxTextChars = 500) {
        const startTime = Date.now();
        const page = await this.getPage();
        try {
            const results = await page.evaluate(({ sel, lim, maxChars }) => {
                const elements = Array.from(document.querySelectorAll(sel)).slice(0, lim);
                return elements.map((el, i) => ({
                    index: i,
                    tag: el.tagName.toLowerCase(),
                    text: (el.innerText || el.textContent || '').trim().substring(0, maxChars),
                    value: el.value || '',
                    href: el.href || '',
                    id: el.id || '',
                    className: el.className || '',
                    type: el.type || '',
                    placeholder: el.placeholder || '',
                }));
            }, { sel: selector, lim: limit, maxChars: maxTextChars });

            return {
                success: true,
                toolName: 'browser_query_selector',
                result: `Found ${results.length} element(s) matching "${selector}"`,
                data: { matches: results, count: results.length },
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_query_selector',
                error: `Query selector failed: ${e.message}`,
                errorCode: 'UNKNOWN_ERROR',
                errorCategory: 'permanent',
                retryable: false,
                retrySuggestion: 'Check the CSS selector syntax.',
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  3. INTERACTIONS (enhanced)
    // ═══════════════════════════════════════════════════════════════

    async click(selector, opts = {}) {
        const startTime = Date.now();
        const page = await this.getPage();
        const { doubleClick = false, button = 'left', modifiers = [], delayMs = 0 } = opts;
        try {
            const locator = await this.resolveElement(page, selector);
            if (!locator) {
                return {
                    success: false,
                    toolName: 'browser_click',
                    error: `Element "${selector}" not found on the page.`,
                    errorCode: 'ELEMENT_NOT_FOUND',
                    errorCategory: 'not_found',
                    retryable: true,
                    retrySuggestion: 'Take a browser_snapshot first to find the correct element reference number, then retry with the right ref.',
                    debugInfo: { executionTimeMs: Date.now() - startTime, selector }
                };
            }

            const clickOpts = { timeout: 5000, button, modifiers, delay: delayMs };

            // ─── OpenClaw Pattern: Proactively capture filechooser ────────
            // Sites like Google Drive, YouTube, TikTok open native file dialogs
            // on click. The filechooser event fires NOW, but browser_upload_file
            // is called LATER. We capture it here so upload can use it.
            this._pendingFileChooser = null;
            if (this._pendingFileChooserTimeout) {
                clearTimeout(this._pendingFileChooserTimeout);
                this._pendingFileChooserTimeout = null;
            }
            const chooserPromise = page.waitForEvent('filechooser', { timeout: 2000 })
                .then(chooser => {
                    this._pendingFileChooser = chooser;
                    console.log('[BrowserService] ✅ File chooser captured proactively');
                    // Auto-expire after 60s if not used
                    this._pendingFileChooserTimeout = setTimeout(() => {
                        this._pendingFileChooser = null;
                        this._pendingFileChooserTimeout = null;
                    }, 60000);
                })
                .catch(() => { /* No file chooser triggered — normal for non-upload clicks */ });

            if (doubleClick) {
                await locator.dblclick(clickOpts);
            } else {
                await locator.click(clickOpts);
            }

            // Give filechooser a moment to fire (it's async)
            await Promise.race([chooserPromise, new Promise(r => setTimeout(r, 500))]);

            return {
                success: true,
                toolName: 'browser_click',
                result: `${doubleClick ? 'Double-clicked' : 'Clicked'} element "${selector}"${modifiers.length ? ` with ${modifiers.join('+')}` : ''}${this._pendingFileChooser ? ' (file chooser opened — use browser_upload_file next)' : ''}`,
                debugInfo: { executionTimeMs: Date.now() - startTime, selector, fileChooserCaptured: !!this._pendingFileChooser }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_click',
                error: toAIFriendlyError(e, selector),
                errorCode: e.message?.includes('timeout') ? 'ELEMENT_NOT_FOUND' : 'UNKNOWN_ERROR',
                errorCategory: 'transient',
                retryable: true,
                retrySuggestion: 'Run browser_snapshot to get fresh refs, then retry with the correct ref.',
                debugInfo: { executionTimeMs: Date.now() - startTime, selector }
            };
        }
    }

    async type(selector, text, clearFirst = true, slowly = false) {
        const startTime = Date.now();
        const page = await this.getPage();
        try {
            const locator = await this.resolveElement(page, selector);
            if (!locator) {
                return {
                    success: false,
                    toolName: 'browser_type',
                    error: `Input element "${selector}" not found.`,
                    errorCode: 'ELEMENT_NOT_FOUND',
                    errorCategory: 'not_found',
                    retryable: true,
                    retrySuggestion: 'Take a browser_snapshot to find the correct input element, then try again with the right ref number.',
                    debugInfo: { executionTimeMs: Date.now() - startTime, selector }
                };
            }

            if (slowly) {
                // Human-like typing with 75ms delay per character — avoids bot detection
                await locator.click();
                if (clearFirst) {
                    await locator.selectText().catch(() => {});
                    await page.keyboard.press('Delete');
                }
                await locator.pressSequentially(text, { delay: 75 });
            } else if (clearFirst) {
                await locator.fill(text);
            } else {
                await locator.click();
                await locator.pressSequentially(text, { delay: 30 });
            }

            return {
                success: true,
                toolName: 'browser_type',
                result: `Typed "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}" into "${selector}"${slowly ? ' (human-like)' : ''}${clearFirst ? ' (cleared first)' : ' (appended)'}`,
                debugInfo: { executionTimeMs: Date.now() - startTime, selector, textLength: text.length, slowly }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_type',
                error: toAIFriendlyError(e, selector),
                errorCode: 'UNKNOWN_ERROR',
                errorCategory: 'transient',
                retryable: true,
                retrySuggestion: 'Run browser_snapshot to get fresh refs, then retry. Make sure the element is a text input.',
                debugInfo: { executionTimeMs: Date.now() - startTime, selector }
            };
        }
    }

    async fillForm(fields, timeoutMs = 8000) {
        const startTime = Date.now();
        const page = await this.getPage();
        const results = [];

        for (const field of fields) {
            const { selector, text, clearFirst = true } = field;
            try {
                const locator = await this.resolveElement(page, selector);
                if (!locator) {
                    results.push({ selector, ok: false, error: 'Element not found' });
                    continue;
                }
                if (clearFirst) {
                    await locator.fill(text, { timeout: timeoutMs });
                } else {
                    await locator.pressSequentially(text, { delay: 30 });
                }
                results.push({ selector, ok: true });
            } catch (e) {
                results.push({ selector, ok: false, error: e.message });
            }
        }

        const successCount = results.filter(r => r.ok).length;
        return {
            success: successCount > 0,
            toolName: 'browser_fill_form',
            result: `Filled ${successCount}/${fields.length} form fields`,
            data: { results },
            debugInfo: { executionTimeMs: Date.now() - startTime }
        };
    }

    async hover(selector) {
        const startTime = Date.now();
        const page = await this.getPage();
        try {
            const locator = await this.resolveElement(page, selector);
            if (!locator) {
                return {
                    success: false,
                    toolName: 'browser_hover',
                    error: `Element "${selector}" not found.`,
                    errorCode: 'ELEMENT_NOT_FOUND',
                    errorCategory: 'not_found',
                    retryable: true,
                    retrySuggestion: 'Take a browser_snapshot to verify the element exists.',
                    debugInfo: { executionTimeMs: Date.now() - startTime, selector }
                };
            }
            await locator.hover();
            return {
                success: true,
                toolName: 'browser_hover',
                result: `Hovering over "${selector}"`,
                debugInfo: { executionTimeMs: Date.now() - startTime, selector }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_hover',
                error: toAIFriendlyError(e, selector),
                errorCode: 'UNKNOWN_ERROR',
                errorCategory: 'transient',
                retryable: true,
                retrySuggestion: 'Run browser_snapshot to get fresh refs.',
                debugInfo: { executionTimeMs: Date.now() - startTime, selector }
            };
        }
    }

    async scrollIntoView(selector) {
        const startTime = Date.now();
        const page = await this.getPage();
        try {
            const locator = await this.resolveElement(page, selector);
            if (!locator) {
                return {
                    success: false,
                    toolName: 'browser_scroll_into_view',
                    error: `Element "${selector}" not found.`,
                    errorCode: 'ELEMENT_NOT_FOUND',
                    errorCategory: 'not_found',
                    retryable: true,
                    retrySuggestion: 'Take a browser_snapshot to find the correct element ref.',
                    debugInfo: { executionTimeMs: Date.now() - startTime }
                };
            }
            await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
            return {
                success: true,
                toolName: 'browser_scroll_into_view',
                result: `Scrolled element "${selector}" into view`,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_scroll_into_view',
                error: `Scroll into view failed: ${e.message}`,
                errorCode: 'UNKNOWN_ERROR',
                errorCategory: 'transient',
                retryable: true,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    async highlight(selector) {
        const startTime = Date.now();
        const page = await this.getPage();
        try {
            const locator = await this.resolveElement(page, selector);
            if (!locator) {
                return {
                    success: false,
                    toolName: 'browser_highlight',
                    error: `Element "${selector}" not found.`,
                    errorCode: 'ELEMENT_NOT_FOUND',
                    errorCategory: 'not_found',
                    retryable: true,
                    retrySuggestion: 'Take a browser_snapshot to find the correct element ref.',
                    debugInfo: { executionTimeMs: Date.now() - startTime }
                };
            }
            const handle = await locator.elementHandle();
            if (handle) {
                await handle.evaluate((el) => {
                    const prev = el.style.outline;
                    el.style.outline = '3px solid red';
                    setTimeout(() => { el.style.outline = prev; }, 2000);
                });
            }
            return {
                success: true,
                toolName: 'browser_highlight',
                result: `Highlighted element "${selector}" with red outline (2 seconds)`,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_highlight',
                error: `Highlight failed: ${e.message}`,
                errorCode: 'UNKNOWN_ERROR',
                errorCategory: 'transient',
                retryable: true,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    async select(selector, value) {
        const startTime = Date.now();
        const page = await this.getPage();
        try {
            const locator = await this.resolveElement(page, selector);
            if (!locator) {
                return {
                    success: false,
                    toolName: 'browser_select',
                    error: `Select element "${selector}" not found.`,
                    errorCode: 'ELEMENT_NOT_FOUND',
                    errorCategory: 'not_found',
                    retryable: true,
                    retrySuggestion: 'Take a browser_snapshot to find the select/dropdown element ref.',
                    debugInfo: { executionTimeMs: Date.now() - startTime, selector }
                };
            }
            await locator.selectOption(value);
            return {
                success: true,
                toolName: 'browser_select',
                result: `Selected "${value}" in dropdown "${selector}"`,
                debugInfo: { executionTimeMs: Date.now() - startTime, selector, value }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_select',
                error: `Select failed: ${e.message}`,
                errorCode: 'UNKNOWN_ERROR',
                errorCategory: 'transient',
                retryable: true,
                retrySuggestion: 'The value might not match available options. Try using { label: "Option Text" } format.',
                debugInfo: { executionTimeMs: Date.now() - startTime, selector }
            };
        }
    }

    async pressKey(key) {
        const startTime = Date.now();
        const page = await this.getPage();
        try {
            await page.keyboard.press(key);
            return {
                success: true,
                toolName: 'browser_press_key',
                result: `Pressed '${key}' in browser`,
                debugInfo: { executionTimeMs: Date.now() - startTime, key }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_press_key',
                error: `Key press failed: ${e.message}`,
                errorCode: 'UNKNOWN_ERROR',
                errorCategory: 'transient',
                retryable: true,
                debugInfo: { executionTimeMs: Date.now() - startTime, key }
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  4. SCROLL
    // ═══════════════════════════════════════════════════════════════

    async scroll(direction, amount) {
        const startTime = Date.now();
        const page = await this.getPage();
        try {
            if (direction === 'top') {
                await page.evaluate(() => window.scrollTo(0, 0));
            } else if (direction === 'bottom') {
                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            } else if (direction === 'left') {
                await page.evaluate((val) => window.scrollBy(-val, 0), amount || 500);
            } else if (direction === 'right') {
                await page.evaluate((val) => window.scrollBy(val, 0), amount || 500);
            } else {
                const y = direction === 'down' ? (amount || 500) : -(amount || 500);
                await page.evaluate((val) => window.scrollBy(0, val), y);
            }
            return {
                success: true,
                toolName: 'browser_scroll',
                result: `Scrolled ${direction}${amount ? ` by ${amount}px` : ''}`,
                debugInfo: { executionTimeMs: Date.now() - startTime, direction, amount }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_scroll',
                error: `Scroll failed: ${e.message}`,
                errorCode: 'UNKNOWN_ERROR',
                errorCategory: 'transient',
                retryable: true,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  5. WAIT (enhanced — multi-condition)
    // ═══════════════════════════════════════════════════════════════

    async wait(opts) {
        const startTime = Date.now();
        const page = await this.getPage();
        const {
            selector, state, timeout,
            text, textGone, url, loadState, jsFunction, timeMs
        } = (typeof opts === 'object' && opts !== null) ? opts : { selector: opts };

        try {
            // Fixed time wait
            if (timeMs) {
                const clampedMs = Math.min(timeMs, 30000);
                await page.waitForTimeout(clampedMs);
                return { success: true, toolName: 'browser_wait', result: `Waited ${clampedMs}ms`, debugInfo: { executionTimeMs: Date.now() - startTime } };
            }

            // Wait for text to appear
            if (text) {
                await page.waitForFunction(
                    (t) => document.body.innerText.includes(t),
                    text,
                    { timeout: timeout || 20000 }
                );
                return { success: true, toolName: 'browser_wait', result: `Text "${text}" appeared`, debugInfo: { executionTimeMs: Date.now() - startTime } };
            }

            // Wait for text to disappear
            if (textGone) {
                await page.waitForFunction(
                    (t) => !document.body.innerText.includes(t),
                    textGone,
                    { timeout: timeout || 20000 }
                );
                return { success: true, toolName: 'browser_wait', result: `Text "${textGone}" disappeared`, debugInfo: { executionTimeMs: Date.now() - startTime } };
            }

            // Wait for URL pattern
            if (url) {
                await page.waitForURL(url, { timeout: timeout || 20000 });
                return { success: true, toolName: 'browser_wait', result: `URL matched: ${page.url()}`, debugInfo: { executionTimeMs: Date.now() - startTime } };
            }

            // Wait for load state
            if (loadState) {
                await page.waitForLoadState(loadState, { timeout: timeout || 20000 });
                return { success: true, toolName: 'browser_wait', result: `Load state "${loadState}" reached`, debugInfo: { executionTimeMs: Date.now() - startTime } };
            }

            // Wait for JS function to return truthy
            if (jsFunction) {
                await page.waitForFunction(jsFunction, { timeout: timeout || 20000 });
                return { success: true, toolName: 'browser_wait', result: `JS condition met`, debugInfo: { executionTimeMs: Date.now() - startTime } };
            }

            // Wait for element (original behavior)
            if (selector) {
                const waitState = state || 'visible';
                const locator = await this.resolveElement(page, selector);
                if (locator) {
                    await locator.waitFor({ state: waitState, timeout: timeout || 10000 });
                } else {
                    await page.waitForSelector(selector, { state: waitState, timeout: timeout || 10000 });
                }
                return { success: true, toolName: 'browser_wait', result: `Element "${selector}" is now ${waitState}`, debugInfo: { executionTimeMs: Date.now() - startTime } };
            }

            // Plain timeout
            if (timeout) {
                await page.waitForTimeout(timeout);
                return { success: true, toolName: 'browser_wait', result: `Waited for ${timeout}ms`, debugInfo: { executionTimeMs: Date.now() - startTime } };
            }

            return {
                success: false,
                toolName: 'browser_wait',
                error: 'No wait condition specified. Provide: selector, text, textGone, url, loadState, jsFunction, timeMs, or timeout.',
                errorCode: 'INVALID_ARGS',
                errorCategory: 'permanent',
                retryable: false,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_wait',
                error: `Wait failed: ${e.message}`,
                errorCode: e.message.includes('Timeout') ? 'NAVIGATION_TIMEOUT' : 'UNKNOWN_ERROR',
                errorCategory: 'timeout',
                retryable: true,
                retrySuggestion: 'The condition was not met within the timeout. Try increasing the timeout or check if the condition is correct.',
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  6. SCREENSHOT & EXTRACT
    // ═══════════════════════════════════════════════════════════════

    async screenshot(opts) {
        const startTime = Date.now();
        const page = await this.getPage();
        const fullPage = opts?.fullPage || false;
        const selector = opts?.selector;

        try {
            let buffer;

            if (selector) {
                const locator = await this.resolveElement(page, selector);
                if (locator) {
                    buffer = await locator.screenshot();
                }
            }

            if (!buffer) {
                buffer = await page.screenshot({ fullPage });
            }

            try {
                const { Jimp } = require('jimp');
                const image = await Jimp.read(buffer);

                if (image.bitmap.width > 1280) {
                    image.resize({ w: 1280 });
                }

                const compressedBuffer = await image.getBuffer('image/jpeg', { quality: 60 });
                return {
                    success: true,
                    toolName: 'browser_screenshot',
                    result: `Screenshot captured (${image.bitmap.width}x${image.bitmap.height} JPEG)`,
                    data: { image: compressedBuffer.toString('base64'), mimeType: 'image/jpeg' },
                    debugInfo: { executionTimeMs: Date.now() - startTime, sizeKB: Math.round(compressedBuffer.length / 1024) }
                };
            } catch (err) {
                return {
                    success: true,
                    toolName: 'browser_screenshot',
                    result: 'Screenshot captured (uncompressed PNG)',
                    data: { image: buffer.toString('base64'), mimeType: 'image/png' },
                    debugInfo: { executionTimeMs: Date.now() - startTime, compressionFailed: true }
                };
            }
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_screenshot',
                error: `Screenshot failed: ${e.message}`,
                errorCode: 'PAGE_CRASHED',
                errorCategory: 'transient',
                retryable: true,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    async extract(selector) {
        const startTime = Date.now();
        const page = await this.getPage();
        try {
            let text;
            if (!selector) {
                text = await page.evaluate(() => document.body.innerText.substring(0, 50000));
            } else {
                const locator = await this.resolveElement(page, selector);
                if (!locator) {
                    return {
                        success: false,
                        toolName: 'browser_extract_text',
                        error: `Element "${selector}" not found.`,
                        errorCode: 'ELEMENT_NOT_FOUND',
                        errorCategory: 'not_found',
                        retryable: true,
                        retrySuggestion: 'Take a browser_snapshot to verify the element exists.',
                        debugInfo: { executionTimeMs: Date.now() - startTime, selector }
                    };
                }
                text = await locator.innerText();
            }
            return {
                success: true,
                toolName: 'browser_extract_text',
                result: text,
                data: { charCount: text.length },
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_extract_text',
                error: `Text extraction failed: ${e.message}`,
                errorCode: 'UNKNOWN_ERROR',
                errorCategory: 'transient',
                retryable: true,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  7. JAVASCRIPT
    // ═══════════════════════════════════════════════════════════════

    async executeScript(script) {
        const startTime = Date.now();
        const page = await this.getPage();
        try {
            const result = await page.evaluate(script);
            const resultStr = JSON.stringify(result);
            const truncated = resultStr ? resultStr.substring(0, 5000) : '';
            return {
                success: true,
                toolName: 'browser_execute_script',
                result: `Script executed. Result: ${truncated}`,
                data: result,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_execute_script',
                error: `Script error: ${e.message}`,
                errorCode: 'UNKNOWN_ERROR',
                errorCategory: 'permanent',
                retryable: false,
                retrySuggestion: 'Check the JavaScript code for syntax errors.',
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  8. FILE UPLOAD (fixed + multiple files + file_chooser)
    // ═══════════════════════════════════════════════════════════════

    async uploadFile(selector, filePaths, timeoutMs = 30000) {
        const startTime = Date.now();
        const page = await this.getPage();

        // Support both single string and array
        const pathsArray = Array.isArray(filePaths) ? filePaths : [filePaths];

        // ─── SMART PATH RESOLUTION ────────────────────────────────────
        // Problem: AI often drops file extension (e.g. "final thumbnail" instead of "final thumbnail.png")
        // Solution: If exact path not found, search directory for matching filename with any extension
        const COMMON_EXTENSIONS = [
            '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.tiff',
            '.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.wmv', '.flv', '.3gp',
            '.mp3', '.wav', '.m4a', '.ogg', '.aac', '.flac',
            '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
            '.txt', '.csv', '.json', '.zip', '.rar', '.7z'
        ];

        const resolvedPaths = pathsArray.map(p => {
            if (!p) return null;

            // Exact path exists → use it directly
            if (fs.existsSync(p)) return p;

            // Try adding common extensions
            for (const ext of COMMON_EXTENSIONS) {
                const withExt = p + ext;
                if (fs.existsSync(withExt)) {
                    console.log(`[BrowserService] Smart resolve: "${p}" → "${withExt}"`);
                    return withExt;
                }
            }

            // Try searching the directory for files starting with the basename
            try {
                const dir = path.dirname(p);
                const base = path.basename(p).toLowerCase();
                if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
                    const entries = fs.readdirSync(dir);
                    // Exact match (case-insensitive)
                    const exactMatch = entries.find(e => e.toLowerCase() === base);
                    if (exactMatch) {
                        const resolved = path.join(dir, exactMatch);
                        console.log(`[BrowserService] Smart resolve (case): "${p}" → "${resolved}"`);
                        return resolved;
                    }
                    // Starts-with match (e.g. "final thumbnail" matches "final thumbnail.png")
                    const startsMatch = entries.find(e => e.toLowerCase().startsWith(base + '.'));
                    if (startsMatch) {
                        const resolved = path.join(dir, startsMatch);
                        console.log(`[BrowserService] Smart resolve (ext): "${p}" → "${resolved}"`);
                        return resolved;
                    }
                }
            } catch (e) { /* ignore directory read errors */ }

            return null; // Could not resolve
        }).filter(Boolean);

        const validPaths = resolvedPaths.filter(p => p && fs.existsSync(p));

        if (validPaths.length === 0) {
            // Build helpful error: show what was tried AND what's actually in the directory
            let dirHint = '';
            try {
                const firstPath = pathsArray[0];
                if (firstPath) {
                    const dir = path.dirname(firstPath);
                    if (fs.existsSync(dir)) {
                        const files = fs.readdirSync(dir).slice(0, 10);
                        dirHint = ` Files in ${dir}: [${files.join(', ')}]`;
                    }
                }
            } catch (e) {}

            return {
                success: false,
                toolName: 'browser_upload_file',
                error: `File not found: "${pathsArray[0]}". Also tried adding common extensions (.png, .jpg, .mp4, etc.) — none matched.${dirHint}`,
                errorCode: 'FILE_NOT_FOUND',
                errorCategory: 'permanent',
                retryable: false,
                retrySuggestion: `Use the EXACT file path WITH extension. Example: ${path.join(DOWNLOAD_DIR, 'final thumbnail.png')} (not "final thumbnail"). Use fs_read on the folder to get exact filename first.`,
                debugInfo: { executionTimeMs: Date.now() - startTime, pathsArray }
            };
        }

        const fileNames = validPaths.map(p => path.basename(p));

        try {
            if (selector) {
                // Method 1: Direct input element targeting
                const locator = await this.resolveElement(page, selector);
                if (locator) {
                    await locator.setInputFiles(validPaths, { timeout: timeoutMs });

                    // Dispatch input + change events for React/Vue frameworks
                    try {
                        const handle = await locator.elementHandle();
                        if (handle) {
                            await handle.evaluate((el) => {
                                el.dispatchEvent(new Event('input', { bubbles: true }));
                                el.dispatchEvent(new Event('change', { bubbles: true }));
                            });
                        }
                    } catch (e) { /* Non-critical */ }

                    return {
                        success: true,
                        toolName: 'browser_upload_file',
                        result: `Uploaded ${fileNames.length} file(s): ${fileNames.join(', ')}`,
                        data: { fileNames, filePaths: validPaths },
                        debugInfo: { executionTimeMs: Date.now() - startTime }
                    };
                }
            }

            // Method 2: File chooser intercept — for YouTube/TikTok/Google Drive hidden inputs
            // OpenClaw Pattern: Check if we already captured a filechooser during click
            if (this._pendingFileChooser) {
                console.log('[BrowserService] ✅ Using pre-captured file chooser from click');
                const chooser = this._pendingFileChooser;
                this._pendingFileChooser = null;
                if (this._pendingFileChooserTimeout) {
                    clearTimeout(this._pendingFileChooserTimeout);
                    this._pendingFileChooserTimeout = null;
                }
                await chooser.setFiles(validPaths);
                return {
                    success: true,
                    toolName: 'browser_upload_file',
                    result: `Uploaded ${fileNames.length} file(s) via pre-captured file chooser: ${fileNames.join(', ')}`,
                    data: { fileNames, filePaths: validPaths, method: 'file_chooser_precaptured' },
                    debugInfo: { executionTimeMs: Date.now() - startTime }
                };
            }

            // Fallback: Wait for a new file chooser event
            const fileChooser = await page.waitForEvent('filechooser', { timeout: timeoutMs });
            await fileChooser.setFiles(validPaths);

            return {
                success: true,
                toolName: 'browser_upload_file',
                result: `Uploaded ${fileNames.length} file(s) via file chooser: ${fileNames.join(', ')}`,
                data: { fileNames, filePaths: validPaths, method: 'file_chooser' },
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };

        } catch (e) {
            return {
                success: false,
                toolName: 'browser_upload_file',
                error: `Upload failed: ${e.message}`,
                errorCode: 'UNKNOWN_ERROR',
                errorCategory: 'transient',
                retryable: true,
                retrySuggestion: 'Click the upload button first (browser_click), then IMMEDIATELY call browser_upload_file. The file chooser is captured during the click.',
                debugInfo: { executionTimeMs: Date.now() - startTime, selector, validPaths }
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  9. DOWNLOADS
    // ═══════════════════════════════════════════════════════════════

    async waitDownload(timeoutMs = 30000) {
        const startTime = Date.now();
        const page = await this.getPage();
        try {
            const download = await page.waitForEvent('download', { timeout: timeoutMs });
            const resolved = await this.resolveBrowserDownloadPath(download, startTime, timeoutMs);

            return {
                success: true,
                toolName: 'browser_wait_download',
                result: `Downloaded: ${resolved.filename} -> ${resolved.path}`,
                data: { filename: resolved.filename, path: resolved.path, url: download.url() },
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_wait_download',
                error: `Download wait failed: ${e.message}`,
                errorCode: 'NAVIGATION_TIMEOUT',
                errorCategory: 'timeout',
                retryable: true,
                retrySuggestion: 'Make sure a download was triggered before calling this. Click a download button first.',
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    async downloadByClick(selector, timeoutMs = 30000) {
        const startTime = Date.now();
        const page = await this.getPage();
        try {
            const locator = await this.resolveElement(page, selector);
            if (!locator) {
                return {
                    success: false,
                    toolName: 'browser_download_by_click',
                    error: `Element "${selector}" not found.`,
                    errorCode: 'ELEMENT_NOT_FOUND',
                    errorCategory: 'not_found',
                    retryable: true,
                    retrySuggestion: 'Take a browser_snapshot to find the download button ref.',
                    debugInfo: { executionTimeMs: Date.now() - startTime }
                };
            }

            const [download] = await Promise.all([
                page.waitForEvent('download', { timeout: timeoutMs }),
                locator.click()
            ]);

            const resolved = await this.resolveBrowserDownloadPath(download, startTime, timeoutMs);

            return {
                success: true,
                toolName: 'browser_download_by_click',
                result: `Clicked and downloaded: ${resolved.filename} -> ${resolved.path}`,
                data: { filename: resolved.filename, path: resolved.path, url: download.url() },
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_download_by_click',
                error: `Download by click failed: ${e.message}`,
                errorCode: 'UNKNOWN_ERROR',
                errorCategory: 'transient',
                retryable: true,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  10. DIALOG HANDLING
    // ═══════════════════════════════════════════════════════════════

    async handleDialog(accept = true, promptText = null, timeoutMs = 10000) {
        const startTime = Date.now();
        const page = await this.getPage();
        try {
            const dialog = await page.waitForEvent('dialog', { timeout: timeoutMs });
            const dialogType = dialog.type();
            const dialogMessage = dialog.message();

            if (accept) {
                await dialog.accept(promptText || '');
            } else {
                await dialog.dismiss();
            }

            return {
                success: true,
                toolName: 'browser_handle_dialog',
                result: `${accept ? 'Accepted' : 'Dismissed'} ${dialogType} dialog: "${dialogMessage}"`,
                data: { type: dialogType, message: dialogMessage, accepted: accept },
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_handle_dialog',
                error: `Dialog handling failed: ${e.message}`,
                errorCode: 'NAVIGATION_TIMEOUT',
                errorCategory: 'timeout',
                retryable: true,
                retrySuggestion: 'No dialog appeared within timeout. Make sure a browser action triggers a dialog first.',
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  11. PDF EXPORT
    // ═══════════════════════════════════════════════════════════════

    async savePdf(savePath = null) {
        const startTime = Date.now();
        const page = await this.getPage();
        try {
            const filename = `page-${Date.now()}.pdf`;
            const fullPath = savePath || path.join(DOWNLOAD_DIR, filename);
            await page.pdf({ path: fullPath, format: 'A4' });
            return {
                success: true,
                toolName: 'browser_save_pdf',
                result: `Page saved as PDF: ${fullPath}`,
                data: { path: fullPath },
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_save_pdf',
                error: `PDF save failed: ${e.message}. Note: PDF export requires headless browser mode.`,
                errorCode: 'UNKNOWN_ERROR',
                errorCategory: 'permanent',
                retryable: false,
                retrySuggestion: 'PDF export only works in headless mode. Use browser_screenshot for a visual capture instead.',
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  12. COOKIE MANAGEMENT
    // ═══════════════════════════════════════════════════════════════

    async getCookies() {
        const startTime = Date.now();
        try {
            if (!this.context) await this.launch();
            const cookies = await this.context.cookies();
            return {
                success: true,
                toolName: 'browser_get_cookies',
                result: `Found ${cookies.length} cookies`,
                data: { cookies, count: cookies.length },
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_get_cookies',
                error: `Get cookies failed: ${e.message}`,
                errorCode: 'UNKNOWN_ERROR',
                errorCategory: 'transient',
                retryable: true,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    async setCookie(cookie) {
        const startTime = Date.now();
        try {
            if (!this.context) await this.launch();
            if (!cookie.url && !cookie.domain) {
                const page = await this.getPage();
                cookie.url = page.url();
            }
            await this.context.addCookies([cookie]);
            return {
                success: true,
                toolName: 'browser_set_cookie',
                result: `Cookie "${cookie.name}" set`,
                data: { name: cookie.name },
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_set_cookie',
                error: `Set cookie failed: ${e.message}`,
                errorCode: 'UNKNOWN_ERROR',
                errorCategory: 'permanent',
                retryable: false,
                retrySuggestion: 'Cookie must have name, value, and either url or domain.',
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    async clearCookies() {
        const startTime = Date.now();
        try {
            if (!this.context) await this.launch();
            await this.context.clearCookies();
            return {
                success: true,
                toolName: 'browser_clear_cookies',
                result: 'All cookies cleared',
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_clear_cookies',
                error: `Clear cookies failed: ${e.message}`,
                errorCode: 'UNKNOWN_ERROR',
                errorCategory: 'transient',
                retryable: true,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  13. STORAGE MANAGEMENT (localStorage / sessionStorage)
    // ═══════════════════════════════════════════════════════════════

    async getStorage(kind = 'local', key = null) {
        const startTime = Date.now();
        const page = await this.getPage();
        try {
            const values = await page.evaluate(({ kind, key }) => {
                const store = kind === 'session' ? sessionStorage : localStorage;
                if (key) return { [key]: store.getItem(key) };
                const result = {};
                for (let i = 0; i < store.length; i++) {
                    const k = store.key(i);
                    result[k] = store.getItem(k);
                }
                return result;
            }, { kind, key });

            const count = Object.keys(values).length;
            return {
                success: true,
                toolName: 'browser_get_storage',
                result: `${kind}Storage: ${count} item(s)`,
                data: { kind, values, count },
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_get_storage',
                error: `Get storage failed: ${e.message}`,
                errorCode: 'UNKNOWN_ERROR',
                errorCategory: 'transient',
                retryable: true,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    async setStorage(key, value, kind = 'local') {
        const startTime = Date.now();
        const page = await this.getPage();
        try {
            await page.evaluate(({ kind, key, value }) => {
                const store = kind === 'session' ? sessionStorage : localStorage;
                store.setItem(key, value);
            }, { kind, key, value });

            return {
                success: true,
                toolName: 'browser_set_storage',
                result: `Set ${kind}Storage["${key}"] = "${String(value).substring(0, 50)}"`,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_set_storage',
                error: `Set storage failed: ${e.message}`,
                errorCode: 'UNKNOWN_ERROR',
                errorCategory: 'transient',
                retryable: true,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    async clearStorage(kind = 'local') {
        const startTime = Date.now();
        const page = await this.getPage();
        try {
            await page.evaluate((kind) => {
                const store = kind === 'session' ? sessionStorage : localStorage;
                store.clear();
            }, kind);

            return {
                success: true,
                toolName: 'browser_clear_storage',
                result: `${kind}Storage cleared`,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_clear_storage',
                error: `Clear storage failed: ${e.message}`,
                errorCode: 'UNKNOWN_ERROR',
                errorCategory: 'transient',
                retryable: true,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  14. VIEWPORT & DEVICE EMULATION
    // ═══════════════════════════════════════════════════════════════

    async resizeViewport(width, height) {
        const startTime = Date.now();
        const page = await this.getPage();
        try {
            await page.setViewportSize({ width, height });
            return {
                success: true,
                toolName: 'browser_resize_viewport',
                result: `Viewport resized to ${width}x${height}`,
                data: { width, height },
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_resize_viewport',
                error: `Resize viewport failed: ${e.message}`,
                errorCode: 'UNKNOWN_ERROR',
                errorCategory: 'transient',
                retryable: true,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    async emulateDevice(deviceName) {
        const startTime = Date.now();
        const page = await this.getPage();
        try {
            const device = KNOWN_DEVICES[deviceName];
            if (!device) {
                const available = Object.keys(KNOWN_DEVICES).join(', ');
                return {
                    success: false,
                    toolName: 'browser_emulate_device',
                    error: `Unknown device "${deviceName}". Available: ${available}`,
                    errorCode: 'INVALID_ARGS',
                    errorCategory: 'permanent',
                    retryable: false,
                    debugInfo: { executionTimeMs: Date.now() - startTime }
                };
            }
            await page.setViewportSize(device.viewport);
            await page.setExtraHTTPHeaders({ 'User-Agent': device.userAgent });
            return {
                success: true,
                toolName: 'browser_emulate_device',
                result: `Emulating ${deviceName}: ${device.viewport.width}x${device.viewport.height}`,
                data: { device: deviceName, viewport: device.viewport },
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_emulate_device',
                error: `Device emulation failed: ${e.message}`,
                errorCode: 'UNKNOWN_ERROR',
                errorCategory: 'transient',
                retryable: true,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    async emulateColorScheme(scheme = 'dark') {
        const startTime = Date.now();
        const page = await this.getPage();
        try {
            await page.emulateMedia({ colorScheme: scheme });
            return {
                success: true,
                toolName: 'browser_emulate_color_scheme',
                result: `Color scheme set to "${scheme}"`,
                data: { colorScheme: scheme },
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_emulate_color_scheme',
                error: `Color scheme emulation failed: ${e.message}`,
                errorCode: 'UNKNOWN_ERROR',
                errorCategory: 'transient',
                retryable: true,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    async setOffline(offline = true) {
        const startTime = Date.now();
        try {
            if (!this.context) await this.launch();
            await this.context.setOffline(offline);
            return {
                success: true,
                toolName: 'browser_set_offline',
                result: `Browser is now ${offline ? 'OFFLINE' : 'ONLINE'}`,
                data: { offline },
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_set_offline',
                error: `Set offline failed: ${e.message}`,
                errorCode: 'UNKNOWN_ERROR',
                errorCategory: 'transient',
                retryable: true,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    async setExtraHeaders(headers) {
        const startTime = Date.now();
        const page = await this.getPage();
        try {
            await page.setExtraHTTPHeaders(headers);
            return {
                success: true,
                toolName: 'browser_set_extra_headers',
                result: `Extra headers set: ${Object.keys(headers).join(', ')}`,
                data: { headers: Object.keys(headers) },
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_set_extra_headers',
                error: `Set headers failed: ${e.message}`,
                errorCode: 'UNKNOWN_ERROR',
                errorCategory: 'transient',
                retryable: true,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    async setHttpCredentials(username, password, clear = false) {
        const startTime = Date.now();
        try {
            if (!this.context) await this.launch();
            if (clear) {
                await this.context.setHTTPCredentials(null);
            } else {
                await this.context.setHTTPCredentials({ username, password });
            }
            return {
                success: true,
                toolName: 'browser_set_http_credentials',
                result: clear ? 'HTTP credentials cleared' : `HTTP credentials set for user "${username}"`,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_set_http_credentials',
                error: `Set credentials failed: ${e.message}`,
                errorCode: 'UNKNOWN_ERROR',
                errorCategory: 'transient',
                retryable: true,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    async setGeolocation(latitude, longitude, accuracy = 100, clear = false) {
        const startTime = Date.now();
        try {
            if (!this.context) await this.launch();
            if (clear) {
                await this.context.setGeolocation(null);
            } else {
                await this.context.setGeolocation({ latitude, longitude, accuracy });
                await this.context.grantPermissions(['geolocation']);
            }
            return {
                success: true,
                toolName: 'browser_set_geolocation',
                result: clear ? 'Geolocation cleared' : `Geolocation set: ${latitude}, ${longitude} (accuracy: ${accuracy}m)`,
                data: clear ? {} : { latitude, longitude, accuracy },
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_set_geolocation',
                error: `Set geolocation failed: ${e.message}`,
                errorCode: 'UNKNOWN_ERROR',
                errorCategory: 'transient',
                retryable: true,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  15. CONSOLE & DEBUGGING
    // ═══════════════════════════════════════════════════════════════

    async getConsoleMessages(level = null) {
        const startTime = Date.now();
        try {
            const messages = level
                ? this.consoleMessages.filter(m => m.level === level)
                : this.consoleMessages;

            return {
                success: true,
                toolName: 'browser_get_console',
                result: `${messages.length} console message(s)${level ? ` of type "${level}"` : ''}`,
                data: { messages, count: messages.length },
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_get_console',
                error: `Get console failed: ${e.message}`,
                errorCode: 'UNKNOWN_ERROR',
                errorCategory: 'transient',
                retryable: true,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    async getPageErrors() {
        const startTime = Date.now();
        try {
            return {
                success: true,
                toolName: 'browser_get_errors',
                result: `${this.pageErrors.length} JavaScript error(s) found`,
                data: { errors: this.pageErrors, count: this.pageErrors.length },
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_get_errors',
                error: `Get errors failed: ${e.message}`,
                errorCode: 'UNKNOWN_ERROR',
                errorCategory: 'transient',
                retryable: true,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  16. TAB MANAGEMENT
    // ═══════════════════════════════════════════════════════════════

    async getTabs() {
        const startTime = Date.now();
        try {
            if (!this.context) await this.launch();
            const pages = this.context.pages();
            const tabs = [];
            for (let i = 0; i < pages.length; i++) {
                const p = pages[i];
                tabs.push({
                    index: i,
                    title: await p.title().catch(() => 'Untitled'),
                    url: p.url(),
                    isActive: p === this.activePage
                });
            }
            return {
                success: true,
                toolName: 'browser_get_tabs',
                result: `${tabs.length} tabs open:\n${tabs.map(t => `${t.isActive ? '→ ' : '  '}[${t.index}] ${t.title} (${t.url})`).join('\n')}`,
                data: tabs,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_get_tabs',
                error: `Failed to list tabs: ${e.message}`,
                errorCode: 'BROWSER_NOT_RUNNING',
                errorCategory: 'transient',
                retryable: true,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    async switchTab(index) {
        const startTime = Date.now();
        try {
            if (!this.context) await this.launch();
            const pages = this.context.pages();
            if (index < 0 || index >= pages.length) {
                return {
                    success: false,
                    toolName: 'browser_switch_tab',
                    error: `Tab index ${index} out of range. Have ${pages.length} tabs (0-${pages.length - 1}).`,
                    errorCode: 'INVALID_ARGS',
                    errorCategory: 'permanent',
                    retryable: false,
                    retrySuggestion: 'Use browser_get_tabs to see available tab indices.',
                    debugInfo: { executionTimeMs: Date.now() - startTime, tabCount: pages.length }
                };
            }
            this.activePage = pages[index];
            await this.activePage.bringToFront();
            const title = await this.activePage.title();
            return {
                success: true,
                toolName: 'browser_switch_tab',
                result: `Switched to tab ${index}: "${title}"`,
                data: { index, title, url: this.activePage.url() },
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_switch_tab',
                error: `Tab switch failed: ${e.message}`,
                errorCode: 'UNKNOWN_ERROR',
                errorCategory: 'transient',
                retryable: true,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    async newTab(url) {
        const startTime = Date.now();
        try {
            if (!this.context) await this.launch();
            const newPage = await this.context.newPage();
            this.activePage = newPage;

            // Attach console & error listeners to new tab
            newPage.on('console', (msg) => {
                this.consoleMessages.push({ level: msg.type(), text: msg.text(), timestamp: new Date().toISOString() });
                if (this.consoleMessages.length > 500) this.consoleMessages.shift();
            });
            newPage.on('pageerror', (error) => {
                this.pageErrors.push({ message: error.message, stack: error.stack, timestamp: new Date().toISOString() });
                if (this.pageErrors.length > 200) this.pageErrors.shift();
            });

            if (url) {
                if (!url.startsWith('http')) url = 'https://' + url;
                await newPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            }
            const title = await newPage.title();
            const tabCount = this.context.pages().length;
            return {
                success: true,
                toolName: 'browser_new_tab',
                result: `New tab opened${url ? `: ${title}` : ''}. Total tabs: ${tabCount}`,
                data: { title, url: newPage.url(), tabCount },
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_new_tab',
                error: `New tab failed: ${e.message}`,
                errorCode: 'UNKNOWN_ERROR',
                errorCategory: 'transient',
                retryable: true,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    async closeTab(index) {
        const startTime = Date.now();
        try {
            if (!this.context) await this.launch();
            const pages = this.context.pages();
            if (pages.length <= 1) {
                return {
                    success: false,
                    toolName: 'browser_close_tab',
                    error: 'Cannot close the last tab. Use browser_close to close the entire browser.',
                    errorCode: 'INVALID_ARGS',
                    errorCategory: 'permanent',
                    retryable: false,
                    debugInfo: { executionTimeMs: Date.now() - startTime }
                };
            }
            const tabIndex = index !== undefined ? index : pages.indexOf(this.activePage);
            if (tabIndex < 0 || tabIndex >= pages.length) {
                return {
                    success: false,
                    toolName: 'browser_close_tab',
                    error: `Tab index ${tabIndex} not valid.`,
                    errorCode: 'INVALID_ARGS',
                    errorCategory: 'permanent',
                    retryable: false,
                    debugInfo: { executionTimeMs: Date.now() - startTime }
                };
            }
            const closedTitle = await pages[tabIndex].title().catch(() => 'Untitled');
            await pages[tabIndex].close();
            const remaining = this.context.pages();
            this.activePage = remaining[0];
            return {
                success: true,
                toolName: 'browser_close_tab',
                result: `Closed tab "${closedTitle}". ${remaining.length} tabs remaining.`,
                data: { closedTitle, remainingTabs: remaining.length },
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_close_tab',
                error: `Close tab failed: ${e.message}`,
                errorCode: 'UNKNOWN_ERROR',
                errorCategory: 'transient',
                retryable: true,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  17. DRAG & DROP
    // ═══════════════════════════════════════════════════════════════

    async dragDrop(sourceSelector, targetSelector) {
        const startTime = Date.now();
        const page = await this.getPage();
        try {
            const source = await this.resolveElement(page, sourceSelector);
            const target = await this.resolveElement(page, targetSelector);
            if (!source) {
                return {
                    success: false,
                    toolName: 'browser_drag_drop',
                    error: `Source element "${sourceSelector}" not found.`,
                    errorCode: 'ELEMENT_NOT_FOUND',
                    errorCategory: 'not_found',
                    retryable: true,
                    debugInfo: { executionTimeMs: Date.now() - startTime }
                };
            }
            if (!target) {
                return {
                    success: false,
                    toolName: 'browser_drag_drop',
                    error: `Target element "${targetSelector}" not found.`,
                    errorCode: 'ELEMENT_NOT_FOUND',
                    errorCategory: 'not_found',
                    retryable: true,
                    debugInfo: { executionTimeMs: Date.now() - startTime }
                };
            }
            await source.dragTo(target);
            return {
                success: true,
                toolName: 'browser_drag_drop',
                result: `Dragged "${sourceSelector}" to "${targetSelector}"`,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            return {
                success: false,
                toolName: 'browser_drag_drop',
                error: `Drag and drop failed: ${e.message}`,
                errorCode: 'UNKNOWN_ERROR',
                errorCategory: 'transient',
                retryable: true,
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  18. CLOSE
    // ═══════════════════════════════════════════════════════════════

    async close() {
        const startTime = Date.now();
        try {
            if (this.context || this.isInitialized) {
                await this._forceClose();
                return {
                    success: true,
                    toolName: 'browser_close',
                    result: 'Browser closed.',
                    debugInfo: { executionTimeMs: Date.now() - startTime }
                };
            }
            return {
                success: true,
                toolName: 'browser_close',
                result: 'Browser was not open.',
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        } catch (e) {
            // Even if close throws, ensure state is cleaned up
            this.browser = null;
            this.context = null;
            this.activePage = null;
            this.isInitialized = false;
            return {
                success: true,
                toolName: 'browser_close',
                result: 'Browser state cleaned up (was already dead).',
                debugInfo: { executionTimeMs: Date.now() - startTime }
            };
        }
    }
}

const browserService = new BrowserManagerService();

function registerBrowserHandlers() {
    // Kick off CDP port resolution at app boot so the port is known (and
    // reserved) before any Hermes spawn or browser launch needs it.
    resolveCdpPort().catch((err) => console.error('[BrowserService] CDP port resolution failed:', err.message));

    // Helper: wrap calls with auto-recovery so browser-closed-by-user is handled seamlessly
    const r = (toolName, fn) => browserService._withAutoRecovery(toolName, fn);

    // ─── NAVIGATION ───────────────────────────────────────────────
    ipcMain.handle('browser-navigate',         async (e, url) => r('browser_navigate', () => browserService.navigate(url)));
    ipcMain.handle('browser-go-back',          async () => r('browser_go_back', () => browserService.goBack()));
    ipcMain.handle('browser-go-forward',       async () => r('browser_go_forward', () => browserService.goForward()));
    ipcMain.handle('browser-reload',           async () => r('browser_reload', () => browserService.reload()));

    // ─── SNAPSHOT & CONTENT ───────────────────────────────────────
    ipcMain.handle('browser-snapshot',         async (e, s) => r('browser_snapshot', () => browserService.snapshot(s)));
    ipcMain.handle('browser-get-html',         async (e, { selector, maxChars }) => r('browser_get_html', () => browserService.getHtml(selector, maxChars)));
    ipcMain.handle('browser-query-selector',   async (e, { selector, limit, maxTextChars }) => r('browser_query_selector', () => browserService.querySelector(selector, limit, maxTextChars)));
    ipcMain.handle('browser-extract',          async (e, s) => r('browser_extract', () => browserService.extract(s)));
    ipcMain.handle('browser-screenshot',       async (e, a) => r('browser_screenshot', () => browserService.screenshot(a)));

    // ─── INTERACTIONS ─────────────────────────────────────────────
    ipcMain.handle('browser-click',            async (e, { selector, doubleClick, button, modifiers, delayMs }) => r('browser_click', () => browserService.click(selector, { doubleClick, button, modifiers, delayMs })));
    ipcMain.handle('browser-type',             async (e, { selector, text, clearFirst, slowly }) => r('browser_type', () => browserService.type(selector, text, clearFirst, slowly)));
    ipcMain.handle('browser-fill-form',        async (e, { fields, timeoutMs }) => r('browser_fill_form', () => browserService.fillForm(fields, timeoutMs)));
    ipcMain.handle('browser-hover',            async (e, { selector }) => r('browser_hover', () => browserService.hover(selector)));
    ipcMain.handle('browser-select',           async (e, { selector, value }) => r('browser_select', () => browserService.select(selector, value)));
    ipcMain.handle('browser-press-key',        async (e, k) => r('browser_press_key', () => browserService.pressKey(k)));
    ipcMain.handle('browser-scroll',           async (e, { direction, amount }) => r('browser_scroll', () => browserService.scroll(direction, amount)));
    ipcMain.handle('browser-scroll-into-view', async (e, { selector }) => r('browser_scroll_into_view', () => browserService.scrollIntoView(selector)));
    ipcMain.handle('browser-highlight',        async (e, { selector }) => r('browser_highlight', () => browserService.highlight(selector)));

    // ─── WAIT ─────────────────────────────────────────────────────
    ipcMain.handle('browser-wait',             async (e, opts) => r('browser_wait', () => browserService.wait(opts)));

    // ─── JAVASCRIPT ───────────────────────────────────────────────
    ipcMain.handle('browser-execute-script',   async (e, s) => r('browser_execute_script', () => browserService.executeScript(s)));

    // ─── FILE UPLOAD ──────────────────────────────────────────────
    ipcMain.handle('browser-upload-file',      async (e, { selector, filePath, filePaths, timeoutMs }) => r('browser_upload_file', () => browserService.uploadFile(selector, filePaths || filePath, timeoutMs)));

    // ─── DOWNLOADS ────────────────────────────────────────────────
    ipcMain.handle('browser-wait-download',    async (e, { timeoutMs }) => r('browser_wait_download', () => browserService.waitDownload(timeoutMs)));
    ipcMain.handle('browser-download-by-click',async (e, { selector, timeoutMs }) => r('browser_download_by_click', () => browserService.downloadByClick(selector, timeoutMs)));

    // ─── DIALOGS ──────────────────────────────────────────────────
    ipcMain.handle('browser-handle-dialog',    async (e, { accept, promptText, timeoutMs }) => r('browser_handle_dialog', () => browserService.handleDialog(accept, promptText, timeoutMs)));

    // ─── PDF ──────────────────────────────────────────────────────
    ipcMain.handle('browser-save-pdf',         async (e, { savePath }) => r('browser_save_pdf', () => browserService.savePdf(savePath)));

    // ─── COOKIES ──────────────────────────────────────────────────
    ipcMain.handle('browser-get-cookies',      async () => r('browser_get_cookies', () => browserService.getCookies()));
    ipcMain.handle('browser-set-cookie',       async (e, { cookie }) => r('browser_set_cookie', () => browserService.setCookie(cookie)));
    ipcMain.handle('browser-clear-cookies',    async () => r('browser_clear_cookies', () => browserService.clearCookies()));

    // ─── STORAGE ──────────────────────────────────────────────────
    ipcMain.handle('browser-get-storage',      async (e, { kind, key }) => r('browser_get_storage', () => browserService.getStorage(kind, key)));
    ipcMain.handle('browser-set-storage',      async (e, { key, value, kind }) => r('browser_set_storage', () => browserService.setStorage(key, value, kind)));
    ipcMain.handle('browser-clear-storage',    async (e, { kind }) => r('browser_clear_storage', () => browserService.clearStorage(kind)));

    // ─── EMULATION ────────────────────────────────────────────────
    ipcMain.handle('browser-resize-viewport',          async (e, { width, height }) => r('browser_resize_viewport', () => browserService.resizeViewport(width, height)));
    ipcMain.handle('browser-emulate-device',           async (e, { deviceName }) => r('browser_emulate_device', () => browserService.emulateDevice(deviceName)));
    ipcMain.handle('browser-emulate-color-scheme',     async (e, { scheme }) => r('browser_emulate_color_scheme', () => browserService.emulateColorScheme(scheme)));
    ipcMain.handle('browser-set-offline',              async (e, { offline }) => r('browser_set_offline', () => browserService.setOffline(offline)));
    ipcMain.handle('browser-set-extra-headers',        async (e, { headers }) => r('browser_set_extra_headers', () => browserService.setExtraHeaders(headers)));
    ipcMain.handle('browser-set-http-credentials',     async (e, { username, password, clear }) => r('browser_set_http_credentials', () => browserService.setHttpCredentials(username, password, clear)));
    ipcMain.handle('browser-set-geolocation',          async (e, { latitude, longitude, accuracy, clear }) => r('browser_set_geolocation', () => browserService.setGeolocation(latitude, longitude, accuracy, clear)));

    // ─── CONSOLE & DEBUGGING ──────────────────────────────────────
    ipcMain.handle('browser-get-console',      async (e, { level }) => r('browser_get_console', () => browserService.getConsoleMessages(level)));
    ipcMain.handle('browser-get-errors',       async () => r('browser_get_errors', () => browserService.getPageErrors()));

    // ─── TABS ─────────────────────────────────────────────────────
    ipcMain.handle('browser-get-tabs',         async () => r('browser_get_tabs', () => browserService.getTabs()));
    ipcMain.handle('browser-switch-tab',       async (e, { index }) => r('browser_switch_tab', () => browserService.switchTab(index)));
    ipcMain.handle('browser-new-tab',          async (e, { url }) => r('browser_new_tab', () => browserService.newTab(url)));
    ipcMain.handle('browser-close-tab',        async (e, { index }) => r('browser_close_tab', () => browserService.closeTab(index)));

    // ─── DRAG & DROP ──────────────────────────────────────────────
    ipcMain.handle('browser-drag-drop',        async (e, { sourceSelector, targetSelector }) => r('browser_drag_drop', () => browserService.dragDrop(sourceSelector, targetSelector)));

    // ─── CLOSE (no auto-recovery needed — explicit close action) ──
    ipcMain.handle('browser-close',            async () => browserService.close());

    console.log('[BrowserService] ✅ All 46 browser handlers registered (with auto-recovery)');
}

module.exports = { registerBrowserHandlers, browserService, resolveCdpPort, getCdpPort };
