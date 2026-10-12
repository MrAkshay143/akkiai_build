/**
 * Arduino Hardware IPC Handlers
 * Uses custom FirmataClient (serialport@13 only — no johnny-five, no firmata package).
 */

const { ipcMain } = require('electron');
const { FirmataClient, UNO_SPEC } = require('./firmata-client');

// ── Logger ──────────────────────────────────────────────────────────────────
const TAG  = '[ARDUINO]';
const log  = (...a) => console.log(TAG, ...a);
const warn = (...a) => console.warn(TAG, '⚠️', ...a);
const err  = (...a) => console.error(TAG, '❌', ...a);

// ── Module check ────────────────────────────────────────────────────────────
log('hardware-handlers.js loaded — checking dependencies...');
let _diag = null;
function getDiag() {
  if (_diag) return _diag;
  _diag = { serialport: false, errors: {} };
  try { require('serialport'); _diag.serialport = true; }
  catch (e) { _diag.errors.serialport = e.message; }
  log('  serialport :', _diag.serialport ? '✅ OK' : `❌ MISSING — ${_diag.errors.serialport}`);
  log('  firmata    : ✅ Built-in (custom Firmata client — no package needed)');
  return _diag;
}
getDiag();

// ── State ───────────────────────────────────────────────────────────────────
let client        = null;   // FirmataClient instance
let connectedPort = null;
let connecting    = false;

function isConnected() {
  return client !== null && client.isReady;
}

function notConnectedError() {
  warn('Not connected. board:', !!client, '| isReady:', client?.isReady);
  return { success: false, error: 'Arduino not connected. Call arduino_connect first.' };
}

function buildBoardInfo() {
  return {
    port:            connectedPort,
    firmware:        `${client.firmware.name} v${client.firmware.major}.${client.firmware.minor}`,
    totalPins:       UNO_SPEC.totalPins,
    digitalPinCount: UNO_SPEC.digitalPinCount,
    analogPins:      UNO_SPEC.analogPins,
    pwmPins:         UNO_SPEC.pwmPins,
    builtinLED:      UNO_SPEC.builtinLED,
  };
}

// ── Register all IPC handlers ────────────────────────────────────────────────
function registerHardwareHandlers() {

  // ── LIST PORTS ─────────────────────────────────────────────────────────────
  ipcMain.handle('arduino-list-ports', async () => {
    log('→ arduino-list-ports');
    const diag = getDiag();
    if (!diag.serialport) {
      return { success: false, error: `serialport not installed.\nRun: npm install && npm run rebuild:native`, diagnostics: diag };
    }
    try {
      const { SerialPort } = require('serialport');
      const ports = await SerialPort.list();
      log(`Found ${ports.length} port(s):`, ports.map(p => p.path).join(', ') || '(none)');
      return {
        success: true,
        ports: ports.map(p => ({
          path:         p.path,
          manufacturer: p.manufacturer || 'Unknown',
          serialNumber: p.serialNumber || null,
          vendorId:     p.vendorId     || null,
          productId:    p.productId    || null,
        })),
        diagnostics: diag,
      };
    } catch (e) {
      err('SerialPort.list() failed:', e.message);
      return { success: false, error: e.message };
    }
  });

  // ── CONNECT ────────────────────────────────────────────────────────────────
  ipcMain.handle('arduino-connect', async (event, { port } = {}) => {
    log(`→ arduino-connect | port: "${port}"`);
    const diag = getDiag();

    if (!diag.serialport) {
      return { success: false, error: `serialport not installed.\nRun: npm install && npm run rebuild:native`, diagnostics: diag };
    }
    if (!port) return { success: false, error: 'port argument required (e.g. "COM3").' };
    if (connecting) return { success: false, error: 'Already connecting — please wait.' };
    if (isConnected()) {
      log('Already connected to', connectedPort);
      return { success: true, alreadyConnected: true, info: buildBoardInfo() };
    }

    connecting = true;
    connectedPort = port;

    try {
      client = new FirmataClient();

      client.on('close', () => {
        warn('Board disconnected unexpectedly');
        client = null;
        connecting = false;
      });

      log('Calling FirmataClient.connect()...');
      await client.connect(port);
      connecting = false;
      const info = buildBoardInfo();
      log('Connected ✅', JSON.stringify(info));
      return { success: true, info };

    } catch (e) {
      err('Connection failed:', e.message);
      client     = null;
      connecting = false;
      connectedPort = null;
      return { success: false, error: e.message };
    }
  });

  // ── DISCONNECT ─────────────────────────────────────────────────────────────
  ipcMain.handle('arduino-disconnect', async () => {
    log('→ arduino-disconnect');
    if (!client) return { success: true, message: 'Already disconnected.' };
    try {
      client.close();
      client        = null;
      connectedPort = null;
      log('Disconnected ✅');
      return { success: true };
    } catch (e) {
      err('Disconnect error:', e.message);
      return { success: false, error: e.message };
    }
  });

  // ── BOARD STATUS ───────────────────────────────────────────────────────────
  ipcMain.handle('arduino-board-status', async () => {
    log('→ arduino-board-status | connected:', isConnected());
    if (!isConnected()) return notConnectedError();
    const info = buildBoardInfo();
    log('Status:', info.firmware);
    return { success: true, info };
  });

  // ── DIGITAL WRITE ──────────────────────────────────────────────────────────
  ipcMain.handle('arduino-digital-write', async (event, { pin, value } = {}) => {
    log(`→ arduino-digital-write | pin: ${pin}, value: ${value}`);
    if (!isConnected()) return notConnectedError();
    try {
      client.pinMode(pin, client.MODES.OUTPUT);
      const out = value ? 1 : 0;
      client.digitalWrite(pin, out);
      log(`  Pin ${pin} → ${out ? 'HIGH' : 'LOW'} ✅`);
      return { success: true, pin, value: out };
    } catch (e) {
      err(`digitalWrite pin ${pin}:`, e.message);
      return { success: false, error: e.message };
    }
  });

  // ── DIGITAL READ ───────────────────────────────────────────────────────────
  ipcMain.handle('arduino-digital-read', async (event, { pin } = {}) => {
    log(`→ arduino-digital-read | pin: ${pin}`);
    if (!isConnected()) return notConnectedError();
    return new Promise((resolve) => {
      let done = false;
      try {
        client.pinMode(pin, client.MODES.INPUT);
        client.digitalRead(pin, (v) => {
          if (done) return;
          done = true;
          log(`  Pin ${pin} = ${v}`);
          resolve({ success: true, pin, value: v });
        });
        setTimeout(() => {
          if (!done) { done = true; err(`digitalRead pin ${pin} timeout`); resolve({ success: false, error: `Digital read pin ${pin} timed out.` }); }
        }, 3000);
      } catch (e) {
        err(`digitalRead pin ${pin}:`, e.message);
        resolve({ success: false, error: e.message });
      }
    });
  });

  // ── ANALOG READ ────────────────────────────────────────────────────────────
  ipcMain.handle('arduino-analog-read', async (event, { pin } = {}) => {
    log(`→ arduino-analog-read | A${pin}`);
    if (!isConnected()) return notConnectedError();
    return new Promise((resolve) => {
      let done = false;
      try {
        client.analogRead(pin, (v) => {
          if (done) return;
          done = true;
          const voltage = ((v / 1023) * 5).toFixed(3);
          log(`  A${pin} = ${v} (${voltage}V)`);
          resolve({ success: true, analogPin: `A${pin}`, value: v, voltage });
        });
        setTimeout(() => {
          if (!done) { done = true; err(`analogRead A${pin} timeout`); resolve({ success: false, error: `Analog read A${pin} timed out.` }); }
        }, 3000);
      } catch (e) {
        err(`analogRead A${pin}:`, e.message);
        resolve({ success: false, error: e.message });
      }
    });
  });

  // ── ANALOG WRITE (PWM) ─────────────────────────────────────────────────────
  ipcMain.handle('arduino-analog-write', async (event, { pin, value } = {}) => {
    log(`→ arduino-analog-write | pin: ${pin}, value: ${value}`);
    if (!isConnected()) return notConnectedError();
    try {
      client.pinMode(pin, client.MODES.PWM);
      const v = Math.max(0, Math.min(255, Math.round(Number(value))));
      client.analogWrite(pin, v);
      log(`  Pin ${pin} PWM → ${v}/255 (${Math.round((v / 255) * 100)}%) ✅`);
      return { success: true, pin, value: v, percentage: Math.round((v / 255) * 100) };
    } catch (e) {
      err(`analogWrite pin ${pin}:`, e.message);
      return { success: false, error: e.message };
    }
  });

  // ── SET PIN MODE ───────────────────────────────────────────────────────────
  ipcMain.handle('arduino-set-pin-mode', async (event, { pin, mode } = {}) => {
    log(`→ arduino-set-pin-mode | pin: ${pin}, mode: ${mode}`);
    if (!isConnected()) return notConnectedError();
    try {
      const modeMap = {
        INPUT:        client.MODES.INPUT,
        OUTPUT:       client.MODES.OUTPUT,
        INPUT_PULLUP: client.MODES.PULLUP,
        PWM:          client.MODES.PWM,
        SERVO:        client.MODES.SERVO,
        ANALOG:       client.MODES.ANALOG,
      };
      const firmataMode = modeMap[String(mode).toUpperCase()];
      if (firmataMode === undefined) {
        return { success: false, error: `Unknown mode "${mode}". Valid: INPUT, OUTPUT, INPUT_PULLUP, PWM, SERVO, ANALOG` };
      }
      client.pinMode(pin, firmataMode);
      log(`  Pin ${pin} mode → ${mode} ✅`);
      return { success: true, pin, mode };
    } catch (e) {
      err(`pinMode pin ${pin}:`, e.message);
      return { success: false, error: e.message };
    }
  });

  // ── SERVO WRITE ────────────────────────────────────────────────────────────
  ipcMain.handle('arduino-servo-write', async (event, { pin, angle } = {}) => {
    log(`→ arduino-servo-write | pin: ${pin}, angle: ${angle}°`);
    if (!isConnected()) return notConnectedError();
    try {
      const a = Math.max(0, Math.min(180, Math.round(Number(angle))));
      client.servoWrite(pin, a);
      log(`  Servo pin ${pin} → ${a}° ✅`);
      return { success: true, pin, angle: a };
    } catch (e) {
      err(`servoWrite pin ${pin}:`, e.message);
      return { success: false, error: e.message };
    }
  });

  // ── LED BLINK ──────────────────────────────────────────────────────────────
  ipcMain.handle('arduino-led-blink', async (event, { pin, intervalMs } = {}) => {
    log(`→ arduino-led-blink | pin: ${pin}, interval: ${intervalMs || 500}ms`);
    if (!isConnected()) return notConnectedError();
    try {
      const interval = Math.max(50, Number(intervalMs) || 500);
      client.ledBlink(pin, interval);
      log(`  LED pin ${pin} blinking @ ${interval}ms ✅`);
      return { success: true, pin, intervalMs: interval };
    } catch (e) {
      err(`ledBlink pin ${pin}:`, e.message);
      return { success: false, error: e.message };
    }
  });

  // ── LED STOP ───────────────────────────────────────────────────────────────
  ipcMain.handle('arduino-led-stop', async (event, { pin } = {}) => {
    log(`→ arduino-led-stop | pin: ${pin}`);
    if (!isConnected()) return notConnectedError();
    try {
      client.ledStop(pin);
      log(`  LED pin ${pin} stopped ✅`);
      return { success: true, pin };
    } catch (e) {
      err(`ledStop pin ${pin}:`, e.message);
      return { success: false, error: e.message };
    }
  });

  log('✅ All 12 Arduino hardware handlers registered');
}

module.exports = { registerHardwareHandlers };
