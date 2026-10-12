const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('onboardingAPI', {
  saveName: (name) => ipcRenderer.invoke('onboarding-save-name', name),
  saveAge: (age) => ipcRenderer.invoke('onboarding-save-age', age),
  signIn: () => ipcRenderer.invoke('onboarding-sign-in'),
  signOut: () => ipcRenderer.invoke('auth-sign-out'),
  getAuthStatus: () => ipcRenderer.invoke('auth-get-status'),
  getHardwareId: () => ipcRenderer.invoke('license-get-hardware-id'),
  submitPayment: (data) => ipcRenderer.invoke('license-submit-payment', data),
  getLicenseStatus: () => ipcRenderer.invoke('license-get-status'),
  openWhatsApp: (text) => ipcRenderer.invoke('license-open-whatsapp', text),
  getOnboardingData: () => ipcRenderer.invoke('onboarding-get-data'),
  getOnboardingMode: () => ipcRenderer.invoke('onboarding-get-mode'),
  reauthComplete: () => ipcRenderer.invoke('reauth-complete'),
  getMonitorStatus: () => ipcRenderer.invoke('license-monitor-status'),

  onAuthStateChanged: (callback) => {
    const sub = (_event, user) => callback(user)
    ipcRenderer.on('auth-state-changed', sub)
    return () => ipcRenderer.removeListener('auth-state-changed', sub)
  },

  onLicenseStatusChange: (callback) => {
    const sub = (_event, status) => callback(status)
    ipcRenderer.on('license-status-changed', sub)
    return () => ipcRenderer.removeListener('license-status-changed', sub)
  },

  onLicenseApproved: (callback) => {
    ipcRenderer.on('license-approved', () => callback())
    return () => ipcRenderer.removeAllListeners('license-approved')
  },

  onboardingComplete: () => ipcRenderer.invoke('onboarding-complete'),
})
