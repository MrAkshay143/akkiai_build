const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const { app } = require('electron')

// ─── PATH HELPERS ────────────────────────────────────────────────

function getLicensePath() {
  return path.join(app.getPath('userData'), 'license.json')
}

// ─── HARDWARE ID ─────────────────────────────────────────────────
// Generates a unique fingerprint tied to the physical machine.
// Uses CPU + memory + username + platform to create a consistent ID.
// Same machine always produces the same ID (even after reinstall).

function generateHardwareId() {
  const components = [
    os.hostname(),
    os.platform(),
    os.arch(),
    os.cpus()[0]?.model || 'unknown',
    String(os.totalmem()),
    os.userInfo()?.username || 'unknown',
  ]
  const raw = components.join('||')
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32)
}

// ─── LICENSE STATE ───────────────────────────────────────────────

function getLicenseState() {
  try {
    const p = getLicensePath()
    if (!fs.existsSync(p)) return null
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

function saveLicenseState(data) {
  try {
    fs.writeFileSync(getLicensePath(), JSON.stringify(data, null, 2))
    return true
  } catch {
    return false
  }
}

function clearLicense() {
  try {
    const p = getLicensePath()
    if (fs.existsSync(p)) fs.unlinkSync(p)
    return true
  } catch {
    return false
  }
}

// ─── LICENSE STATUS CHECKS ───────────────────────────────────────

function isLicenseApproved() {
  const state = getLicenseState()
  return !!(state && state.status === 'approved')
}

function getLicenseStatus() {
  const state = getLicenseState()
  if (!state) {
    return { status: 'none', message: 'No license found' }
  }
  return {
    status: state.status,
    plan: state.plan,
    email: state.email,
    hardwareId: state.hardwareId,
    message: state.status === 'approved' ? 'License approved' : 'Waiting for approval',
  }
}

// ─── FIRESTORE SYNC ──────────────────────────────────────────────
// These are called from the IPC handlers in main.js.
// The actual Firestore read/write happens via firebase-service.

// Save pending license request (user has paid, waiting for admin)
function savePendingLicense({ uid, email, plan, hardwareId }) {
  const state = {
    status: 'pending',
    plan,
    email,
    uid,
    hardwareId: hardwareId || generateHardwareId(),
    createdAt: Date.now(),
    expiresAt: null,
    approvedAt: null,
  }
  return saveLicenseState(state)
}

// Mark license as approved
function approveLicense(data) {
  const current = getLicenseState() || {}
  const state = {
    ...current,
    ...data,
    status: 'approved',
    approvedAt: Date.now(),
  }
  return saveLicenseState(state)
}

// Check if the stored hardware ID matches the current machine
function isHardwareMatch() {
  const state = getLicenseState()
  if (!state || !state.hardwareId) return false
  return state.hardwareId === generateHardwareId()
}

// Mark license as blocked
function blockLicense(data) {
  const current = getLicenseState() || {}
  const state = {
    ...current,
    ...data,
    status: 'blocked',
    blockedAt: Date.now(),
  }
  return saveLicenseState(state)
}

// Check if license is blocked
function isLicenseBlocked() {
  const state = getLicenseState()
  return !!(state && state.status === 'blocked')
}

// ─── CERTIFICATION LICENSE (Microsoft Store test-access) ────────────────
// A certification license lets a dedicated, server-recognized account use the
// full application WITHOUT an approved hardware ID. It never weakens normal
// customers: it is only set after the backend Firestore registry authorizes
// the authenticated account, never from arbitrary client input.

// Mark the local state as a certification license for the given account.
function markCertified({ plan, email, uid, expiresAt }) {
  const current = getLicenseState() || {}
  const state = {
    ...current,
    status: 'approved',
    licenseType: 'certification',
    certifiedAccountEmail: email || current.email || null,
    certifiedAccountUid: uid || current.uid || null,
    plan: plan || current.plan || 'certification',
    certifiedAt: Date.now(),
    expiresAt: expiresAt || null,
    hardwareId: current.hardwareId || null,
  }
  return saveLicenseState(state)
}

// Is the local license a certification license?
function isCertificationLicense() {
  const state = getLicenseState()
  if (!state) return false
  return state.licenseType === 'certification' && state.status === 'approved'
}

// Effective license check used by the startup gate. For normal users this is
// the existing approved+hardware-match requirement. For a certification
// license, hardware match is explicitly NOT required (unknown reviewer device).
function isEffectiveLicensed() {
  const state = getLicenseState()
  if (!state) return false
  if (state.status !== 'approved') return false
  if (state.licenseType === 'certification') return true
  return isHardwareMatch()
}

module.exports = {
  generateHardwareId,
  getLicenseState,
  saveLicenseState,
  clearLicense,
  isLicenseApproved,
  isLicenseBlocked,
  getLicenseStatus,
  savePendingLicense,
  approveLicense,
  blockLicense,
  isHardwareMatch,
  markCertified,
  isCertificationLicense,
  isEffectiveLicensed,
}
