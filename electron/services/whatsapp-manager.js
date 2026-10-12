// WhatsApp manager — Baileys (WhatsApp Web multi-device protocol over WebSocket).
//
// This is the SAME approach OpenClaw and our own Hermes agent use
// (`hermes-agent-main/scripts/whatsapp-bridge/bridge.js`). Unlike the old
// whatsapp-web.js implementation it does NOT launch a headless Chromium —
// it speaks WhatsApp's protocol directly, which is lighter, faster, far more
// reliable, and bundles cleanly into the production EXE.
//
// Public interface is unchanged so the rest of the app (IPC handlers,
// renderer) keeps working without edits:
//   - new WhatsAppManager(mainWindow, app)
//   - updateMainWindow, getState, initialize, logout, shutdown, sendReply
//   - emits 'whatsapp-event' with: status | qr-code | qr-error | mobile-message

const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');
const { pathToFileURL } = require('url');

const BOT_SIGNATURE = '[AKKI_AI_BOT]';

// Baileys is ESM-only; load it lazily via dynamic import from this CommonJS file.
function getBaileysSpecifier() {
    try {
        const resolved = require.resolve('@whiskeysockets/baileys');
        if (resolved && fs.existsSync(resolved)) {
            return pathToFileURL(resolved).href;
        }
    } catch (_) {}

    const resourcesPath = process.resourcesPath || path.join(__dirname, '..', '..');
    const candidates = [
        path.join(resourcesPath, 'node_modules', '@whiskeysockets', 'baileys', 'lib', 'index.js'),
        path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', '@whiskeysockets', 'baileys', 'lib', 'index.js'),
        path.join(__dirname, '..', '..', 'node_modules', '@whiskeysockets', 'baileys', 'lib', 'index.js'),
        path.join(__dirname, '..', '..', '..', 'node_modules', '@whiskeysockets', 'baileys', 'lib', 'index.js'),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) {
            return pathToFileURL(c).href;
        }
    }
    return '@whiskeysockets/baileys';
}

let _baileysPromise = null;
function loadBaileys() {
    if (!_baileysPromise) {
        const specifier = getBaileysSpecifier();
        console.log('[WhatsApp] Loading Baileys from specifier:', specifier);
        _baileysPromise = import(specifier).then((mod) => ({
            makeWASocket: mod.makeWASocket || mod.default,
            useMultiFileAuthState: mod.useMultiFileAuthState,
            DisconnectReason: mod.DisconnectReason,
            fetchLatestBaileysVersion: mod.fetchLatestBaileysVersion,
            downloadMediaMessage: mod.downloadMediaMessage,
            Browsers: mod.Browsers,
        })).catch((err) => {
            console.error('[WhatsApp] Failed to load Baileys:', err);
            _baileysPromise = null;
            throw err;
        });
    }
    return _baileysPromise;
}

// Baileys expects a pino-like logger. A silent no-op logger keeps the console
// clean and avoids pulling pino in as a direct dependency.
const silentLogger = {
    level: 'silent',
    trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
    child() { return silentLogger; },
};

class WhatsAppManager {
    constructor(mainWindow, app) {
        this.mainWindow = mainWindow;
        this.app = app;

        this.sock = null;
        this.isReady = false;
        this.isInitializing = false;
        this.manualLogout = false;

        this.status = 'disconnected';
        this.statusReason = null;
        this.qrCode = null;
        this.qrError = null;
        this.qrGeneratedAt = null;

        // Baileys multi-file auth state directory (creds + signal keys).
        this.sessionPath = path.join(app.getPath('userData'), 'baileys_auth');

        this.recentlySentIds = new Set(); // our own replies → skip to avoid loops
        this.maxRecentIds = 50;

        this.reconnectTimer = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 8;

        this.initTimeout = null;
        this.maxInitTimeMs = 45000;

        this._saveCreds = null;
    }

    updateMainWindow(mainWindow) {
        this.mainWindow = mainWindow;
    }

    getState() {
        return {
            status: this.status,
            reason: this.statusReason,
            isReady: this.isReady,
            isInitializing: this.isInitializing,
            qrCode: this.qrCode,
            qrError: this.qrError,
            qrGeneratedAt: this.qrGeneratedAt,
            reconnectAttempts: this.reconnectAttempts,
        };
    }

    setStatus(status, extra = {}) {
        this.status = status;
        this.statusReason = extra.reason || null;
        this.sendToFrontend('status', { status, ...extra });
    }

    ensureRuntimeDirectories() {
        if (!fs.existsSync(this.sessionPath)) {
            fs.mkdirSync(this.sessionPath, { recursive: true });
        }
    }

    hasSavedSession() {
        try {
            return fs.existsSync(path.join(this.sessionPath, 'creds.json'));
        } catch (_) {
            return false;
        }
    }

    clearInitTimeout() {
        if (this.initTimeout) {
            clearTimeout(this.initTimeout);
            this.initTimeout = null;
        }
    }

    clearReconnectTimer() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    clearAllTimers() {
        this.clearInitTimeout();
        this.clearReconnectTimer();
    }

    startInitTimeout() {
        this.clearInitTimeout();
        this.initTimeout = setTimeout(() => {
            // Connected or showing a QR? Then the timeout is irrelevant.
            if (this.isReady || this.status === 'scan_qr') return;
            console.error('[WhatsApp] Initialization timeout (no QR / no connection).');
            this.isInitializing = false;
            this.qrError = 'WhatsApp connect timed out. Check your internet and retry.';
            this.setStatus('disconnected', { reason: 'init-timeout' });
            this.sendToFrontend('qr-error', {
                error: this.qrError,
                code: 'INIT_TIMEOUT',
                retryable: true,
            });
        }, this.maxInitTimeMs);
    }

    scheduleReconnect(reason = 'unknown') {
        if (this.manualLogout) return;
        if (this.reconnectTimer) return;

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('[WhatsApp] Reconnect limit reached. Waiting for manual restart.');
            this.setStatus('disconnected', { reason: 'reconnect-limit-reached' });
            return;
        }

        this.reconnectAttempts += 1;
        const delayMs = Math.min(30000, 2000 * (2 ** (this.reconnectAttempts - 1)));
        this.setStatus('reconnecting', { reason, attempt: this.reconnectAttempts, delayMs });

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.startSocket().catch((err) => {
                console.error('[WhatsApp] Reconnect attempt failed:', err.message || err);
                this.scheduleReconnect('reconnect-error');
            });
        }, delayMs);
    }

    async initialize(options = {}) {
        const { isReconnect = false } = options;

        if (this.isInitializing) {
            console.log('[WhatsApp] Initialize skipped (already initializing).');
            return;
        }
        if (this.sock && this.isReady) {
            console.log('[WhatsApp] Initialize skipped (already connected).');
            this.setStatus('connected');
            return;
        }

        this.manualLogout = false;
        this.ensureRuntimeDirectories();
        this.clearReconnectTimer();

        this.isInitializing = true;
        this.isReady = false;
        this.qrCode = null;
        this.qrError = null;
        this.qrGeneratedAt = null;
        this.setStatus(isReconnect ? 'reconnecting' : 'initializing', {
            attempt: this.reconnectAttempts || 0,
        });

        this.startInitTimeout();

        try {
            await this.startSocket();
        } catch (error) {
            const errorMessage = String(error?.message || error || '');
            console.error('[WhatsApp] Initialize error:', errorMessage);
            this.clearInitTimeout();
            this.isInitializing = false;
            this.isReady = false;
            this.qrError = errorMessage || 'Initialization failed';
            this.setStatus('disconnected', { reason: errorMessage || 'init-error' });
            this.sendToFrontend('qr-error', {
                error: this.qrError,
                code: 'INIT_ERROR',
                retryable: true,
            });
            this.scheduleReconnect('init-error');
        }
    }

    async startSocket() {
        const {
            makeWASocket,
            useMultiFileAuthState,
            DisconnectReason,
            fetchLatestBaileysVersion,
            Browsers,
        } = await loadBaileys();

        const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);
        this._saveCreds = saveCreds;

        let version;
        try {
            ({ version } = await fetchLatestBaileysVersion());
        } catch (_) {
            version = undefined; // Baileys falls back to a sane default
        }

        // Tear down any previous socket before creating a new one.
        if (this.sock) {
            try { this.sock.ev.removeAllListeners(); } catch (_) {}
            try { this.sock.end(undefined); } catch (_) {}
            this.sock = null;
        }

        const sock = makeWASocket({
            version,
            auth: state,
            logger: silentLogger,
            printQRInTerminal: false,
            browser: (Browsers && Browsers.appropriate)
                ? Browsers.appropriate('Akki Ai')
                : ['Akki Ai', 'Chrome', '120.0'],
            syncFullHistory: false,
            markOnlineOnConnect: false,
            // Baileys 7.x: required so messages needing E2EE session re-establishment
            // are not silently dropped (msg.message === null).
            getMessage: async () => ({ conversation: '' }),
        });
        this.sock = sock;

        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', (update) => this.handleConnectionUpdate(update, DisconnectReason));
        sock.ev.on('messages.upsert', (payload) => {
            this.handleMessagesUpsert(payload).catch((err) => {
                console.error('[WhatsApp] message handler error:', err.message || err);
            });
        });
    }

    async handleConnectionUpdate(update, DisconnectReason) {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            this.isInitializing = false;
            this.clearInitTimeout();
            try {
                const url = await qrcode.toDataURL(qr, {
                    errorCorrectionLevel: 'M',
                    type: 'image/png',
                    margin: 1,
                });
                this.qrCode = url;
                this.qrError = null;
                this.qrGeneratedAt = Date.now();
                this.setStatus('scan_qr');
                this.sendToFrontend('qr-code', { url, generatedAt: this.qrGeneratedAt });
            } catch (error) {
                const errMsg = error.message || String(error);
                console.error('[WhatsApp] QR encode error:', errMsg);
                this.qrCode = null;
                this.qrError = `QR generation failed: ${errMsg}`;
                this.setStatus('qr_error', { reason: 'qr-encode-failed' });
                this.sendToFrontend('qr-error', { error: this.qrError, code: 'QR_ENCODE_FAILED', retryable: true });
            }
            return;
        }

        if (connection === 'connecting') {
            if (!this.isReady) this.setStatus('initializing');
            return;
        }

        if (connection === 'open') {
            this.clearInitTimeout();
            this.clearReconnectTimer();
            this.isInitializing = false;
            this.isReady = true;
            this.qrCode = null;
            this.qrError = null;
            this.qrGeneratedAt = null;
            this.reconnectAttempts = 0;
            this.setStatus('connected');
            console.log('[WhatsApp] Connected.');
            return;
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            this.clearInitTimeout();
            this.isInitializing = false;
            this.isReady = false;
            this.qrCode = null;

            if (this.manualLogout) {
                this.setStatus('disconnected', { reason: 'manual-logout' });
                return;
            }

            if (statusCode === DisconnectReason.loggedOut) {
                // Session invalidated on the phone → wipe creds, require re-link.
                console.warn('[WhatsApp] Logged out from phone. Clearing session.');
                this.wipeSession();
                this.qrError = 'WhatsApp was unlinked from your phone. Please scan the QR again.';
                this.setStatus('disconnected', { reason: 'logged-out' });
                this.sendToFrontend('qr-error', { error: this.qrError, code: 'LOGGED_OUT', retryable: true });
                return;
            }

            // 515 = restart required (normal right after first pairing). Reconnect fast.
            const reason = statusCode === 515 ? 'restart-required' : `closed-${statusCode || 'unknown'}`;
            console.warn(`[WhatsApp] Connection closed (${reason}). Reconnecting...`);
            if (statusCode === 515) {
                // Immediate reconnect without counting against the retry budget.
                this.setStatus('reconnecting', { reason });
                this.startSocket().catch(() => this.scheduleReconnect(reason));
            } else {
                this.scheduleReconnect(reason);
            }
        }
    }

    async handleMessagesUpsert({ messages, type }) {
        // Self-chat messages frequently arrive as 'append' rather than 'notify'.
        if (type !== 'notify' && type !== 'append') return;
        if (!this.sock) return;

        for (const msg of messages) {
            if (!msg.message || !msg.key) continue;

            const chatId = msg.key.remoteJid || '';
            if (!chatId || chatId === 'status@broadcast' || chatId.endsWith('@g.us')) continue;

            // Only the user's own "Message Yourself" chat is allowed through.
            if (!msg.key.fromMe) continue;

            const myNumber = (this.sock.user?.id || '').replace(/:.*@/, '@').replace(/@.*/, '');
            const myLid = (this.sock.user?.lid || '').replace(/:.*@/, '@').replace(/@.*/, '');
            const chatNumber = chatId.replace(/@.*/, '');
            const isSelfChat = (myNumber && chatNumber === myNumber) || (myLid && chatNumber === myLid);
            if (!isSelfChat) continue;

            // Skip our own bot replies (loop prevention).
            if (this.recentlySentIds.has(msg.key.id)) continue;

            const content = this.unwrapMessage(msg.message);

            // ── Text ──
            let body = '';
            if (content.conversation) body = content.conversation;
            else if (content.extendedTextMessage?.text) body = content.extendedTextMessage.text;

            if (body) {
                body = String(body).trim();
                if (!body || body.includes(BOT_SIGNATURE)) continue;
                console.log('[WhatsApp] ✅ Forwarding text to Akki:', body.substring(0, 60));
                this.sendToFrontend('mobile-message', {
                    message: body,
                    chatId,
                    timestamp: Number(msg.messageTimestamp) || Date.now(),
                    messageId: msg.key.id || null,
                });
                continue;
            }

            // ── Voice note / audio → transcribe via Gemini, forward as text ──
            const audioMsg = content.audioMessage || content.pttMessage;
            if (audioMsg) {
                try {
                    console.log('[WhatsApp] ✅ Voice message detected — transcribing via Gemini...');
                    const { downloadMediaMessage } = await loadBaileys();
                    const buffer = await downloadMediaMessage(
                        msg, 'buffer', {},
                        { logger: silentLogger, reuploadRequest: this.sock.updateMediaMessage }
                    );
                    if (buffer && buffer.length) {
                        const base64 = Buffer.from(buffer).toString('base64');
                        const mime = audioMsg.mimetype || 'audio/ogg';
                        const transcription = await this.transcribeWithGemini(base64, mime);
                        if (transcription) {
                            console.log('[WhatsApp] ✅ Voice transcribed:', transcription.substring(0, 60));
                            this.sendToFrontend('mobile-message', {
                                message: `[Voice Note] ${transcription}`,
                                chatId,
                                timestamp: Number(msg.messageTimestamp) || Date.now(),
                                messageId: msg.key.id || null,
                            });
                        } else {
                            console.warn('[WhatsApp] Voice transcription returned empty.');
                        }
                    }
                } catch (error) {
                    console.error('[WhatsApp] Voice handling error:', error.message || error);
                }
            }
        }
    }

    // Unwrap ephemeral / view-once / document-caption envelopes to reach the
    // actual message content.
    unwrapMessage(message) {
        let content = message || {};
        if (content.ephemeralMessage?.message) content = content.ephemeralMessage.message;
        if (content.viewOnceMessage?.message) content = content.viewOnceMessage.message;
        if (content.viewOnceMessageV2?.message) content = content.viewOnceMessageV2.message;
        if (content.documentWithCaptionMessage?.message) content = content.documentWithCaptionMessage.message;
        return content;
    }

    /**
     * Transcribe audio using Gemini's standard generateContent API.
     * Uses the same Gemini API key configured in the app settings.
     */
    async transcribeWithGemini(base64AudioData, mimeType = 'audio/ogg') {
        try {
            let apiKey = process.env.GEMINI_API_KEY;
            const keyPath = path.join(this.app.getPath('userData'), 'secret_key.json');
            if (fs.existsSync(keyPath)) {
                const data = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
                if (data.apiKey || data.geminiKey) apiKey = data.apiKey || data.geminiKey;
            }
            if (!apiKey) {
                console.error('[WhatsApp] Gemini API key missing for voice transcription.');
                return null;
            }

            // Resolve model and optional per-tool API key from tools_config.json
            let model = 'gemini-2.0-flash';
            let fallbackModel = 'gemini-2.0-flash-lite';
            let enableFallback = true;
            let toolsCfg = null;
            try {
                toolsCfg = require('./tools-config-manager');
                const cfg = toolsCfg.readConfig();
                const t = (cfg.tools && cfg.tools.whatsapp_transcribe) || {};
                model = toolsCfg.getEffectiveModel('whatsapp_transcribe') || model;
                fallbackModel = t.fallbackModel || cfg.defaultGlobalFallbackModel || fallbackModel;
                enableFallback = t.enableFallback !== false && cfg.enableGlobalFallback !== false;
                if (t.usePrimaryApiKey === false && t.customApiKey && t.customApiKey.trim()) {
                    apiKey = t.customApiKey.trim();
                }
            } catch (cfgErr) {
                console.warn('[WhatsApp] tools_config unavailable, using defaults:', cfgErr?.message || cfgErr);
            }

            const { GoogleGenAI } = require('@google/genai');
            const ai = new GoogleGenAI({ apiKey });

            const runTranscribe = (modelId) => ai.models.generateContent({
                model: modelId,
                contents: [{
                    role: 'user',
                    parts: [
                        { inlineData: { mimeType, data: base64AudioData } },
                        { text: 'Transcribe this audio message exactly as spoken. Output ONLY the transcription text, nothing else. If the audio is in any language other than English, still transcribe it accurately in that language.' },
                    ],
                }],
            });

            let result;
            try {
                result = await runTranscribe(model);
            } catch (primaryErr) {
                const msg = String(primaryErr?.message || primaryErr || '');
                const notFound = primaryErr?.status === 404 || /404|not found|NOT_FOUND/i.test(msg);
                if (!enableFallback || !fallbackModel || fallbackModel === model) throw primaryErr;
                console.warn(`[WhatsApp] Model ${model} failed, retrying with fallback ${fallbackModel}`);
                if (notFound && toolsCfg) toolsCfg.markModelRetired('whatsapp_transcribe');
                result = await runTranscribe(fallbackModel);
            }

            let transcription = '';
            if (typeof result.text === 'string') transcription = result.text.trim();
            else if (result.candidates?.[0]?.content?.parts?.[0]?.text) {
                transcription = result.candidates[0].content.parts[0].text.trim();
            }
            return transcription || null;
        } catch (error) {
            console.error('[WhatsApp] Gemini transcription error:', error?.message || error);
            return null;
        }
    }

    async sendReply(chatId, text) {
        if (!this.sock || !this.isReady) {
            console.warn('[WhatsApp] Send skipped. Client not ready.');
            return false;
        }

        const targetChatId = String(chatId || '').trim();
        const messageText = String(text || '').trim();
        if (!targetChatId || !messageText) {
            console.warn('[WhatsApp] Send skipped. Invalid chatId or message.');
            return false;
        }

        try {
            const replyText = `${messageText}\n\n_${BOT_SIGNATURE}_`;
            const sent = await this.sock.sendMessage(targetChatId, { text: replyText });
            const sentId = sent?.key?.id;
            if (sentId) {
                this.recentlySentIds.add(sentId);
                if (this.recentlySentIds.size > this.maxRecentIds) {
                    this.recentlySentIds.delete(this.recentlySentIds.values().next().value);
                }
            }
            return true;
        } catch (error) {
            console.error('[WhatsApp] Send error:', error.message || error);
            return false;
        }
    }

    wipeSession() {
        try {
            if (fs.existsSync(this.sessionPath)) {
                fs.rmSync(this.sessionPath, { recursive: true, force: true });
            }
        } catch (error) {
            console.warn('[WhatsApp] Failed to wipe session:', error.message || error);
        }
    }

    async destroySocket() {
        if (!this.sock) return;
        const sock = this.sock;
        this.sock = null;
        try { sock.ev.removeAllListeners(); } catch (_) {}
        try { sock.end(undefined); } catch (_) {}
    }

    async logout() {
        this.manualLogout = true;
        this.clearAllTimers();
        this.reconnectAttempts = 0;
        this.isReady = false;
        this.isInitializing = false;
        this.qrCode = null;

        try {
            if (this.sock) await this.sock.logout();
        } catch (error) {
            console.warn('[WhatsApp] Logout error:', error.message || error);
        }
        await this.destroySocket();
        this.wipeSession();
        this.setStatus('disconnected', { reason: 'manual-logout' });
    }

    async shutdown() {
        this.manualLogout = true;
        this.clearAllTimers();
        this.isReady = false;
        this.isInitializing = false;
        this.qrCode = null;
        await this.destroySocket();
    }

    sendToFrontend(event, data) {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
        try {
            this.mainWindow.webContents.send('whatsapp-event', { event, data });
        } catch (error) {
            console.error('[WhatsApp] Failed to send IPC event:', error.message || error);
        }
    }
}

module.exports = WhatsAppManager;
