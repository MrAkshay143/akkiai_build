/**
 * Agent Town Server Manager
 *
 * Starts the Agent Town Next.js server as a child process from Electron.
 * The server runs on localhost:3000 and provides the full Agent Town UI
 * which is then embedded in Akki Ai via a <webview> tag.
 *
 * The server includes its own Hermes Bridge that connects to the Hermes
 * Python CLI for agent task execution.
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { app } = require('electron');
// Lazy-load so we don't create a circular dep — hermes-bridge is loaded first
function _getActualBridgePort() {
  try { return require('./hermes-bridge').getActualBridgePort(); } catch { return null; }
}

// ── File-based logging for production debugging ──────────────────
const LOG_DIR = app ? path.join(app.getPath('userData'), 'logs') : __dirname;
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'agent-town-server.log');

function writeLog(level, ...args) {
  const timestamp = new Date().toISOString();
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  const line = `[${timestamp}] [${level}] ${msg}\n`;
  // Console log (visible in dev mode)
  if (level === 'ERROR') console.error('[Agent Town Server]', ...args);
  else console.log('[Agent Town Server]', ...args);
  // File log (always available — critical for production debugging)
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* ignore */ }
}

const PREFIX = '[Agent Town Server]';
const log = {
  info: (...args) => writeLog('INFO', ...args),
  warn: (...args) => writeLog('WARN', ...args),
  error: (...args) => writeLog('ERROR', ...args),
};

let serverProcess = null;
let isReady = false;
let serverPort = 3000;

/**
 * Kill any process currently holding a TCP port.
 * Prevents "lockfile access denied" when a previous session left a zombie server.
 */
async function killProcessOnPort(port) {
  if (process.platform !== 'win32') {
    // macOS/Linux: lsof lists the PIDs bound to the port
    try {
      const { stdout } = await new Promise((resolve, reject) => {
        exec(`lsof -ti tcp:${port}`, { encoding: 'utf8', timeout: 5000 }, (err, stdout, stderr) => {
          if (err) return reject(err);
          resolve({ stdout });
        });
      });
      for (const pid of stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
        if (pid === String(process.pid)) continue;
        try {
          process.kill(Number(pid), 'SIGKILL');
          log.info(`Killed stale process PID ${pid} on port ${port}`);
        } catch { /* already dead */ }
      }
    } catch { /* port was not in use — fine */ }
    return;
  }
  try {
    const { stdout } = await new Promise((resolve, reject) => {
      exec(`netstat -ano | findstr :${port}`, { encoding: 'utf8', timeout: 5000 }, (err, stdout, stderr) => {
        if (err) return reject(err);
        resolve({ stdout });
      });
    });
    const pids = new Set();
    for (const line of stdout.split('\n')) {
      const parts = line.trim().split(/\s+/);
      // netstat line: Proto  Local  Foreign  State  PID
      const pid = parts[parts.length - 1];
      if (pid && /^\d+$/.test(pid) && pid !== '0') pids.add(pid);
    }
    for (const pid of pids) {
      // Safe mode: skip killing processes from other apps
      log.info(`Port ${port} in use by PID ${pid} — skipping kill (safe mode)`);
    }
  } catch { /* port was not in use — fine */ }
}

/**
 * Remove all known Next.js lockfile paths so the new process can start cleanly.
 */
function clearNextLockFiles(agentTownPath) {
  const lockPaths = [
    path.join(agentTownPath, '.next', 'dev', 'lock'),
    path.join(agentTownPath, '.next', 'lockfile'),
    path.join(agentTownPath, '.next', 'cache', 'lockfile'),
    path.join(agentTownPath, '.next', 'trace'),
  ];
  for (const p of lockPaths) {
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
        log.info(`Removed stale lock: ${path.relative(agentTownPath, p)}`);
      } catch (e) {
        log.warn(`Could not remove lock ${p}: ${e.message}`);
      }
    }
  }
}

/**
 * Resolve the Agent Town project directory.
 */
function getAgentTownPath() {
  // 1. Env var
  const envPath = process.env.AGENT_TOWN_PATH;
  if (envPath && fs.existsSync(envPath)) return path.resolve(envPath);

  // 2. Production: bundled in extraResources
  if (process.resourcesPath) {
    const resourcePath = path.join(process.resourcesPath, 'agent-town');
    if (fs.existsSync(path.join(resourcePath, 'package.json'))) return resourcePath;
  }

  // 3. Development: sibling folder
  // Akki:       .../Akki Ai - AGI/Source code latest for developers/
  // Agent Town:  .../Akki Ai - AGI/agent-town-main/agent-town-main/
  const devPath = path.resolve(__dirname, '..', '..', '..', 'agent-town-main', 'agent-town-main');
  if (fs.existsSync(path.join(devPath, 'package.json'))) return devPath;

  // 4. Development: Akki Ai layout — agent-town is inside source-code
  const akkiDevPath = path.resolve(__dirname, '..', '..', 'agent-town');
  if (fs.existsSync(path.join(akkiDevPath, 'package.json'))) return akkiDevPath;

  return null;
}

/**
 * Resolve the Hermes project path for Agent Town's bridge.
 */
function getHermesPath() {
  const envPath = process.env.HERMES_PROJECT_PATH;
  if (envPath && fs.existsSync(envPath)) return path.resolve(envPath);

  const devPath = path.resolve(__dirname, '..', '..', '..', 'hermes-agent-main');
  if (fs.existsSync(devPath)) return devPath;

  // Akki Ai layout — hermes-agent is inside source-code
  const akkiDevPath = path.resolve(__dirname, '..', '..', 'hermes-agent');
  if (fs.existsSync(akkiDevPath)) return akkiDevPath;

  return null;
}

/**
 * Read the provider API key from agent_town_config.json (userData) and return
 * the env vars Hermes needs.
 *
 * WHY THIS EXISTS:
 * The Agent Town server's own Hermes bridge (lib/hermes-bridge.ts) spawns
 * Hermes with `env: { ...process.env }` and does NOT inject the provider key.
 * On Windows this happens to work because GOOGLE_API_KEY is usually set as a
 * persistent system environment variable, so it is already in process.env.
 * On macOS the key is only stored in agent_town_config.json — the shell that
 * launches Electron has no GOOGLE_API_KEY — so the key never reaches Hermes,
 * and Hermes fails with "Provider 'gemini' is set in config.yaml but no API
 * key was found." (It also prunes the stale env-seeded entry from auth.json,
 * so the previously-saved key cannot rescue it.)
 *
 * By injecting the key here, into the Next.js server's env, it propagates
 * through `...process.env` in lib/hermes-bridge.ts to the Hermes subprocess
 * on every platform. This mirrors getAgentTownEnv() in hermes-bridge.js.
 */
/**
 * Mirror the user's current provider key into ~/.hermes/.env so a stale key
 * there can't override the spawn-env key (Hermes loads that file with dotenv
 * override=True). See the long-form rationale in hermes-bridge.js
 * `syncHermesDotEnvKey`. Idempotent; preserves all other .env lines. The
 * Agent Town Next.js bridge reads the same global file as the main bridge.
 */
function syncHermesDotEnvKey() {
  try {
    if (!app || typeof app.getPath !== 'function') return;
    const os = require('os');
    const configPath = path.join(app.getPath('userData'), 'agent_town_config.json');
    if (!fs.existsSync(configPath)) return;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    const updates = {};
    if (config.provider === 'openai-codex') return;
    if (config.provider === 'openrouter') {
      const k = config.openRouterApiKey || config.apiKey;
      if (k) updates.OPENROUTER_API_KEY = k;
    } else {
      const k = config.geminiApiKey || config.apiKey;
      if (k) { updates.GOOGLE_API_KEY = k; updates.GEMINI_API_KEY = k; }
    }
    if (Object.keys(updates).length === 0) return;

    const hermesHome = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
    const envPath = path.join(hermesHome, '.env');
    let lines = [];
    if (fs.existsSync(envPath)) lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);

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
    log.info(`Synced current ${config.provider} API key into ${envPath} (dotenv override=True would otherwise use a stale key)`);
  } catch (err) {
    log.warn(`syncHermesDotEnvKey failed: ${err.message}`);
  }
}

function getProviderApiKeyEnv() {
  const env = {};
  try {
    if (!app || typeof app.getPath !== 'function') return env;
    // Keep ~/.hermes/.env in sync first so the injected key actually wins.
    syncHermesDotEnvKey();
    const configPath = path.join(app.getPath('userData'), 'agent_town_config.json');
    if (!fs.existsSync(configPath)) return env;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    if (config.provider) env.HERMES_INFERENCE_PROVIDER = config.provider;

    // Codex uses ChatGPT OAuth, no API key to inject.
    if (config.provider === 'openai-codex') return env;

    const activeKey = config.provider === 'openrouter'
      ? (config.openRouterApiKey || config.apiKey)
      : (config.geminiApiKey || config.apiKey);

    if (!activeKey) return env;
    if (config.provider === 'openrouter') {
      env.OPENROUTER_API_KEY = activeKey;
    } else {
      // Gemini — set both env var names Hermes recognises for compatibility.
      env.GOOGLE_API_KEY = activeKey;
      env.GEMINI_API_KEY = activeKey;
    }
  } catch (err) {
    log.warn(`Could not read provider API key from agent_town_config.json: ${err.message}`);
  }
  return env;
}

/**
 * Check if the server is ready by pinging it.
 */
function waitForReady(port, maxAttempts = 30, intervalMs = 1000) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    let settled = false;

    const check = () => {
      if (settled) return;
      attempts++;

      const req = http.get(`http://127.0.0.1:${port}`, (res) => {
        if (settled) return;
        settled = true;
        isReady = true;
        res.resume(); // consume the response body so the socket closes cleanly
        resolve(port);
      });

      // Guard flag so req.destroy() in the timeout handler doesn't also
      // fire the error handler and schedule a second redundant retry.
      let reqHandled = false;

      req.on('error', () => {
        if (reqHandled || settled) return;
        reqHandled = true;
        if (attempts >= maxAttempts) {
          settled = true;
          reject(new Error(`Server not ready after ${maxAttempts} attempts`));
        } else {
          setTimeout(check, intervalMs);
        }
      });

      req.setTimeout(2000, () => {
        if (reqHandled || settled) return;
        reqHandled = true;
        req.destroy(); // triggers error event, but reqHandled guard stops double-fire
        if (attempts >= maxAttempts) {
          settled = true;
          reject(new Error(`Server timeout after ${maxAttempts} attempts`));
        } else {
          setTimeout(check, intervalMs);
        }
      });
    };

    check();
  });
}

/**
 * Start the Agent Town server.
 * @param {number} port - Port to run on (default 3000)
 * @returns {Promise<number>} - The port the server is running on
 */
async function startAgentTownServer(port = 3000) {
  serverPort = port;

  const agentTownPath = getAgentTownPath();
  if (!agentTownPath) {
    log.error('Agent Town project not found!');
    log.error('Expected at: ../agent-town-main/agent-town-main/');
    return null;
  }

  // ── Detailed startup diagnostics ──────────────────────────────
  log.info('========================================');
  log.info('Agent Town Server Starting...');
  log.info(`Log file: ${LOG_FILE}`);
  log.info(`agentTownPath: ${agentTownPath}`);
  log.info(`process.execPath: ${process.execPath}`);
  log.info(`process.resourcesPath: ${process.resourcesPath || 'N/A'}`);

  // List key files to verify they exist
  const keyFiles = ['server.js', 'server-bundle.cjs', 'package.json', '.next/required-server-files.json', '.next/BUILD_ID'];
  for (const f of keyFiles) {
    const fullPath = path.join(agentTownPath, f);
    log.info(`  ${f}: ${fs.existsSync(fullPath) ? '✅ EXISTS' : '❌ MISSING'}`);
  }

  // Check node_modules
  const nmPath = path.join(agentTownPath, 'node_modules');
  if (fs.existsSync(nmPath)) {
    const nmDirs = fs.readdirSync(nmPath).filter(d => !d.startsWith('.'));
    log.info(`  node_modules: ✅ ${nmDirs.length} packages (${nmDirs.slice(0, 10).join(', ')}${nmDirs.length > 10 ? '...' : ''})`);
  } else {
    log.info('  node_modules: ❌ MISSING');
  }

  // Detect production mode: standalone server.js + .next build output
  const isProduction = fs.existsSync(path.join(agentTownPath, 'server.js')) &&
    fs.existsSync(path.join(agentTownPath, '.next', 'required-server-files.json')) &&
    fs.existsSync(path.join(agentTownPath, 'node_modules', 'next'));

  log.info(`Mode: ${isProduction ? '🏭 PRODUCTION' : '🔧 DEVELOPMENT'}`);
  log.info('========================================');

  // Resolve Hermes path
  const hermesPath = getHermesPath();

  // Environment variables
  const env = {
    ...process.env,
    PORT: String(port),
    NODE_ENV: isProduction ? 'production' : 'development',
    AGENT_PROVIDER: 'hermes',
    NEXT_PUBLIC_AGENT_PROVIDER: 'hermes',
    // Tell the WS proxy interceptor where Electron's Hermes Bridge is
    GATEWAY_URL: `ws://127.0.0.1:${_getActualBridgePort() || 18789}/`,
    // Inject the provider API key (Gemini / OpenRouter) read from
    // agent_town_config.json so it propagates to the Hermes subprocess that
    // Agent Town's own bridge (lib/hermes-bridge.ts) spawns. Without this,
    // macOS (where the key is not a system env var) fails with "no API key
    // was found". See getProviderApiKeyEnv() for the full rationale.
    ...getProviderApiKeyEnv(),
  };

  if (hermesPath) {
    env.HERMES_PROJECT_PATH = hermesPath;
    log.info(`Hermes path: ${hermesPath}`);
  }

  // Resolve the dynamic CDP port BEFORE spawning, so the Agent Town bridge
  // (lib/hermes-bridge.ts) spawns Hermes with the correct BROWSER_CDP_URL.
  // Port 9222 may be occupied by foreign apps (e.g. Adobe Premiere Pro).
  try {
    const { resolveCdpPort } = require('./browser-manager');
    const cdpPort = await resolveCdpPort();
    env.AKKI_CDP_PORT = String(cdpPort);
    log.info(`CDP port for Hermes spawns: ${cdpPort}`);
  } catch (err) {
    log.warn(`Could not resolve dynamic CDP port (${err.message}) — Agent Town will default to 9222.`);
  }

  log.info(`Port: ${port}`);

  // Kill any zombie server holding port 3000 from a previous session
  await killProcessOnPort(port).catch(() => {});

  // Remove all stale Next.js lock files so the new process can compile
  clearNextLockFiles(agentTownPath);

  // Brief pause to let the killed process release file handles
  await new Promise((resolve) => setTimeout(resolve, 600));

  try {
    if (isProduction) {
      // PRODUCTION: Use Next.js standalone server.js (CommonJS — works with Electron's Node)
      // The standalone server.js is auto-generated by `next build` with output: "standalone"
      // Hermes Bridge WS proxy runs separately on port 18789, so Agent Town just serves HTTP.
      const serverScript = path.join(agentTownPath, 'server.js');

      if (!fs.existsSync(serverScript)) {
        log.error('Production server.js not found in agent-town dist!');
        return null;
      }

      // Use Electron's own Node.js runtime (process.execPath points to electron.exe
      // which can also run Node.js scripts via child_process.fork/spawn)
      log.info(`Using standalone server.js`);
      serverProcess = spawn(process.execPath, [serverScript], {
        cwd: agentTownPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...env,
          // Electron's execPath is the electron binary — tell Node to act as node
          ELECTRON_RUN_AS_NODE: '1',
        },
        windowsHide: true,
      });
    } else {
      // DEVELOPMENT: Use tsx server.ts
      const tsxCmd = path.join(agentTownPath, 'node_modules', '.bin', 'tsx.cmd');
      const tsxUnix = path.join(agentTownPath, 'node_modules', '.bin', 'tsx');
      const tsxPath = process.platform === 'win32' ? tsxCmd : tsxUnix;

      if (!fs.existsSync(tsxPath)) {
        log.error(`tsx binary not found at ${tsxPath}`);
        log.error('Run "pnpm install" in agent-town-main directory first.');
        return null;
      }

      log.info(`Using tsx: ${tsxPath}`);

      if (process.platform === 'win32') {
        serverProcess = spawn('cmd.exe', ['/c', `"${tsxPath}" server.ts`], {
          cwd: agentTownPath,
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
          windowsHide: true,
          windowsVerbatimArguments: true,
        });
      } else {
        serverProcess = spawn(tsxPath, ['server.ts'], {
          cwd: agentTownPath,
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
          windowsHide: true,
        });
      }
    }
  } catch (err) {
    log.error('Failed to spawn server:', err.message);
    return null;
  }

  // Stream stdout — log to file for production debugging
  serverProcess.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf-8').trim();
    if (text) {
      log.info(`[stdout] ${text}`);
    }
  });

  // Stream stderr — critical for catching Next.js/Node errors
  serverProcess.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf-8').trim();
    if (text) {
      log.error(`[stderr] ${text}`);
    }
  });

  serverProcess.on('error', (err) => {
    log.error(`❌ Server process SPAWN ERROR: ${err.message}`);
    log.error(`   code: ${err.code}, errno: ${err.errno}`);
    serverProcess = null;
    isReady = false;
  });

  serverProcess.on('close', (code, signal) => {
    log.info(`Server process exited — code: ${code}, signal: ${signal}`);
    if (code !== 0 && code !== null) {
      log.error(`❌ Agent Town server CRASHED with exit code ${code}`);
    }
    serverProcess = null;
    isReady = false;
  });

  // Wait for server to be ready (90 attempts × 1s = 90s max, handles slow cold-starts)
  try {
    const readyPort = await waitForReady(port, 90, 1000);
    log.info(`✅ Server ready on http://localhost:${readyPort}`);

    // Diagnostics: confirm a real /_next/static asset also serves (not just /)
    try {
      const staticDir = path.join(agentTownPath, '.next', 'static');
      let asset = null;
      const stack = [staticDir];
      while (stack.length && !asset) {
        const dir = stack.pop();
        if (!fs.existsSync(dir)) break;
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const entry = path.join(dir, ent.name);
          if (ent.isDirectory()) stack.push(entry);
          else { asset = entry; break; }
        }
      }
      if (asset) {
        const rel = asset.substring(asset.indexOf('static') + 'static'.length).split(path.sep).filter(Boolean).join('/');
        const url = `http://127.0.0.1:${readyPort}/_next/static/${rel}`;
        const status = await new Promise((resolve) => {
          const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode); });
          req.on('error', () => resolve(-1));
          req.setTimeout(3000, () => { req.destroy(); resolve(-2); });
        });
        log.info(`Agent Town static asset check: HTTP ${status} for /_next/static/${rel}`);
      } else {
        log.info('Agent Town static asset check: no asset under .next/static');
      }
    } catch (err) {
      log.warn(`Agent Town static asset check failed: ${err.message}`);
    }

    return readyPort;
  } catch (err) {
    log.error('Server failed to start:', err.message);
    stopAgentTownServer();
    return null;
  }
}

/**
 * Stop the Agent Town server.
 */
function stopAgentTownServer() {
  if (!serverProcess) return;

  log.info('Stopping server...');
  isReady = false;

  try {
    // On Windows, killing a shell-spawned process requires killing the tree
    if (process.platform === 'win32') {
      const pid = serverProcess.pid;
      if (pid) {
        spawn('taskkill', ['/pid', String(pid), '/f', '/t'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      }
    } else {
      serverProcess.kill('SIGTERM');
    }
  } catch (err) {
    log.warn('Error stopping server:', err.message);
  }

  serverProcess = null;
  log.info('Server stopped.');
}

/**
 * Get the server URL if ready.
 */
function getServerUrl() {
  return isReady ? `http://localhost:${serverPort}` : null;
}

/**
 * Check if server is currently running and ready.
 */
function isServerReady() {
  return isReady && serverProcess !== null;
}

module.exports = {
  startAgentTownServer,
  stopAgentTownServer,
  getServerUrl,
  isServerReady,
};
