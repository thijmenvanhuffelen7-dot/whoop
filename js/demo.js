// Demo-bron: simuleert realistische hartslag en RR-intervallen.
// De gegenereerde data wordt als echt 0x2A37-pakket opgebouwd en via
// dezelfde parser uitgelezen als een echte band.
import { parseHeartRate } from './ble.js';

export class DemoSource extends EventTarget {
  constructor() {
    super();
    this.kind = 'demo';
    this.status = 'idle';
    this.timer = null;
    this.name = 'Demoband';
    this.breathHz = 0.22;   // ~13 ademhalingen per minuut
    this.rsaAmp = 3.5;      // bpm
    this.base = 60 + Math.random() * 8;
    this.drift = 0;
    this.battery = 82;
  }

  start() {
    this.t0 = performance.now();
    this.beatAt = 0;  // ms sinds start van de volgende slag
    this.lastTick = 0;
    this._setStatus('connected');
    this.dispatchEvent(new CustomEvent('battery', { detail: { level: this.battery } }));
    this.timer = setInterval(() => this._tick(), 1000);
    setTimeout(() => this._tick(), 150);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this._setStatus('idle');
  }

  /** Laat de RSA meebewegen met een ademhalingsbegeleider. */
  setBreathing(perMinute) {
    if (perMinute) { this.breathHz = perMinute / 60; this.rsaAmp = perMinute <= 7 ? 7.5 : 5; }
    else { this.breathHz = 0.22; this.rsaAmp = 3.5; }
  }

  _hrAt(tMs) {
    const t = tMs / 1000;
    const resp = this.rsaAmp * Math.sin(2 * Math.PI * this.breathHz * t);
    const slow = 2.2 * Math.sin(2 * Math.PI * 0.035 * t + 1.3);
    return this.base + this.drift + resp + slow;
  }

  _tick() {
    const now = performance.now() - this.t0;
    // Langzame random walk, begrensd
    this.drift += (Math.random() - 0.5) * 0.8;
    this.drift = Math.max(-6, Math.min(10, this.drift * 0.985));

    const rr = [];
    while (this.beatAt <= now) {
      let interval = 60000 / this._hrAt(this.beatAt) + (Math.random() - 0.5) * 18;
      this.beatAt += interval;
      // Af en toe een artefact (gemiste of extra slag)
      const r = Math.random();
      if (r < 0.006) interval *= 1.9;
      else if (r < 0.012) interval *= 0.55;
      rr.push(interval);
    }
    if (!rr.length) return;

    if (Math.random() < 0.01 && this.battery > 5) {
      this.battery -= 1;
      this.dispatchEvent(new CustomEvent('battery', { detail: { level: this.battery } }));
    }

    const hr = Math.round(this._hrAt(now));
    const packet = buildPacket(hr, rr.slice(-6));
    const data = parseHeartRate(packet);
    this.dispatchEvent(new CustomEvent('data', { detail: data }));
  }

  _setStatus(status) {
    this.status = status;
    this.dispatchEvent(new CustomEvent('status', { detail: { status } }));
  }
}

/** Bouwt een 0x2A37-pakket: uint8 hartslag, contact gedetecteerd, RR aanwezig. */
export function buildPacket(hr, rrMs, { hr16 = false, energy = null } = {}) {
  const flags = (hr16 ? 0x01 : 0) | 0x06 | (energy != null ? 0x08 : 0) | (rrMs.length ? 0x10 : 0);
  const size = 1 + (hr16 ? 2 : 1) + (energy != null ? 2 : 0) + rrMs.length * 2;
  const dv = new DataView(new ArrayBuffer(size));
  let o = 0;
  dv.setUint8(o++, flags);
  if (hr16) { dv.setUint16(o, hr, true); o += 2; } else { dv.setUint8(o++, Math.min(255, hr)); }
  if (energy != null) { dv.setUint16(o, energy, true); o += 2; }
  for (const ms of rrMs) { dv.setUint16(o, Math.round((ms * 1024) / 1000), true); o += 2; }
  return dv;
}
