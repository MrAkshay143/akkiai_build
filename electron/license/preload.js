const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('licenseAPI', {
  // Auth
  signIn: () => ipcRenderer.invoke('auth-sign-in'),
  signOut: () => ipcRenderer.invoke('auth-sign-out'),
  getAuthStatus: () => ipcRenderer.invoke('auth-get-status'),
  onAuthStateChanged: (callback) => {
    const sub = (_event, user) => callback(user)
    ipcRenderer.on('auth-state-changed', sub)
    return () => ipcRenderer.removeListener('auth-state-changed', sub)
  },

  // License
  getLicenseStatus: () => ipcRenderer.invoke('license-get-status'),
  submitPayment: (data) => ipcRenderer.invoke('license-submit-payment', data),
  getHardwareId: () => ipcRenderer.invoke('license-get-hardware-id'),
  onLicenseApproved: (callback) => {
    ipcRenderer.on('license-approved', () => callback())
    return () => ipcRenderer.removeAllListeners('license-approved')
  },
  onLicenseStatusChange: (callback) => {
    const sub = (_event, status) => callback(status)
    ipcRenderer.on('license-status-changed', sub)
    return () => ipcRenderer.removeListener('license-status-changed', sub)
  },

  // Blocked
  isBlocked: () => ipcRenderer.invoke('license-is-blocked'),
  onLicenseBlocked: (callback) => {
    const sub = (_event, status) => callback(status)
    ipcRenderer.on('license-status-changed', sub)
    return () => ipcRenderer.removeListener('license-status-changed', sub)
  },

  // WhatsApp
  openWhatsApp: (text) => ipcRenderer.invoke('license-open-whatsapp', text),
})
