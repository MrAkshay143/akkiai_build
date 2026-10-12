/**
 * Hermes Bridge — WebSocket server for Electron main process.
 *
 * Emulates the OpenClaw gateway protocol so the Agent Town frontend
 * (already embedded in Akki Ai) can connect and dispatch tasks to
 * Hermes Agent via Python CLI.
 *
 * Protocol flow:
 *   connect.challenge → connect → hello-ok handshake
 *   chat.send → spawns `python -m hermes_cli.main -z "prompt"`
 *   chat.abort → kills the running process
 *
 * Ported from: agent-town-main/lib/hermes-bridge.ts
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');
const { isWindows, findBundledChromiumExecutable } = require('./platform-utils');

// Dynamic CDP port — resolved at app startup by browser-manager (port 9222
// may be taken by foreign apps like Adobe Premiere Pro / Adobe UXP).
// Lazy require to avoid any module-load-order issues.
function getCdpUrl() {
  try {
    const { getCdpPort } = require('./browser-manager');
    return `http://127.0.0.1:${getCdpPort()}`;
  } catch {
    return 'http://127.0.0.1:9222';
  }
}

// ── Logger ──────────────────────────────────────────────

const PREFIX = '[Hermes Bridge]';
const log = {
  info: (...args) => console.log(PREFIX, ...args),
  warn: (...args) => console.warn(PREFIX, ...args),
  error: (...args) => console.error(PREFIX, ...args),
  debug: (...args) => {
    if (process.env.HERMES_BRIDGE_DEBUG) console.log(PREFIX, '[DEBUG]', ...args);
  },
};

// ── State ───────────────────────────────────────────────

let runCounter = 0;
/** @type {Set<object>} All connected WebSocket clients */
const connectedClients = new Set();
let workerRoster = [];
let wsServer = null;
let httpServer = null;
let actualBridgePort = null;
let _toolResultCallback = null;

// ── Hermes Path Resolution ──────────────────────────────

/**
 * Resolves the Hermes project directory.
 * Priority:
 *   1. HERMES_PROJECT_PATH env var
 *   2. Sibling folder (development layout)
 *   3. Electron extraResources (production EXE)
 */
function getHermesProjectPath(electronApp) {
  // 1. Explicit env var
  const envPath = process.env.HERMES_PROJECT_PATH;
  if (envPath && fs.existsSync(envPath)) return path.resolve(envPath);

  // 2. Development: sibling folder
  // Akki Ai is at: .../Akki Ai - AGI/Source code latest for developers/
  // Hermes is at:    .../Akki Ai - AGI/hermes-agent-main/
  const devSibling = path.resolve(__dirname, '..', '..', '..', 'hermes-agent-main');
  if (fs.existsSync(devSibling)) return devSibling;

  // 2b. Development: Akki Ai layout — hermes-agent is inside source-code
  const akkiDevPath = path.resolve(__dirname, '..', '..', 'hermes-agent');
  if (fs.existsSync(akkiDevPath)) return akkiDevPath;

  // 3. Production: bundled in extraResources
  if (electronApp) {
    const resourcePath = path.join(process.resourcesPath, 'hermes-agent');
    if (fs.existsSync(resourcePath)) return resourcePath;
  }

  return null;
}

/**
 * Find the bundled Chromium — checks both production EXE resources and dev source folder.
 * Always returns the same bundled Chromium regardless of how the app is run.
 */
function findBundledChromium() {
  const searchDirs = [];

  // 1. Production EXE: extraResources/browsers/
  if (process.resourcesPath) {
    searchDirs.push(path.join(process.resourcesPath, 'browsers'));
  }

  // 2. Development: Source code latest for developers/browsers/
  searchDirs.push(path.resolve(__dirname, '..', '..', 'browsers'));

  if (isWindows) {
    for (const browsersDir of searchDirs) {
      if (!fs.existsSync(browsersDir)) continue;
      try {
        for (const entry of fs.readdirSync(browsersDir)) {
          if (entry.startsWith('chromium-')) {
            const chromePath = path.join(browsersDir, entry, 'chrome-win64', 'chrome.exe');
            if (fs.existsSync(chromePath)) return chromePath;
          }
        }
      } catch { /* ignore */ }
    }
    return null;
  }

  // macOS / Linux: same scan, platform-specific executable layout.
  return findBundledChromiumExecutable(searchDirs);
}

/**
 * Create a .cmd wrapper so Python can run agent-browser using Electron's
 * built-in Node.js (ELECTRON_RUN_AS_NODE). Works on fresh PCs without Node.js.
 */
function setupAgentBrowserWrapper(hermesProjectPath, userDataPath) {
  if (!hermesProjectPath) return null;

  // 1. Prioritize Native Standalone Binary (Rust executable)
  let binaryName = null;
  if (process.platform === 'win32') {
    binaryName = 'agent-browser-win32-x64.exe';
  } else if (process.platform === 'darwin') {
    binaryName = process.arch === 'arm64' ? 'agent-browser-darwin-arm64' : 'agent-browser-darwin-x64';
  } else if (process.platform === 'linux') {
    binaryName = process.arch === 'arm64' ? 'agent-browser-linux-arm64' : 'agent-browser-linux-x64';
  }

  if (binaryName) {
    const nativeBinaryPath = path.join(
      hermesProjectPath, 'node_modules', 'agent-browser', 'bin', binaryName
    );
    if (fs.existsSync(nativeBinaryPath)) {
      log.info(`Found native standalone browser binary: ${nativeBinaryPath}`);
      return nativeBinaryPath;
    }
  }

  // 2. Fallback to .cmd/shell script wrapper using Electron's Node.js
  const agentBrowserJs = path.join(
    hermesProjectPath, 'node_modules', 'agent-browser', 'bin', 'agent-browser.js'
  );
  if (!fs.existsSync(agentBrowserJs)) return null;

  // Write to userDataPath (always user-writable) rather than hermesProjectPath (which might be read-only in Program Files)
  const wrapperDir = userDataPath && fs.existsSync(userDataPath) ? userDataPath : hermesProjectPath;
  const electronExe = process.execPath; // electron.exe acts as Node.js

  if (isWindows) {
    const wrapperPath = path.join(wrapperDir, 'agent-browser-akki.cmd');
    const cmdContent = [
      '@echo off',
      'set ELECTRON_RUN_AS_NODE=1',
      `"${electronExe}" "${agentBrowserJs}" %*`,
    ].join('\r\n') + '\r\n';

    try {
      fs.writeFileSync(wrapperPath, cmdContent, 'utf8');
      // Also write legacy compat wrapper
      const legacyPath = path.join(wrapperDir, 'agent-browser-stonic.cmd');
      if (!fs.existsSync(legacyPath)) {
        fs.writeFileSync(legacyPath, cmdContent, 'utf8');
      }
      return wrapperPath;
    } catch (err) {
      log.warn(`Could not create agent-browser wrapper in ${wrapperDir}: ${err.message}`);
      return null;
    }
  }

  // macOS / Linux: executable shell script wrapper
  const wrapperPath = path.join(wrapperDir, 'agent-browser-akki.sh');
  const shContent = [
    '#!/bin/sh',
    'export ELECTRON_RUN_AS_NODE=1',
    `exec "${electronExe}" "${agentBrowserJs}" "$@"`,
  ].join('\n') + '\n';

  try {
    fs.writeFileSync(wrapperPath, shContent, { encoding: 'utf8', mode: 0o755 });
    fs.chmodSync(wrapperPath, 0o755);
    // Also write legacy compat wrapper
    const legacyShellPath = path.join(wrapperDir, 'agent-browser-stonic.sh');
    if (!fs.existsSync(legacyShellPath)) {
      fs.writeFileSync(legacyShellPath, shContent, { encoding: 'utf8', mode: 0o755 });
      fs.chmodSync(legacyShellPath, 0o755);
    }
    return wrapperPath;
  } catch (err) {
    log.warn(`Could not create agent-browser wrapper in ${wrapperDir}: ${err.message}`);
    return null;
  }
}

function getHermesPythonPath(hermesProjectPath) {
  if (!hermesProjectPath) return null;

  // 1. Production: embedded Python bundled in extraResources
  if (process.resourcesPath) {
    const embeddedWin = path.join(process.resourcesPath, 'python-embedded', 'python.exe');
    if (fs.existsSync(embeddedWin)) return embeddedWin;

    // macOS / Linux: python-build-standalone layout (bin/python3)
    const embeddedUnix = path.join(process.resourcesPath, 'python-embedded', 'bin', 'python3');
    if (fs.existsSync(embeddedUnix)) return embeddedUnix;
  }

  // 2. Development: .venv/Scripts/python.exe (Windows)
  const winPath = path.join(hermesProjectPath, '.venv', 'Scripts', 'python.exe');
  if (fs.existsSync(winPath)) return winPath;

  // 3. Development: .venv/bin/python (Linux/macOS)
  const unixPath = path.join(hermesProjectPath, '.venv', 'bin', 'python');
  if (fs.existsSync(unixPath)) return unixPath;

  return null;
}

// ── WebSocket Frame Helpers ─────────────────────────────

function sendFrame(state, frame) {
  if (!state || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  try {
    state.ws.send(JSON.stringify(frame));
  } catch (err) {
    log.error('sendFrame failed:', err.message);
  }
}

function sendEvent(state, event, payload) {
  sendFrame(state, { type: 'event', event, payload, seq: state.seq++ });
}

/**
 * Broadcast an event to ALL connected clients so that both
 * the Agent Town iframe and the Voice Assistant bridge receive
 * lifecycle, chat, and agent events.
 */
function broadcastEvent(event, payload) {
  for (const client of connectedClients) {
    sendEvent(client, event, payload);
  }
}

function sendResponse(state, id, ok, payloadOrError) {
  const frame = { type: 'res', id, ok };
  if (ok) {
    frame.payload = payloadOrError;
  } else {
    frame.error = payloadOrError;
  }
  sendFrame(state, frame);
}

/**
 * Map a Hermes NDJSON stream event emitted by Hermes Python (oneshot mode
 * with STONIC_STREAM_EVENTS=1) into the granular WebSocket `agent` events the
 * renderer turns into a live, step-by-step timeline. Returns the final answer
 * text when the event is the terminal `final` marker, else null.
 */
function forwardStreamEvent(runId, sessionKey, evt) {
  const k = evt && evt.k;
  if (k === 'text') {
    broadcastEvent('agent', { runId, sessionKey, stream: 'assistant', data: { delta: String(evt.delta || '') } });
  } else if (k === 'reasoning') {
    broadcastEvent('agent', { runId, sessionKey, stream: 'reasoning', data: { text: String(evt.text || '') } });
  } else if (k === 'tool_start') {
    // Suppress Agent UI for internal huggingface tool (silent execution)
    if (evt.name !== 'huggingface_generate_image') {
      broadcastEvent('agent', { runId, sessionKey, stream: 'tool_start', data: { id: evt.id, name: evt.name, args: evt.args } });
    }
  } else if (k === 'tool_end') {
    console.log('[HF-DIAG] tool_end name=' + evt.name + ' ok=' + evt.ok + ' output_len=' + (evt.output ? evt.output.length : 0));
    if (evt.name !== 'huggingface_generate_image') {
      broadcastEvent('agent', { runId, sessionKey, stream: 'tool_end', data: { id: evt.id, name: evt.name, ok: evt.ok, output: evt.output } });
    }
    // Always notify main.js about completed tools (e.g. to open Info Panel for generated images)
    if (_toolResultCallback) {
      console.log('[HF-DIAG] calling _toolResultCallback for ' + evt.name);
      try { _toolResultCallback(evt.name, evt.output); } catch(e) { console.log('[HF-DIAG] _toolResultCallback error: ' + e.message); }
    }
  } else if (k === 'status') {
    broadcastEvent('agent', { runId, sessionKey, stream: 'status', data: { text: String(evt.text || '') } });
  } else if (k === 'final') {
    return String(evt.text || '');
  }
  return null;
}

// ── Agent Town Config — API Key Injection ───────────────

/**
 * Mirror the user's currently-selected provider API key from
 * agent_town_config.json into `~/.hermes/.env`.
 *
 * WHY THIS EXISTS:
 * Hermes loads `~/.hermes/.env` with python-dotenv `override=True`
 * (hermes_cli/env_loader.py), so any key stored there CLOBBERS the
 * GOOGLE_API_KEY / GEMINI_API_KEY we inject into the spawn env. If that
 * file holds an OLD key (e.g. a previous `AIza…` key from a past `hermes
 * setup`), every Gemini turn fails with HTTP 400 "API key expired" — and
 * oneshot mode redirects Python stderr to devnull, so the only thing the
 * user sees is an empty "(No response from Hermes)". The Voice Assistant
 * is unaffected because it calls Gemini directly with the app's key and
 * never reads ~/.hermes/.env.
 *
 * Akki owns the key (the user types it in the UI), so we keep Hermes's
 * authoritative `.env` in sync. Idempotent: only writes when the value
 * actually differs, and preserves every other line in the file.
 */
function syncHermesDotEnvKey(userDataPath) {
  try {
    if (!userDataPath) return;
    const os = require('os');
    const configPath = path.join(userDataPath, 'agent_town_config.json');
    if (!fs.existsSync(configPath)) return;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    // Determine which env keys the selected provider needs enforced.
    const updates = {};
    if (config.provider === 'openai-codex') return; // OAuth — no API key.
    if (config.provider === 'openrouter') {
      const k = config.openRouterApiKey || config.apiKey;
      if (k) updates.OPENROUTER_API_KEY = k;
    } else {
      // Gemini (and default) — both names Hermes recognises.
      const k = config.geminiApiKey || config.apiKey;
      if (k) { updates.GOOGLE_API_KEY = k; updates.GEMINI_API_KEY = k; }
    }
    if (Object.keys(updates).length === 0) return;

    const hermesHome = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
    const envPath = path.join(hermesHome, '.env');

    let lines = [];
    if (fs.existsSync(envPath)) {
      lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    }

    let changed = false;
    const seen = new Set();
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*([A-Za-z0-9_]+)\s*=/);
      if (m && Object.prototype.hasOwnProperty.call(updates, m[1])) {
        seen.add(m[1]);
        const desired = `${m[1]}=${updates[m[1]]}`;
        if (lines[i] !== desired) { lines[i] = desired; changed = true; }
      }
    }
    for (const key of Object.keys(updates)) {
      if (seen.has(key)) continue;
      while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
      lines.push(`${key}=${updates[key]}`);
      changed = true;
    }
    if (!changed) return;

    if (!fs.existsSync(hermesHome)) fs.mkdirSync(hermesHome, { recursive: true });
    fs.writeFileSync(envPath, lines.join('\n') + '\n', 'utf8');
    log.info(`Synced current ${config.provider} API key into ${envPath} (was overriding spawn env via dotenv override=True)`);
  } catch (err) {
    log.warn(`syncHermesDotEnvKey failed: ${err.message}`);
  }
}

/**
 * Reads agent_town_config.json from userData and returns
 * the correct env vars to inject into the Hermes process.
 */
function getAgentTownEnv(userDataPath) {
  const env = {};
  const os = require('os');
  env.HERMES_HOME = path.join(os.homedir(), '.hermes');

  // Keep Hermes's ~/.hermes/.env in sync with the user's current key so a
  // stale key there can't override the one we inject below (override=True).
  syncHermesDotEnvKey(userDataPath);

    if (!userDataPath) { console.log('[HF-DIAG] getAgentTownEnv: early return — no userDataPath'); return env; }
    try {
      const configPath = path.join(userDataPath, 'agent_town_config.json');
      if (!fs.existsSync(configPath)) { console.log('[HF-DIAG] getAgentTownEnv: early return — no agent_town_config.json'); return env; }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    if (config.provider) {
      env.HERMES_INFERENCE_PROVIDER = config.provider;
    }

    // Pass the user-selected model alongside the provider. Without this, Hermes
    // falls back to ~/.hermes/config.yaml's default model — which can mismatch
    // the selected provider (e.g. provider=gemini but config default is an
    // OpenAI model), making the Gemini path return an empty answer
    // ("(No response from Hermes)"). Keeping provider+model as one consistent
    // pair from agent_town_config.json removes that whole class of failure.
    if (config.modelId) {
      env.HERMES_INFERENCE_MODEL = config.modelId;
    }

    if (config.provider === 'openai-codex') {
      return env;
    }
    const activeKey = config.provider === 'openrouter'
      ? (config.openRouterApiKey || config.apiKey)
      : (config.geminiApiKey || config.apiKey);

    if (!activeKey) { console.log('[HF-DIAG] getAgentTownEnv: early return — no activeKey'); return env; }
    if (config.provider === 'openrouter') {
      env.OPENROUTER_API_KEY = activeKey;
    } else {
      // Gemini — both env var names for compatibility
      env.GOOGLE_API_KEY = activeKey;
      env.GEMINI_API_KEY = activeKey;
    }

    // Inject Hugging Face API key from hf_key.json so the Python
    // huggingface_generate_image tool can find it without manual setup.
    try {
      const hfKeyPath = path.join(userDataPath, 'hf_key.json');
      if (fs.existsSync(hfKeyPath)) {
        const hfData = JSON.parse(fs.readFileSync(hfKeyPath, 'utf8'));
        if (hfData.apiKey) {
          env.HUGGINGFACE_API_KEY = hfData.apiKey;
        }
      }
    } catch {}

    // [DIAG] probe: confirm HF key injection status
    console.log('[HF-DIAG] getAgentTownEnv: hfKeySet=' + (!!env.HUGGINGFACE_API_KEY) + ' len=' + (env.HUGGINGFACE_API_KEY ? env.HUGGINGFACE_API_KEY.length : 0));

    // Inject configured image output directory so the Python tool saves
    // images to the same folder the user chose in Settings.
    try {
      const outputCfgPath = path.join(userDataPath, 'hf_image_output.json');
      if (fs.existsSync(outputCfgPath)) {
        const outputCfg = JSON.parse(fs.readFileSync(outputCfgPath, 'utf8'));
        if (outputCfg.path) {
          env.HF_IMAGE_OUTPUT_DIR = outputCfg.path;
        }
      }
    } catch {}
  } catch {}
  return env;
}

// ── Personality Injection ───────────────────────────────

function buildPersonalityPrefix(params) {
  const label = params.seatLabel;
  const role = params.seatRole;
  if (!label && !role) {
    return '[You are Akki Ai Agent, powered by Hermes. Stay in character when responding.]\n\n';
  }
  const parts = [];
  if (label) parts.push(`Your name is "${label}".`);
  if (role) parts.push(`Your role is ${role}.`);
  parts.push('Stay in character when responding.');
  return `[${parts.join(' ')}]\n\n`;
}

// ── Chat Send Handler ───────────────────────────────────

function handleChatSend(state, id, params, hermesConfig) {
  const sessionKey = params.sessionKey || 'default';
  const rawMessage = params.message || '';
  const runId = `hermes_${Date.now()}_${++runCounter}`;

  // Inject personality context
  const message = buildPersonalityPrefix(params) + rawMessage;

  // Immediate ACK — only to the requesting client
  sendResponse(state, id, true, { runId, status: 'accepted' });

  // Lifecycle start — BROADCAST to all clients (Agent Town UI + Voice bridge)
  broadcastEvent('agent', {
    runId, sessionKey,
    stream: 'lifecycle',
    data: { phase: 'start' },
  });

  // Resolve Hermes paths
  const { pythonPath, projectPath } = hermesConfig;
  if (!pythonPath || !projectPath) {
    const errMsg = 'Hermes Agent not found. Set HERMES_PROJECT_PATH or place hermes-agent-main as sibling folder.';
    log.error(errMsg);
    broadcastEvent('agent', { runId, sessionKey, stream: 'lifecycle', data: { phase: 'error', error: errMsg } });
    broadcastEvent('chat', { runId, sessionKey, state: 'error' });
    return;
  }

  // Build command: python -m hermes_cli.main -z "message"
  const args = ['-m', 'hermes_cli.main', '-z', message];

  log.info(`Spawning Hermes for run ${runId}`);
  log.info(`[AKKI_DBG] Spawn env AKKI_BRIDGE_URL = ${actualBridgePort ? `http://127.0.0.1:${actualBridgePort}` : '(NOT SET — actualBridgePort is null)'}`);
  log.info(`[AKKI_DBG] Spawn env BROWSER_CDP_URL = ${getCdpUrl()}`);
  log.info(`[AKKI_DBG] Spawn env AGENT_BROWSER_EXECUTABLE_PATH = ${hermesConfig.bundledChromiumPath || '(none)'}`);
  log.info(`[AKKI_DBG] Spawn env AGENT_BROWSER_EXECUTABLE_PATH = ${hermesConfig.bundledChromiumPath || '(none)'}`);

  // Send "thinking" bubble — BROADCAST
  broadcastEvent('agent', {
    runId, sessionKey,
    stream: 'reasoning',
    data: { text: 'Thinking...' },
  });

  let child;
  try {
    child = spawn(pythonPath, args, {
      cwd: projectPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...getAgentTownEnv(hermesConfig.userDataPath),
        HERMES_NONINTERACTIVE: '1',
        HERMES_QUIET: '1',
        PYTHONIOENCODING: 'utf-8',
        // Stream reasoning / tool steps / answer tokens live to the chat window
        AKKI_STREAM_EVENTS: '1',
        STONIC_STREAM_EVENTS: '1',
        // Stable per-chat session id → Hermes resumes the same conversation
        // across turns (multi-turn memory) and manages the context window itself.
        ...(sessionKey ? { AKKI_SESSION_ID: `akki-chat-${sessionKey}`, STONIC_SESSION_ID: `stonic-chat-${sessionKey}` } : {}),
        // Run Chrome in headed (visible) mode so user can see it live
        AGENT_BROWSER_HEADED: '1',
        // Enable console logs streaming to stderr
        HERMES_CONSOLE_LOGGING: '1',
        // Pass the running voice assistant browser DevTools URL (dynamic port)
        BROWSER_CDP_URL: getCdpUrl(),
        // Akki bridge URL — Python uses this to ask Electron to lazy-launch
        // the bundled Chromium when the CDP port is not yet alive.
        ...(actualBridgePort
          ? { AKKI_BRIDGE_URL: `http://127.0.0.1:${actualBridgePort}`, STONIC_BRIDGE_URL: `http://127.0.0.1:${actualBridgePort}` }
          : {}),
        // Pass dynamic Akki Data path
        ...(hermesConfig.akkiDataDir
          ? { AKKI_DATA_DIR: hermesConfig.akkiDataDir, STONIC_DATA_DIR: hermesConfig.akkiDataDir }
          : {}),
        // Pass bundled Chromium path so Python browser tools can find it
        ...(hermesConfig.bundledChromiumPath
          ? { AGENT_BROWSER_EXECUTABLE_PATH: hermesConfig.bundledChromiumPath }
          : {}),
        // Pass wrapper path so Python runs agent-browser via Electron's Node.js
        ...(hermesConfig.agentBrowserWrapperPath
          ? { AGENT_BROWSER_CMD_OVERRIDE: hermesConfig.agentBrowserWrapperPath }
          : {}),
      },
    });
  } catch (err) {
    const errMsg = `Failed to spawn Hermes: ${err.message}`;
    log.error(errMsg);
    broadcastEvent('agent', { runId, sessionKey, stream: 'lifecycle', data: { phase: 'error', error: errMsg } });
    broadcastEvent('chat', { runId, sessionKey, state: 'error' });
    return;
  }

  state.runningProcesses.set(runId, child);

  let stdout = '';
  let stderr = '';
  let lineBuf = '';
  let finalText = '';
  let sawStreamEvent = false;

  // Process one logical stdout line. Lines prefixed with the RS char (\x1e)
  // are structured stream events; anything else is plain text (legacy
  // / non-streaming fallback) and is forwarded as an assistant delta.
  const handleLine = (line) => {
    if (line.charCodeAt(0) === 0x1e) {
      sawStreamEvent = true;
      let evt;
      try { evt = JSON.parse(line.slice(1)); } catch { return; }
      const maybeFinal = forwardStreamEvent(runId, sessionKey, evt);
      if (maybeFinal !== null) finalText = maybeFinal;
      return;
    }
    if (line.trim().length > 0) {
      broadcastEvent('agent', {
        runId, sessionKey,
        stream: 'assistant',
        data: { delta: line + '\n' },
      });
    }
  };

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf-8');
    stdout += text;
    lineBuf += text;
    let nl;
    while ((nl = lineBuf.indexOf('\n')) !== -1) {
      const line = lineBuf.slice(0, nl);
      lineBuf = lineBuf.slice(nl + 1);
      handleLine(line);
    }
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf-8');
    stderr += text;
    if (text.trim().length > 0) {
      text.split('\n').forEach(line => {
        if (line.trim()) {
          console.error(`[Hermes Python stderr] ${line.trim()}`);
        }
      });
    }
  });

  child.on('error', (err) => {
    log.error(`Hermes process error for run ${runId}:`, err.message);
    state.runningProcesses.delete(runId);
    broadcastEvent('agent', { runId, sessionKey, stream: 'lifecycle', data: { phase: 'error', error: err.message } });
    broadcastEvent('chat', { runId, sessionKey, state: 'error' });
  });

  child.on('close', (code) => {
    state.runningProcesses.delete(runId);

    // Flush any trailing partial line that arrived without a newline.
    if (lineBuf.length > 0) { handleLine(lineBuf); lineBuf = ''; }

    // AKKI_DBG: dump FULL stdout/stderr for diagnostics
    log.info(`[AKKI_DBG] Hermes run ${runId} closed with code ${code}`);
    log.info(`[AKKI_DBG] === FULL STDOUT (${stdout.length} chars) ===\n${stdout}\n[AKKI_DBG] === END STDOUT ===`);
    log.info(`[AKKI_DBG] === FULL STDERR (${stderr.length} chars) ===\n${stderr}\n[AKKI_DBG] === END STDERR ===`);

    if (code === null || code !== 0) {
      const errMsg = stderr.trim() || `Hermes exited with code ${code}`;
      log.error(`Hermes failed for run ${runId}:`, errMsg);
      broadcastEvent('agent', { runId, sessionKey, stream: 'lifecycle', data: { phase: 'error', error: errMsg } });
      broadcastEvent('chat', { runId, sessionKey, state: 'error' });
      return;
    }

    // In streaming mode the authoritative answer comes from the `final`
    // event; otherwise fall back to the raw stdout (legacy behaviour).
    const realResponse = (sawStreamEvent ? finalText : stdout).trim();
    if (!realResponse) {
      // Exit 0 but no answer. In stream mode Python redirects its own stderr to
      // devnull, so the underlying model error is hidden there — surface what we
      // can (provider/model + any captured stderr) to make the cause findable.
      const atEnv = getAgentTownEnv(hermesConfig.userDataPath);
      log.warn(`Hermes returned EMPTY answer for run ${runId} (exit 0). provider=${atEnv.HERMES_INFERENCE_PROVIDER || '(default)'} model=${atEnv.HERMES_INFERENCE_MODEL || '(config.yaml default)'} — verify the model name is valid for this provider. Captured stderr: ${stderr.trim() || '(none — swallowed by oneshot devnull in stream mode)'}`);
    }
    const responseText = realResponse || '(No response from Hermes)';

    // Lifecycle end — BROADCAST
    broadcastEvent('agent', { runId, sessionKey, stream: 'lifecycle', data: { phase: 'end' } });

    // Final chat message — BROADCAST
    broadcastEvent('chat', {
      runId, sessionKey,
      state: 'final',
      message: { content: [{ type: 'text', text: responseText }] },
    });

    log.info(`Run ${runId} completed successfully`);
  });
}

// ── Chat Abort Handler ──────────────────────────────────

function handleChatAbort(state, id, params) {
  const runId = params.runId;
  const sessionKey = params.sessionKey || 'default';

  if (runId && state.runningProcesses.has(runId)) {
    const child = state.runningProcesses.get(runId);
    try { if (process.platform === "win32" && child.pid) { require("child_process").execSync(`taskkill /pid ${child.pid} /t /f`, { stdio: "ignore" }); } else { child.kill(); } } catch { /* process may already be dead */ }
    state.runningProcesses.delete(runId);
    log.info(`Aborted run ${runId}`);
  }

  sendResponse(state, id, true, {});
  if (runId) {
    // BROADCAST abort to all clients so Agent Town UI reacts
    broadcastEvent('chat', { runId, sessionKey, state: 'aborted' });
  }
}

// ── Dispatch to Worker (for sub-agent tasks) ────────────

function dispatchToWorker(seatId, task, hermesConfig) {
  return new Promise((resolve) => {
    const seat = workerRoster.find((w) => w.seatId === seatId);

    if (connectedClients.size === 0) {
      resolve({ result: '', error: 'No active WebSocket clients' });
      return;
    }
    if (!seat) {
      resolve({ result: '', error: `Unknown seatId: ${seatId}` });
      return;
    }

    const runId = `hermes_sub_${Date.now()}_${++runCounter}`;
    const sessionKey = `subagent:dispatch:${seatId}:${runId}`;

    const prefix = buildPersonalityPrefix({ seatLabel: seat.label, seatRole: seat.roleTitle });
    const message = prefix + task;

    // Lifecycle start — BROADCAST
    broadcastEvent('agent', {
      runId, sessionKey,
      stream: 'lifecycle',
      data: { phase: 'start', label: `${seat.label}: ${task.slice(0, 40)}`, seatId },
    });

    const { pythonPath, projectPath } = hermesConfig;
    if (!pythonPath || !projectPath) {
      const errMsg = 'Hermes Agent not configured for dispatch';
      log.error(errMsg);
      broadcastEvent('agent', { runId, sessionKey, stream: 'lifecycle', data: { phase: 'error', error: errMsg } });
      resolve({ result: '', error: errMsg });
      return;
    }

    const args = ['-m', 'hermes_cli.main', '-z', message];
    log.info(`Dispatching to ${seat.label} (${seatId}), run ${runId}`);

    let child;
    try {
      child = spawn(pythonPath, args, {
        cwd: projectPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...getAgentTownEnv(hermesConfig.userDataPath),
          HERMES_NONINTERACTIVE: '1',
          HERMES_QUIET: '1',
          PYTHONIOENCODING: 'utf-8',
          // Run Chrome in headed (visible) mode so user can see it live
          AGENT_BROWSER_HEADED: '1',
          // Enable console logs streaming to stderr
          HERMES_CONSOLE_LOGGING: '1',
          // Pass the running voice assistant browser DevTools URL (dynamic port)
          BROWSER_CDP_URL: getCdpUrl(),
          // Akki bridge URL — Python uses this to ask Electron to lazy-launch
          // the bundled Chromium when the CDP port is not yet alive.
          ...(actualBridgePort
            ? { AKKI_BRIDGE_URL: `http://127.0.0.1:${actualBridgePort}`, STONIC_BRIDGE_URL: `http://127.0.0.1:${actualBridgePort}` }
            : {}),
          // Pass dynamic Akki Data path
          ...(hermesConfig.akkiDataDir
            ? { AKKI_DATA_DIR: hermesConfig.akkiDataDir, STONIC_DATA_DIR: hermesConfig.akkiDataDir }
            : {}),
          // Pass bundled Chromium path so Python browser tools can find it
          ...(hermesConfig.bundledChromiumPath
            ? { AGENT_BROWSER_EXECUTABLE_PATH: hermesConfig.bundledChromiumPath }
            : {}),
          // Pass wrapper path so Python runs agent-browser via Electron's Node.js
          ...(hermesConfig.agentBrowserWrapperPath
            ? { AGENT_BROWSER_CMD_OVERRIDE: hermesConfig.agentBrowserWrapperPath }
            : {}),
        },
      });
    } catch (err) {
      const errMsg = `Failed to spawn Hermes for dispatch: ${err.message}`;
      log.error(errMsg);
      broadcastEvent('agent', { runId, sessionKey, stream: 'lifecycle', data: { phase: 'error', error: errMsg } });
      resolve({ result: '', error: errMsg });
      return;
    }

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf-8'); });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf-8');
      stderr += text;
      if (text.trim().length > 0) {
        text.split('\n').forEach(line => {
          if (line.trim()) {
            console.error(`[Hermes Python stderr] ${line.trim()}`);
          }
        });
      }
    });

    child.on('error', (err) => {
      log.error(`dispatch process error for run ${runId}:`, err.message);
      broadcastEvent('agent', { runId, sessionKey, stream: 'lifecycle', data: { phase: 'error', error: err.message } });
      resolve({ result: '', error: err.message });
    });

    child.on('close', (code) => {
      if (code !== 0) {
        const errMsg = stderr.trim() || `Hermes exited with code ${code}`;
        log.error(`dispatch failed for run ${runId}:`, errMsg);
        broadcastEvent('agent', { runId, sessionKey, stream: 'lifecycle', data: { phase: 'error', error: errMsg } });
        resolve({ result: '', error: errMsg });
        return;
      }

      const responseText = stdout.trim() || '(No response)';

      broadcastEvent('agent', { runId, sessionKey, stream: 'lifecycle', data: { phase: 'end' } });
      broadcastEvent('chat', {
        runId, sessionKey,
        state: 'final',
        message: { content: [{ type: 'text', text: responseText }] },
      });

      log.info(`Dispatch to ${seat.label} completed (run ${runId})`);
      resolve({ result: responseText });
    });
  });
}

// ── Client Message Router ───────────────────────────────

function handleMessage(state, raw, hermesConfig) {
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    log.warn('Received non-JSON message, ignoring');
    return;
  }

  if (frame.type !== 'req') {
    log.debug('Ignoring non-request frame:', frame.type);
    return;
  }

  const { id, method, params } = frame;
  if (!id || !method) {
    log.warn('Request frame missing id or method');
    return;
  }

  log.debug(`Request: ${method} (id=${id})`);

  switch (method) {
    case 'connect':
      sendResponse(state, id, true, {
        type: 'hello-ok',
        scopes: ['operator.read', 'operator.write'],
      });
      log.info('Client authenticated (hello-ok)');
      break;

    case 'chat.send':
      handleChatSend(state, id, params || {}, hermesConfig);
      break;

    case 'chat.abort':
      handleChatAbort(state, id, params || {});
      break;

    case 'sessions.list':
      sendResponse(state, id, true, { sessions: [] });
      break;

    case 'sessions.preview':
      sendResponse(state, id, true, { previews: [] });
      break;

    case 'models.list':
      sendResponse(state, id, true, {
        models: [{ id: 'hermes-default', provider: 'hermes', contextWindow: 128000 }],
      });
      break;

    default:
      log.warn(`Unknown method: ${method}`);
      sendResponse(state, id, false, {
        code: 'unknown_method',
        message: `Unknown method: ${method}`,
      });
      break;
  }
}

// ── Cleanup ─────────────────────────────────────────────

function cleanupClient(state) {
  connectedClients.delete(state);
  for (const [runId, child] of state.runningProcesses) {
    log.info(`Killing orphaned process for run ${runId}`);
    try { if (process.platform === "win32" && child.pid) { require("child_process").execSync(`taskkill /pid ${child.pid} /t /f`, { stdio: "ignore" }); } else { child.kill(); } } catch { /* already dead */ }
  }
  state.runningProcesses.clear();
}

// ── Tool Result Callback ────────────────────────────────

/**
 * Register a callback invoked every time a Hermes tool completes.
 * Main.js uses this to open the Information Panel when
 * huggingface_generate_image finishes.
 *
 * @param {(toolName: string, output: string) => void} cb
 */
function setToolResultCallback(cb) {
  _toolResultCallback = typeof cb === 'function' ? cb : null;
}

// ── Public API ──────────────────────────────────────────

/**
 * Start the Hermes Bridge WebSocket server.
 *
 * @param {import('electron').App} electronApp - Electron app instance
 * @param {number} port - Port to listen on (default: 18789)
 * @returns {{ server: http.Server, stop: () => void }}
 */
function startHermesBridge(electronApp, port = 18789) {
  // Resolve Hermes paths once at startup
  const projectPath = getHermesProjectPath(electronApp);
  const pythonPath = projectPath ? getHermesPythonPath(projectPath) : null;
  const userDataPath = (electronApp && typeof electronApp.getPath === 'function')
    ? electronApp.getPath('userData')
    : null;

  // Sync the user's current provider key into ~/.hermes/.env at boot, before
  // any chat turn (Agent Town or Expert), so a stale key in that file can't
  // override the fresh key via dotenv override=True. The Agent Town Next.js
  // bridge reads the same global file, so this one write fixes both bridges.
  syncHermesDotEnvKey(userDataPath);

  const bundledChromiumPath = findBundledChromium();
  if (bundledChromiumPath) {
    log.info(`Bundled Chromium: ${bundledChromiumPath}`);
  }

  // Create a .cmd wrapper so Python can run agent-browser via Electron's Node.js.
  // This works on fresh PCs without Node.js installed.
  const agentBrowserWrapperPath = setupAgentBrowserWrapper(projectPath, userDataPath);
  if (agentBrowserWrapperPath) {
    log.info(`Agent Browser wrapper: ${agentBrowserWrapperPath}`);
  }

  const akkiDataDir = (electronApp && typeof electronApp.getPath === 'function')
    ? path.join(electronApp.getPath('documents'), 'Akki Data')
    : null;
  // Legacy Stonic Data directory fallback
  const legacyStonicDataDir = (electronApp && typeof electronApp.getPath === 'function')
    ? path.join(electronApp.getPath('documents'), 'Stonic Data')
    : null;
  // Use Akki Data if it exists, otherwise fall back to Stonic Data
  const resolvedDataDir = (akkiDataDir && fs.existsSync(akkiDataDir))
    ? akkiDataDir
    : legacyStonicDataDir;

  const hermesConfig = { pythonPath, projectPath, userDataPath, bundledChromiumPath, agentBrowserWrapperPath, akkiDataDir: resolvedDataDir, stonicDataDir: legacyStonicDataDir };

  if (projectPath && pythonPath) {
    log.info(`Hermes project: ${projectPath}`);
    log.info(`Hermes Python: ${pythonPath}`);
  } else {
    log.warn('Hermes Agent not found. Agent Town will connect but tasks will fail.');
    log.warn('Set HERMES_PROJECT_PATH environment variable or place hermes-agent-main as sibling folder.');
    if (projectPath && !pythonPath) {
      log.warn(`Project found at ${projectPath} but .venv is missing. Run setup-hermes.sh first.`);
    }
  }

  // Create HTTP server (required for WebSocket upgrade)
  httpServer = http.createServer((req, res) => {
    // Health check endpoint
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        hermes: !!pythonPath,
        clients: connectedClients.size,
      }));
      return;
    }

    // Ensure-browser endpoint — Hermes Python calls this when it needs the
    // bundled Chromium (CDP port 9222) but the browser isn't running yet.
    // Lazy-launches the same Voice Assistant Chromium via BrowserManagerService.
    // Idempotent: if already running, returns immediately.
    if (req.url === '/api/internal/ensure-browser' && req.method === 'POST') {
      let browserService;
      try {
        ({ browserService } = require('./browser-manager'));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `browser-manager unavailable: ${err.message}` }));
        return;
      }
      log.info('[AKKI_DBG] ensure-browser endpoint HIT — calling browserService.launch()');
      Promise.resolve()
        .then(() => browserService.launch())
        .then(() => {
          log.info('[AKKI_DBG] ensure-browser browserService.launch() RESOLVED — Chromium ready');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        })
        .catch((err) => {
          log.error('[AKKI_DBG] ensure-browser FAILED:', err && err.message, err && err.stack);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err && err.message }));
        });
      return;
    }

    // Seat sync endpoint (Agent Town UI sends seat config changes here)
    if (req.url === '/api/internal/seat-sync' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const { seats } = JSON.parse(body);
          if (Array.isArray(seats)) {
            workerRoster = seats
              .filter((s) => s.assigned)
              .map((s) => ({ seatId: s.seatId, label: s.label, roleTitle: s.roleTitle }));
            log.debug(`Worker roster updated: ${workerRoster.length} workers`);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  // WebSocket server (noServer mode — we handle upgrades manually)
  wsServer = new WebSocket.Server({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    // Accept upgrade on any path (Agent Town connects to /api/gateway or /)
    wsServer.handleUpgrade(req, socket, head, (ws) => {
      const state = {
        ws,
        seq: 0,
        runningProcesses: new Map(),
      };

      connectedClients.add(state);
      log.info(`Client connected (total: ${connectedClients.size})`);

      // Send connect challenge immediately
      sendEvent(state, 'connect.challenge', {});

      ws.on('message', (data) => {
        handleMessage(state, data.toString(), hermesConfig);
      });

      ws.on('close', () => {
        log.info(`Client disconnected (remaining: ${connectedClients.size - 1})`);
        cleanupClient(state);
      });

      ws.on('error', (err) => {
        log.error('Client WS error:', err.message);
        cleanupClient(state);
      });
    });
  });

  wsServer.on('error', (err) => {
    log.error('WebSocketServer error:', err.message);
  });

  // Start listening
  httpServer.listen(port, '127.0.0.1', () => {
    const bound = httpServer.address();
    actualBridgePort = (bound && bound.port) || port;
    log.info(`WebSocket server started on ws://127.0.0.1:${actualBridgePort}`);
    log.info('Agent Town frontend can now connect.');
  });

  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log.warn(`Port ${port} is already in use. Trying port ${port + 1}...`);
      httpServer.listen(port + 1, '127.0.0.1', () => {
        const bound = httpServer.address();
        actualBridgePort = (bound && bound.port) || (port + 1);
        log.info(`WebSocket server started on ws://127.0.0.1:${actualBridgePort}`);
      });
    } else {
      log.error('HTTP server error:', err.message);
    }
  });

  return {
    server: httpServer,
    stop: () => stopHermesBridge(),
  };
}

/**
 * Stop the Hermes Bridge server and cleanup all resources.
 */
function stopHermesBridge() {
  log.info('Shutting down...');

  // Kill all running Hermes processes for all clients
  for (const client of connectedClients) {
    cleanupClient(client);
  }
  connectedClients.clear();

  // Close WebSocket server
  if (wsServer) {
    wsServer.close();
    wsServer = null;
  }

  // Close HTTP server
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }

  log.info('Shutdown complete.');
}

module.exports = {
  startHermesBridge,
  stopHermesBridge,
  dispatchToWorker,
  getHermesProjectPath,
  getHermesPythonPath,
  setToolResultCallback,
  getActualBridgePort: () => actualBridgePort,
};
