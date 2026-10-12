const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const diagLog = (msg) => {
  try {
    const p = path.join(app.getPath('userData'), 'akki_startup_diag.log');
    fs.appendFileSync(p, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) {}
};
global.diagLog = diagLog;

process.on('uncaughtException', (err) => {
  diagLog('GLOBAL UNCAUGHT EXCEPTION: ' + (err ? (err.stack || err.message) : 'Unknown'));
});
process.on('unhandledRejection', (reason) => {
  diagLog('GLOBAL UNHANDLED REJECTION: ' + (reason ? (reason.stack || reason.message || reason) : 'Unknown'));
});

app.on('before-quit', () => diagLog('EVENT: before-quit'));
app.on('will-quit', () => diagLog('EVENT: will-quit'));
app.on('quit', (e, code) => diagLog('EVENT: quit code=' + code));
app.on('window-all-closed', () => diagLog('EVENT: window-all-closed'));

diagLog('main.js starting');

try {
  const resourcesPath = process.resourcesPath || path.join(__dirname, '..', '..');
  const unpackedModules = path.join(resourcesPath, 'app.asar.unpacked', 'node_modules');
  const resourcesModules = path.join(resourcesPath, 'node_modules');

  const extraPaths = [unpackedModules, resourcesModules].filter(p => fs.existsSync(p));

  // 1. Hook _nodeModulePaths so all modules down the tree get extra search paths
  const origNodeModulePaths = Module._nodeModulePaths;
  Module._nodeModulePaths = function(from) {
    const paths = origNodeModulePaths.call(this, from);
    return extraPaths.concat(paths);
  };

  // 2. Hook _resolveFilename as fallback for unpacked and external modules
  const origResolveFilename = Module._resolveFilename;
  Module._resolveFilename = function(request, parent, isMain, options) {
    try {
      return origResolveFilename.call(this, request, parent, isMain, options);
    } catch (err) {
      if (err && err.code === 'MODULE_NOT_FOUND') {
        for (const extraDir of extraPaths) {
          try {
            return origResolveFilename.call(this, path.join(extraDir, request), parent, isMain, options);
          } catch (e2) {}
        }
      }
      throw err;
    }
  };

  diagLog('Module hooks installed successfully. Extra paths: ' + extraPaths.join('; '));

  require('./main_source.js');
  diagLog('main_source.js loaded successfully');
} catch (err) {
  diagLog('FATAL ERROR loading main_source.js: ' + (err ? (err.stack || err.message) : 'Unknown error'));
  throw err;
}