/**
 * Minimal Firmata Protocol Client
 * Uses only serialport@13 (already installed + rebuilt for Electron).
 * No johnny-five, no firmata package — zero extra dependencies.
 *
 * Supports: connect, disconnect, pinMode, digitalWrite, digitalRead,
 *           analogRead, analogWrite (PWM), servoWrite.
 *
 * Arduino must have StandardFirmata uploaded via Arduino IDE:
 *   File → Examples → Firmata → StandardFirmata
 */

const { EventEmitter } = require('events');

const TAG = '[FIRMATA]';
const log  = (...a) => console.log(TAG, ...a);
const warn = (...a) => console.warn(TAG, '⚠️', ...a);
const err  = (...a) => console.error(TAG, '❌', ...a);

// ── Pin modes (matches Firmata protocol) ──────────────────────────────────
const MODES = {
  INPUT:        0,
  OUTPUT:       1,
  ANALOG:       2,
  PWM:          3,
  SERVO:        4,
  PULLUP:       11,
};

// ── Arduino Uno R3 hardware specs ─────────────────────────────────────────
const UNO_SPEC = {
  totalPins:       20,   // digital 0-13, analog A0-A5 (14-19)
  digitalPinCount: 14,   // 0-13
  analogPins:      [14, 15, 16, 17, 18, 19],  // A0-A5 internal indices
  pwmPins:         [3, 5, 6, 9, 10, 11],
  builtinLED:      13,
};

class FirmataClient extends EventEmitter {
  constructor() {
    super();
    this._port          = null;
    this._rxBuf         = Buffer.alloc(0);
    this._portStates    = [0, 0, 0];   // tracks digital port output state (3 ports × 8 bits)
    this._analogCbs     = {};          // { analogPinIndex → callback }
    this._digitalCbs    = {};          // { pinNumber      → callback }
    this._blinkTimers   = {};          // { pinNumber      → setInterval id }
    this.firmware       = { name: 'StandardFirmata', major: 0, minor: 0 };
    this.isReady        = false;
    this.MODES          = MODES;
    this.HIGH           = 1;
    this.LOW            = 0;
    this.spec           = { ...UNO_SPEC };
  }

  // ── CONNECT ──────────────────────────────────────────────────────────────
  connect(path) {
    return new Promise((resolve, reject) => {
      log(`Connecting to ${path} at 57600 baud...`);
      let resolved = false;
      const settle = (fn, val) => { if (!resolved) { resolved = true; fn(val); } };

      const { SerialPort } = require('serialport');
      this._port = new SerialPort({ path, baudRate: 57600 });

      const connTimeout = setTimeout(() => {
        err('Timeout — no response from Arduino after 15s');
        settle(reject, new Error(
          `Firmata timeout on ${path}.\n` +
          `• Is StandardFirmata uploaded on the Arduino?\n` +
          `• Is ${path} the correct COM port?\n` +
          `• Is the Arduino plugged in via USB?`
        ));
      }, 15000);

      this._port.on('error', (e) => {
        err('SerialPort error:', e.message);
        clearTimeout(connTimeout);
        settle(reject, e);
      });

      this._port.on('open', () => {
        log('Serial port opened — sending Firmata handshake...');
        // Give hardware 500ms to settle, then reset + request firmware info
        setTimeout(() => this._handshake(), 500);
      });

      this._port.on('data', (data) => {
        this._parse(data);
      });

      this._port.on('close', () => {
        warn('Serial port closed');
        this.isReady = false;
        this.emit('close');
      });

      // Treat firmware report as "ready" signal
      this.once('firmware', () => {
        clearTimeout(connTimeout);
        log(`Board ready — Firmware: ${this.firmware.name} v${this.firmware.major}.${this.firmware.minor}`);
        this.isReady = true;
        this.emit('ready');
        settle(resolve, this);
      });

      // Fallback: if no firmware report within 4s after port open, assume ready anyway
      // (some older StandardFirmata versions don't send firmware report spontaneously)
      setTimeout(() => {
        if (!this.isReady) {
          clearTimeout(connTimeout);
          warn('No firmware report received — assuming board is ready (fallback)');
          this.isReady = true;
          this.emit('ready');
          settle(resolve, this);
        }
      }, 4500);
    });
  }

  _handshake() {
    // 1. System reset
    this._write([0xFF]);
    // 2. Request firmware version (SYSEX REPORT_FIRMWARE)
    setTimeout(() => {
      this._write([0xF0, 0x79, 0xF7]);
      // 3. Enable analog pin reporting for A0-A5
      for (let i = 0; i < 6; i++) this._write([0xC0 | i, 1]);
      // 4. Enable digital port reporting for ports 0-2
      for (let i = 0; i < 3; i++) this._write([0xD0 | i, 1]);
      log('Handshake sent — waiting for firmware report...');
    }, 200);
  }

  // ── DISCONNECT ───────────────────────────────────────────────────────────
  close() {
    this._stopAllBlinks();
    this._analogCbs  = {};
    this._digitalCbs = {};
    if (this._port && this._port.isOpen) {
      this._port.close();
    }
    this._port   = null;
    this.isReady = false;
    log('Disconnected');
  }

  // ── PIN CONTROL ───────────────────────────────────────────────────────────

  pinMode(pin, mode) {
    log(`  pinMode(${pin}, ${mode})`);
    this._write([0xF4, pin, mode]);
  }

  // Set digital pin HIGH(1) or LOW(0)
  digitalWrite(pin, value) {
    const portNum = Math.floor(pin / 8);
    const bit     = pin % 8;
    if (value) {
      this._portStates[portNum] |=  (1 << bit);
    } else {
      this._portStates[portNum] &= ~(1 << bit);
    }
    const pv = this._portStates[portNum];
    this._write([0x90 | portNum, pv & 0x7F, (pv >> 7) & 0x01]);
  }

  // Read digital pin once — calls back with 0 or 1
  digitalRead(pin, callback) {
    this._digitalCbs[pin] = callback;
    const portNum = Math.floor(pin / 8);
    this._write([0xD0 | portNum, 1]);
    // Request current port state via SYSEX PIN_STATE_QUERY as backup
    this._write([0xF0, 0x6D, pin, 0xF7]);
  }

  // PWM output — value 0-255 — only works on PWM pins: 3,5,6,9,10,11
  analogWrite(pin, value) {
    const v = Math.max(0, Math.min(255, Math.round(value)));
    this._write([0xE0 | pin, v & 0x7F, (v >> 7) & 0x01]);
  }

  // Move servo to angle 0-180 — must be on a PWM pin
  servoWrite(pin, angle) {
    const a = Math.max(0, Math.min(180, Math.round(angle)));
    this.pinMode(pin, MODES.SERVO);
    setTimeout(() => {
      // Use extended analog SYSEX for servo angle (more reliable than ANALOG_MESSAGE)
      this._write([0xF0, 0x6F, pin, a & 0x7F, (a >> 7) & 0x01, 0xF7]);
    }, 100);
  }

  // Read analog pin once — pass analogPinIndex 0-5 (A0=0, A1=1...)
  analogRead(analogPin, callback) {
    this._analogCbs[analogPin] = callback;
    this._write([0xC0 | analogPin, 1]);
    // No immediate request needed — Firmata sends continuous reports; callback fires on next report
  }

  // ── LED BLINK HELPERS ─────────────────────────────────────────────────────

  ledBlink(pin, intervalMs) {
    this.ledStop(pin);
    this.pinMode(pin, MODES.OUTPUT);
    let state = 0;
    this._blinkTimers[pin] = setInterval(() => {
      state = state ? 0 : 1;
      this.digitalWrite(pin, state);
    }, intervalMs);
    log(`  LED blink started on pin ${pin} @ ${intervalMs}ms`);
  }

  ledStop(pin) {
    if (this._blinkTimers[pin]) {
      clearInterval(this._blinkTimers[pin]);
      delete this._blinkTimers[pin];
    }
    this.digitalWrite(pin, 0);
    log(`  LED stopped on pin ${pin}`);
  }

  _stopAllBlinks() {
    Object.keys(this._blinkTimers).forEach(pin => {
      clearInterval(this._blinkTimers[pin]);
    });
    this._blinkTimers = {};
  }

  // ── SERIAL WRITE HELPER ───────────────────────────────────────────────────
  _write(bytes) {
    if (!this._port || !this._port.isOpen) {
      warn('_write() — port not open, skipping');
      return;
    }
    this._port.write(Buffer.from(bytes));
  }

  // ── FIRMATA PROTOCOL PARSER ───────────────────────────────────────────────
  _parse(data) {
    this._rxBuf = Buffer.concat([this._rxBuf, data]);

    while (this._rxBuf.length > 0) {
      const byte = this._rxBuf[0];

      // ── SYSEX (0xF0 ... 0xF7) ─────────────────────────────────────────
      if (byte === 0xF0) {
        const endIdx = this._rxBuf.indexOf(0xF7, 1);
        if (endIdx === -1) break; // Wait for complete SYSEX

        const sysexType = this._rxBuf[1];

        // REPORT_FIRMWARE (0x79)
        if (sysexType === 0x79 && endIdx >= 4) {
          const major = this._rxBuf[2];
          const minor = this._rxBuf[3];
          let name = '';
          for (let i = 4; i < endIdx - 1; i += 2) {
            if (i + 1 < endIdx) {
              const ch = (this._rxBuf[i] & 0x7F) | ((this._rxBuf[i + 1] & 0x7F) << 7);
              if (ch > 0) name += String.fromCharCode(ch);
            }
          }
          this.firmware = { name: name.trim() || 'StandardFirmata', major, minor };
          log(`Firmware: ${this.firmware.name} v${major}.${minor}`);
          this.emit('firmware', this.firmware);
        }

        // PIN_STATE_RESPONSE (0x6E) — response to PIN_STATE_QUERY
        if (sysexType === 0x6E && endIdx >= 5) {
          const pin   = this._rxBuf[2];
          const mode  = this._rxBuf[3];
          const value = this._rxBuf[4] | (endIdx > 5 ? (this._rxBuf[5] << 7) : 0);
          if (this._digitalCbs[pin]) {
            this._digitalCbs[pin](value & 1);
            delete this._digitalCbs[pin];
          }
        }

        this._rxBuf = this._rxBuf.slice(endIdx + 1);
        continue;
      }

      const cmd  = byte & 0xF0;
      const chan  = byte & 0x0F;

      // ── ANALOG_MESSAGE (0xE0 | analogPin) ─────────────────────────────
      if (cmd === 0xE0) {
        if (this._rxBuf.length < 3) break;
        const value = this._rxBuf[1] | (this._rxBuf[2] << 7);
        if (this._analogCbs[chan] !== undefined) {
          this._analogCbs[chan](value);
          // Keep callback for continuous reads (don't delete)
        }
        this._rxBuf = this._rxBuf.slice(3);
        continue;
      }

      // ── DIGITAL_MESSAGE (0x90 | portNumber) ───────────────────────────
      if (cmd === 0x90) {
        if (this._rxBuf.length < 3) break;
        const portVal = this._rxBuf[1] | (this._rxBuf[2] << 7);
        for (let bit = 0; bit < 8; bit++) {
          const pin  = chan * 8 + bit;
          const pinV = (portVal >> bit) & 1;
          if (this._digitalCbs[pin] !== undefined) {
            this._digitalCbs[pin](pinV);
            delete this._digitalCbs[pin]; // one-shot digital read
          }
        }
        this._rxBuf = this._rxBuf.slice(3);
        continue;
      }

      // ── Skip unknown bytes ─────────────────────────────────────────────
      this._rxBuf = this._rxBuf.slice(1);
    }
  }
}

module.exports = { FirmataClient, MODES, UNO_SPEC };
