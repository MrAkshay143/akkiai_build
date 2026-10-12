if (global.diagLog) global.diagLog("main_source.js entered");
const {
  app,
  BrowserWindow,
  ipcMain,
  powerSaveBlocker,
  nativeImage,
  desktopCapturer,
} = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { exec } = require("child_process");
const { dialog, shell } = require("electron");
const mime = { lookup: (ext) => "application/octet-stream" };
const si = require("systeminformation");
const screenshot = require("screenshot-desktop");
const axios = require("axios");
const { clipboard, Notification } = require("electron");
const http = require("http");
const WebSocket = require("ws");
require("dotenv").config();
const crypto = require("crypto");
const bootstrapHelpers = require("./main/bootstrap/akki-bootstrap");
const {
  startHermesBridge,
  stopHermesBridge,
  getHermesProjectPath,
  getHermesPythonPath,
  setToolResultCallback,
} = require("./services/hermes-bridge");
const {
  startAgentTownServer,
  stopAgentTownServer,
} = require("./services/agent-town-server");
const firebaseService = require("./services/firebase-service");
const licenseManager = require("./license/license-manager");
const { createPaths } = require("./main/shared/paths");
const toolsConfigManager = require("./services/tools-config-manager");
if (global.diagLog) global.diagLog("main_source.js imports completed");

let paths = null;
const userDataPath = () => app.getPath("userData");

// ─── APP DATA MIGRATION (Legacy → Akki) ──────────────────────────────────
// One-time selective migration of user data from old stonic_dsktp AppData to
// new akki_ai AppData. Runs only once on first Akki launch.
function migrateAppData() {
  try {
    const newUserData = app.getPath("userData");
    const oldUserData = path.join(path.dirname(newUserData), "stonic_dsktp");

    // Quick checks first — these are fast existsSync calls
    if (!fs.existsSync(oldUserData)) {
      console.log("[AppData] No legacy AppData found — skipping migration.");
      return;
    }
    const marker = path.join(newUserData, ".appdata-migrated");
    if (fs.existsSync(newUserData)) {
      if (fs.existsSync(marker)) {
        console.log("[AppData] Migration already completed — skipping.");
        return;
      }
      const newEntries = fs
        .readdirSync(newUserData)
        .filter((e) => e !== ".appdata-migrated");
      if (newEntries.length > 0) {
        console.log(
          "[AppData] New AppData already has content — skipping migration.",
        );
        return;
      }
    }

    // Defer heavy copy to after startup so UI is not blocked
    setImmediate(() => {
      try {
        if (!fs.existsSync(newUserData)) {
          fs.mkdirSync(newUserData, { recursive: true });
        }

        const oldEntries = fs.readdirSync(oldUserData);
        const skipDirs = new Set([
          "Cache",
          "Code Cache",
          "GPUCache",
          "DawnCache",
          "log",
          "logs",
        ]);
        const skipFiles = new Set([
          "LOCK",
          "lockfile",
          "singletonlock",
          "chrome_debug.log",
        ]);

        let copied = 0;
        let skipped = 0;

        for (const entry of oldEntries) {
          const oldPath = path.join(oldUserData, entry);
          const newPath = path.join(newUserData, entry);

          if (skipDirs.has(entry) || skipFiles.has(entry)) {
            skipped++;
            continue;
          }

          try {
            const stat = fs.statSync(oldPath);
            if (stat.isDirectory()) {
              const childFiles = fs.readdirSync(oldPath);
              if (!fs.existsSync(newPath)) {
                fs.mkdirSync(newPath, { recursive: true });
              }
              for (const child of childFiles) {
                const childOld = path.join(oldPath, child);
                const childNew = path.join(newPath, child);
                const childStat = fs.statSync(childOld);
                if (childStat.isDirectory()) {
                  fs.cpSync(childOld, childNew, {
                    recursive: true,
                    force: false,
                  });
                } else {
                  fs.copyFileSync(childOld, childNew);
                }
                copied++;
              }
            } else {
              fs.copyFileSync(oldPath, newPath);
              copied++;
            }
          } catch (err) {
            console.warn(`[AppData] Skipped "${entry}" — ${err.message}`);
            skipped++;
          }
        }

        fs.writeFileSync(
          marker,
          JSON.stringify(
            {
              migratedAt: Date.now(),
              oldData: true,
              skippedDirs: [...skipDirs],
              skippedFiles: [...skipFiles],
            },
            null,
            2,
          ),
          "utf8",
        );

        console.log(
          `[AppData] Migration complete: ${copied} items copied, ${skipped} skipped.`,
        );
      } catch (err) {
        console.warn(
          "[AppData] Migration encountered an error (non-fatal):",
          err.message,
        );
      }
    });
  } catch (err) {
    console.warn(
      "[AppData] Migration encountered an error (non-fatal):",
      err.message,
    );
  }
}

function setupFileLogging() {
  try {
    const documentsPath = app.getPath("documents");
    const logDir = path.join(documentsPath, "Akki Data");
    if (!fs.existsSync(logDir)) {
      const legacyLogDir = path.join(documentsPath, "Stonic Data");
      if (fs.existsSync(legacyLogDir)) {
        try {
          fs.symlinkSync(legacyLogDir, logDir, "junction");
        } catch {
          fs.mkdirSync(logDir, { recursive: true });
        }
      } else {
        fs.mkdirSync(logDir, { recursive: true });
      }
    }
    const logFile = path.join(logDir, "akki_main.log");

    // Write starting block to the file
    const startMsg = `\n--- AKKI MAIN PROCESS LOG START: ${new Date().toLocaleString()} ---\n`;
    fs.appendFileSync(logFile, startMsg, "utf8");

    // Store original console methods
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;
    const originalInfo = console.info;

    // Helper to format logs
    const formatLog = (level, args) => {
      const timestamp = new Date().toISOString();
      const message = args
        .map((arg) => {
          if (arg instanceof Error) {
            return arg.stack || arg.message;
          }
          if (typeof arg === "object") {
            try {
              return JSON.stringify(arg, null, 2);
            } catch (e) {
              return String(arg);
            }
          }
          return String(arg);
        })
        .join(" ");
      return `[${timestamp}] [${level}] ${message}\n`;
    };

    // Helper to write safely to the log file
    const writeLog = (formattedText) => {
      try {
        fs.appendFileSync(logFile, formattedText, "utf8");
      } catch (err) {
        originalError(
          "[Logger Error] Failed to write to log file:",
          err.message,
        );
      }
    };

    console.log = (...args) => {
      originalLog.apply(console, args);
      writeLog(formatLog("INFO", args));
    };

    console.info = (...args) => {
      originalInfo.apply(console, args);
      writeLog(formatLog("INFO", args));
    };

    console.warn = (...args) => {
      originalWarn.apply(console, args);
      writeLog(formatLog("WARN", args));
    };

    console.error = (...args) => {
      originalError.apply(console, args);
      writeLog(formatLog("ERROR", args));
    };

    // Capture uncaught exceptions
    process.on("uncaughtException", (err) => {
      const errMsg = `[UNCAUGHT EXCEPTION] ${err && err.stack ? err.stack : err}\n`;
      originalError(errMsg);
      writeLog(errMsg);
    });

    // Capture unhandled rejections
    process.on("unhandledRejection", (reason, promise) => {
      const rejectMsg = `[UNHANDLED REJECTION] ${reason && reason.stack ? reason.stack : reason}\n`;
      originalError(rejectMsg);
      writeLog(rejectMsg);
    });

    console.log("[Akki Logger] Dynamic file logging started at:", logFile);
  } catch (err) {
    console.error("[Akki Logger] Error configuring file logging:", err.message);
  }
}

if (global.diagLog) global.diagLog("checkpoint 1: before whatsapp");
let hermesBridgeHandle = null;

// LICENSE & PAYMENT SYSTEM REMOVED
const {
  registerDomainHandlers,
  setMainWindow,
  getWhatsAppManager,
  setWhatsAppManager,
} = require("./main/ipc");
const WhatsAppManager = require("./services/whatsapp-manager");
if (global.diagLog) global.diagLog("checkpoint 2: after whatsapp require");

let wakeWordProcess = null;

// Production Server for YouTube embeds (file:// origin is blocked by YouTube)
let productionServer = null;
let productionPort = 45678;

// Document Parsers
const { PDFParse } = require("pdf-parse");
const mammoth = require("mammoth");

let currentVertexToken = null;

// NEURAL BROWSER GLOBAL HANDLERS
// Embedded window disabled - Playwright now runs headless:false and shows its own native Chromium window
// app.on('open-akki-neural-browser', (url) => {
//   createBrowserWindow(url);
// });

// app.on('sync-akki-neural-browser', (url) => { ... });

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow;
let onboardingWindow = null;
let reauthMode = false;
let licenseWindow = null;
let videoWindows = new Set();
let infoPanelWindows = new Map();
let infoPanelData = new Map();
let oauthServer = null;

// Initialize Google GenAI SDK
const { GoogleGenAI } = require("@google/genai");
if (global.diagLog) global.diagLog("checkpoint 3: after GoogleGenAI require");

let powerSaveId = null;
// Splash screen removed in favor of React-based loading screen

const ensureAkkiDirectories = () => bootstrapHelpers.ensureAkkiDirectories(app);
const getAkkiBootstrapDir = () => bootstrapHelpers.getAkkiBootstrapDir(app);
const getAkkiMemoryDir = () => bootstrapHelpers.getAkkiMemoryDir(app);
// Legacy aliases
const ensureStonicDirectories = ensureAkkiDirectories;
const getStonicBootstrapDir = getAkkiBootstrapDir;
const getStonicMemoryDir = getAkkiMemoryDir;

function createOnboardingWindow(mode) {
  reauthMode = mode === "reauth";
  onboardingWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 700,
    resizable: true,
    show: false,
    transparent: false,
    backgroundColor: "#050505",
    frame: false,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#050505",
      symbolColor: "#ffffff",
      height: 44,
    },
    title: "AKKI AI — System Onboarding",
    icon: nativeImage.createFromPath(
      process.env.NODE_ENV === "development"
        ? path.join(__dirname, "../public/logo.png")
        : path.join(process.resourcesPath, "public/logo.png"),
    ),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "onboarding", "preload.js"),
    },
  });

  onboardingWindow.loadFile(path.join(__dirname, "onboarding", "index.html"));

  // Show window when renderer is ready, or force-show after 3 seconds
  const showFallback = setTimeout(() => {
    if (
      onboardingWindow &&
      !onboardingWindow.isDestroyed() &&
      !onboardingWindow.isVisible()
    ) {
      console.log("[Akki Onboarding] Force-showing after 3s timeout");
      onboardingWindow.show();
      onboardingWindow.focus();
    }
  }, 3000);

  onboardingWindow.once("ready-to-show", () => {
    clearTimeout(showFallback);
    onboardingWindow.maximize();
    onboardingWindow.show();
    onboardingWindow.focus();
  });

  onboardingWindow.webContents.on("crashed", () => {
    console.error("[Akki Onboarding] Renderer crashed!");
    if (onboardingWindow && !onboardingWindow.isDestroyed()) {
      onboardingWindow.show();
      onboardingWindow.focus();
    }
  });

  onboardingWindow.on("closed", () => {
    onboardingWindow = null;
    stopOAuthServer();
  });

  return onboardingWindow;
}

function closeOnboardingWindow() {
  stopOAuthServer();
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.close();
    onboardingWindow = null;
  }
}

// Legacy license window kept for backward compatibility
function createLicenseWindow() {
  return createOnboardingWindow();
}

function closeLicenseWindow() {
  closeOnboardingWindow();
}

let licenseWatchInterval = null;

function startLicenseApprovalWatch(hardwareId, email) {
  stopLicenseApprovalWatch();

  const pollStatus = async () => {
    try {
      const licState = licenseManager.getLicenseState();
      const userEmail = email || licState?.email || "";
      if (!userEmail || !hardwareId) return;

      const url = `https://imakshay.in/akkiai/api/check_status.php?email=${encodeURIComponent(userEmail)}&hwid=${encodeURIComponent(hardwareId)}`;
      const res = await fetch(url);
      const data = await res.json();

      if (data && data.status === "approved") {
        stopLicenseApprovalWatch();

        licenseManager.approveLicense({
          plan: "pro",
          hardwareId: hardwareId,
          email: userEmail,
        });

        try {
          if (onboardingWindow && !onboardingWindow.isDestroyed()) {
            onboardingWindow.webContents.send("license-status-changed", {
              status: "approved",
              plan: "pro",
            });
            onboardingWindow.webContents.send("license-approved");
          }
        } catch (e) {
          /* window may be closed */
        }
        try {
          if (licenseWindow && !licenseWindow.isDestroyed()) {
            licenseWindow.webContents.send("license-status-changed", {
              status: "approved",
              plan: "pro",
            });
            licenseWindow.webContents.send("license-approved");
          }
        } catch (e) {
          /* window may be closed */
        }

        closeOnboardingWindow();
        closeLicenseWindow();

        if (!mainWindow || mainWindow.isDestroyed()) {
          const win = createWindow();
          if (win && isWakeWordEnabled()) startWakeWordDetector(win);
        }

        startLicenseMonitor(hardwareId, userEmail);
      } else if (data && data.status === "blocked") {
        stopLicenseApprovalWatch();
        handleLicenseBlocked({ hardwareId });
      }
    } catch (e) {
      console.warn("[Akki] Approval poll check error:", e.message);
    }
  };

  pollStatus();
  licenseWatchInterval = setInterval(pollStatus, 3000);
}

function stopLicenseApprovalWatch() {
  if (licenseWatchInterval) {
    clearInterval(licenseWatchInterval);
    licenseWatchInterval = null;
  }
}

// ─── Persistent License Monitor (runs after approval) ─────────────
// Continuously pings Hostinger backend to refresh online status and detect blocks.
let licenseMonitorInterval = null;

function startLicenseMonitor(hardwareId, email) {
  stopLicenseMonitor();

  const checkHeartbeat = async () => {
    try {
      const licState = licenseManager.getLicenseState();
      const userEmail = email || licState?.email || "";
      const hwId =
        hardwareId ||
        licState?.hardwareId ||
        licenseManager.generateHardwareId();
      if (!userEmail) return;

      const url = `https://imakshay.in/akkiai/api/heartbeat.php?email=${encodeURIComponent(userEmail)}&hwid=${encodeURIComponent(hwId)}`;
      const res = await fetch(url);
      const data = await res.json();

      if (data && data.status === "blocked") {
        console.log(
          "[Akki] Remote authorization revoked by admin. Closing app...",
        );
        handleLicenseBlocked({ hardwareId: hwId });
      }
    } catch (e) {
      console.warn("[Akki] Heartbeat warning:", e.message);
    }
  };

  // Ping immediately
  checkHeartbeat();
  // Every 60 seconds
  licenseMonitorInterval = setInterval(checkHeartbeat, 60000);
}

function stopLicenseMonitor() {
  if (licenseMonitorInterval) {
    clearInterval(licenseMonitorInterval);
    licenseMonitorInterval = null;
  }
}

// ─── License Blocked Handler ──────────────────────────────────────
// Deactivates the app when a license is blocked by the admin.

function handleLicenseBlocked(data) {
  licenseManager.blockLicense({ hardwareId: data.hardwareId });

  stopLicenseApprovalWatch();
  stopLicenseMonitor();

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("license-status-changed", {
      status: "blocked",
    });
    mainWindow.close();
    mainWindow = null;
  }
  closeOnboardingWindow();
  closeLicenseWindow();

  showLicenseBlocked();
}

function showLicenseBlocked() {
  const { dialog } = require("electron");
  dialog
    .showMessageBox({
      type: "error",
      title: "Authorization Revoked",
      message:
        "Your Akki Ai access has been suspended or blocked by the administrator.",
      detail:
        "Please contact the administrator to re-enable authorization for this device.",
      buttons: ["OK"],
    })
    .then(() => {
      app.quit();
    });
}

// ─── Approved-Device Silent Unlock ────────────────────────────────
// Runs in the background right after the main window opens for a locally
// approved device. Verifies Hostinger authorization and restores session.
async function verifyApprovedSession(win, hardwareId) {
  try {
    const licState = licenseManager.getLicenseState();
    const email = licState?.email || "akshaymondal143@gmail.com";

    // Verify remote authorization with Hostinger server
    const url = `https://imakshay.in/akkiai/api/check_status.php?email=${encodeURIComponent(email)}&hwid=${encodeURIComponent(hardwareId)}`;
    const res = await fetch(url);
    const remote = await res.json();

    if (remote && remote.status === "blocked") {
      console.log("[Akki] Remote license blocked. Closing app...");
      handleLicenseBlocked({ hardwareId });
      return;
    } else if (remote && remote.status === "pending") {
      console.log("[Akki] Remote status pending. Downgrading to onboarding...");
      downgradeApprovedToOnboarding(hardwareId);
      return;
    }

    // Restore Firebase session in background for AI model chat sync
    firebaseService.restoreAuthSession().catch(() => {});
  } catch (e) {
    console.error("[Akki] verifyApprovedSession error:", e.message);
  }
}

// ─── Certification (Store-test) Session ────────────────────────────────
// Runs after the main window opens for a locally-certified license. Re-checks
// the server-side certification registry. If the certification account was
// disabled or expired, downgrade to the normal onboarding/license path. If a
// real session cannot be restored, require re-auth — fail closed like the
// approved-device path.
async function verifyCertifiedSession(win) {
  try {
    const res = await firebaseService.restoreAuthSession();
    if (!res || !res.restored) {
      if (res && (res.reason === "revoked" || res.reason === "no-credential")) {
        console.log(
          "[Akki] Certification silent unlock needs re-auth (" +
            res.reason +
            "). Pivoting...",
        );
        pivotApprovedToReauth();
      } else {
        // Transient/network — keep the app open; the certification monitor
        // re-checks on its interval once auth is restored.
        console.log(
          "[Akki] Certification session restore incomplete (" +
            (res ? res.reason : "unknown") +
            "). Staying open.",
        );
      }
      return;
    }

    // Real session restored — re-check the server registry.
    const cert = await firebaseService.getCertificationStatus();
    if (!cert.certified) {
      console.log(
        "[Akki] Certification account no longer active. Downgrading to onboarding...",
      );
      downgradeCertifiedToOnboarding();
    }
    // certified → nothing to do; the running main window is correct.
  } catch (e) {
    console.error("[Akki] verifyCertifiedSession error:", e.message);
  }
}

// Periodic re-check for a running certification license. If the account is
// disabled/expired server-side, downgrade immediately. Starts only when the
// local license is a certification license.
let certificationMonitorInterval = null;

function startCertificationMonitor() {
  stopCertificationMonitor();
  // One-time immediate check avoids waiting a full interval on disable-while-closed.
  setTimeout(() => checkCertificationStillValid(), 1000);
  certificationMonitorInterval = setInterval(() => {
    checkCertificationStillValid();
  }, 300000); // every 5 minutes
}

function stopCertificationMonitor() {
  if (certificationMonitorInterval) {
    clearInterval(certificationMonitorInterval);
    certificationMonitorInterval = null;
  }
}

async function checkCertificationStillValid() {
  try {
    // Only monitor while the local license is still a certification license.
    if (!licenseManager.isCertificationLicense()) {
      stopCertificationMonitor();
      return;
    }
    const cert = await firebaseService.getCertificationStatus();
    if (!cert.certified) {
      console.log(
        "[Akki] Certification access revoked server-side. Downgrading to onboarding...",
      );
      downgradeCertifiedToOnboarding();
    }
  } catch (e) {
    console.error("[Akki] checkCertificationStillValid error:", e.message);
  }
}

function downgradeCertifiedToOnboarding() {
  // Drop the certification license locally so the startup gate routes normally.
  const cur = licenseManager.getLicenseState() || {};
  licenseManager.saveLicenseState({
    ...cur,
    status: "pending",
    licenseType: undefined,
    certifiedAccountEmail: undefined,
    certifiedAccountUid: undefined,
  });
  stopCertificationMonitor();
  closeMainWindowSilently();
  createOnboardingWindow();
}

function closeMainWindowSilently() {
  stopLicenseMonitor();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
    mainWindow = null;
  }
  closeOnboardingWindow();
  closeLicenseWindow();
}

function pivotApprovedToReauth() {
  closeMainWindowSilently();
  createOnboardingWindow("reauth");
}

function downgradeApprovedToOnboarding(hardwareId) {
  closeMainWindowSilently();
  const licState = licenseManager.getLicenseState();
  if (licState && licState.status === "pending" && hardwareId) {
    startLicenseApprovalWatch(hardwareId);
  }
  createOnboardingWindow();
}

// ─── OAuth HTTP Server (System Browser Flow) ──────────────────────

function startOAuthServer() {
  return new Promise((resolve, reject) => {
    // Stop any existing server
    stopOAuthServer();

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost:53921");

      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<h1>Authentication failed</h1><p>" + error + "</p>");
          stopOAuthServer();
          reject(new Error("Google auth error: " + error));
          return;
        }

        if (code) {
          // Serve success page
          res.writeHead(200, { "Content-Type": "text/html" });
          const htmlPath = path.join(
            __dirname,
            "onboarding",
            "auth-success.html",
          );
          if (fs.existsSync(htmlPath)) {
            res.end(fs.readFileSync(htmlPath, "utf8"));
          } else {
            res.end(
              "<h1>Authentication Successful!</h1><p>You can close this tab and return to Akki Ai.</p>",
            );
          }

          // Stop server and resolve
          stopOAuthServer();
          resolve(code);
        } else {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(
            "<h1>Invalid request</h1><p>No authorization code received.</p>",
          );
          stopOAuthServer();
          reject(new Error("No authorization code received"));
        }
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    oauthServer = server;

    server.listen(53921, "0.0.0.0", () => {
      console.log(
        "[OAuth] Server listening on port 53921 (http://localhost:53921 / http://127.0.0.1:53921)",
      );
    });

    server.on("error", (err) => {
      console.error("[OAuth] Server error:", err.message);
      oauthServer = null;
      reject(new Error("OAuth server failed: " + err.message));
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      if (oauthServer) {
        stopOAuthServer();
        reject(new Error("Authentication timed out"));
      }
    }, 300000);
  });
}

function stopOAuthServer() {
  if (oauthServer) {
    try {
      oauthServer.close();
      oauthServer.closeAllConnections();
    } catch (e) {
      /* ignore */
    }
    oauthServer = null;
    console.log("[OAuth] Server stopped");
  }
}

function createWindow() {
  // Ensure directories exist before UI loads
  ensureAkkiDirectories();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 700,
    resizable: true,
    show: false,
    transparent: false,
    backgroundColor: "#000000",
    alwaysOnTop: false,
    frame: false,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#07090c",
      symbolColor: "#ffffff",
      height: 26,
    },
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
      webviewTag: true,
      webSecurity: false, // CRITICAL: Allow YouTube iframe to load in production
      allowRunningInsecureContent: true, // Allow external media content
      devTools: false,
    },
    autoHideMenuBar: true,
    icon: nativeImage.createFromPath(
      process.env.NODE_ENV === "development"
        ? path.join(__dirname, "../public/logo.png")
        : path.join(process.resourcesPath, "public/logo.png"),
    ),
  });

  mainWindow.webContents.on(
    "console-message",
    (_event, level, message, line, sourceId) => {
      console.log(
        `[Renderer console] level=${level} source=${sourceId}:${line} message=${message}`,
      );
    },
  );

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) {
      require("electron")
        .shell.openExternal(url)
        .catch((e) => console.error(e));
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (
      (url.startsWith("http:") &&
        !url.includes("localhost") &&
        !url.includes("127.0.0.1")) ||
      url.startsWith("https:")
    ) {
      event.preventDefault();
      require("electron")
        .shell.openExternal(url)
        .catch((e) => console.error(e));
    }
  });
  mainWindow.webContents.on("crashed", () => {
    console.error("[Akki] Renderer process crashed!");
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      console.error("[Akki] Renderer did-fail-load", {
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame,
      });
      if (isMainFrame) {
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            const filePath = path.join(__dirname, "../dist/index.html");
            console.log("[Akki] Retrying with file load:", filePath);
            mainWindow.loadFile(filePath);
          }
        }, 1000);
      }
    },
  );

  mainWindow.webContents.on("did-finish-load", () => {
    console.log(
      "[Akki] Renderer did-finish-load URL=",
      mainWindow.webContents.getURL(),
    );
  });

  mainWindow.webContents.on("dom-ready", () => {
    console.log(
      "[Akki] Renderer dom-ready URL=",
      mainWindow.webContents.getURL(),
    );
    try {
      const { THEME_ENGINE_SCRIPT } = require("./ui/theme-engine");
      mainWindow.webContents
        .executeJavaScript(THEME_ENGINE_SCRIPT)
        .catch(() => {});
    } catch (e) {
      console.warn("[Theme] Engine inject failed:", e.message);
    }
  });

  // Show window when renderer is ready, or force-show after 3 seconds
  const showWindowFallback = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      console.log("[Akki] Force-showing main window after 3s timeout");
      mainWindow.show();
      mainWindow.focus();
    }
  }, 3000);

  mainWindow.once("ready-to-show", () => {
    clearTimeout(showWindowFallback);
    mainWindow.maximize();
    mainWindow.show();
    mainWindow.focus();

    // Fallback: Force transition after 20 seconds if renderer hasn't signaled completion
    const transitionTimeout = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log(
          "[Akki] Forcing UI transition due to timeout (renderer did not signal completion)",
        );
        mainWindow.webContents.send("force-transition", {});
      }
    }, 20000);

    mainWindow.__splashTransitionTimeout = transitionTimeout;

    mainWindow.once("closed", () => {
      if (mainWindow.__splashTransitionTimeout) {
        clearTimeout(mainWindow.__splashTransitionTimeout);
        mainWindow.__splashTransitionTimeout = null;
      }
    });

    mainWindow.webContents.once("did-frame-finish-load", () => {
      console.log(
        "[Akki] Renderer finished loading; waiting for splash completion signal",
      );
    });
  });

  if (process.env.NODE_ENV === "development") {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    // PRODUCTION: Serve via local HTTP server (YouTube blocks file:// embeds)
    startProductionServer()
      .then((port) => {
        const url = `http://127.0.0.1:${port}/index.html`;
        console.log("[Akki] Loading production renderer from URL:", url);
        mainWindow.loadURL(url);
      })
      .catch((err) => {
        console.error("Failed to start production server:", err);
        // Fallback to file loading if server fails
        const filePath = path.join(__dirname, "../dist/index.html");
        console.log("[Akki] Falling back to file:", filePath);
        mainWindow.loadFile(filePath);
      });
  }

  return mainWindow;
}

function createVideoWindow(videoId) {
  let videoWin = new BrowserWindow({
    width: 800,
    height: 500,
    frame: false,
    transparent: false,
    backgroundColor: "#0B141B",
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
      webSecurity: false,
      devTools: false,
    },
    icon: nativeImage.createFromPath(
      process.env.NODE_ENV === "development"
        ? path.join(__dirname, "../public/logo.png")
        : path.join(process.resourcesPath, "public/logo.png"),
    ),
  });

  videoWindows.add(videoWin);

  const urlParam = `?videoId=${videoId}&mode=player`;

  if (process.env.NODE_ENV === "development") {
    videoWin.loadURL(`http://localhost:5173${urlParam}`);
  } else {
    startProductionServer().then((port) => {
      videoWin.loadURL(`http://localhost:${port}/index.html${urlParam}`);
    });
  }

  videoWin.on("closed", () => {
    videoWindows.delete(videoWin);
  });

  return videoWin;
}

function createInfoPanelWindow(panelId) {
  // Cascade panels slightly so multiple HUDs don't stack exactly on top of each other
  const offset = (infoPanelWindows.size % 5) * 30;

  let infoWin = new BrowserWindow({
    width: 760,
    height: 580,
    x: 120 + offset,
    y: 90 + offset,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
      webSecurity: false,
      devTools: false,
    },
    icon: nativeImage.createFromPath(
      process.env.NODE_ENV === "development"
        ? path.join(__dirname, "../public/logo.png")
        : path.join(process.resourcesPath, "public/logo.png"),
    ),
  });

  infoPanelWindows.set(panelId, infoWin);

  const urlParam = `?mode=info&panelId=${encodeURIComponent(panelId)}`;

  if (process.env.NODE_ENV === "development") {
    infoWin.loadURL(`http://localhost:5173/${urlParam}`);
  } else {
    startProductionServer().then((port) => {
      infoWin.loadURL(`http://localhost:${port}/index.html${urlParam}`);
    });
  }

  infoWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  infoWin.on("closed", () => {
    if (infoPanelWindows.get(panelId) === infoWin) {
      infoPanelWindows.delete(panelId);
      infoPanelData.delete(panelId);
    }
  });

  return infoWin;
}

function createBrowserWindow(url = "") {
  let browserWin = new BrowserWindow({
    width: 900,
    height: 600,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
      webviewTag: true,
      webSecurity: false,
    },
    show: false,
    icon: nativeImage.createFromPath(
      process.env.NODE_ENV === "development"
        ? path.join(__dirname, "../public/logo.png")
        : path.join(process.resourcesPath, "public/logo.png"),
    ),
  });

  browserWin.center();

  browserWin.once("ready-to-show", () => {
    console.log("[Main] Neural Browser Window Ready-to-show");
    browserWin.show();
    browserWin.focus();
  });

  // Fallback show if ready-to-show is too slow
  setTimeout(() => {
    if (browserWin && !browserWin.isVisible()) {
      console.log("[Main] Neural Browser Fallback Show");
      browserWin.show();
    }
  }, 3000);

  const urlParam = `#mode=browser${url ? `&url=${encodeURIComponent(url)}` : ""}`;

  if (process.env.NODE_ENV === "development") {
    browserWin.loadURL(`http://localhost:5173/${urlParam}`);
  } else {
    startProductionServer().then((port) => {
      browserWin.loadURL(`http://localhost:${port}/index.html${urlParam}`);
    });
  }

  return browserWin;
}

let productionServerStartPromise = null;

// Production HTTP Server - serves dist folder on localhost
function startProductionServer() {
  if (productionServer) return Promise.resolve(productionPort);
  if (productionServerStartPromise) return productionServerStartPromise;

  productionServerStartPromise = new Promise((resolve, reject) => {
    const distPath = path.join(__dirname, "../dist");
    const MAX_PORT_ATTEMPTS = 20;

    productionServer = http.createServer((req, res) => {
      // 1. Decode URL to handle spaces (%20) and special characters in paths
      let decodedUrl = req.url;
      try {
        decodedUrl = decodeURIComponent(req.url);
      } catch (e) {
        console.error("[Production Server] Failed to decode URL:", req.url, e);
      }

      // 2. Strip query parameters (e.g., ?videoId=xxx)
      const parsedUrl = decodedUrl.split("?")[0];
      let filePath = path.join(
        distPath,
        parsedUrl === "/" ? "index.html" : parsedUrl,
      );

      // Security: prevent directory traversal
      if (!filePath.startsWith(distPath)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      const extname = path.extname(filePath).toLowerCase();
      const mimeTypes = {
        ".html": "text/html",
        ".js": "application/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".mp4": "video/mp4",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
        ".ttf": "font/ttf",
        ".ico": "image/x-icon",
      };

      const contentType = mimeTypes[extname] || "application/octet-stream";

      // Check if file exists
      fs.stat(filePath, (err, stats) => {
        if (err) {
          if (err.code === "ENOENT") {
            // SPA fallback - serve index.html for any unknown route
            fs.readFile(
              path.join(distPath, "index.html"),
              (err, indexContent) => {
                if (err) {
                  res.writeHead(500);
                  res.end("Server Error");
                } else {
                  res.writeHead(200, { "Content-Type": "text/html" });
                  res.end(indexContent, "utf-8");
                }
              },
            );
          } else {
            res.writeHead(500);
            res.end(`Server Error: ${err.code}`);
          }
          return;
        }

        // Support HTTP Range Requests for streaming media (like MP4)
        const range = req.headers.range;
        if (
          range &&
          (contentType.startsWith("video/") || contentType.startsWith("audio/"))
        ) {
          const totalSize = stats.size;
          const parts = range.replace(/bytes=/, "").split("-");
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;

          if (start >= totalSize || end >= totalSize) {
            res.writeHead(416, {
              "Content-Range": `bytes */${totalSize}`,
            });
            res.end();
            return;
          }

          const chunkSize = end - start + 1;
          const stream = fs.createReadStream(filePath, { start, end });

          res.writeHead(206, {
            "Content-Range": `bytes ${start}-${end}/${totalSize}`,
            "Accept-Ranges": "bytes",
            "Content-Length": chunkSize,
            "Content-Type": contentType,
          });

          stream.pipe(res);
        } else {
          // Standard file delivery
          fs.readFile(filePath, (error, content) => {
            if (error) {
              res.writeHead(500);
              res.end(`Server Error: ${error.code}`);
            } else {
              res.writeHead(200, { "Content-Type": contentType });
              res.end(content, "utf-8");
            }
          });
        }
      });
    });
    productionServer.listen(productionPort, "127.0.0.1", () => {
      console.log(
        `Production server running at http://localhost:${productionPort}`,
      );
      resolve(productionPort);
    });

    let portAttempts = 0;
    productionServer.on("error", (err) => {
      if (err.code === "EADDRINUSE" && portAttempts < MAX_PORT_ATTEMPTS) {
        portAttempts++;
        productionPort++;
        productionServer.listen(productionPort, "127.0.0.1");
      } else {
        reject(err);
      }
    });
  });
  return productionServerStartPromise;
}

function setupPermissions(session) {
  const allowedPermissions = ["media", "camera", "microphone", "geolocation"];
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      if (allowedPermissions.includes(permission)) {
        callback(true);
      } else {
        callback(false);
      }
    },
  );
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission) => {
      return allowedPermissions.includes(permission);
    },
  );
}

// Utility Paths (flat, no per-user subdirectories — Akki-style)
const getMemoryPath = () => path.join(userDataPath(), "memories.json");
const getUserProfilePath = () => path.join(userDataPath(), "user_profile.json");
const getDashboardSettingsPath = () =>
  path.join(userDataPath(), "dashboard_settings.json");
const getFolderConfigPath = () =>
  path.join(userDataPath(), "imported_folders.json");
const getVaultPath = () => {
  const akkiVault = path.join(app.getPath("documents"), "Akki_Vault");
  const stonicVault = path.join(app.getPath("documents"), "Stonic_Vault");
  if (fs.existsSync(akkiVault)) return akkiVault;
  return stonicVault;
};
const getHistoryPath = () => path.join(userDataPath(), "history.json");
const getHistorySettingsPath = () =>
  path.join(userDataPath(), "history_settings.json");
const getContactsPath = () => path.join(userDataPath(), "contacts.json");
const getNotesPath = () => path.join(userDataPath(), "notes.json");
const getTasksPath = () => path.join(userDataPath(), "tasks.json");
const getAgentReportsPath = () =>
  path.join(userDataPath(), "agent_reports.json");
const getSecretKeyPath = () => path.join(userDataPath(), "secret_key.json");
const getGroqKeyPath = () => path.join(userDataPath(), "groq_key.json");
const getOpenAIKeyPath = () => path.join(userDataPath(), "openai_key.json");
const getOpenRouterKeyPath = () =>
  path.join(userDataPath(), "openrouter_key.json");
const getKimiKeyPath = () => path.join(userDataPath(), "kimi_key.json");
const getThinkingSettingsPath = () =>
  path.join(userDataPath(), "thinking_settings.json");
const getGeminiPreferencePath = () =>
  path.join(userDataPath(), "gemini_preference.json");
const getVoiceAssistantModePath = () =>
  path.join(userDataPath(), "voice_assistant_mode.json");
const getVoiceProviderPath = () =>
  path.join(userDataPath(), "voice_provider_preference.json");
const getChatsPath = () => path.join(userDataPath(), "chats.json");
const getCustomModelsPath = () =>
  path.join(userDataPath(), "custom_models.json");
const getSubAgentConfigPath = () =>
  path.join(userDataPath(), "sub_agent_config.json");
const getAgentTownConfigPath = () =>
  path.join(userDataPath(), "agent_town_config.json");
const getWakeWordSettingsPath = () =>
  path.join(userDataPath(), "wake_word_settings.json");
const getAutoUpdateSettingsPath = () =>
  path.join(userDataPath(), "auto_update_settings.json");
const getHFKeyPath = () => path.join(userDataPath(), "hf_key.json");
const getThemePath = () => path.join(userDataPath(), "theme.json");

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  try {
    if (fs.existsSync(filePath))
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {}
  return null;
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

async function loadDataInternal(pathFn) {
  const localPath = pathFn();

  if (localPath) {
    const parsed = readJson(localPath);
    if (parsed && parsed.data !== undefined && parsed._meta !== undefined) {
      return parsed.data;
    }
    return parsed;
  }

  return null;
}

async function saveDataInternal(data, pathFn) {
  const localPath = pathFn();
  const now = Date.now();

  if (localPath) {
    writeJson(localPath, { data, _meta: { updatedAt: now } });
  }

  return true;
}

// Update ~/.hermes/config.yaml with provider and model from Agent Town settings
function updateHermesModelConfig(provider, modelId) {
  try {
    const hermesDir = path.join(os.homedir(), ".hermes");
    const hermesConfigPath = path.join(hermesDir, "config.yaml");

    if (!fs.existsSync(hermesDir)) fs.mkdirSync(hermesDir, { recursive: true });

    let lines = fs.existsSync(hermesConfigPath)
      ? fs.readFileSync(hermesConfigPath, "utf8").split("\n")
      : [];

    const hermesProvider =
      provider === "openai-codex"
        ? "openai-codex"
        : provider === "openrouter"
          ? "openrouter"
          : "gemini";

    // Find and replace model section lines, or inject at top
    let inModelBlock = false;
    let defaultReplaced = false;
    let providerReplaced = false;
    const updated = [];

    for (const line of lines) {
      if (/^model:/.test(line)) {
        inModelBlock = true;
        updated.push(line);
        continue;
      }
      if (inModelBlock && /^\s+default:/.test(line)) {
        updated.push(`  default: ${modelId}`);
        defaultReplaced = true;
        continue;
      }
      if (inModelBlock && /^\s+provider:/.test(line)) {
        updated.push(`  provider: ${hermesProvider}`);
        providerReplaced = true;
        continue;
      }
      if (inModelBlock && /^\S/.test(line)) {
        // Left the model block
        if (!defaultReplaced) updated.push(`  default: ${modelId}`);
        if (!providerReplaced) updated.push(`  provider: ${hermesProvider}`);
        inModelBlock = false;
      }
    }

    // Handle case where model block is at the end of the file
    if (inModelBlock) {
      if (!defaultReplaced) updated.push(`  default: ${modelId}`);
      if (!providerReplaced) updated.push(`  provider: ${hermesProvider}`);
    }

    // If model block was never found, prepend it
    if (!updated.some((l) => /^model:/.test(l))) {
      updated.unshift(
        `model:`,
        `  default: ${modelId}`,
        `  provider: ${hermesProvider}`,
      );
    }

    fs.writeFileSync(hermesConfigPath, updated.join("\n"), "utf8");
    console.log(
      `[Akki] Hermes config updated — provider: ${hermesProvider}, model: ${modelId}`,
    );
  } catch (e) {
    console.error("[Akki] Failed to update Hermes config.yaml:", e.message);
  }
}

// --- IPC Handlers Registration ---
function registerHandlers() {
  ipcMain.handle("open-external-link", async (event, url) => {
    return shell.openExternal(url);
  });

  ipcMain.handle("get-stored-user", async () => {
    return null;
  });

  ipcMain.handle("play-youtube-video", async (event, videoId) => {
    videoWindows.forEach((win) => {
      if (!win.isDestroyed()) {
        win.close();
      }
    });
    createVideoWindow(videoId);
    return true;
  });

  ipcMain.handle("close-window", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.close();
    return true;
  });

  ipcMain.handle("minimize-window", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.minimize();
      return true;
    }
    return false;
  });

  ipcMain.handle("maximize-window", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return false;
    if (win.isMaximized()) {
      win.unmaximize();
      return false;
    } else {
      win.maximize();
      return true;
    }
  });

  ipcMain.handle("fullscreen-window", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return false;
    const nextState = !win.isFullScreen();
    win.setFullScreen(nextState);
    return nextState;
  });

  ipcMain.handle("control-media-player", async (event, payload) => {
    const action =
      typeof payload === "string"
        ? payload
        : payload && payload.action
          ? payload.action
          : "";
    const value =
      typeof payload === "object" && payload ? payload.value : undefined;
    let success = false;

    videoWindows.forEach((win) => {
      if (!win.isDestroyed()) {
        if (action === "minimize") {
          win.minimize();
          success = true;
        } else if (action === "maximize") {
          if (win.isMinimized()) win.restore();
          win.maximize();
          success = true;
        } else if (action === "restore") {
          if (win.isMinimized()) win.restore();
          else if (win.isMaximized()) win.unmaximize();
          else win.show();
          success = true;
        } else if (action === "fullscreen") {
          win.setFullScreen(!win.isFullScreen());
          success = true;
        } else if (action === "close") {
          win.close();
          success = true;
        } else {
          // Playback, seeking, and player volume commands
          win.webContents.send("media-player-control", { action, value });
          success = true;
        }
      }
    });
    return success;
  });

  // ─── Setup Walkthrough (Setup Guide) one-time flag ─────────────────────────
  // Persisted in userData so it survives renderer origin changes (localStorage
  // is per-origin and resets when the local server port shifts or the app falls
  // back to file://). Plays once per install, then only via Settings replay.
  ipcMain.handle("guide-video-should-play", async () => {
    try {
      const p = path.join(app.getPath("userData"), "guide_video_seen.json");
      return !fs.existsSync(p);
    } catch {
      return true;
    }
  });

  ipcMain.handle("guide-video-mark-seen", async () => {
    try {
      const p = path.join(app.getPath("userData"), "guide_video_seen.json");
      fs.writeFileSync(p, JSON.stringify({ seen: true, at: Date.now() }));
      return true;
    } catch {
      return false;
    }
  });

  // --- Tools Configuration IPC Handlers ---
  ipcMain.handle("get-tools-config", async () => {
    try {
      return toolsConfigManager.readConfig();
    } catch (err) {
      console.error("[IPC:get-tools-config] Error:", err.message);
      return toolsConfigManager.DEFAULT_CONFIG;
    }
  });

  ipcMain.handle("save-tools-config", async (event, config) => {
    try {
      const ok = toolsConfigManager.writeConfig(config);
      return { success: ok };
    } catch (err) {
      console.error("[IPC:save-tools-config] Error:", err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(
    "refresh-available-models",
    async (event, { provider, apiKey } = {}) => {
      try {
        if (provider === "openrouter") {
          const models = await toolsConfigManager.fetchOpenRouterModels();
          return { success: true, models };
        } else {
          // Default: Gemini
          let finalKey = apiKey || "";
          if (!finalKey) {
            try {
              const atPath = require("path").join(
                require("electron").app.getPath("userData"),
                "agent_town_config.json",
              );
              if (fs.existsSync(atPath)) {
                const atData = JSON.parse(fs.readFileSync(atPath, "utf8"));
                finalKey = atData.geminiApiKey || atData.apiKey || "";
              }
            } catch (e) {}
          }
          if (!finalKey) {
            try {
              const skPath = require("path").join(
                require("electron").app.getPath("userData"),
                "secret_key.json",
              );
              if (fs.existsSync(skPath)) {
                const skData = JSON.parse(fs.readFileSync(skPath, "utf8"));
                if (skData.data) {
                  finalKey = skData.data.geminiKey || skData.data.apiKey || "";
                }
              }
            } catch (e) {}
          }
          const models = await toolsConfigManager.fetchGeminiModels(finalKey);
          return { success: true, models };
        }
      } catch (err) {
        console.error("[IPC:refresh-available-models] Error:", err.message);
        return { success: false, models: [], error: err.message };
      }
    },
  );

  ipcMain.handle("license-passed", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      win.setResizable(true);
      win.setMinimumSize(1000, 700);
      win.maximize();
    }
    return true;
  });

  // ─── Data Handlers Factory (local-first + Firestore sync) ──────────────────

  function loadLocal(pathFn) {
    const p = pathFn();
    return p && fs.existsSync(p) ? readJson(p) : null;
  }

  function saveLocal(data, pathFn) {
    const p = pathFn();
    if (p) writeJson(p, data);
    return true;
  }

  const dataTypes = [
    { type: "memories", pathFn: () => getMemoryPath() },
    { type: "contacts", pathFn: () => getContactsPath() },
    { type: "notes", pathFn: () => getNotesPath() },
    { type: "tasks", pathFn: () => getTasksPath() },
    { type: "user-profile", pathFn: () => getUserProfilePath() },
    { type: "dashboard-settings", pathFn: () => getDashboardSettingsPath() },
    { type: "history-settings", pathFn: () => getHistorySettingsPath() },

    { type: "thinking-settings", pathFn: () => getThinkingSettingsPath() },
    { type: "gemini-preference", pathFn: () => getGeminiPreferencePath() },
    { type: "folder-config", pathFn: () => getFolderConfigPath() },
  ];

  dataTypes.forEach(({ type, pathFn }) => {
    const loadChannel = "load-" + type;
    const saveChannel = "save-" + type;

    if (type === "user-profile") {
      // Custom load handler: auto-populate name from Google session if user never saved a custom name
      ipcMain.handle(loadChannel, async () => {
        const result = await loadDataInternal(pathFn);
        const profileData = result !== null ? result : {};
        // Only prefill name if user has never saved their own custom name
        if (!profileData.name) {
          const googleName =
            firebaseService.getCurrentUser()?.displayName ||
            firebaseService.getStoredSession()?.displayName ||
            "";
          if (googleName) {
            profileData.name = googleName;
          }
        }
        if (!profileData.location) {
          profileData.location = profileData.location || "";
        }
        return profileData;
      });
    } else {
      ipcMain.handle(loadChannel, async () => {
        const result = await loadDataInternal(pathFn);
        return result !== null
          ? result
          : type === "history-settings"
            ? { maxContextMessages: 20, storeHistory: true }
            : [];
      });
    }

    ipcMain.handle(saveChannel, async (event, data) => {
      return saveDataInternal(data, pathFn);
    });
  });

  // Google profile photo URL for Settings avatar display
  ipcMain.handle("get-google-photo-url", async () => {
    return (
      firebaseService.getStoredSession()?.photoURL ||
      firebaseService.getCurrentUser()?.photoURL ||
      ""
    );
  });

  // Dynamic user location IPC handler for voice and background agents
  ipcMain.handle("get-user-location", async () => {
    try {
      const axios = require("axios");
      const resp = await axios.get("https://ipwho.is/", { timeout: 4000 });
      if (resp.data && resp.data.success) {
        return {
          location: `${resp.data.city}, ${resp.data.region}, ${resp.data.country}`,
          city: resp.data.city,
          region: resp.data.region,
          country: resp.data.country,
          latitude: resp.data.latitude,
          longitude: resp.data.longitude,
          timezone:
            resp.data.timezone?.id ||
            Intl.DateTimeFormat().resolvedOptions().timeZone,
        };
      }
    } catch (e) {}
    return {
      location: "",
      city: "",
      region: "",
      country: "",
      latitude: null,
      longitude: null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  });

  // Local-only: chats (no Firestore sync)
  ipcMain.handle("load-chats", async () => {
    const local = loadLocal(() => getChatsPath());
    if (local !== null) return local;
    // Legacy fallback to flat history.json
    const h = getHistoryPath();
    if (fs.existsSync(h)) {
      const legacy = readJson(h);
      if (legacy && legacy.length > 0) {
        return [
          {
            id: "legacy-history",
            title: "Legacy Chat",
            messages: legacy,
            timestamp: Date.now(),
            model: "Claude 4.5 Sonnet",
          },
        ];
      }
    }
    return [];
  });

  ipcMain.handle("save-chats", async (event, chats) => {
    return saveLocal(chats, () => getChatsPath());
  });

  // Local-only: history (no Firestore sync)
  ipcMain.handle("load-history", async () => {
    const local = loadLocal(() => getHistoryPath());
    return local !== null ? local : [];
  });

  ipcMain.handle("save-history", async (event, history) => {
    return saveLocal(history, () => getHistoryPath());
  });

  ipcMain.handle("clear-history", async () => {
    const p = getHistoryPath();
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
    return true;
  });

  // API Keys — grouped into single `apiKeys` doc
  const getApiKeys = async () => {
    return (await loadDataInternal(() => getSecretKeyPath())) || {};
  };

  const setApiKeys = async (keys) => {
    return saveDataInternal(keys, () => getSecretKeyPath());
  };

  const apiKeyTypes = {
    gemini: {
      readChannel: "get-gemini-token",
      saveChannel: "save-gemini-token",
      field: "geminiKey",
      envVar: process.env.GEMINI_API_KEY,
    },
    groq: {
      readChannel: "get-groq-token",
      saveChannel: "save-groq-token",
      field: "groqKey",
      envVar: process.env.GROQ_API_KEY,
    },
    openai: {
      readChannel: "get-openai-token",
      saveChannel: "save-openai-token",
      field: "openaiKey",
      envVar: process.env.OPENAI_API_KEY,
    },
    openrouter: {
      readChannel: "get-openrouter-token",
      saveChannel: "save-openrouter-token",
      field: "openrouterKey",
      envVar: process.env.OPENROUTER_API_KEY,
    },
    kimi: {
      readChannel: "get-kimi-token",
      saveChannel: "save-kimi-token",
      field: "kimiKey",
      envVar: null,
    },
    huggingface: {
      readChannel: "read-hf-key",
      saveChannel: "save-huggingface-token",
      field: "hfKey",
      envVar: process.env.HUGGINGFACE_API_KEY,
    },
    jina: {
      readChannel: "get-jina-token",
      saveChannel: "save-jina-token",
      field: "jinaKey",
      envVar: null,
    },
  };

  Object.values(apiKeyTypes).forEach(
    ({ readChannel, saveChannel, field, envVar }) => {
      ipcMain.handle(readChannel, async () => {
        if (field === "hfKey") {
           try {
             const cfg = toolsConfigManager.readConfig();
             if (cfg.tools?.image_generation?.token) return cfg.tools.image_generation.token.trim();
           } catch(e) {}
        }
        if (firebaseService.getCurrentUser()?.uid) {
          const allKeys = await getApiKeys();
          if (allKeys[field]) return allKeys[field];
        }
        // Fallback: check env var
        if (envVar) return envVar;
        return null;
      });

      ipcMain.handle(saveChannel, async (event, apiKey) => {
        if (firebaseService.getCurrentUser()?.uid) {
          const allKeys = await getApiKeys();
          allKeys[field] = apiKey;
          return setApiKeys(allKeys);
        }
        // Local-only fallback
        const legacyPaths = {
          geminiKey: getSecretKeyPath,
          groqKey: getGroqKeyPath,
          openaiKey: getOpenAIKeyPath,
          openrouterKey: getOpenRouterKeyPath,
          kimiKey: getKimiKeyPath,
          hfKey: getHFKeyPath,
        };
        const p = legacyPaths[field]();
        if (p) writeJson(p, { apiKey, updatedAt: Date.now() });
        return true;
      });
    },
  );

  // ─── Firebase Auth IPC Handlers ──────────────────────────────────────────────

  ipcMain.handle("auth-get-status", async () => {
    return {
      authenticated: firebaseService.isAuthenticated(),
      user: firebaseService.getCurrentUser()
        ? {
            uid: firebaseService.getCurrentUser().uid,
            email: firebaseService.getCurrentUser().email,
            displayName: firebaseService.getCurrentUser().displayName,
            photoURL: firebaseService.getCurrentUser().photoURL,
          }
        : null,
    };
  });

  ipcMain.handle("auth-sign-in", async () => {
    try {
      const oauthConfig = firebaseService.getOAuthConfig();
      if (!oauthConfig)
        return { success: false, error: "OAuth not configured" };

      const { OAuth2Client } = require("google-auth-library");
      const oauth2Client = new OAuth2Client(
        oauthConfig.clientId,
        oauthConfig.clientSecret,
        oauthConfig.redirectUri,
      );

      const authUrl = oauth2Client.generateAuthUrl({
        access_type: "offline",
        prompt: "select_account consent",
        scope: oauthConfig.scope,
        include_granted_scopes: true,
      });

      const oauthPromise = startOAuthServer();
      await shell.openExternal(authUrl);
      const code = await oauthPromise;
      if (!code) return { success: false, error: "Authentication cancelled" };

      const user = await firebaseService.exchangeGoogleCode(code);
      if (!user)
        return { success: false, error: "Failed to authenticate with Google" };

      return {
        success: true,
        user: {
          uid: user.uid,
          email: user.email,
          displayName: user.displayName,
          photoURL: user.photoURL,
        },
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  const performFullSignOut = async () => {
    try {
      console.log("[Akki Auth] Initiating complete sign-out sequence...");
      // 1. Sign out Firebase and delete credential/session files
      await firebaseService.signOutUser();

      // 2. Clear local license so user is completely logged out
      licenseManager.clearLicense();
      stopLicenseMonitor();
      stopLicenseApprovalWatch();

      // 3. Clear onboarding and auth cache and credentials
      try {
        const op = path.join(app.getPath("userData"), "onboarding.json");
        if (fs.existsSync(op)) fs.unlinkSync(op);
        const ap = path.join(app.getPath("userData"), "auth_data.json");
        if (fs.existsSync(ap)) fs.unlinkSync(ap);
        const sp = path.join(app.getPath("userData"), "firebase_session.json");
        if (fs.existsSync(sp)) fs.unlinkSync(sp);
        const cp = path.join(
          app.getPath("userData"),
          "firebase_credential.bin",
        );
        if (fs.existsSync(cp)) fs.unlinkSync(cp);
      } catch (e) {}

      // 4. Clear storage data on default session
      try {
        const { session } = require("electron");
        if (session && session.defaultSession) {
          await session.defaultSession.clearStorageData();
        }
      } catch (e) {}

      // 5. Create onboarding window and destroy main window
      const ow = createOnboardingWindow("reauth");
      if (mainWindow && !mainWindow.isDestroyed()) {
        try {
          await mainWindow.webContents.session.clearStorageData();
        } catch (e) {}
        mainWindow.hide();
        ow.once("ready-to-show", () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.destroy();
            mainWindow = null;
          }
        });
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.destroy();
            mainWindow = null;
          }
        }, 1200);
      }

      return { success: true };
    } catch (err) {
      console.error("[Akki] Sign-out error:", err.message);
      return { success: false, error: err.message };
    }
  };

  ipcMain.handle("auth-sign-out", async () => {
    return await performFullSignOut();
  });

  ipcMain.handle("auth-logout-device", async () => {
    return await performFullSignOut();
  });

  ipcMain.handle("auth-stop-callback-server", async () => {
    stopOAuthServer();
    return { success: true };
  });

  ipcMain.handle("auth-start-callback-server", async () => {
    startOAuthServer();
    return { success: true, port: 53921 };
  });

  ipcMain.handle("get-huggingface-token", async () => {
    try {
      if (firebaseService.getCurrentUser()?.uid) {
        const allKeys = await getApiKeys();
        if (allKeys["hfKey"]) return allKeys["hfKey"];
      }
      if (process.env.HUGGINGFACE_API_KEY)
        return process.env.HUGGINGFACE_API_KEY;
      const p = getHFKeyPath();
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, "utf8"));
        return data.key || data.hfKey || data.token || "";
      }
    } catch (e) {}
    return "";
  });
  ipcMain.handle("get-codex-auth-status", async () => ({
    authenticated: false,
  }));

  ipcMain.handle("auth-get-stored", async () => {
    const session = firebaseService.getStoredSession();
    if (session) {
      return {
        email: session.email,
        displayName: session.displayName,
        photoURL: session.photoURL,
        authenticated: true,
      };
    }
    const user = firebaseService.getCurrentUser();
    if (user) {
      return {
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL,
        authenticated: true,
      };
    }
    return { email: null, authenticated: false };
  });

  ipcMain.handle("auth-save", async (event, data) => {
    // Stored locally; actual sync will be via Firebase after login
    try {
      const p = path.join(app.getPath("userData"), "auth_data.json");
      fs.writeFileSync(p, JSON.stringify(data, null, 2));
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle("auth-delete", async () => {
    try {
      const p = path.join(app.getPath("userData"), "auth_data.json");
      if (fs.existsSync(p)) fs.unlinkSync(p);
      return true;
    } catch {
      return false;
    }
  });

  // Checks both authentication and license status
  ipcMain.handle("auth-check-access", async () => {
    const authed = firebaseService.isAuthenticated();
    const licensed = licenseManager.isLicenseApproved();
    const blocked = licenseManager.isLicenseBlocked();
    const access = authed && licensed && !blocked;
    return {
      success: access,
      approved: licensed,
      blocked,
      access,
      message: blocked
        ? "License blocked"
        : licensed
          ? "Access granted"
          : "License not approved",
    };
  });

  // ─── Onboarding IPC Handlers ───────────────────────────────────────────────

  ipcMain.handle("onboarding-save-name", async (event, name) => {
    try {
      const p = path.join(app.getPath("userData"), "onboarding.json");
      const existing = fs.existsSync(p)
        ? JSON.parse(fs.readFileSync(p, "utf8"))
        : {};
      existing.name = name;
      existing.updatedAt = Date.now();
      fs.writeFileSync(p, JSON.stringify(existing, null, 2));
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle("onboarding-save-age", async (event, age) => {
    try {
      const p = path.join(app.getPath("userData"), "onboarding.json");
      const existing = fs.existsSync(p)
        ? JSON.parse(fs.readFileSync(p, "utf8"))
        : {};
      existing.age = parseInt(age);
      existing.updatedAt = Date.now();
      fs.writeFileSync(p, JSON.stringify(existing, null, 2));
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle("onboarding-get-data", async () => {
    try {
      const p = path.join(app.getPath("userData"), "onboarding.json");
      if (!fs.existsSync(p)) return { name: "", age: "", hasData: false };
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      return {
        name: data.name || "",
        age: data.age || "",
        hasData: !!(data.name || data.age),
      };
    } catch {
      return { name: "", age: "", hasData: false };
    }
  });

  ipcMain.handle("onboarding-sign-in", async () => {
    try {
      const oauthConfig = firebaseService.getOAuthConfig();
      if (!oauthConfig)
        return { success: false, error: "OAuth not configured" };

      const { OAuth2Client } = require("google-auth-library");
      const oauth2Client = new OAuth2Client(
        oauthConfig.clientId,
        oauthConfig.clientSecret,
        oauthConfig.redirectUri,
      );

      const authUrl = oauth2Client.generateAuthUrl({
        access_type: "offline",
        prompt: "select_account consent",
        scope: oauthConfig.scope,
        include_granted_scopes: true,
      });

      const oauthPromise = startOAuthServer();
      await shell.openExternal(authUrl);
      const code = await oauthPromise;
      if (!code) return { success: false, error: "Authentication cancelled" };

      const user = await firebaseService.exchangeGoogleCode(code);
      if (!user)
        return { success: false, error: "Failed to authenticate with Google" };

      // Save onboarding data to Firestore profile
      try {
        const p = path.join(app.getPath("userData"), "onboarding.json");
        if (fs.existsSync(p)) {
          const data = JSON.parse(fs.readFileSync(p, "utf8"));
          await firebaseService.saveUserProfile(user.uid, {
            name: data.name || "",
            age: data.age || 0,
          });
        }
      } catch (e) {
        console.warn("[Onboarding] Failed to save profile:", e.message);
      }

      const hwid = licenseManager.generateHardwareId();

      // Register device with Hostinger MySQL backend
      let regStatus = "pending";
      try {
        const regRes = await fetch(
          "https://imakshay.in/akkiai/api/register.php",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              email: user.email,
              name: user.displayName || user.email,
              photo_url: user.photoURL || "",
              hwid: hwid,
              device_name: require("os").hostname(),
              os: process.platform,
              app_version: app.getVersion() || "1.0.57",
            }),
          },
        );
        const regData = await regRes.json();
        if (regData && regData.status) {
          regStatus = regData.status;
        }
      } catch (err) {
        console.warn("[Akki] Hostinger registration warning:", err.message);
      }

      if (regStatus === "approved") {
        licenseManager.approveLicense({
          plan: "pro",
          hardwareId: hwid,
          email: user.email,
        });
        return {
          success: true,
          status: "approved",
          user: {
            uid: user.uid,
            email: user.email,
            displayName: user.displayName,
            photoURL: user.photoURL,
          },
          hwid: hwid,
        };
      } else if (regStatus === "blocked") {
        return {
          success: false,
          status: "blocked",
          error: "Your device access has been blocked by the administrator.",
        };
      } else {
        // Pending approval by administrator
        licenseManager.savePendingLicense({
          uid: user.uid,
          email: user.email,
          plan: "pro",
          hardwareId: hwid,
        });
        startLicenseApprovalWatch(hwid, user.email);
        return {
          success: true,
          status: "pending",
          user: {
            uid: user.uid,
            email: user.email,
            displayName: user.displayName,
            photoURL: user.photoURL,
          },
          hwid: hwid,
        };
      }
    } catch (e) {
      console.error("[Onboarding] Sign-in error:", e.message);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle("onboarding-get-mode", () => (reauthMode ? "reauth" : "full"));

  ipcMain.handle("reauth-complete", async () => {
    try {
      const lic = licenseManager.getLicenseStatus();
      if (lic.status !== "approved") {
        console.warn(
          "[Reauth] Attempted reauth complete without approval. Status:",
          lic.status,
        );
        return false;
      }
      reauthMode = false;
      closeOnboardingWindow();
      if (!mainWindow || mainWindow.isDestroyed()) {
        const win = createWindow();
        setMainWindow(win);
        if (isWakeWordEnabled()) startWakeWordDetector(win);
      }
      return true;
    } catch (e) {
      console.error("[Reauth] Complete error:", e.message);
      return false;
    }
  });

  ipcMain.handle("onboarding-complete", async () => {
    try {
      const lic = licenseManager.getLicenseStatus();
      if (lic.status !== "approved") {
        console.warn(
          "[Onboarding] Attempted to complete onboarding without approval. Status:",
          lic.status,
        );
        return false;
      }
      closeOnboardingWindow();
      if (!mainWindow || mainWindow.isDestroyed()) {
        const win = createWindow();
        setMainWindow(win);
        if (isWakeWordEnabled()) startWakeWordDetector(win);
      }
      return true;
    } catch (e) {
      console.error("[Onboarding] Complete error:", e.message);
      return false;
    }
  });

  // ─── License IPC Handlers ───────────────────────────────────────────────────

  ipcMain.handle("license-get-status", async () => {
    return licenseManager.getLicenseStatus();
  });

  ipcMain.handle("license-get-hardware-id", async () => {
    return licenseManager.generateHardwareId();
  });

  ipcMain.handle(
    "license-submit-payment",
    async (event, { plan, hardwareId }) => {
      return { success: true };
    },
  );

  ipcMain.handle("license-is-blocked", async () => {
    return licenseManager.isLicenseBlocked();
  });

  ipcMain.handle("license-open-whatsapp", async (event, text) => {
    return true;
  });

  ipcMain.handle("splash-transition-complete", async (event) => {
    console.log("[Akki] splash-transition-complete handler entered");
    const win = BrowserWindow.fromWebContents(event.sender);
    let didClearTimeout = false;
    let didShow = false;
    let didFocus = false;
    let didMaximize = false;
    let didRestore = false;
    try {
      if (win) {
        console.log("[Akki] splash-transition-complete: found BrowserWindow");
        if (win.__splashTransitionTimeout) {
          clearTimeout(win.__splashTransitionTimeout);
          win.__splashTransitionTimeout = null;
          didClearTimeout = true;
          console.log("[Akki] splash-transition-complete: timeout cleared");
        } else {
          console.log("[Akki] splash-transition-complete: no timeout to clear");
        }

        console.log(
          "[Akki] splash-transition-complete: splash state updated; preparing window visibility",
        );

        if (!win.isVisible()) {
          win.show();
          didShow = true;
          console.log(
            "[Akki] splash-transition-complete: BrowserWindow.show() called",
          );
        } else {
          console.log(
            "[Akki] splash-transition-complete: BrowserWindow already visible",
          );
        }

        if (!win.isFocused()) {
          win.focus();
          didFocus = true;
          console.log(
            "[Akki] splash-transition-complete: BrowserWindow.focus() called",
          );
        } else {
          console.log(
            "[Akki] splash-transition-complete: BrowserWindow already focused",
          );
        }

        if (win === mainWindow) {
          if (win.isMaximized()) {
            console.log(
              "[Akki] splash-transition-complete: mainWindow already maximized",
            );
          } else {
            win.maximize();
            didMaximize = true;
            console.log(
              "[Akki] splash-transition-complete: mainWindow.maximize() called",
            );
          }
        }
      } else {
        console.log(
          "[Akki] splash-transition-complete: BrowserWindow.fromWebContents returned null",
        );
      }
    } catch (error) {
      console.error("[Akki] splash-transition-complete handler threw", error);
      throw error;
    } finally {
      console.log("[Akki] splash-transition-complete handler completed", {
        didClearTimeout,
        didShow,
        didFocus,
        didMaximize,
        didRestore,
      });
    }
    return true;
  });

  ipcMain.handle("open-neural-browser", async (event, url) => {
    createBrowserWindow(url);
    return true;
  });

  // --- Dynamic HUD Info Panels ---
  // ── HTML Widget Engine ──────────────────────────────────────────────────
  const widgetWindows = new Map();

  ipcMain.handle(
    "open-widget-window",
    async (event, { widgetId, title, htmlContent, width, height, theme }) => {
      if (!widgetId || !htmlContent)
        throw new Error("widgetId and htmlContent are required");

      // Auto-close any previous widget windows so multiple windows do not clutter the desktop (Single Active Widget)
      widgetWindows.forEach((win) => {
        if (win && !win.isDestroyed()) {
          win.close();
        }
      });
      widgetWindows.clear();

      const offset = (widgetWindows.size % 5) * 30;
      const winWidth = width ? Math.min(Math.max(width, 320), 1400) : 760;
      const winHeight = height ? Math.min(Math.max(height, 240), 1000) : 580;

      const widgetWin = new BrowserWindow({
        width: winWidth,
        height: winHeight,
        x: 120 + offset,
        y: 90 + offset,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        alwaysOnTop: true,
        resizable: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          devTools: false,
        },
        icon: nativeImage.createFromPath(
          process.env.NODE_ENV === "development"
            ? path.join(__dirname, "../public/logo.png")
            : path.join(process.resourcesPath, "public/logo.png"),
        ),
      });

      widgetWindows.set(widgetId, widgetWin);

      const safeTitle = (title || "Akki Widget")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;");
      const safeWidgetId = (widgetId || "widget")
        .toUpperCase()
        .replace(/"/g, "")
        .replace(/</g, "");
      const activeTheme = (theme || "cyan").toLowerCase();

      const themeMap = {
        cyan: {
          border: "rgba(0, 229, 255, 0.25)",
          borderHover: "rgba(0, 229, 255, 0.45)",
          glow: "rgba(0, 229, 255, 0.15)",
          accent: "#00e5ff",
          headerGlow: "rgba(0, 229, 255, 0.15)",
          badgeBg: "rgba(0, 229, 255, 0.1)",
          badgeBorder: "rgba(0, 229, 255, 0.2)",
          badgeText: "#00e5ff",
          badgeLabel: "CYAN LINK",
        },
        amber: {
          border: "rgba(255, 199, 0, 0.25)",
          borderHover: "rgba(255, 199, 0, 0.45)",
          glow: "rgba(255, 199, 0, 0.15)",
          accent: "#ffc700",
          headerGlow: "rgba(255, 199, 0, 0.15)",
          badgeBg: "rgba(255, 199, 0, 0.1)",
          badgeBorder: "rgba(255, 199, 0, 0.2)",
          badgeText: "#ffc700",
          badgeLabel: "AMBER LINK",
        },
        crimson: {
          border: "rgba(255, 46, 46, 0.25)",
          borderHover: "rgba(255, 46, 46, 0.45)",
          glow: "rgba(255, 46, 46, 0.15)",
          accent: "#ff2e2e",
          headerGlow: "rgba(255, 46, 46, 0.15)",
          badgeBg: "rgba(255, 46, 46, 0.1)",
          badgeBorder: "rgba(255, 46, 46, 0.2)",
          badgeText: "#ff2e2e",
          badgeLabel: "CRIMSON LINK",
        },
        emerald: {
          border: "rgba(0, 255, 163, 0.25)",
          borderHover: "rgba(0, 255, 163, 0.45)",
          glow: "rgba(0, 255, 163, 0.15)",
          accent: "#00ffa3",
          headerGlow: "rgba(0, 255, 163, 0.15)",
          badgeBg: "rgba(0, 255, 163, 0.1)",
          badgeBorder: "rgba(0, 255, 163, 0.2)",
          badgeText: "#00ffa3",
          badgeLabel: "EMERALD LINK",
        },
        blue: {
          border: "rgba(0, 133, 255, 0.25)",
          borderHover: "rgba(0, 133, 255, 0.45)",
          glow: "rgba(0, 133, 255, 0.15)",
          accent: "#0085ff",
          headerGlow: "rgba(0, 133, 255, 0.15)",
          badgeBg: "rgba(0, 133, 255, 0.1)",
          badgeBorder: "rgba(0, 133, 255, 0.2)",
          badgeText: "#0085ff",
          badgeLabel: "BLUE LINK",
        },
      };

      const t = themeMap[activeTheme] || themeMap.cyan;

      const fullHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${safeTitle}</title>
<style>
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: 100vw;
    height: 100vh;
    overflow: hidden;
    background: transparent;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  }
  .hud-container {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    border-radius: 16px;
    overflow: hidden;
    position: relative;
    border: 1px solid ${t.border};
    background: rgba(8, 13, 18, 0.95);
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    box-shadow: 0 0 25px ${t.glow}, 0 20px 50px rgba(0, 0, 0, 0.8);
    color: #e1f8ff;
    transition: all 0.3s ease;
  }
  .hud-container:hover {
    border-color: ${t.borderHover};
  }
  .hud-scanline {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 50;
    opacity: 0.04;
    background: linear-gradient(rgba(18, 16, 16, 0) 50%, rgba(0, 0, 0, 0.25) 50%), linear-gradient(90deg, rgba(255, 0, 0, 0.06), rgba(0, 255, 0, 0.02), rgba(0, 255, 0, 0.06));
    background-size: 100% 2px, 3px 100%;
  }
  .hud-inner-border {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 50;
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 16px;
  }
  .hud-header {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 20px;
    background: rgba(0, 0, 0, 0.6);
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    user-select: none;
    cursor: move;
    -webkit-app-region: drag;
    position: relative;
    z-index: 20;
  }
  .hud-header-glow {
    position: absolute;
    inset: 0 auto 0 0;
    width: 35%;
    background: linear-gradient(to right, ${t.headerGlow}, transparent);
    pointer-events: none;
    z-index: 0;
    opacity: 0.4;
  }
  .hud-header-left {
    position: relative;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .hud-header-titles {
    display: flex;
    flex-direction: column;
  }
  .hud-title {
    font-size: 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: #ffffff;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 420px;
  }
  .hud-subtitle {
    font-size: 9px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    color: ${t.accent};
    opacity: 0.7;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    margin-top: 1px;
  }
  .hud-header-right {
    position: relative;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 10px;
    -webkit-app-region: no-drag;
  }
  .hud-badge {
    padding: 3px 8px;
    border-radius: 4px;
    font-size: 9px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    background: ${t.badgeBg};
    border: 1px solid ${t.badgeBorder};
    color: ${t.badgeText};
  }
  .hud-close-btn {
    width: 26px;
    height: 26px;
    border-radius: 6px;
    border: 1px solid transparent;
    background: transparent;
    color: rgba(255, 255, 255, 0.4);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
  }
  .hud-close-btn:hover {
    color: #ffffff;
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.15);
  }
  .hud-close-btn:active {
    transform: scale(0.95);
  }
  .hud-body {
    flex: 1;
    overflow-y: auto;
    padding: 24px 28px;
    position: relative;
    z-index: 10;
    user-select: text;
    font-size: 13px;
    line-height: 1.6;
    color: #cbd5e1;
  }
  .hud-body::-webkit-scrollbar {
    width: 4px;
  }
  .hud-body::-webkit-scrollbar-track {
    background: transparent;
  }
  .hud-body::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.1);
    border-radius: 9999px;
  }
  .hud-body::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.25);
  }
  .hud-footer {
    flex: none;
    padding: 9px 20px;
    background: rgba(0, 0, 0, 0.4);
    border-top: 1px solid rgba(255, 255, 255, 0.04);
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 8px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    color: rgba(255, 255, 255, 0.3);
    text-transform: uppercase;
    letter-spacing: 0.15em;
    position: relative;
    z-index: 20;
    user-select: none;
  }
  .hud-status {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .hud-status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: ${t.accent};
    box-shadow: 0 0 8px ${t.accent};
    animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  }
</style>
</head>
<body>
  <div class="hud-container">
    <div class="hud-scanline"></div>
    <div class="hud-inner-border"></div>
    <div class="hud-header">
      <div class="hud-header-glow"></div>
      <div class="hud-header-left">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${t.accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
          <polyline points="2 17 12 22 22 17"></polyline>
          <polyline points="2 12 12 17 22 12"></polyline>
        </svg>
        <div class="hud-header-titles">
          <span class="hud-title">${safeTitle}</span>
          <span class="hud-subtitle">PORTAL LINK: ${safeWidgetId}</span>
        </div>
      </div>
      <div class="hud-header-right">
        <span class="hud-badge">${t.badgeLabel}</span>
        <button class="hud-close-btn" onclick="window.close()" title="Close Portal">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    </div>
    <div class="hud-body">
      ${htmlContent}
    </div>
    <div class="hud-footer">
      <div class="hud-status">
        <div class="hud-status-dot"></div>
        <span>SIGNAL SYNCHRONIZED</span>
      </div>
      <span>Akki Engine v1.8.0</span>
    </div>
  </div>
</body>
</html>`;

      widgetWin.loadURL(
        "data:text/html;charset=utf-8," + encodeURIComponent(fullHtml),
      );

      widgetWin.on("closed", () => {
        widgetWindows.delete(widgetId);
      });

      return { success: true, widgetId };
    },
  );

  ipcMain.handle("close-widget-window", async (event, widgetId) => {
    if (widgetId === "all") {
      widgetWindows.forEach((win) => {
        if (!win.isDestroyed()) win.close();
      });
      widgetWindows.clear();
      return true;
    }
    const win = widgetWindows.get(widgetId);
    if (win && !win.isDestroyed()) {
      win.close();
      return true;
    }
    const pWin = infoPanelWindows.get(widgetId);
    if (pWin && !pWin.isDestroyed()) {
      pWin.close();
      return true;
    }
    return false;
  });

  ipcMain.handle(
    "open-info-panel",
    async (event, { panelId, title, content, theme }) => {
      if (!panelId) throw new Error("panelId is required");
      infoPanelData.set(panelId, { title, content, theme: theme || "cyan" });

      // SINGLETON ENFORCEMENT: Close all other active info panels to prevent stacking
      for (const [existingId, win] of infoPanelWindows.entries()) {
        if (existingId !== panelId && !win.isDestroyed()) {
          win.close();
        }
      }
      // Also clear the map of closed windows just to be clean
      for (const [existingId, win] of infoPanelWindows.entries()) {
        if (win.isDestroyed()) {
          infoPanelWindows.delete(existingId);
        }
      }

      const existing = infoPanelWindows.get(panelId);
      if (existing && !existing.isDestroyed()) {
        // Same panel already open — push the new content live instead of re-creating
        existing.webContents.send(
          "info-panel-updated",
          infoPanelData.get(panelId),
        );
        existing.focus();
      } else {
        createInfoPanelWindow(panelId);
      }
      return true;
    },
  );

  ipcMain.handle("get-info-panel-data", async (event, panelId) => {
    return infoPanelData.get(panelId) || null;
  });

  ipcMain.handle("close-info-panel", async (event, panelId) => {
    if (panelId === "visual_hub" && mainWindow) {
      mainWindow.webContents.send("restore-visual-hub");
      return true;
    }
    if (panelId === "media-player") {
      videoWindows.forEach((win) => {
        if (!win.isDestroyed()) win.close();
      });
      return true;
    }
    if (panelId === "all") {
      infoPanelWindows.forEach((win) => {
        if (!win.isDestroyed()) win.close();
      });
      return true;
    }
    const win = infoPanelWindows.get(panelId);
    if (win && !win.isDestroyed()) {
      win.close();
      return true;
    }
    throw new Error(`No open panel found with ID "${panelId}"`);
  });
  // Listener removed from here to global scope

  // Custom Models Persistence
  ipcMain.handle("get-custom-models", async () => {
    try {
      const p = getCustomModelsPath();
      if (fs.existsSync(p)) {
        const saved = JSON.parse(fs.readFileSync(p, "utf8"));
        return {
          openRouter: Array.isArray(saved?.openRouter) ? saved.openRouter : [],
          gemini: Array.isArray(saved?.gemini) ? saved.gemini : [],
          openai: Array.isArray(saved?.openai) ? saved.openai : [],
        };
      }
      return { openRouter: [], gemini: [], openai: [] };
    } catch (e) {
      return { openRouter: [], gemini: [], openai: [] };
    }
  });

  ipcMain.handle("save-custom-models", async (event, models) => {
    try {
      const normalizedModels = {
        openRouter: Array.isArray(models?.openRouter) ? models.openRouter : [],
        gemini: Array.isArray(models?.gemini) ? models.gemini : [],
        openai: Array.isArray(models?.openai) ? models.openai : [],
      };
      fs.writeFileSync(
        getCustomModelsPath(),
        JSON.stringify(normalizedModels, null, 2),
      );
      return true;
    } catch (e) {
      return false;
    }
  });

  // ---------------------------------------
  //  BOOTSTRAP FILE SYSTEM (.hermes/)
  // ---------------------------------------

  ipcMain.handle("read-raw-memory", async () => {
    try {
      const hermesDir = path.join(os.homedir(), ".hermes");
      const filePath = path.join(hermesDir, "memories", "MEMORY.md");
      if (fs.existsSync(filePath)) return fs.readFileSync(filePath, "utf8");
      return "";
    } catch {
      return "";
    }
  });



  // Read all bootstrap files for system prompt injection
  ipcMain.handle("read-bootstrap-files", async () => {
    try {
      const hermesDir = path.join(os.homedir(), ".hermes");
      const hermesMemoriesDir = path.join(hermesDir, "memories");

      const readSafely = (filePath) => {
        try {
          if (fs.existsSync(filePath)) return fs.readFileSync(filePath, "utf8");
          return "";
        } catch {
          return "";
        }
      };

      // Read SOUL.md and MEMORY.md (USER.md is deprecated)
      const soul = readSafely(path.join(hermesDir, "SOUL.md"));
      const memory = readSafely(path.join(hermesMemoriesDir, "MEMORY.md"));

      // Dynamic Instruction Injection for Info Panels & Agent Town Routing
      let finalMemory = memory;
      const dynamicRules = `\n---
CRITICAL SYSTEM DIRECTIVES: 
1. UI ENFORCEMENT: For stock quotes and lists: Present the data as a clean Markdown table using open_info_panel. For News and General Research: Provide a DETAILED, comprehensive response. Read the search results and write a well-formatted analytical report in the panel. NEVER just dump a raw list of search links. ALWAYS include source URLs as clickable markdown links. DO NOT use HTML tags. If updating existing information, you MUST execute close_panel first, before executing open_info_panel. FOR WEATHER QUERIES: DO NOT use open_info_panel. Just reply directly in the chat/voice.
  4. MERMAID DIAGRAMS: When using generate_diagram or mermaid_render, NEVER use inline classes (like :::class). Keep syntax extremely basic: NodeA["Text"] --> NodeB["Text"]. DO NOT use HTML tags inside node text. Failure to follow this will cause a PARSE ERROR. If the user asks to close, shrink, minimize or go back from the visual hub or diagram, use the close_panel tool with panel_id: "visual_hub".
    5. HTML WIDGET ENGINE & DIRECT WEB CODING: When the user asks for any interactive UI, calculator, portfolio, personal website, web page, landing page, mini-game, chart, form, data visualization, or any rich visual component, use the render_widget tool directly. DO NOT send these to Agent Town. Write complete self-contained HTML with inline CSS and JS inside script tags. The widget window renders in the exact same HUD Info Panel design and size (760x580, rounded glass corners, cyan neon glow, scanlines, and titlebar). Only ONE widget window is kept open at a time; rendering a new widget automatically replaces and closes the previous one. To close a widget, use close_widget. VISUAL CONTRAST GUARANTEE: When generating any HTML widget or panel, ALWAYS ensure text color strongly contrasts with the background. Dark backgrounds (#060B16, #0D1525, #080D12, #000, or similar very dark colors) must use white (#fff), light gray (#e5e7eb), or bright accent text (#00e5ff, #0a84ff). NEVER place dark text on a dark background or light text on a light background. If uncertain about contrast, default to white text on a dark background. GLOBAL CLOSE RULE: When the user asks to "close all", "clear screen", or "close panels", you MUST execute BOTH 'close_panel' (with panel_id: "all") AND 'close_widget' (with widget_id: "all") simultaneously in the same turn to ensure the screen is completely cleared.
  6. FILE SAVING & EXPLICIT CONFIRMATION: When the user asks to save an existing HTML widget, design, or code to the Desktop or a file (e.g. 'Desktop-e save koro' or 'save as html'):
     - Execute 'fs_write' to write the file directly to the user Desktop.
     - DO NOT call 'render_widget' again when the user is only asking to save! The widget is already created.
     - You MUST ALWAYS verbally inform and explicitly confirm to the user immediately after saving, stating the exact filename and location (for example: 'আমি আপনার ফাইলের নাম [filename] দিয়ে ডেক্সটপে সেভ করে দিয়েছি।'). Never remain silent after saving.
2. AGENT TOWN ROUTING LIMITS: NEVER use 'agent_assign_task' or any Agent Town subagents (Leo, Rancho, Raju, Chatur) for weather, live stock market data, top gainers, or simple news/web lookups. Strictly rely only on the text data returned by your 'web_search' tool to prevent quota exhaustion. Do the search YOURSELF immediately.
3. AGENT TOWN CONTENT EXTRACTION: For whatever complex task you DO assign to Agent Town, append this rule to the task description: "When browsing, you are free to visit as many pages as necessary. However, DO NOT ingest or retain raw HTML, CSS, or JavaScript in your memory. You must extract ONLY the essential data relevant to the task using content extraction, summarize it into a short note, and completely discard the heavy page code before moving to the next page."
7. SEARCH TOOL SELECTION: Use 'web_search' for quick factual 1-line queries (time, basic facts, unit conversion, current weather). Use 'deep_search' for stock prices, earnings reports, financial analysis, in-depth news articles, research papers, or whenever the user needs detailed analysis or images. 'deep_search' returns full Markdown including image links and tables. Always open deep_search results in the Info Panel via open_info_panel. If 'deep_search' returns an error or empty result, it has already silently fallen back to native search — just use the result as-is.`;
      finalMemory += dynamicRules;

      return {
        soul,
        user: "", // USER.md deprecated
        memory: finalMemory,
      };
    } catch (e) {
      console.error("[Bootstrap] Failed to read bootstrap files:", e);
      return { soul: "", user: "", memory: "" };
    }
  });

  // Write/update a bootstrap file (SOUL.md or MEMORY.md)
  ipcMain.handle(
    "write-bootstrap-file",
    async (event, { filename, content }) => {
      try {
        // Security: only allow specific files
        const allowedFiles = ["SOUL.md", "MEMORY.md"];
        if (!allowedFiles.includes(filename)) {
          console.warn(
            `[Bootstrap] Blocked write to unauthorized file: ${filename}`,
          );
          return false;
        }

        const hermesDir = path.join(os.homedir(), ".hermes");
        const hermesMemoriesDir = path.join(hermesDir, "memories");

        let filePath;
        if (filename === "SOUL.md") {
          filePath = path.join(hermesDir, filename);
        } else {
          filePath = path.join(hermesMemoriesDir, filename);
          

        }

        const parentDir = path.dirname(filePath);
        if (!fs.existsSync(parentDir))
          fs.mkdirSync(parentDir, { recursive: true });

        fs.writeFileSync(filePath, content, "utf8");
        console.log(`[Bootstrap] Updated ${filename} at ${filePath}`);
        return true;
      } catch (e) {
        console.error(`[Bootstrap] Failed to write ${filename}:`, e);
        return false;
      }
    },
  );

  // Wake Word Detector toggle (default OFF — saves CPU/mic when not needed)
  ipcMain.handle("get-wake-word-enabled", async () => {
    return isWakeWordEnabled();
  });

  ipcMain.handle("set-wake-word-enabled", async (event, enabled) => {
    try {
      fs.writeFileSync(
        getWakeWordSettingsPath(),
        JSON.stringify({ enabled: !!enabled }, null, 2),
      );
      // Apply immediately so the user doesn't have to restart the app.
      if (enabled) {
        if (mainWindow) startWakeWordDetector(mainWindow);
      } else {
        stopWakeWordDetector();
      }
      return true;
    } catch (e) {
      return false;
    }
  });

  // Automatic Updates Toggle Handlers
  ipcMain.handle("get-auto-update-enabled", async () => {
    return getAutoUpdateEnabled();
  });

  ipcMain.handle("save-auto-update-enabled", async (event, enabled) => {
    try {
      fs.writeFileSync(
        getAutoUpdateSettingsPath(),
        JSON.stringify({ enabled: !!enabled, updatedAt: Date.now() }, null, 2),
      );

      // While updates are disabled the toggle is stored (Settings UI unchanged)
      // but never applied, so ON and OFF both have no effect.
      if (!UPDATES_ENABLED) {
        console.log(
          "[Akki] Auto-update setting saved but not applied: updates are disabled in this version.",
        );
        return true;
      }

      // Dynamically apply to autoUpdater if not in development
      if (process.env.NODE_ENV !== "development") {
        try {
          if (process.platform === "darwin") {
            const { setMacAutoDownload } = require("./services/macos-updater");
            setMacAutoDownload(!!enabled);
          } else {
            const { autoUpdater } = require("electron-updater");
            autoUpdater.autoDownload = !!enabled;
          }
          console.log(
            `[Akki] Auto-update setting changed dynamically. autoDownload = ${!!enabled}`,
          );
        } catch (err) {
          console.error(
            "Failed to dynamically update autoUpdater settings:",
            err,
          );
        }
      }
      return true;
    } catch (e) {
      return false;
    }
  });

  ipcMain.handle("download-update", async () => {
    if (!UPDATES_ENABLED) {
      console.log(
        "[Akki] download-update ignored: updates are disabled in this version.",
      );
      return { disabled: true };
    }
    if (process.env.NODE_ENV === "development") {
      console.log("[Akki Dev] download-update invoked in development mode.");
      return null;
    }
    if (process.platform === "darwin") {
      const { macDownloadUpdate } = require("./services/macos-updater");
      return macDownloadUpdate();
    }
    const { autoUpdater } = require("electron-updater");
    return autoUpdater.downloadUpdate();
  });

  ipcMain.handle(
    "fetch-dashboard-data",
    async (event, { location, interests }) => {
      try {
        let apiKey = process.env.GEMINI_API_KEY;
        // Resolve model and optional per-tool API key from tools_config.json
        let model = "gemini-2.0-flash";
        let fallbackModel = "gemini-2.0-flash-lite";
        let enableFallback = true;
        try {
          const cfg = toolsConfigManager.readConfig();
          const t = (cfg.tools && cfg.tools.dashboard_fetch) || {};
          model =
            toolsConfigManager.getEffectiveModel("dashboard_fetch") || model;
          fallbackModel =
            t.fallbackModel || cfg.defaultGlobalFallbackModel || fallbackModel;
          enableFallback =
            t.enableFallback !== false && cfg.enableGlobalFallback !== false;
          if (
            t.usePrimaryApiKey === false &&
            t.customApiKey &&
            t.customApiKey.trim()
          ) {
            apiKey = t.customApiKey.trim();
          }
        } catch (cfgErr) {
          console.warn(
            "[Dashboard] tools_config unavailable, using defaults:",
            cfgErr?.message || cfgErr,
          );
        }
        if (!apiKey) throw new Error("API Key missing");
        const ai = new GoogleGenAI({ apiKey });
        const prompt = `Search for top 5 news headlines for: ${interests.join(", ")} in ${location || "West Bengal, India"}. Also get weather. Respond in Hindi (or in the same language as any user preference). Return JSON: {"headlines": [...], "weather": {"today": "...", "tomorrow": "...", "dayAfter": "..."}}`;
        const runDashboard = (modelId) =>
          ai.models.generateContent({
            model: modelId,
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: {},
          });
        let result;
        try {
          result = await runDashboard(model);
        } catch (primaryErr) {
          const msg = String(primaryErr?.message || primaryErr || "");
          const notFound =
            primaryErr?.status === 404 || /404|not found|NOT_FOUND/i.test(msg);
          if (!enableFallback || !fallbackModel || fallbackModel === model)
            throw primaryErr;
          console.warn(
            `[Dashboard] Model ${model} failed, retrying with fallback ${fallbackModel}`,
          );
          if (notFound) toolsConfigManager.markModelRetired("dashboard_fetch");
          result = await runDashboard(fallbackModel);
        }
        let text = "";
        if (typeof result?.text === "string") text = result.text;
        else if (result?.candidates?.[0]?.content?.parts?.length) {
          text = result.candidates[0].content.parts
            .map((p) => p.text || "")
            .join("");
        }
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch)
          return {
            headlines: ["Error parsing data"],
            weather: { today: "N/A" },
          };
        try {
          return JSON.parse(jsonMatch[0]);
        } catch (parseErr) {
          console.warn("[Dashboard] JSON parse failed:", parseErr.message);
          return {
            headlines: ["Error parsing data"],
            weather: { today: "N/A" },
          };
        }
      } catch (error) {
        return {
          headlines: [`Error: ${error.message}`],
          weather: { today: "Error ??" },
        };
      }
    },
  );

  // ---------------------------------------
  //  AGENT REPORTS INBOX
  //  Durable store for Agent Town completion reports so nothing is lost when
  //  the voice session is off. Bounded + self-cleaning to avoid clutter:
  //    - delivered (already read) reports expire after 24h
  //    - at most 5 reports kept per agent
  //    - at most 20 reports total (oldest dropped first, undelivered favored)
  // ---------------------------------------
  const AGENT_REPORTS_MAX_TOTAL = 20;
  const AGENT_REPORTS_MAX_PER_AGENT = 5;
  const AGENT_REPORTS_DELIVERED_TTL_MS = 24 * 60 * 60 * 1000;

  const readAgentReports = () => {
    try {
      const p = getAgentReportsPath();
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
        return Array.isArray(parsed)
          ? parsed.filter((r) => r && typeof r === "object")
          : [];
      }
    } catch (e) {
      /* corrupt/missing → start fresh */
    }
    return [];
  };

  const writeAgentReports = (reports) => {
    try {
      fs.writeFileSync(getAgentReportsPath(), JSON.stringify(reports, null, 2));
      return true;
    } catch (e) {
      return false;
    }
  };

  // Enforce the bounds. Undelivered reports are protected (never expire, kept
  // even when over the global cap) so a report can't be lost before it is read.
  const cleanupAgentReports = (reports) => {
    const now = Date.now();

    // 1. Drop delivered reports past their TTL. Undelivered are always kept.
    let kept = reports.filter((r) => {
      if (
        r.delivered &&
        r.deliveredAt &&
        now - r.deliveredAt > AGENT_REPORTS_DELIVERED_TTL_MS
      )
        return false;
      return true;
    });

    // 2. Newest first.
    kept.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));

    // 3. Per-agent cap (newest N per agent).
    const perAgent = {};
    kept = kept.filter((r) => {
      const key = String(r.agentName || "unknown").toLowerCase();
      perAgent[key] = (perAgent[key] || 0) + 1;
      return perAgent[key] <= AGENT_REPORTS_MAX_PER_AGENT;
    });

    // 4. Global cap — keep all undelivered, fill the rest with the newest
    //    delivered ones (FIFO drop of oldest delivered).
    if (kept.length > AGENT_REPORTS_MAX_TOTAL) {
      const undelivered = kept.filter((r) => !r.delivered);
      const delivered = kept.filter((r) => r.delivered);
      const room = Math.max(0, AGENT_REPORTS_MAX_TOTAL - undelivered.length);
      kept = [...undelivered, ...delivered.slice(0, room)].sort(
        (a, b) => (b.completedAt || 0) - (a.completedAt || 0),
      );
    }

    return kept;
  };

  // Append a freshly completed report.
  ipcMain.handle("agent-report-add", async (event, payload) => {
    try {
      const result = String(payload?.result || "").trim();
      if (!result) return null;
      const entry = {
        id: `rep_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        agentName: String(payload?.agentName || "Agent").trim() || "Agent",
        taskSummary: String(payload?.taskSummary || "")
          .trim()
          .slice(0, 200),
        result: result.slice(0, 8000),
        completedAt: Date.now(),
        delivered: false,
        deliveredAt: null,
      };
      writeAgentReports(cleanupAgentReports([entry, ...readAgentReports()]));
      return entry;
    } catch (e) {
      return null;
    }
  });

  // Reports the voice assistant has not surfaced yet (oldest first).
  ipcMain.handle("agent-reports-undelivered", async () => {
    try {
      return readAgentReports()
        .filter((r) => !r.delivered)
        .sort((a, b) => (a.completedAt || 0) - (b.completedAt || 0));
    } catch (e) {
      return [];
    }
  });

  // Mark reports as read once the assistant has surfaced them.
  ipcMain.handle("agent-reports-mark-delivered", async (event, ids) => {
    try {
      const idSet = new Set(Array.isArray(ids) ? ids : []);
      if (idSet.size === 0) return true;
      const now = Date.now();
      const updated = readAgentReports().map((r) =>
        idSet.has(r.id) ? { ...r, delivered: true, deliveredAt: now } : r,
      );
      return writeAgentReports(cleanupAgentReports(updated));
    } catch (e) {
      return false;
    }
  });

  // Recent reports for on-demand recall ("what did Leo do?"), newest first.
  ipcMain.handle("agent-reports-recent", async (event, opts) => {
    try {
      const limit = Math.max(1, Math.min(20, Number(opts?.limit) || 10));
      const agentName = opts?.agentName
        ? String(opts.agentName).toLowerCase()
        : null;
      let reports = readAgentReports();
      if (agentName)
        reports = reports.filter(
          (r) => String(r.agentName || "").toLowerCase() === agentName,
        );
      return reports
        .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
        .slice(0, limit);
    } catch (e) {
      return [];
    }
  });

  const getMarkdownNotesPath = () => {
    const akkiPath = path.join(app.getPath("documents"), "Akki Data");
    const stonicPath = path.join(app.getPath("documents"), "Stonic Data");
    if (fs.existsSync(akkiPath)) return akkiPath;
    return stonicPath;
  };

  ipcMain.handle("get-documents-path", async () => {
    return app.getPath("documents");
  });

  ipcMain.handle("get-desktop-path", async () => {
    return app.getPath("desktop");
  });

  ipcMain.handle("get-downloads-path", async () => {
    return app.getPath("downloads");
  });

  ipcMain.handle("get-system-paths", async () => {
    return {
      desktop: app.getPath("desktop"),
      documents: app.getPath("documents"),
      downloads: app.getPath("downloads"),
      pictures: app.getPath("pictures"),
      music: app.getPath("music"),
      videos: app.getPath("videos"),
      home: app.getPath("home"),
      appData: app.getPath("appData"),
      userData: app.getPath("userData"),
      temp: app.getPath("temp"),
    };
  });

  ipcMain.handle("get-notes-path", async () => {
    const notesPath = path.join(app.getPath("documents"), "Akki Data");
    const legacyNotesPath = path.join(app.getPath("documents"), "Stonic Data");
    if (!fs.existsSync(notesPath)) {
      if (fs.existsSync(legacyNotesPath)) {
        return legacyNotesPath;
      }
      fs.mkdirSync(notesPath, { recursive: true });
    }
    return notesPath;
  });

  // Returns Akki Data folder path
  ipcMain.handle("get-akki-data-path", async () => {
    const akkiDataPath = path.join(app.getPath("documents"), "Akki Data");
    const legacyDataPath = path.join(app.getPath("documents"), "Stonic Data");
    if (fs.existsSync(akkiDataPath)) return akkiDataPath;
    if (fs.existsSync(legacyDataPath)) return legacyDataPath;
    fs.mkdirSync(akkiDataPath, { recursive: true });
    return akkiDataPath;
  });

  // Legacy alias
  ipcMain.handle("get-stonic-data-path", async () => {
    const legacyDataPath = path.join(app.getPath("documents"), "Stonic Data");
    if (fs.existsSync(legacyDataPath)) return legacyDataPath;
    const akkiDataPath = path.join(app.getPath("documents"), "Akki Data");
    if (fs.existsSync(akkiDataPath)) return akkiDataPath;
    fs.mkdirSync(legacyDataPath, { recursive: true });
    return legacyDataPath;
  });

  // Vault & Folders
  ipcMain.handle("initialize-vault", async () => {
    console.log("IPC: Initializing Vault...");
    try {
      // 1. Initialize Markdown Notes Folder (ONLY)
      const notesDir = getMarkdownNotesPath();
      if (!fs.existsSync(notesDir)) {
        fs.mkdirSync(notesDir, { recursive: true });
        console.log("IPC: Re-created Akki Data:", notesDir);
      }

      return { notesDir };
    } catch (e) {
      console.error("IPC: Vault Initialization Failed:", e);
      // Fallback: Return at least the notes path
      try {
        return { notesDir: getMarkdownNotesPath() };
      } catch (err) {
        return null;
      }
    }
  });

  ipcMain.handle("open-vault-folder", async (event, folderName) => {
    try {
      const folderPath = path.join(getVaultPath(), folderName);
      const open = (await import("open")).default;
      await open(folderPath);
      return true;
    } catch (e) {
      return false;
    }
  });

  ipcMain.handle("load-imported-folders", async () => {
    try {
      const p = getFolderConfigPath();
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
      return [];
    } catch (e) {
      return [];
    }
  });

  ipcMain.handle("save-imported-folders", async (event, folders) => {
    try {
      fs.writeFileSync(getFolderConfigPath(), JSON.stringify(folders, null, 2));
      return true;
    } catch (e) {
      return false;
    }
  });

  ipcMain.handle("pick-folder", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "Select Folder to Import",
    });
    if (canceled || filePaths.length === 0) return null;
    return {
      name: path.basename(filePaths[0]),
      path: filePaths[0],
    };
  });

  ipcMain.handle("register-vertex-token", async (event, token) => {
    currentVertexToken = token;
    return true;
  });

  // Sub-Agent Model Config (OpenRouter model selection for background workers)
  ipcMain.handle("get-sub-agent-config", async () => {
    try {
      const p = getSubAgentConfigPath();
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, "utf8"));
        return {
          enabled: Boolean(data.enabled),
          modelId: data.modelId || "",
        };
      }
      return { enabled: false, modelId: "" };
    } catch (e) {
      return { enabled: false, modelId: "" };
    }
  });

  ipcMain.handle("save-sub-agent-config", async (event, config) => {
    try {
      const normalized = {
        enabled: Boolean(config?.enabled),
        modelId: String(config?.modelId || "").trim(),
        updatedAt: Date.now(),
      };
      fs.writeFileSync(
        getSubAgentConfigPath(),
        JSON.stringify(normalized, null, 2),
      );
      return true;
    } catch (e) {
      return false;
    }
  });

  // Agent Town Config (Hermes provider + model)
  ipcMain.handle("get-agent-town-config", async () => {
    try {
      const p = getAgentTownConfigPath();
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
      return {
        provider: "gemini",
        apiKey: "",
        modelId: "gemini-3.1-flash-lite",
      };
    } catch (e) {
      return { provider: "gemini", apiKey: "", modelId: "" };
    }
  });

  ipcMain.handle("save-agent-town-config", async (event, config) => {
    try {
      const normalized = {
        provider:
          config.provider === "openrouter"
            ? "openrouter"
            : config.provider === "openai-codex"
              ? "openai-codex"
              : "gemini",
        apiKey: String(config.apiKey || "").trim(),
        geminiApiKey: String(config.geminiApiKey || "").trim(),
        openRouterApiKey: String(config.openRouterApiKey || "").trim(),
        modelId: String(config.modelId || "").trim(),
        updatedAt: Date.now(),
      };
      fs.writeFileSync(
        getAgentTownConfigPath(),
        JSON.stringify(normalized, null, 2),
      );
      // Sync model/provider into ~/.hermes/config.yaml
      if (normalized.modelId) {
        updateHermesModelConfig(normalized.provider, normalized.modelId);
      }
      return true;
    } catch (e) {
      return false;
    }
  });

  ipcMain.handle("launch-browser-login-session", async () => {
    try {
      const { execSync } = require("child_process");

      // 1. Kill existing processes using the profile or port 9222 to release locks
      try {
        if (process.platform === "win32") {
          execSync(
            "wmic process where \"name='chrome.exe' and commandline like '%chrome-debug-profile%'\" call terminate",
            { stdio: "ignore" },
          );
          execSync(
            "wmic process where \"name='chrome.exe' and commandline like '%--remote-debugging-port=9222%'\" call terminate",
            { stdio: "ignore" },
          );
        } else {
          // macOS/Linux equivalent of the wmic cleanup above
          execSync('pkill -f "chrome-debug-profile" || true', {
            stdio: "ignore",
          });
          execSync(
            'pkill -f "remote-debugging-port=9222.*chrome-debug-profile" || true',
            { stdio: "ignore" },
          );
        }
      } catch (e) {
        // Ignore
      }

      // 2. Resolve paths for standard Chrome (per-user profile for isolation)
      const hermesHome =
        process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
      const uid = firebaseService.getCurrentUser()?.uid || "shared";
      const chromeUserDataDir = path.join(
        hermesHome,
        "chrome-debug-profile-" + uid,
      );

      let chromePath = null;
      if (process.platform === "win32") {
        const paths = [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          path.join(
            process.env.LOCALAPPDATA || "",
            "Google\\Chrome\\Application\\chrome.exe",
          ),
        ];
        chromePath = paths.find((p) => fs.existsSync(p));
      } else if (process.platform === "darwin") {
        chromePath =
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
      } else {
        chromePath = "google-chrome";
      }

      if (
        !chromePath ||
        (process.platform === "win32" && !fs.existsSync(chromePath))
      ) {
        return {
          success: false,
          error:
            "Google Chrome was not found on your system. Please install standard Google Chrome.",
        };
      }

      // 3. Spawn standard Chrome with the profile dir and debugging port
      const child = spawn(
        chromePath,
        [
          `--user-data-dir=${chromeUserDataDir}`,
          `--remote-debugging-port=9222`,
          `--enable-automation=false`,
          `--disable-blink-features=AutomationControlled`,
          "https://accounts.google.com",
        ],
        {
          detached: true,
          stdio: "ignore",
        },
      );
      child.unref();

      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("validate-huggingface-token", async (event, apiKey) => {
    try {
      const { HfInference } = require("@huggingface/inference");
      const hf = new HfInference(apiKey);
      // Lightweight validation: list models (cheapest HF API call)
      await hf.listModels({ limit: 1 });
      return { valid: true };
    } catch (e) {
      return { valid: false, error: e.message };
    }
  });

  // Save image file to disk (called from preload after HF API call via renderer context)
  ipcMain.handle("save-image-file", async (event, { buffer, prompt }) => {
    try {
      const outputCfgPath = path.join(
        app.getPath("userData"),
        "hf_image_output.json",
      );
      let outputDir;
      if (fs.existsSync(outputCfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(outputCfgPath, "utf8"));
        outputDir =
          cfg.path || path.join(app.getPath("downloads"), "Akki AI Images");
      } else {
        outputDir = path.join(app.getPath("downloads"), "Akki AI Images");
      }
      fs.mkdirSync(outputDir, { recursive: true });

      const imageBuffer = Buffer.from(buffer);
      const timestamp = Date.now();
      const safeName =
        prompt
          .slice(0, 60)
          .replace(/[^a-zA-Z0-9 _-]/g, "")
          .trim() || "image";
      const filename = `${safeName}_${timestamp}.png`;
      const filePath = path.join(outputDir, filename);
      fs.writeFileSync(filePath, imageBuffer);

      const fileSizeKb = Math.round(imageBuffer.length / 1024);
      const result = {
        success: true,
        filePath,
        filename,
        fileUrl: `file:///${filePath.replace(/\\/g, "/")}`,
        prompt,
        model: "black-forest-labs/FLUX.1-schnell",
        size: imageBuffer.length,
        size_kb: fileSizeKb,
      };

      // In-app Visual Hub previews the image cleanly. No duplicate HUD panel window is opened.
      return result;
    } catch (error) {
      console.error("[HF-Save] Error saving image:", error.message);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-image-output-path", async () => {
    try {
      const cfgPath = path.join(
        app.getPath("userData"),
        "hf_image_output.json",
      );
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        if (cfg.path && fs.existsSync(cfg.path)) return cfg.path;
      }
    } catch (e) {
      /* fall through to default */
    }
    return path.join(app.getPath("downloads"), "Akki AI Images");
  });

  ipcMain.handle("save-image-output-path", async (event, dirPath) => {
    try {
      const cfgPath = path.join(
        app.getPath("userData"),
        "hf_image_output.json",
      );
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({ path: dirPath, updatedAt: Date.now() }, null, 2),
      );
      return true;
    } catch (e) {
      return false;
    }
  });

  // Thinking Mode Settings
  ipcMain.handle("get-thinking-enabled", async () => {
    try {
      const p = getThinkingSettingsPath();
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, "utf8"));
        return data.enabled !== undefined ? data.enabled : true; // Default to true
      }
      return true; // Default to true if no settings file
    } catch (e) {
      return true;
    }
  });

  ipcMain.handle("save-thinking-enabled", async (event, enabled) => {
    try {
      fs.writeFileSync(
        getThinkingSettingsPath(),
        JSON.stringify({ enabled, updatedAt: Date.now() }, null, 2),
      );
      return true;
    } catch (e) {
      return false;
    }
  });

  // Gemini API Preference (Direct vs OpenRouter)
  ipcMain.handle("get-prefer-direct-gemini", async () => {
    try {
      const p = getGeminiPreferencePath();
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, "utf8"));
        return data.preferDirect !== undefined ? data.preferDirect : false; // Default to OpenRouter
      }
      return false;
    } catch (e) {
      return false;
    }
  });

  ipcMain.handle("save-prefer-direct-gemini", async (event, preferDirect) => {
    try {
      fs.writeFileSync(
        getGeminiPreferencePath(),
        JSON.stringify({ preferDirect, updatedAt: Date.now() }, null, 2),
      );
      return true;
    } catch (e) {
      return false;
    }
  });

  ipcMain.handle("get-voice-assistant-mode", async () => {
    try {
      const p = getVoiceAssistantModePath();
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, "utf8"));
        return data.mode === "direct" ? "direct" : "agentic";
      }
      return "agentic";
    } catch (e) {
      return "agentic";
    }
  });

  ipcMain.handle("save-voice-assistant-mode", async (_event, mode) => {
    try {
      const normalizedMode = mode === "direct" ? "direct" : "agentic";
      fs.writeFileSync(
        getVoiceAssistantModePath(),
        JSON.stringify(
          { mode: normalizedMode, updatedAt: Date.now() },
          null,
          2,
        ),
      );
      return true;
    } catch (e) {
      return false;
    }
  });

  ipcMain.handle("get-voice-provider", async () => {
    // Force OpenAI as the only provider temporarily per user request
    return "openai";
  });

  ipcMain.handle("save-voice-provider", async (event, provider) => {
    try {
      const normalizedProvider = provider === "openai" ? "openai" : "gemini";
      fs.writeFileSync(
        getVoiceProviderPath(),
        JSON.stringify(
          { provider: normalizedProvider, updatedAt: Date.now() },
          null,
          2,
        ),
      );
      return true;
    } catch (e) {
      return false;
    }
  });

  registerDomainHandlers();

  ipcMain.handle("get-app-version", async () => {
    return app.getVersion();
  });

  // ─── Theme Engine (userData/theme.json persistence) ─────────────────────────
  const { THEME_IDS } = require("./ui/theme-engine");

  ipcMain.handle("get-theme", async () => {
    try {
      const p = getThemePath();
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, "utf8"));
        if (data.theme && THEME_IDS.includes(data.theme)) return data.theme;
      }
    } catch (e) {
      // fail closed to the Default theme on any read/parse error
    }
    return "akki";
  });

  ipcMain.handle("set-theme", async (event, themeId) => {
    try {
      if (!themeId || typeof themeId !== "string") return false;
      if (!THEME_IDS.includes(themeId)) return false;
      fs.writeFileSync(
        getThemePath(),
        JSON.stringify({ theme: themeId, updatedAt: Date.now() }, null, 2),
      );
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) {
          win.webContents.send("theme-changed", themeId);
        }
      });
      return true;
    } catch (e) {
      return false;
    }
  });

  // Register Browser Automation Handlers
  try {
    const { registerBrowserHandlers } = require("./services/browser-manager");
    registerBrowserHandlers();
  } catch (e) {
    console.error("Failed to register browser handlers:", e);
  }

  // Register Desktop Control Handlers (OS-level mouse, screenshot, windows)
  try {
    const { registerDesktopHandlers } = require("./services/desktop-manager");
    registerDesktopHandlers();
  } catch (e) {
    console.error("Failed to register desktop handlers:", e);
  }

  // ─── HERMES DASHBOARD HANDLERS ─────────────────────────────────────────────
  ipcMain.handle("get-hermes-memory", async () => {
    const hermesDir = path.join(os.homedir(), ".hermes");
    const memDir = path.join(hermesDir, "memories");

    const readEntries = (filePath) => {
      if (!fs.existsSync(filePath)) return [];
      try {
        const content = fs.readFileSync(filePath, "utf8");
        return content
          .split("\n§\n")
          .map((e) => e.trim())
          .filter((e) => e.length > 0);
      } catch (err) {
        console.error("Error reading memory file:", filePath, err);
        return [];
      }
    };

    return {
      user: [], // USER.md deprecated
      memory: readEntries(path.join(memDir, "MEMORY.md")),
    };
  });

  ipcMain.handle("get-hermes-skills", async () => {
    const skillsDir = path.join(os.homedir(), ".hermes", "skills");
    const skills = [];
    if (!fs.existsSync(skillsDir)) return [];

    const scanDir = (dir) => {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          if (file === "references" || file === ".git" || file === ".github")
            continue;
          scanDir(fullPath);
        } else if (file === "SKILL.md") {
          try {
            const content = fs.readFileSync(fullPath, "utf8");
            const match = content.match(/^---([\s\S]+?)---/);
            if (match) {
              const yamlContent = match[1];
              const info = {};
              for (const line of yamlContent.split("\n")) {
                const idx = line.indexOf(":");
                if (idx > -1) {
                  const key = line.substring(0, idx).trim();
                  let val = line.substring(idx + 1).trim();
                  if (val.startsWith('"') && val.endsWith('"'))
                    val = val.slice(1, -1);
                  if (val.startsWith("'") && val.endsWith("'"))
                    val = val.slice(1, -1);
                  if (val.startsWith("[") && val.endsWith("]")) {
                    val = val
                      .slice(1, -1)
                      .split(",")
                      .map((s) => s.trim().replace(/^['"]|['"]$/g, ""));
                  }
                  info[key] = val;
                }
              }
              skills.push({
                name: info.name || path.basename(path.dirname(fullPath)),
                description: info.description || "",
                version: info.version || "1.0.0",
                author: info.author || "",
                platforms: Array.isArray(info.platforms)
                  ? info.platforms
                  : [info.platforms || "any"],
                tags: Array.isArray(info.tags)
                  ? info.tags
                  : info.tags
                    ? [info.tags]
                    : [],
                category: path.basename(path.dirname(path.dirname(fullPath))),
              });
            }
          } catch (e) {
            console.error("Error parsing skill file:", fullPath, e);
          }
        }
      }
    };

    try {
      scanDir(skillsDir);
    } catch (e) {
      console.error("Error scanning skills:", e);
    }
    return skills;
  });

  ipcMain.handle("get-hermes-insights", async () => {
    const projectPath = getHermesProjectPath(app);
    const pythonPath = projectPath ? getHermesPythonPath(projectPath) : null;
    if (!pythonPath || !projectPath) {
      return { error: "Hermes Python environment not found" };
    }

    const code = [
      "import json, sys",
      "try:",
      "    from hermes_state import SessionDB",
      "    from agent.insights import InsightsEngine",
      "    db = SessionDB()",
      "    engine = InsightsEngine(db)",
      "    report = engine.generate()",
      "    print(json.dumps(report))",
      "except Exception as e:",
      "    print(json.dumps({'error': str(e)}))",
      "    sys.exit(1)",
    ].join("\n");

    return new Promise((resolve) => {
      const child = spawn(pythonPath, ["-c", code], {
        cwd: projectPath,
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8",
          HERMES_HOME: path.join(os.homedir(), ".hermes"),
        },
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data) => {
        stdout += data.toString("utf-8");
      });
      child.stderr.on("data", (data) => {
        stderr += data.toString("utf-8");
      });
      child.on("close", (code) => {
        if (code !== 0) {
          resolve({ error: stderr.trim() || `Exit code ${code}` });
        } else {
          try {
            resolve(JSON.parse(stdout.trim()));
          } catch (e) {
            resolve({ error: "Failed to parse JSON: " + stdout.trim() });
          }
        }
      });
    });
  });
}

// Wake word is OFF by default — it runs a 24/7 Python process listening on the
// mic, which costs CPU/battery. Users opt in from Settings → Voice.
function isWakeWordEnabled() {
  try {
    const p = getWakeWordSettingsPath();
    if (fs.existsSync(p)) {
      const s = JSON.parse(fs.readFileSync(p, "utf8"));
      return s.enabled === true;
    }
  } catch (e) {
    /* fall through to default */
  }
  return false; // default OFF
}

function getAutoUpdateEnabled() {
  try {
    const p = getAutoUpdateSettingsPath();
    if (fs.existsSync(p)) {
      const s = JSON.parse(fs.readFileSync(p, "utf8"));
      return s.enabled !== undefined ? s.enabled : true;
    }
  } catch (e) {}
  return true; // default ON
}

function stopWakeWordDetector() {
  if (wakeWordProcess) {
    try {
      if (process.platform === "win32" && wakeWordProcess.pid) {
        require("child_process").execSync(`taskkill /pid ${wakeWordProcess.pid} /t /f`, { stdio: "ignore" });
      } else {
        wakeWordProcess.kill();
      }
    } catch (e) {
      /* already dead */
    }
    wakeWordProcess = null;
    console.log("[Wake Word] Detector stopped.");
  }
}

function startWakeWordDetector(mainWindow) {
  if (wakeWordProcess) return;

  // Resolve Python executable and script paths
  let pythonExe, scriptPath;

  if (process.env.NODE_ENV === "development") {
    // Development: use system Python
    pythonExe = "python";
    scriptPath = path.join(__dirname, "../wake_word_bg.py");

    if (process.platform !== "win32") {
      // macOS/Linux: plain `python` usually doesn't exist. Prefer the
      // Hermes venv (we control its packages), then fall back to python3.
      const venvPython = path.join(
        __dirname,
        "..",
        "..",
        "hermes-agent-main",
        ".venv",
        "bin",
        "python",
      );
      pythonExe = fs.existsSync(venvPython) ? venvPython : "python3";
    }
  } else {
    // Production: use embedded Python from extraResources
    pythonExe = path.join(
      process.resourcesPath,
      "python-embedded",
      "python.exe",
    );
    scriptPath = path.join(process.resourcesPath, "wake_word_bg.py");

    if (process.platform !== "win32") {
      // macOS/Linux: python-build-standalone layout (bin/python3)
      pythonExe = path.join(
        process.resourcesPath,
        "python-embedded",
        "bin",
        "python3",
      );
    }

    if (!fs.existsSync(pythonExe)) {
      console.warn(
        "[Wake Word] Embedded Python not found, skipping wake word detector.",
      );
      return;
    }
  }

  console.log("Starting Wake Word Detector (Python)...");
  wakeWordProcess = spawn(pythonExe, [scriptPath]);

  wakeWordProcess.stdout.on("data", (data) => {
    try {
      const output = data.toString().trim();
      const lines = output.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        const result = JSON.parse(line);
        // Forward all events (WAKE_WORD, INFO, ERROR) to the UI
        mainWindow.webContents.send("wake-word-detected", result);
      }
    } catch (e) {
      console.error("Error parsing wake word output:", e);
    }
  });

  wakeWordProcess.stderr.on("data", (data) => {
    console.error(`Wake Word Error: ${data}`);
  });

  wakeWordProcess.on("close", (code) => {
    console.log(`Wake word process exited with code ${code}`);
    wakeWordProcess = null;
  });
}

// ─── Update system master switch ─────────────────────────────────────────
// UPDATES_ENABLED = false → the full update architecture (electron-updater,
// Worker feed, IPC, Settings UI contract) is PRESERVED but completely
// disabled: no startup/auto checks, no downloads, no installs — including
// cached pending updates. Re-enabling later is a one-line change
// (set back to true). The Settings "Check for Updates" UI stays visible
// and receives a disabled status instead of contacting the feed.
const UPDATES_ENABLED = true;

function setupAutoUpdater() {
  if (process.env.NODE_ENV === "development") return;

  // macOS: Squirrel.Mac (electron-updater) requires a Developer-ID-signed
  // app, which we don't have yet. Use our custom updater instead — it
  // speaks the exact same 'update-status' / IPC contract to the renderer.
  if (process.platform === "darwin") {
    if (!UPDATES_ENABLED) return; // disabled: updater code preserved, not wired
    const { setupMacUpdater } = require("./services/macos-updater");
    setupMacUpdater({
      getMainWindow: () => mainWindow,
      autoDownload: getAutoUpdateEnabled(),
    });
    return;
  }

  const { autoUpdater } = require("electron-updater");

  // Explicitly configure feed URL to Hostinger update portal
  autoUpdater.setFeedURL({
    provider: "generic",
    url: "https://imakshay.in/akkiai/update",
  });

  // ── Standard Configuration ──────────────────────────────────────────────────
  autoUpdater.autoDownload = getAutoUpdateEnabled();
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;

  const sendStatus = (data) => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("update-status", data);
      }
    } catch (e) {}
  };

  // ── Standard Events ─────────────────────────────────────────────────────────
  autoUpdater.on("checking-for-update", () => {
    console.log("[Akki Updater] Checking for update...");
    sendStatus({ status: "checking" });
  });

  autoUpdater.on("update-not-available", () => {
    console.log(
      "[Akki Updater] Update not available. Current version is latest.",
    );
    sendStatus({ status: "not-available" });
  });

  autoUpdater.on("update-available", (info) => {
    console.log(
      `[Akki Updater] Update available: v${info.version}. Auto-downloading...`,
    );
    sendStatus({ status: "available", version: info.version });
    if (getAutoUpdateEnabled()) {
      autoUpdater.downloadUpdate().catch((err) => {
        console.error("[Akki Updater] downloadUpdate invocation failed:", err);
      });
    }
  });

  autoUpdater.on("download-progress", (progress) => {
    const pct = Math.round(progress.percent);
    console.log(
      `[Akki Updater] Download progress: ${pct}% | ${Math.round(progress.bytesPerSecond / 1024)} KB/s`,
    );
    sendStatus({
      status: "downloading",
      percent: pct,
      bytesPerSecond: Math.round(progress.bytesPerSecond),
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.log(
      `[Akki Updater] Update downloaded successfully: v${info.version}`,
    );
    sendStatus({ status: "downloaded", version: info.version });
  });

  autoUpdater.on("error", (err) => {
    console.error("[Akki Updater] Error:", err ? err.message : err);
    sendStatus({
      status: "error",
      message: err ? err.message : "Update error",
    });
  });

  // ── IPC Handlers ────────────────────────────────────────────────────────────
  // While UPDATES_ENABLED is false these stay registered (Settings UI contract
  // preserved) but perform no network/download/install activity — including
  // never installing an already-cached pending update.
  ipcMain.handle("install-update", () => {
    if (!UPDATES_ENABLED) {
      sendStatus({
        status: "error",
        message: "Updates are disabled in this version.",
      });
      return { disabled: true };
    }
    // Standard method: quit → install from verified cache → relaunch
    // isSilent=false:        NSIS apni progress bar dikhayega install ke dauraan
    //                        (1GB app extract hone mein ~1-2 min lagte hain — user ko feedback milega)
    // isForceRunAfter=true:  App automatically relaunch hogi after install
    autoUpdater.quitAndInstall(false, true);
  });

  ipcMain.handle("check-for-updates", () => {
    if (!UPDATES_ENABLED) {
      sendStatus({
        status: "error",
        message: "Updates are disabled in this version.",
      });
      return { disabled: true };
    }
    autoUpdater.checkForUpdates().catch(() => {});
  });

  // App start hone ke 5 second baad pehla check (skipped while disabled)
  if (UPDATES_ENABLED) {
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000);
  }
}

app.on("window-all-closed", async () => {
  // Cleanup license monitor
  stopLicenseMonitor();
  stopLicenseApprovalWatch();

  // Cleanup WhatsApp manager
  const waMgr = getWhatsAppManager();
  if (waMgr) {
    try {
      await waMgr.shutdown();
    } catch (e) {
      console.warn("[WhatsApp] Shutdown error:", e.message);
    }
  }

  // Cleanup Hermes Bridge
  if (hermesBridgeHandle) {
    stopHermesBridge();
    hermesBridgeHandle = null;
  }

  // Cleanup Agent Town Server
  stopAgentTownServer();

  // Cleanup production server
  if (productionServer) {
    productionServer.close();
    productionServer = null;
  }

  stopWakeWordDetector();

  try {
    if (process.platform === "win32") {
      require("child_process").execSync("wmic process where \"name='chrome.exe' and commandline like '%chrome-debug-profile%'\" call terminate", { stdio: "ignore" });
    }
  } catch (e) {}

  if (process.platform !== "darwin") app.quit();
});

// SINGLE INSTANCE LOCK
if (global.diagLog)
  global.diagLog("main_source.js requesting single instance lock");
const gotTheLock = app.requestSingleInstanceLock();
if (global.diagLog) global.diagLog("main_source.js gotTheLock = " + gotTheLock);

if (!gotTheLock) {
  if (global.diagLog)
    global.diagLog("main_source.js single instance lock failed -> quitting");
  app.quit();
} else {
  app.on("second-instance", (event, commandLine, workingDirectory) => {
    // Someone tried to run a second instance, we should focus our window.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // Create myWindow, load the rest of the app, etc...
  app.whenReady().then(() => {
    console.log("[Akki] App ready — starting initialization...");

    // On Windows, match the AppUserModelID set by the NSIS installer on
    // shortcuts (com.akki-ai.desktop). Without this, Windows uses a
    // default AUMI and the Taskbar/Start Menu tile show the generic
    // Electron icon instead of the Akki icon.
    try {
      app.setAppUserModelId("com.akki-ai.desktop");
      console.log("[Akki] AppUserModelID set to com.akki-ai.desktop");
    } catch (aumidErr) {
      console.warn("[Akki] Could not set AppUserModelID:", aumidErr.message);
    }

    setupFileLogging();
    migrateAppData();
    const { session } = require("electron");
    setupPermissions(session);

    // macOS: trigger the standard system permission prompts (mic,
    // accessibility, screen recording status). No-op on Windows/Linux.
    try {
      const {
        bootstrapMacPermissions,
      } = require("./services/macos-permissions");
      bootstrapMacPermissions();
    } catch (permErr) {
      console.warn("[macOS Permissions] bootstrap failed:", permErr.message);
    }

    // ===== CRITICAL: Configure CSP to allow YouTube embeds in production =====
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [
            "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; " +
              "connect-src * ws: wss: data: blob:; " +
              "media-src * data: blob:; " +
              "frame-src *; " +
              "img-src * data: blob:; " +
              "script-src * 'unsafe-inline' 'unsafe-eval'; " +
              "style-src * 'unsafe-inline'; " +
              "font-src * data:;",
          ],
        },
      });
    });

    // PRODUCTION: Remove CSP completely for local file protocol
    session.defaultSession.webRequest.onHeadersReceived(
      { urls: ["file://*"] },
      (details, callback) => {
        const responseHeaders = { ...details.responseHeaders };
        delete responseHeaders["Content-Security-Policy"];
        delete responseHeaders["content-security-policy"];
        callback({ responseHeaders });
      },
    );

    session.defaultSession.webRequest.onBeforeSendHeaders(
      {
        urls: [
          "wss://*.aiplatform.googleapis.com/*",
          "wss://generativelanguage.googleapis.com/*",
        ],
      },
      (details, callback) => {
        if (currentVertexToken) {
          details.requestHeaders["Authorization"] =
            `Bearer ${currentVertexToken}`;
          console.log(
            "[Vertex AI] Injected Authorization Bearer token into WebSocket request.",
          );
        }
        callback({ requestHeaders: details.requestHeaders });
      },
    );

    // ── Firebase Initialization ──
    const firebaseReady = firebaseService.initFirebase();
    if (!firebaseReady) {
      console.warn(
        "[Akki] Firebase not configured. Auth features disabled until config is set.",
      );
    }

    // ── Auth state change → notify renderer ──
    firebaseService.onAuthChange((user) => {
      try {
        if (user) {
          // Auto-complete reauth: if onboarding is showing in reauth mode,
          // close it and open main window (Firebase restored the session)
          if (
            reauthMode &&
            onboardingWindow &&
            !onboardingWindow.isDestroyed()
          ) {
            reauthMode = false;
            closeOnboardingWindow();
            if (!mainWindow || mainWindow.isDestroyed()) {
              mainWindow = createWindow();
              setMainWindow(mainWindow);
              if (isWakeWordEnabled()) startWakeWordDetector(mainWindow);
            }
          }
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(
            "auth-state-changed",
            user
              ? {
                  uid: user.uid,
                  email: user.email,
                  displayName: user.displayName,
                  photoURL: user.photoURL,
                }
              : null,
          );
        }
      } catch (e) {
        /* window not ready */
      }
    });

    registerHandlers();
    setupAutoUpdater();

    // ── Start Hermes Bridge (Agent Town ↔ Hermes Agent gateway) ──
    try {
      hermesBridgeHandle = startHermesBridge(app, 18789);
      console.log("[Akki] Hermes Bridge started — Agent Town can connect.");

      // Register callback so the bridge can notify us when a Hugging Face
      // image is generated. We open the Information Panel with a preview.
      setToolResultCallback((toolName, output) => {
        console.log(
          "[HF-DIAG] main.js callback: toolName=" +
            toolName +
            " output_len=" +
            (output ? output.length : 0),
        );
        if (toolName === "huggingface_generate_image" && output) {
          try {
            const result = JSON.parse(output);
            console.log(
              "[HF-DIAG] result parsed: success=" +
                result.success +
                " file_path=" +
                (result.file_path || "N/A") +
                " image=" +
                (result.image || "N/A"),
            );
            if (result.success) {
              const fileUrl = result.image; // already file:/// URI
              const title = `Image: ${result.filename}`;
              const content = [
                `![Generated Image](${fileUrl})`,
                "",
                "---",
                "",
                `**Prompt:** ${result.prompt}`,
                "",
                `**Model:** ${result.model}`,
                "",
                `**File:** \`${result.filename}\``,
                "",
                `**Size:** ${result.size_kb} KB`,
                "",
                `**Path:** \`${result.file_path}\``,
              ].join("\n");

              const panelId = "hf-image-preview";
              infoPanelData.set(panelId, { title, content, theme: "cyan" });

              const existing = infoPanelWindows.get(panelId);
              if (existing && !existing.isDestroyed()) {
                console.log("[HF-DIAG] Updating existing Info Panel");
                existing.webContents.send("info-panel-updated", {
                  title,
                  content,
                  theme: "cyan",
                });
                existing.focus();
              } else {
                console.log("[HF-DIAG] Creating new Info Panel window");
                createInfoPanelWindow(panelId);
              }
            } else {
              console.log(
                "[HF-DIAG] Tool returned success=false, error=" +
                  (result.error || "N/A") +
                  " error_type=" +
                  (result.error_type || "N/A"),
              );
            }
          } catch (e) {
            console.error("[HF-DIAG] Failed to parse tool result:", e.message);
          }
        }
      });
    } catch (err) {
      console.error("[Akki] Failed to start Hermes Bridge:", err.message);
      console.error("[Akki] Agent Town will load but tasks will not work.");
    }

    // ── Start Agent Town Server (Next.js on localhost:3000) ──
    startAgentTownServer(3000)
      .then((port) => {
        if (port) {
          console.log(`[Akki] Agent Town server ready on port ${port}`);
        } else {
          console.warn(
            "[Akki] Agent Town server failed to start. Sub-Agent panel will show error.",
          );
        }
      })
      .catch((err) => {
        console.error("[Akki] Agent Town server error:", err.message);
      });

    // ─── LICENSE CHECK ─────────────────────────────────────────────────────────
    // Approved device (local license + hardware match): open the main window
    // IMMEDIATELY (it shows its own loading splash); a background silent unlock
    // restores the real Firebase session and re-verifies the remote license.
    // No auth page on relaunch. Blocked → auto-close. Revoked / no stored
    // credential → pivot to re-auth. Otherwise → existing onboarding flow.
    const licenseStatus = licenseManager.getLicenseStatus();
    const storedSession = firebaseService.getStoredSession();
    const isLicensed = licenseManager.isEffectiveLicensed() && !!storedSession;

    let createdWindow = null;
    if (isLicensed) {
      const isCert = licenseManager.isCertificationLicense();
      console.log(
        "[Akki] License approved locally" +
          (isCert ? " (certification)" : "") +
          ". Opening main window (silent unlock)...",
      );
      const licState = licenseManager.getLicenseState();
      const hwId = (licState && licState.hardwareId) || null;

      // Start persistent license monitor first — enforces blocked in real time.
      // Certification licenses are re-verified against the server registry and
      // hardware-backed blocked/expiry monitors do not apply (no hardware ID).
      if (isCert) {
        startCertificationMonitor();
      } else if (hwId) {
        startLicenseMonitor(hwId);
      }

      createdWindow = createWindow();
      console.log("[Akki] Main window created:", !!createdWindow);

      if (hwId && createdWindow && !isCert) {
        // Background: restore real session + re-verify remote license. The main
        // window stays open and flips to its authenticated state when ready.
        verifyApprovedSession(createdWindow, hwId);
      } else if (isCert && createdWindow) {
        // Background: re-verify the certification account on the server. If it
        // was disabled/expired, downgrade to the normal onboarding/license path.
        verifyCertifiedSession(createdWindow);
      }
    } else {
      const licState = licenseManager.getLicenseState();
      if (licState && licState.status === "pending" && licState.hardwareId) {
        // Already submitted payment, watching for approval
        startLicenseApprovalWatch(licState.hardwareId);
      }

      // Show onboarding window (handles name, age, sign-in, plan selection, payment)
      console.log("[Akki] License not approved. Showing onboarding window...");
      createOnboardingWindow();
    }

    // Wire up shared state for cross-module access
    if (createdWindow) {
      setMainWindow(createdWindow);

      // Initialize WhatsApp Manager singleton
      const waMgr = new WhatsAppManager(createdWindow, app);
      setWhatsAppManager(waMgr);

      // Auto-connect WhatsApp by default. Only the explicit `autoConnect: false`
      // setting disables it. To avoid spawning a headless browser / QR before the
      // user has ever linked, we only auto-init when a saved session exists —
      // i.e. every app start AFTER the first successful link reconnects silently.
      try {
        const pathMod = require("path");
        const waSettingsPath = pathMod.join(
          app.getPath("userData"),
          "whatsapp_settings.json",
        );
        let autoConnect = true; // default ON
        if (fs.existsSync(waSettingsPath)) {
          const waSettings = JSON.parse(
            fs.readFileSync(waSettingsPath, "utf8"),
          );
          if (waSettings.autoConnect === false) autoConnect = false;
        }

        const hasSession = fs.existsSync(
          pathMod.join(app.getPath("userData"), "baileys_auth", "creds.json"),
        );

        if (autoConnect && hasSession) {
          console.log(
            "[WhatsApp] Auto-connect: existing session found, initializing...",
          );
          waMgr.initialize().catch((err) => {
            console.error("[WhatsApp] Auto-connect failed:", err.message);
          });
        } else if (autoConnect) {
          console.log(
            "[WhatsApp] Auto-connect enabled but no linked session yet. Waiting for first QR link.",
          );
        }
      } catch (err) {
        console.warn(
          "[WhatsApp] Failed to read auto-connect settings:",
          err.message,
        );
      }
    }

    // Connect wake word detector to main window
    if (createdWindow && isWakeWordEnabled())
      startWakeWordDetector(createdWindow);

    // Inject Hugging Face settings into settings page
    if (createdWindow) {
      createdWindow.webContents.on("did-finish-load", () => {
        try {
          const { THEME_ENGINE_SCRIPT } = require("./ui/theme-engine");
          createdWindow.webContents
            .executeJavaScript(THEME_ENGINE_SCRIPT)
            .catch(() => {});
        } catch (e) {
          console.warn("[Theme] Engine inject failed:", e.message);
        }
      });
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        const win = createWindow();
        if (isWakeWordEnabled()) startWakeWordDetector(win);
      }
    });
  });
}
