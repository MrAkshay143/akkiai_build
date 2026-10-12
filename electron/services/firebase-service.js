const { app, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const { initializeApp, getApps, deleteApp } = require('firebase/app')
const {
  getAuth,
  signInWithCredential,
  GoogleAuthProvider,
  signOut,
  onAuthStateChanged,
} = require('firebase/auth')
const { OAuth2Client } = require('google-auth-library')
const credentialStore = require('./auth-credential-store')

let firebaseApp = null
let auth = null
let db = null
let authUnsubscribe = null
// currentUser is set ONLY from the real Firebase Auth session. The legacy
// firebase_session.json stub is metadata only and is NEVER treated as auth.
let currentUser = null

const authListeners = []
let authReadyWaiters = []
let restoreTimer = null
let monitorStatusIpcRegistered = false

const health = {
  initState: 'not-initialized',
  authState: 'signed-out', // signed-out | restoring | authenticated | restore-failed
  lastAuthError: null,
  lastRemote: null,
  lastError: null,
}

// ── Safe logging / redaction ────────────────────────────────────────────
// Firestore/license error classification used by the monitor + diagnostics.
function safeSanitize(input) {
  const str = String(input == null ? '' : input)
  return str
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]')
    .replace(/(refresh_token|id_token|access_token|authorization|code)=([^&\s]+)/gi, '$1=[REDACTED]')
}

function classifyFirestoreError(err) {
  const code = err && err.code
  if (code === 'permission-denied') return 'PERMISSION_DENIED'
  if (code === 'unauthenticated') return 'AUTH_UNAUTHENTICATED'
  if (code === 'unavailable' || code === 'deadline-exceeded' || code === 'aborted' ||
      code === 'internal' || code === 'network-request-failed' || code === 'resource-exhausted') {
    return 'NETWORK'
  }
  return 'ERROR'
}

function logLicense(tag, cls, detail) {
  const line = '[Firebase/License] ' + tag + ' => ' + cls + ' :: ' + safeSanitize(detail)
  if (cls === 'NETWORK') {
    console.warn(line)
  } else {
    console.error(line)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function isRevokedCredentialError(err) {
  const msg = String((err && err.message) || err).toLowerCase()
  return msg.includes('invalid_grant') || msg.includes('invalid grant') || msg.includes('revoked')
}

// ── Auth listeners ──────────────────────────────────────────────────────

function onAuthChange(callback) {
  authListeners.push(callback)
  if (currentUser) {
    callback(currentUser)
  }
  return () => {
    const idx = authListeners.indexOf(callback)
    if (idx !== -1) authListeners.splice(idx, 1)
  }
}

function notifyAuthListeners(user) {
  for (const cb of authListeners) {
    try { cb(user) } catch (e) { console.error('[Firebase] Auth listener error:', e.message) }
  }
}

// Single pipeline through which the REAL auth user flows. Resolves every
// waitForAuthReady() waiter once a real user is present, and only notifies
// listeners on sign-in / sign-out transitions.
function applyAuthUser(user) {
  const wasAuthed = currentUser !== null
  currentUser = user || null
  if (currentUser) {
    persistSession(currentUser)
    health.authState = 'authenticated'
    health.lastAuthError = null
  } else {
    health.authState = 'signed-out'
  }
  if (authReadyWaiters.length) {
    const waiters = authReadyWaiters
    authReadyWaiters = []
    for (const resolve of waiters) { try { resolve(true) } catch (e) { /* ignore */ } }
  }
  if (wasAuthed !== (currentUser !== null)) {
    notifyAuthListeners(currentUser)
  }
}

// ── Auth readiness gate ─────────────────────────────────────────────────
// Every Firestore license operation waits on this so NO Firestore call is
// ever made before a real Firebase session exists in this process.
function waitForAuthReady() {
  if (currentUser) return Promise.resolve(true)
  return new Promise((resolve) => { authReadyWaiters.push(resolve) })
}

// ── Real Firebase session restoration ───────────────────────────────────

const RESTORE_RETRY_DELAYS = [0, 2000, 6000, 15000]

async function restoreAuthSession() {
  const config = loadConfig()
  if (!config || !auth) {
    return { restored: false, reason: 'not-configured', retriable: false }
  }

  const stored = credentialStore.loadCredential()
  if (!stored || !stored.refreshToken) {
    // No durable credential — a normal (manual) Google login is required.
    health.lastAuthError = { code: 'AUTH_RESTORE_FAILED', message: 'No stored credential for silent restore.' }
    health.authState = 'restore-failed'
    return { restored: false, reason: 'no-credential', retriable: false }
  }

  health.authState = 'restoring'
  for (let attempt = 0; attempt < RESTORE_RETRY_DELAYS.length; attempt++) {
    if (RESTORE_RETRY_DELAYS[attempt] > 0) await sleep(RESTORE_RETRY_DELAYS[attempt])
    // A manual sign-in may have completed while we were waiting.
    if (currentUser) return { restored: true, reason: 'already-signed-in', retriable: false }

    try {
      const oauth2Client = new OAuth2Client(config.oauthClientId, config.oauthClientSecret, 'http://localhost:53921/callback')
      oauth2Client.setCredentials({ refresh_token: stored.refreshToken })
      const creds = await oauth2Client.refreshAccessToken()
      const idToken = creds.credentials && creds.credentials.id_token
      if (!idToken) throw new Error('Google did not return an ID token')

      const credential = GoogleAuthProvider.credential(idToken)
      const credResult = await signInWithCredential(auth, credential)
      applyAuthUser(credResult.user)
      logLicense('restoreAuthSession', 'RESTORE_OK', 'Silent session restored (user=' + credResult.user.uid + ')')
      return { restored: true, reason: 'ok', retriable: false }
    } catch (err) {
      if (isRevokedCredentialError(err)) {
        // Token revoked/invalid — fail closed: erase it, require normal login.
        credentialStore.deleteCredential()
        const msg = 'Stored Google credential was revoked. A normal login is required.'
        health.lastAuthError = { code: 'AUTH_RESTORE_FAILED', message: msg }
        health.authState = 'restore-failed'
        logLicense('restoreAuthSession', 'AUTH_RESTORE_FAILED', msg)
        return { restored: false, reason: 'revoked', retriable: false }
      }
      const msg = 'Session restore attempt ' + (attempt + 1) + ' failed: ' + ((err && err.message) || String(err))
      console.warn('[Firebase] ' + safeSanitize(msg))
      health.lastAuthError = { code: 'NETWORK', message: msg }
      health.authState = 'restore-failed'
    }
  }
  logLicense('restoreAuthSession', 'NETWORK', 'silent restore could not complete within retry window')
  return { restored: false, reason: 'network', retriable: true }
}

// Keep trying in the background (offline at launch → auto-recover later).
function scheduleRestoreRetry() {
  if (restoreTimer) clearTimeout(restoreTimer)
  restoreTimer = setTimeout(async () => {
    restoreTimer = null
    if (currentUser || !auth) return
    const res = await restoreAuthSession()
    if (!res.restored && res.retriable) scheduleRestoreRetry()
  }, 30000)
}

// ── Firebase init / shutdown ────────────────────────────────────────────

function initFirebase() {
  const config = loadConfig()
  if (!config) {
    console.warn('[Firebase] No valid Firebase config found. Auth disabled.')
    health.initState = 'no-config'
    return false
  }

  try {
    const existing = getApps().find((app) => app.name === '[DEFAULT]')
    if (existing) {
      firebaseApp = existing
    } else {
      firebaseApp = initializeApp({
        apiKey: config.apiKey,
        authDomain: config.authDomain,
        projectId: config.projectId,
        storageBucket: config.storageBucket,
        messagingSenderId: config.messagingSenderId,
        appId: config.appId,
      })
    }

    auth = getAuth(firebaseApp)
    const { getFirestore } = require('firebase/firestore')
    db = getFirestore(firebaseApp)

    authUnsubscribe = onAuthStateChanged(auth, (user) => {
      applyAuthUser(user)
    })

    health.initState = 'ready'
    health.authState = 'restoring'

    registerMonitorStatusIpc()

    // Kick off REAL session restoration. This is async; every Firestore
    // license operation waits on waitForAuthReady() so nothing touches
    // Firestore before auth is actually restored.
    restoreAuthSession().then((res) => {
      if (!res.restored && res.retriable) scheduleRestoreRetry()
    })

    console.log('[Firebase] Initialized successfully. Real session restoration started.')
    return true
  } catch (e) {
    console.error('[Firebase] Initialization failed:', e.message)
    health.initState = 'error'
    return false
  }
}

function shutdownFirebase() {
  if (restoreTimer) {
    clearTimeout(restoreTimer)
    restoreTimer = null
  }
  if (authUnsubscribe) {
    authUnsubscribe()
    authUnsubscribe = null
  }
  if (firebaseApp) {
    try { deleteApp(firebaseApp) } catch (e) { /* ignore */ }
    firebaseApp = null
    auth = null
    currentUser = null
  }
}

// ─── SESSION METADATA (display only — never treated as auth) ────────────

function getSessionPath() {
  return path.join(app.getPath('userData'), 'firebase_session.json')
}

function persistSession(user) {
  try {
    if (user) {
      const session = {
        uid: user.uid,
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL,
        lastSignIn: Date.now(),
      }
      fs.writeFileSync(getSessionPath(), JSON.stringify(session, null, 2))
    } else {
      clearSessionFile()
    }
  } catch (e) {
    console.warn('[Firebase] Failed to persist session metadata:', e.message)
  }
}

function clearSessionFile() {
  const p = getSessionPath()
  if (fs.existsSync(p)) fs.unlinkSync(p)
}

function getStoredSession() {
  try {
    const p = getSessionPath()
    if (fs.existsSync(p)) {
      const session = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (session && session.uid) return session
    }
  } catch (e) { /* ignore */ }
  return null
}

function getCurrentUser() {
  return currentUser
}

// TRUE only when the Firebase SDK holds a real, live session in this process.
function isAuthenticated() {
  return currentUser !== null
}

// ─── GOOGLE SIGN-IN ──────────────────────────────────────────────────────
// Uses google-auth-library to generate the OAuth URL, opens it in a
// BrowserWindow, catches the authorization code from the redirect,
// exchanges it for tokens, and signs in to Firebase with the id_token.
// The Google refresh_token is captured and securely persisted so the real
// session can be restored after restart.

async function exchangeGoogleCode(code, codeVerifier) {
  const config = loadConfig()
  if (!config || !config.oauthClientId) {
    throw new Error('Firebase not configured.')
  }
  if (!auth) {
    throw new Error('Firebase not initialized.')
  }

  const oauth2Client = new OAuth2Client(config.oauthClientId, config.oauthClientSecret, 'http://localhost:53921/callback')

  const { tokens } = await oauth2Client.getToken(code)
  if (!tokens.id_token) {
    throw new Error('No id_token in Google response')
  }

  // Persist the refresh token securely. Google only issues a refresh_token
  // on a FRESH consent — the login URL must include prompt=consent or an
  // already-granted account returns tokens WITHOUT a refresh_token, making
  // silent restore impossible. Flag it loudly so a regression is obvious.
  if (tokens.refresh_token) {
    credentialStore.saveCredential(tokens.refresh_token)
  } else {
    logLicense('exchangeGoogleCode', 'NO_REFRESH_TOKEN', 'Google did not return a refresh_token (consent likely already granted). Silent restore unavailable until a fresh-consent login.')
    health.lastAuthError = { code: 'NO_REFRESH_TOKEN', message: 'Login did not issue a refresh token; silent restore will not work until consent is re-granted.' }
  }

  const ticket = await oauth2Client.verifyIdToken({
    idToken: tokens.id_token,
    audience: config.oauthClientId,
  })
  const payload = ticket.getPayload()

  const credential = GoogleAuthProvider.credential(tokens.id_token)
  const result = await signInWithCredential(auth, credential)
  applyAuthUser(result.user)

  return result.user
}

function getOAuthConfig() {
  const config = loadConfig()
  if (!config || !config.oauthClientId) return null
  return {
    clientId: config.oauthClientId,
    clientSecret: config.oauthClientSecret,
    redirectUri: 'http://localhost:53921/callback',
    scope: ['openid', 'email', 'profile'],
  }
}

// ─── USER PROFILE (FIRESTORE SYNC) ──────────────────────────────────────

async function saveUserProfile(uid, data) {
  if (!db) throw new Error('Firestore not initialized')
  const { doc, setDoc } = require('firebase/firestore')
  const ref = doc(db, 'users', uid, 'profile', 'data')
  await setDoc(ref, {
    ...data,
    updatedAt: Date.now(),
  }, { merge: true })
  return true
}

async function getUserProfile(uid) {
  if (!db) return null
  const { doc, getDoc } = require('firebase/firestore')
  const ref = doc(db, 'users', uid, 'profile', 'data')
  const snap = await getDoc(ref)
  if (snap.exists()) {
    return snap.data()
  }
  return null
}

// Legacy embedded-window sign-in kept for reference
async function signInWithGoogle() {
  throw new Error('Use system browser OAuth flow instead')
}

async function signOutUser() {
  if (!auth) return true
  try {
    await signOut(auth)
    currentUser = null
    credentialStore.deleteCredential()
    clearSessionFile()
    health.authState = 'signed-out'
    notifyAuthListeners(null)
    return true
  } catch (e) {
    console.error('[Firebase] Sign-out failed:', e.message)
    return false
  }
}

function loadConfig() {
  try {
    const configPath = path.join(__dirname, '..', 'config', 'firebase-config.js')
    if (!fs.existsSync(configPath)) return null
    const { FIREBASE_CONFIG } = require(configPath)
    if (!FIREBASE_CONFIG || !FIREBASE_CONFIG.apiKey || FIREBASE_CONFIG.apiKey === 'YOUR_API_KEY') {
      return null
    }
    return FIREBASE_CONFIG
  } catch {
    return null
  }
}

// ─── FIRESTORE USER DATA SYNC ───────────────────────────────────────────

async function saveUserData(uid, type, data, updatedAt) {
  if (!db) throw new Error('Firestore not initialized')
  const { doc, setDoc } = require('firebase/firestore')
  const ref = doc(db, 'users', uid, 'data', type)
  await setDoc(ref, { data, updatedAt: updatedAt || Date.now() })
  return true
}

async function loadUserData(uid, type) {
  if (!db) return null
  const { doc, getDoc } = require('firebase/firestore')
  const ref = doc(db, 'users', uid, 'data', type)
  const snap = await getDoc(ref)
  if (snap.exists()) {
    return snap.data()
  }
  return null
}

// ─── FIRESTORE LICENSE OPERATIONS ────────────────────────────────────────

function getDb() {
  return db
}

// Creates the pending license request at approved_devices/{hardwareId}.
// WAITS for real auth first, then attempts the allowed CREATE directly.
// No blocking pre-create read is performed: for a brand-new device the
// document does not exist yet and the owner-based `get` rule cannot match
// it, so a pre-read would fail with PERMISSION_DENIED and abort the submit.
// If the create is rejected because the document already exists (updates are
// admin-only), the existing doc is read back — owner reads are allowed —
// and a same-uid pending/approved/blocked record is preserved, never
// rewritten. Fail-closed: any other error is rethrown.
async function submitLicenseRequest({ hardwareId, uid, email, plan }) {
  if (!db) throw new Error('Firestore not initialized')
  await waitForAuthReady()

  if (!currentUser) throw new Error('Not authenticated')
  if (!uid || uid !== currentUser.uid) throw new Error('License request UID must match the signed-in user')
  if (!hardwareId) throw new Error('Missing hardware ID')

  const { doc, getDoc, setDoc } = require('firebase/firestore')
  const ref = doc(db, 'approved_devices', hardwareId)

  const payload = {
    hardwareId,
    uid,
    email,
    plan,
    status: 'pending',
    createdAt: Date.now(),
    approvedAt: null,
  }

  try {
    await setDoc(ref, payload)
    return { success: true, existed: false, status: 'pending' }
  } catch (err) {
    const cls = classifyFirestoreError(err)
    if (cls !== 'PERMISSION_DENIED') {
      logLicense('submitLicenseRequest', cls, (err && err.message) || String(err))
      health.lastError = { code: cls, at: Date.now() }
      throw err
    }
    let existing = null
    try {
      existing = await getDoc(ref)
    } catch (readErr) {
      const readCls = classifyFirestoreError(readErr)
      logLicense('submitLicenseRequest', readCls, (readErr && readErr.message) || String(readErr))
      health.lastError = { code: readCls, at: Date.now() }
      throw err
    }
    if (existing && existing.exists()) {
      const d = existing.data() || {}
      if (d.status === 'pending' || d.status === 'approved' || d.status === 'blocked') {
        if (d.uid === uid) {
          logLicense('submitLicenseRequest', 'EXISTS', 'Existing license for this device preserved (status=' + d.status + '). No write attempted.')
          return { success: true, existed: true, status: d.status }
        }
        throw new Error('A license already exists for this device under another account.')
      }
      logLicense('submitLicenseRequest', 'EXISTS', 'Existing document has unrecognized status; preserving it, no write attempted.')
      return { success: true, existed: true, status: 'pending' }
    }
    logLicense('submitLicenseRequest', cls, (err && err.message) || String(err))
    health.lastError = { code: cls, at: Date.now() }
    throw err
  }
}

async function fetchLicenseStatus(hardwareId) {
  if (!db) {
    logLicense('fetchLicenseStatus', 'ERROR', 'Firestore not initialized')
    return null
  }

  try {
    await waitForAuthReady()
  } catch (err) {
    logLicense('fetchLicenseStatus', 'AUTH_UNAUTHENTICATED', (err && err.message) || String(err))
    health.lastError = { code: 'AUTH_UNAUTHENTICATED', at: Date.now() }
    return null
  }

  const { doc, getDoc } = require('firebase/firestore')
  try {
    const ref = doc(db, 'approved_devices', hardwareId)
    const snap = await getDoc(ref)
    if (snap.exists()) {
      const d = snap.data()
      health.lastRemote = { status: d.status, plan: d.plan, at: Date.now() }
      return { status: d.status, plan: d.plan, hardwareId: d.hardwareId }
    }
    health.lastRemote = { status: 'NOT_FOUND', at: Date.now() }
    logLicense('fetchLicenseStatus', 'NOT_FOUND', 'approved_devices/' + hardwareId + ' does not exist')
    return null
  } catch (err) {
    const cls = classifyFirestoreError(err)
    logLicense('fetchLicenseStatus', cls, (err && err.message) || String(err))
    health.lastError = { code: cls, at: Date.now() }
    return null
  }
}

// ─── CERTIFICATION ACCOUNT (Microsoft Store test-access) ────────────────
// Server-authoritative registry that grants certification (Store-test) access
// to a dedicated Google account WITHOUT requiring an approved hardware ID.
// This is READ-ONLY from the client: end users can never write themselves in.
// The document is keyed by normalized email and also stores the uid so the
// check can match on the stable uid first, falling back to email.
const CERT_COLLECTION = 'certification_accounts'

function normalizeEmail(email) {
  return (email || '').trim().toLowerCase()
}

// Returns { certified: bool, plan, email, expiresAt } sourced ONLY from the
// server registry for the currently authenticated user. Fail-closed: any
// error or missing doc yields { certified: false }.
async function getCertificationStatus() {
  if (!db) {
    logLicense('getCertificationStatus', 'ERROR', 'Firestore not initialized')
    return { certified: false }
  }
  try {
    await waitForAuthReady()
  } catch (err) {
    logLicense('getCertificationStatus', 'AUTH_UNAUTHENTICATED', (err && err.message) || String(err))
    return { certified: false }
  }

  const user = currentUser
  if (!user) {
    logLicense('getCertificationStatus', 'AUTH_UNAUTHENTICATED', 'No authenticated user')
    return { certified: false }
  }

  const { doc, getDoc } = require('firebase/firestore')
  let found = null
  // Primary lookup by stable uid (immutable, unspoofable at the auth boundary).
  if (user.uid) {
    try {
      const ref = doc(db, CERT_COLLECTION, user.uid)
      const snap = await getDoc(ref)
      if (snap.exists()) found = snap.data()
    } catch (err) { /* fall through to email lookup */ }
  }
  // Fallback lookup by normalized email (human-authored registry docs).
  if (!found && user.email) {
    try {
      const ref = doc(db, CERT_COLLECTION, normalizeEmail(user.email))
      const snap = await getDoc(ref)
      if (snap.exists()) found = snap.data()
    } catch (err) {
      const cls = classifyFirestoreError(err)
      logLicense('getCertificationStatus', cls, (err && err.message) || String(err))
      health.lastError = { code: cls, at: Date.now() }
    }
  }

  if (!found || found.enabled !== true) {
    return { certified: false }
  }
  // Optional expiry — if expiresAt set and in the past, treat as disabled.
  if (found.expiresAt && Date.now() > found.expiresAt) {
    logLicense('getCertificationStatus', 'EXPIRED', 'certification account expired')
    return { certified: false }
  }
  return {
    certified: true,
    plan: found.plan || 'certification',
    email: found.email || user.email,
    uid: found.uid || user.uid,
    expiresAt: found.expiresAt || null,
  }
}

// ─── LICENSE WATCH ───────────────────────────────────────────────────────

// Registers an onSnapshot listener on approved_devices/{hardwareId}.
// Returns an unsubscribe function synchronously (the compiled startup uses
// the return value to stop the watch). The actual Firestore listener is
// registered only after waitForAuthReady() resolves.
function watchLicenseStatus(hardwareId, callback) {
  if (!db) {
    logLicense('watchLicenseStatus', 'ERROR', 'Firestore not initialized')
    callback({ failed: 'ERROR' })
    return () => {}
  }

  let cancelled = false
  let unsubFn = null

  const unsub = () => {
    cancelled = true
    if (unsubFn) {
      try { unsubFn() } catch (e) { /* ignore */ }
      unsubFn = null
    }
  }

  // Wait for REAL auth before touching Firestore — nothing is sent earlier.
  waitForAuthReady()
    .then(() => {
      if (cancelled) return
      const { doc, onSnapshot } = require('firebase/firestore')
      const ref = doc(db, 'approved_devices', hardwareId)
      unsubFn = onSnapshot(ref, (snap) => {
        if (cancelled) return
        if (snap.exists()) {
          const d = snap.data()
          const data = { status: d.status, plan: d.plan, hardwareId: d.hardwareId }
          health.lastRemote = { status: d.status, plan: d.plan, at: Date.now() }
          logLicense('watchLicenseStatus', 'SNAPSHOT', 'status=' + data.status)
          callback(data)
        } else {
          health.lastRemote = { status: 'NOT_FOUND', at: Date.now() }
          logLicense('watchLicenseStatus', 'NOT_FOUND', 'approved_devices/' + hardwareId + ' does not exist')
          callback(null)
        }
      }, (err) => {
        const cls = classifyFirestoreError(err)
        logLicense('watchLicenseStatus', cls, (err && err.message) || String(err))
        health.lastError = { code: cls, at: Date.now() }
        callback({ failed: cls })
      })
    })
    .catch((err) => {
      logLicense('watchLicenseStatus', 'AUTH_UNAUTHENTICATED', (err && err.message) || String(err))
      callback({ failed: 'AUTH_UNAUTHENTICATED' })
    })

  return unsub
}

// ─── Diagnostics ────────────────────────────────────────────────────────

function getSessionHealth() {
  return {
    installedVersion: app.getVersion ? app.getVersion() : 'unknown',
    authenticated: currentUser !== null,
    uid: currentUser ? currentUser.uid : null,
    authState: health.authState,
    lastAuthError: health.lastAuthError
      ? { code: health.lastAuthError.code, message: safeSanitize(health.lastAuthError.message) }
      : null,
    lastRemote: health.lastRemote,
    lastError: health.lastError,
  }
}

function registerMonitorStatusIpc() {
  if (monitorStatusIpcRegistered) return
  monitorStatusIpcRegistered = true
  try {
    ipcMain.handle('license-monitor-status', async () => getSessionHealth())
  } catch (e) {
    console.error('[Firebase] Failed to register monitor-status IPC:', e.message)
  }
}

module.exports = {
  initFirebase,
  shutdownFirebase,
  signInWithGoogle,
  signOutUser,
  getCurrentUser,
  isAuthenticated,
  getStoredSession,
  onAuthChange,
  getDb,
  submitLicenseRequest,
  watchLicenseStatus,
  fetchLicenseStatus,
  exchangeGoogleCode,
  getOAuthConfig,
  saveUserProfile,
  getUserProfile,
  saveUserData,
  loadUserData,
  restoreAuthSession,
  waitForAuthReady,
  getSessionHealth,
  getCertificationStatus,
}