const path = require('path')
const fs = require('fs')
const { app, safeStorage } = require('electron')

const CREDENTIAL_FILE = 'firebase_credential.bin'

function getCredentialPath() {
  return path.join(app.getPath('userData'), CREDENTIAL_FILE)
}

function isEncryptionAvailable() {
  try {
    return !!safeStorage && safeStorage.isEncryptionAvailable()
  } catch (e) {
    return false
  }
}

// Persist the Google OAuth refresh token encrypted with OS-level safeStorage
// (DPAPI on Windows). Never store the raw token. Fail closed if encryption is
// unavailable. Tokens are never logged.
function saveCredential(refreshToken) {
  if (!refreshToken || typeof refreshToken !== 'string' || refreshToken.length === 0) {
    return false
  }
  if (!isEncryptionAvailable()) {
    console.error('[CredentialStore] safeStorage encryption unavailable — refusing to persist refresh token insecurely (fail closed).')
    return false
  }
  try {
    const encrypted = safeStorage.encryptString(refreshToken)
    fs.writeFileSync(getCredentialPath(), encrypted)
    return true
  } catch (err) {
    console.error('[CredentialStore] Failed to encrypt/ persist credential:', err && err.message)
    return false
  }
}

function loadCredential() {
  try {
    if (!isEncryptionAvailable()) return null
    const p = getCredentialPath()
    if (!fs.existsSync(p)) return null
    const encrypted = fs.readFileSync(p)
    const refreshToken = safeStorage.decryptString(encrypted)
    if (!refreshToken) return null
    return { refreshToken }
  } catch (err) {
    // Ciphertext belongs to a different OS user / app rekey / corrupted file.
    // Fail closed: remove it and require a fresh login.
    console.error('[CredentialStore] Failed to decrypt stored credential; removing it. Manual login required:', err && err.message)
    try {
      const p = getCredentialPath()
      if (fs.existsSync(p)) fs.unlinkSync(p)
    } catch (e) { /* ignore */ }
    return null
  }
}

function deleteCredential() {
  try {
    const p = getCredentialPath()
    if (fs.existsSync(p)) fs.unlinkSync(p)
    return true
  } catch (err) {
    console.error('[CredentialStore] Failed to delete credential:', err && err.message)
    return false
  }
}

module.exports = {
  saveCredential,
  loadCredential,
  deleteCredential,
  isEncryptionAvailable,
}