// Web Bluetooth-koppeling met de standaard Heart Rate- en Battery-service.

export const HR_SERVICE = 'heart_rate';                  // 0x180D
export const HR_MEASUREMENT = 'heart_rate_measurement';  // 0x2A37
export const BATTERY_SERVICE = 'battery_service';        // 0x180F
export const BATTERY_LEVEL = 'battery_level';            // 0x2A19

const MAX_RETRIES = 8;

/**
 * Leest een Heart Rate Measurement-pakket (0x2A37) uit.
 *  flags bit 0: 0 = hartslag uint8, 1 = uint16
 *  flags bit 1-2: huidcontact (bit 2 = ondersteund, bit 1 = gedetecteerd)
 *  flags bit 3: energy expended aanwezig (uint16, overslaan)
 *  flags bit 4: RR-intervallen aanwezig (uint16 LE, eenheid 1/1024 s)
 */
export function parseHeartRate(value) {
  const dv = value instanceof DataView
    ? value
    : new DataView(value.buffer, value.byteOffset || 0, value.byteLength);
  if (dv.byteLength < 2) throw new RangeError('Pakket te kort');

  const flags = dv.getUint8(0);
  let offset = 1;

  const hr16 = (flags & 0x01) !== 0;
  if (hr16 && dv.byteLength < 3) throw new RangeError('Pakket te kort');
  const hr = hr16 ? dv.getUint16(offset, true) : dv.getUint8(offset);
  offset += hr16 ? 2 : 1;

  const contactSupported = (flags & 0x04) !== 0;
  const contact = contactSupported ? (flags & 0x02) !== 0 : null;

  let energy = null;
  if (flags & 0x08) {
    if (offset + 2 <= dv.byteLength) energy = dv.getUint16(offset, true);
    offset += 2;
  }

  const rrPresent = (flags & 0x10) !== 0;
  const rr = [];
  if (rrPresent) {
    while (offset + 2 <= dv.byteLength) {
      rr.push((dv.getUint16(offset, true) * 1000) / 1024);
      offset += 2;
    }
  }
  return { hr, contact, energy, rr, rrPresent };
}

export class BleSource extends EventTarget {
  constructor() {
    super();
    this.kind = 'ble';
    this.device = null;
    this.hrChar = null;
    this.batteryChar = null;
    this.manual = false;
    this.retries = 0;
    this.retryTimer = null;
    this.status = 'idle';
    this._onDisconnected = this._onDisconnected.bind(this);
    this._onHr = this._onHr.bind(this);
    this._onBattery = this._onBattery.bind(this);
  }

  static get supported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth && typeof navigator.bluetooth.requestDevice === 'function';
  }

  get name() { return this.device?.name || 'band'; }

  async request(acceptAll = false) {
    const optionalServices = [HR_SERVICE, BATTERY_SERVICE];
    const options = acceptAll
      ? { acceptAllDevices: true, optionalServices }
      : { filters: [{ namePrefix: 'WHOOP' }], optionalServices };
    const device = await navigator.bluetooth.requestDevice(options);
    this._attach(device);
    this.manual = false;
    this.retries = 0;
    await this._connect();
  }

  _attach(device) {
    if (this.device && this.device !== device) {
      this.device.removeEventListener('gattserverdisconnected', this._onDisconnected);
    }
    this.device = device;
    device.addEventListener('gattserverdisconnected', this._onDisconnected);
  }

  async _connect() {
    this._setStatus(this.retries > 0 ? 'reconnecting' : 'connecting', { attempt: this.retries });
    const server = await this.device.gatt.connect();

    let service;
    try {
      service = await server.getPrimaryService(HR_SERVICE);
    } catch (cause) {
      const err = new Error('Geen hartslagdienst');
      err.code = 'NO_HR_SERVICE';
      err.cause = cause;
      this.manual = true;
      try { server.disconnect(); } catch {}
      this._setStatus('idle');
      throw err;
    }

    const ch = await service.getCharacteristic(HR_MEASUREMENT);
    ch.removeEventListener('characteristicvaluechanged', this._onHr);
    ch.addEventListener('characteristicvaluechanged', this._onHr);
    await ch.startNotifications();
    this.hrChar = ch;
    this.retries = 0;
    this._setStatus('connected');
    this._readBattery(server);
  }

  async _readBattery(server) {
    try {
      const svc = await server.getPrimaryService(BATTERY_SERVICE);
      const ch = await svc.getCharacteristic(BATTERY_LEVEL);
      const v = await ch.readValue();
      this._emitBattery(v.getUint8(0));
      if (ch.properties?.notify) {
        ch.removeEventListener('characteristicvaluechanged', this._onBattery);
        ch.addEventListener('characteristicvaluechanged', this._onBattery);
        await ch.startNotifications().catch(() => {});
      }
      this.batteryChar = ch;
    } catch {
      this._emitBattery(null);
    }
  }

  _onBattery(e) { this._emitBattery(e.target.value.getUint8(0)); }
  _emitBattery(level) { this.dispatchEvent(new CustomEvent('battery', { detail: { level } })); }

  _onHr(e) {
    try {
      const data = parseHeartRate(e.target.value);
      this.dispatchEvent(new CustomEvent('data', { detail: data }));
    } catch {
      /* ongeldig pakket negeren */
    }
  }

  _onDisconnected() {
    this.hrChar = null;
    if (this.manual) { this._setStatus('idle'); return; }
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    clearTimeout(this.retryTimer);
    this.retries += 1;
    if (this.retries > MAX_RETRIES) { this._setStatus('lost'); return; }
    const delay = Math.min(1000 * 2 ** (this.retries - 1), 15000);
    this._setStatus('reconnecting', { attempt: this.retries, max: MAX_RETRIES, delay });
    this.retryTimer = setTimeout(async () => {
      if (this.manual) return;
      try {
        await this._connect();
      } catch (err) {
        if (err.code === 'NO_HR_SERVICE') {
          this.dispatchEvent(new CustomEvent('error', { detail: err }));
          return;
        }
        if (!this.manual && !this.device?.gatt?.connected) this._scheduleReconnect();
      }
    }, delay);
  }

  /** Handmatig opnieuw proberen nadat automatisch herverbinden is opgegeven. */
  async retry() {
    if (!this.device) return;
    this.manual = false;
    this.retries = 0;
    clearTimeout(this.retryTimer);
    try { await this._connect(); }
    catch (err) {
      if (err.code === 'NO_HR_SERVICE') throw err;
      this._scheduleReconnect();
    }
  }

  stop() {
    this.manual = true;
    clearTimeout(this.retryTimer);
    try { this.hrChar?.removeEventListener('characteristicvaluechanged', this._onHr); } catch {}
    try { if (this.device?.gatt?.connected) this.device.gatt.disconnect(); } catch {}
    this.hrChar = null;
    this._setStatus('idle');
  }

  _setStatus(status, extra = {}) {
    this.status = status;
    this.dispatchEvent(new CustomEvent('status', { detail: { status, ...extra } }));
  }
}
