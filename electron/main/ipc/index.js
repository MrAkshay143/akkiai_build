const { registerSkillsHandlers } = require('./skills-handlers');
const { registerSystemHandlers } = require('./system-handlers');
const { registerHardwareHandlers } = require('./hardware-handlers');
const { registerWhatsAppHandlers } = require('./whatsapp-handlers');

// Shared state for cross-module access (set by main.js after window creation)
let _mainWindow = null;
let _whatsAppManager = null;

function registerDomainHandlers() {
  registerSystemHandlers();
  registerSkillsHandlers();
  registerHardwareHandlers();
  registerWhatsAppHandlers({
    getMainWindow: () => _mainWindow,
    getWhatsAppManager: () => _whatsAppManager,
    setWhatsAppManager: (mgr) => { _whatsAppManager = mgr; },
  });
}

function setMainWindow(win) { _mainWindow = win; }
function getMainWindow() { return _mainWindow; }
function getWhatsAppManager() { return _whatsAppManager; }
function setWhatsAppManager(mgr) { _whatsAppManager = mgr; }

module.exports = {
  registerDomainHandlers,
  setMainWindow,
  getMainWindow,
  getWhatsAppManager,
  setWhatsAppManager,
};
