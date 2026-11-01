import { BleSource } from './ble.js';
import { DemoSource } from './demo.js';
import { analyze, filterRR } from './hrv.js';
import { db } from './db.js';
import { LiveChart, drawSparkline, drawTrend } from './chart.js';

/* ============================================================
   Hulpjes
   ============================================================ */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const nf0 = new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const fmtDate = new Intl.DateTimeFormat('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmt0 = (v) => (v == null || !isFinite(v) ? '–' : nf0.format(v));
const mmss = (s) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const durText = (s) => (s >= 90 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

/* ============================================================
   Instellingen
   ============================================================ */
const SETTINGS_KEY = 'whoop.settings';
const defaults = { age: null, maxHr: null, restHr: null, hrvDuration: 60, theme: 'dark', breathRate: 6, onboarded: false, iosHintDismissed: false };
const settings = (() => {
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
  catch { return { ...defaults }; }
})();
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}

function maxHr() {
  if (settings.maxHr) return settings.maxHr;
  if (settings.age) return Math.round(208 - 0.7 * settings.age); // Tanaka
  return 190;
}
function restHr() { return settings.restHr || 60; }

const ZONES = [
  { label: 'Rust' },
  { label: 'Zone 1 · Herstel' },
  { label: 'Zone 2 · Licht' },
  { label: 'Zone 3 · Matig' },
  { label: 'Zone 4 · Zwaar' },
  { label: 'Zone 5 · Maximaal' },
];
/** Zone op basis van hartslagreserve (Karvonen). Kleur: blauw → groen → geel → oranje → rood. */
function zoneFor(hr) {
  const pct = (hr - restHr()) / Math.max(1, maxHr() - restHr());
  const n = pct < 0.5 ? 0 : pct < 0.6 ? 1 : pct < 0.7 ? 2 : pct < 0.8 ? 3 : pct < 0.9 ? 4 : 5;
  return { n, ...ZONES[n], pct };
}

/* ============================================================
   Thema
   ============================================================ */
const lightQuery = matchMedia('(prefers-color-scheme: light)');
function applyTheme() {
  const t = settings.theme === 'system' ? (lightQuery.matches ? 'light' : 'dark') : settings.theme;
  document.documentElement.dataset.theme = t;
  $('#meta-theme').setAttribute('content', t === 'light' ? '#f4f5f8' : '#0b0d10');
  liveChart?.draw();
  if (currentTab === 'history') renderHistory();
}
lightQuery.addEventListener?.('change', () => settings.theme === 'system' && applyTheme());

/* ============================================================
   Toestand
   ============================================================ */
const state = {
  source: null,
  status: 'idle',
  hr: null,
  contact: null,
  battery: null,
  hrHist: [],    // {t, hr}
  rrHist: [],    // {t, rr}
  rrSeen: false,
  connectedAt: 0,
  lastData: 0,
  recording: null,
};
const listeners = new Set(); // ontvangers van ruwe data (meting, adem, opname)

let liveChart;
let currentTab = 'live';

/* ============================================================
   Bron (band of demo)
   ============================================================ */
function bindSource(src) {
  src.addEventListener('status', (e) => onStatus(e.detail));
  src.addEventListener('data', (e) => onData(e.detail));
  src.addEventListener('battery', (e) => onBattery(e.detail.level));
  src.addEventListener('error', (e) => onSourceError(e.detail));
}

async function connectBle(acceptAll) {
  hide('#error-notice'); hide('#no-hr-notice');
  if (!BleSource.supported) { show('#no-bt-notice'); return; }
  try {
    if (navigator.bluetooth.getAvailability && !(await navigator.bluetooth.getAvailability())) {
      showError('Bluetooth staat uit of is niet beschikbaar op dit toestel. Zet Bluetooth aan en probeer het opnieuw.');
      return;
    }
  } catch {}
  stopSource();
  const src = new BleSource();
  bindSource(src);
  state.source = src;
  try {
    await src.request(acceptAll);
  } catch (err) {
    state.source = null;
    onSourceError(err);
    onStatus({ status: 'idle' });
  }
}

function startDemo() {
  hide('#error-notice'); hide('#no-hr-notice');
  stopSource();
  const src = new DemoSource();
  bindSource(src);
  state.source = src;
  src.start();
  toast('Demo-modus gestart. De data is gesimuleerd.');
}

function stopSource() {
  if (state.recording) stopRecording();
  const src = state.source;
  state.source = null;
  if (src) src.stop();
  state.hr = null; state.battery = null; state.rrSeen = false; state.contact = null;
  state.hrHist = []; state.rrHist = [];
  liveChart?.clear();
  onStatus({ status: 'idle' });
  onBattery(null);
  renderLive();
}

function onSourceError(err) {
  if (err?.code === 'NO_HR_SERVICE') {
    show('#no-hr-notice');
    $('#no-hr-notice').scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'center' });
    return;
  }
  const name = err?.name || '';
  const msg = String(err?.message || '');
  if (name === 'NotFoundError' && /cancel/i.test(msg)) {
    toast('Geen band gekozen.');
    return;
  }
  const texts = {
    NotFoundError: 'Er is geen band gevonden. Zorg dat je band in de buurt is, dat Hartslag uitzenden aanstaat in de WHOOP-app en dat die app gesloten is. Of probeer "Toon alle apparaten".',
    NotAllowedError: 'Je hebt geen toestemming gegeven voor Bluetooth. Sta Bluetooth toe in de instellingen van je browser en probeer het opnieuw.',
    SecurityError: 'Bluetooth is geblokkeerd. Open de app via een https-adres en sta Bluetooth toe.',
    NetworkError: 'De band reageerde niet. Houd hem dichtbij je telefoon en probeer het opnieuw.',
    NotSupportedError: 'Dit apparaat ondersteunt de benodigde Bluetooth-functies niet.',
    InvalidStateError: 'Bluetooth was even bezet. Probeer het over een paar seconden opnieuw.',
  };
  showError(texts[name] || 'Verbinden is niet gelukt. Controleer of Bluetooth aanstaat en probeer het opnieuw.');
}

function onStatus({ status, attempt, max }) {
  const isDemo = state.source?.kind === 'demo';
  state.status = status;
  if (status === 'connected' && !state.connectedAt) state.connectedAt = Date.now();
  if (status === 'idle') state.connectedAt = 0;

  const pill = $('#status-pill');
  const label = {
    idle: 'Niet verbonden',
    connecting: 'Verbinden…',
    connected: isDemo ? 'Demo' : 'Verbonden',
    reconnecting: `Opnieuw verbinden${attempt ? ` (${attempt}/${max || 8})` : ''}…`,
    lost: 'Verbinding verloren',
  }[status] || status;
  pill.dataset.status = isDemo && status === 'connected' ? 'demo' : status;
  $('#status-text').textContent = label;

  const active = status !== 'idle';
  $('#actions-idle').hidden = active;
  $('#actions-connected').hidden = !active;
  $('#btn-retry').hidden = status !== 'lost';
  $('#btn-disconnect').textContent = isDemo ? 'Demo stoppen' : 'Verbinding verbreken';
  $('#btn-record').disabled = status !== 'connected' && !state.recording;

  if (status === 'reconnecting' && state.source?.kind === 'ble') {
    $('#hero-sub').textContent = 'Verbinding weg. We proberen automatisch opnieuw te verbinden…';
  } else if (status === 'lost') {
    $('#hero-sub').textContent = 'Kon niet opnieuw verbinden. Breng de band dichterbij en tik op "Opnieuw verbinden".';
  }
  if (status !== 'connected') stopBeat();
  renderLive();
  updateHrvHint();
}

function onBattery(level) {
  state.battery = level;
  const el = $('#battery');
  if (level == null) { el.hidden = true; return; }
  el.hidden = false;
  $('#battery-text').textContent = `${level}%`;
  $('#battery-fill').setAttribute('width', String(Math.max(1, (13 * level) / 100)));
  el.setAttribute('aria-label', `Batterij ${level} procent`);
  el.style.color = level <= 15 ? 'var(--zone-5)' : '';
}

function onData(d) {
  const t = performance.now();
  state.lastData = Date.now();
  if (d.hr > 0 && d.hr < 255) {
    state.hr = d.hr;
    state.hrHist.push({ t, hr: d.hr });
    liveChart.push(t, d.hr);
  }
  state.contact = d.contact;
  if (d.rrPresent && d.rr.length) state.rrSeen = true;
  for (const rr of d.rr) state.rrHist.push({ t, rr });
  const cut = t - 120000;
  while (state.hrHist.length && state.hrHist[0].t < cut) state.hrHist.shift();
  while (state.rrHist.length && state.rrHist[0].t < cut) state.rrHist.shift();

  if (state.recording) {
    state.recording.samples.push([Math.round((Date.now() - state.recording.start) / 100) / 10, d.hr]);
    state.recording.rr.push(...d.rr);
  }
  listeners.forEach((fn) => fn(d));
  renderLive();
  if (!beatTimer) scheduleBeat();
}

/* ============================================================
   Live-scherm
   ============================================================ */
let lastAnnounce = 0;
function renderLive() {
  const hr = state.hr;
  const connected = state.status === 'connected';
  const stale = connected && state.lastData && Date.now() - state.lastData > 5000;
  const num = $('#hr-number');
  num.textContent = hr && state.status !== 'idle' ? String(hr) : '--';

  if (hr && state.status !== 'idle') {
    const z = zoneFor(hr);
    document.documentElement.style.setProperty('--zone', `var(--zone-${z.n})`);
    liveChart.color = `--zone-${z.n}`;
    $('#zone-chip').textContent = z.label;
    $('#zone-chip').hidden = false;
  } else {
    document.documentElement.style.setProperty('--zone', 'var(--zone-0)');
    $('#zone-chip').textContent = 'Geen data';
  }
  $('#contact-chip').hidden = state.contact !== false || state.status === 'idle';

  const sub = $('#hero-sub');
  if (state.status === 'idle') sub.textContent = BleSource.supported ? 'Verbind je band om te beginnen' : 'Probeer de demo-modus of open de app in Bluefy of Chrome';
  else if (state.status === 'connecting') sub.textContent = 'Verbinden met je band…';
  else if (connected) {
    if (!state.lastData || stale) sub.textContent = 'Verbonden. Wachten op hartslagdata…';
    else sub.textContent = state.source?.kind === 'demo' ? 'Gesimuleerde data · demo-modus' : `Live van ${state.source?.name || 'je band'}`;
  }

  // Statistieken over de laatste 60 s
  const t60 = performance.now() - 60000;
  const hrs = state.hrHist.filter((p) => p.t >= t60).map((p) => p.hr);
  $('#live-avg').textContent = state.status === 'idle' ? '–' : fmt0(mean(hrs));
  $('#live-minmax').textContent = hrs.length && state.status !== 'idle' ? `${Math.min(...hrs)}–${Math.max(...hrs)}` : '–';

  const rmssdEl = $('#live-rmssd');
  const rrs = state.rrHist.filter((p) => p.t >= t60).map((p) => p.rr);
  if (state.status === 'idle') rmssdEl.textContent = '–';
  else if (rrs.length >= 10) rmssdEl.textContent = fmt0(analyze(rrs).rmssd);
  else if (!state.rrSeen && state.connectedAt && Date.now() - state.connectedAt > 15000) {
    rmssdEl.textContent = 'n.v.t.';
    rmssdEl.title = 'Je band stuurt geen RR-intervallen';
  } else rmssdEl.textContent = '…';

  if (hr && connected && Date.now() - lastAnnounce > 30000) {
    lastAnnounce = Date.now();
    $('#hr-sr').textContent = `Hartslag ${hr} slagen per minuut, ${zoneFor(hr).label}.`;
  }
  if (state.recording) {
    $('#record-info').textContent = `Opname loopt · ${mmss((Date.now() - state.recording.start) / 1000)}`;
  }
}

// Hartslag-"puls" op elke slag
let beatTimer = null;
function scheduleBeat() {
  clearTimeout(beatTimer);
  beatTimer = null;
  const fresh = state.lastData && Date.now() - state.lastData < 5000;
  if (!state.hr || state.status !== 'connected' || !fresh) return;
  beatTimer = setTimeout(() => { pulse(); scheduleBeat(); }, 60000 / state.hr);
}
function stopBeat() { clearTimeout(beatTimer); beatTimer = null; }
function pulse() {
  if (reducedMotion.matches || document.hidden) return;
  for (const el of [$('#heart'), $('#hr-number')]) {
    el.classList.remove('beat'); void el.offsetWidth; el.classList.add('beat');
  }
}
setInterval(() => { if (state.status !== 'idle') renderLive(); if (!beatTimer) scheduleBeat(); }, 1000);

// Sessie-opname
function startRecording() {
  state.recording = { start: Date.now(), samples: [], rr: [] };
  $('#btn-record').setAttribute('aria-pressed', 'true');
  $('#btn-record-text').textContent = 'Stop opname';
  $('#record-info').hidden = false;
  requestWakeLock();
  renderLive();
}
async function stopRecording() {
  const rec = state.recording;
  state.recording = null;
  $('#btn-record').setAttribute('aria-pressed', 'false');
  $('#btn-record-text').textContent = 'Start sessie-opname';
  $('#record-info').hidden = true;
  releaseWakeLock();
  if (!rec) return;
  const duration = (Date.now() - rec.start) / 1000;
  const hrs = rec.samples.map((s) => s[1]).filter((v) => v > 0);
  if (duration < 10 || hrs.length < 5) { toast('Opname te kort, niet opgeslagen.'); return; }
  const a = analyze(rec.rr);
  await safeAdd({
    type: 'session', date: rec.start, duration,
    meanHr: mean(hrs), minHr: Math.min(...hrs), maxHr: Math.max(...hrs),
    rmssd: a.rmssd, samples: rec.samples, rr: rec.rr, demo: state.source?.kind === 'demo',
  });
  toast('Sessie opgeslagen in Geschiedenis.');
}

/* ============================================================
   HRV-meting
   ============================================================ */
const hrv = { running: false, phase: null, rr: [], start: 0, dur: 60, timer: null, unsub: null };
const RING_LEN = 2 * Math.PI * 88;

function updateHrvHint() {
  const ok = state.status === 'connected';
  $('#btn-hrv-start').disabled = !ok && !hrv.running;
  $('#hrv-hint').textContent = ok
    ? (state.source?.kind === 'demo' ? 'Je meet nu met gesimuleerde demo-data.' : '')
    : 'Verbind eerst je band op het tabblad Live, of start daar de demo-modus.';
}

function startHrv() {
  if (state.status !== 'connected') return;
  hrv.dur = Number($('input[name="hrv-dur"]:checked')?.value || settings.hrvDuration);
  hrv.running = true; hrv.phase = 'prep'; hrv.rr = [];
  $('#hrv-intro').hidden = true; $('#hrv-result').hidden = true; $('#hrv-running').hidden = false;
  requestWakeLock();
  const prepUntil = Date.now() + 5000;
  hrv.unsub = addListener((d) => {
    $('#hrv-hr').textContent = d.hr || '--';
    if (hrv.phase === 'measure') { hrv.rr.push(...d.rr); $('#hrv-beats').textContent = hrv.rr.length; }
  });
  $('#hrv-beats').textContent = '0';
  $('#hrv-ring').style.strokeDasharray = RING_LEN;
  setRing(0);

  const tick = () => {
    const now = Date.now();
    if (hrv.phase === 'prep') {
      const left = (prepUntil - now) / 1000;
      $('#hrv-phase').textContent = 'Maak je klaar';
      $('#hrv-time').textContent = String(Math.max(1, Math.ceil(left)));
      $('#hrv-instruction').textContent = 'Ga stil zitten of liggen en adem rustig.';
      if (left <= 0) {
        hrv.phase = 'measure'; hrv.start = now;
        $('#hrv-phase').textContent = 'Meten';
        $('#hrv-instruction').textContent = 'Blijf stil en adem rustig door.';
      }
      return;
    }
    const el = (now - hrv.start) / 1000;
    $('#hrv-time').textContent = mmss(hrv.dur - el);
    setRing(el / hrv.dur);
    if (el > 15 && !state.rrSeen) {
      cancelHrv('Je band stuurt geen RR-intervallen (tijd tussen slagen). Zonder die gegevens kan HRV niet worden berekend.');
      return;
    }
    if (el >= hrv.dur) finishHrv();
  };
  tick();
  hrv.timer = setInterval(tick, 250);
}

function setRing(frac) {
  $('#hrv-ring').style.strokeDashoffset = String(RING_LEN * (1 - Math.min(1, Math.max(0, frac))));
}

function endHrvRun() {
  clearInterval(hrv.timer);
  hrv.unsub?.();
  hrv.running = false;
  releaseWakeLock();
  $('#hrv-running').hidden = true;
}

function cancelHrv(message) {
  endHrvRun();
  $('#hrv-intro').hidden = false;
  updateHrvHint();
  if (message) { $('#hrv-hint').textContent = message; toast(message); }
}

async function finishHrv() {
  const duration = (Date.now() - hrv.start) / 1000;
  endHrvRun();
  const a = analyze(hrv.rr);
  const minBeats = Math.max(20, Math.round(duration / 3));
  if (!a.rmssd || a.beats < minBeats) {
    $('#hrv-intro').hidden = false;
    updateHrvHint();
    const msg = `Te weinig bruikbare slagen (${a.beats}${a.removed ? `, ${a.removed} weggefilterd` : ''}). Blijf stiller zitten, controleer of de band goed aansluit en probeer het opnieuw.`;
    $('#hrv-hint').textContent = msg;
    return;
  }
  const rec = {
    type: 'hrv', date: Date.now() - duration * 1000, duration,
    rmssd: a.rmssd, lnRmssd: a.lnRmssd, sdnn: a.sdnn, meanHr: a.meanHr,
    beats: a.beats, removed: a.removed, rr: hrv.rr, demo: state.source?.kind === 'demo',
  };
  // Vergelijking met eigen 7-daagse gemiddelde (vóór het opslaan van deze meting)
  let prev = [];
  try {
    const weekAgo = Date.now() - 7 * 86400000;
    prev = (await db.all()).filter((r) => r.type === 'hrv' && r.date >= weekAgo && r.rmssd);
  } catch {}
  await safeAdd(rec);
  showHrvResult(rec, prev);
}

function showHrvResult(rec, prev) {
  $('#hrv-result').hidden = false;
  $('#res-date').textContent = `${fmtDate.format(new Date(rec.date))} · ${durText(rec.duration)}${rec.demo ? ' · demo' : ''}`;
  $('#res-rmssd').textContent = fmt0(rec.rmssd);
  $('#res-ln').textContent = nf2.format(rec.lnRmssd);
  $('#res-sdnn').textContent = fmt0(rec.sdnn);
  $('#res-hr').textContent = fmt0(rec.meanHr);
  $('#res-beats').textContent = fmt0(rec.beats);
  const pct = rec.beats + rec.removed ? (rec.removed / (rec.beats + rec.removed)) * 100 : 0;
  $('#res-filtered').textContent = rec.removed
    ? `${rec.removed} van ${rec.beats + rec.removed} intervallen weggefilterd als artefact (${nf1.format(pct)}%).`
    : 'Geen artefacten gevonden. Mooi stil gezeten!';

  const cmp = $('#res-compare');
  if (!prev.length) {
    cmp.textContent = 'Dit is je eerste meting van de afgelopen 7 dagen. Na een paar metingen zie je hier hoe je ervoor staat.';
  } else {
    const avg = mean(prev.map((r) => r.rmssd));
    const diff = ((rec.rmssd - avg) / avg) * 100;
    const word = Math.abs(diff) < 5 ? 'rond' : diff > 0 ? 'boven' : 'onder';
    const amount = Math.abs(diff) < 5 ? '' : `${nf0.format(Math.abs(diff))}% `;
    cmp.innerHTML = '';
    cmp.append(
      document.createTextNode(Math.abs(diff) < 5 ? 'Je zit ' : ''),
      Object.assign(document.createElement('strong'), { textContent: `${amount}${word}` }),
      document.createTextNode(` je 7-daagse gemiddelde van ${fmt0(avg)} ms (${prev.length} ${prev.length === 1 ? 'meting' : 'metingen'}).`),
    );
  }
  $('#res-rmssd').focus?.();
}

/* ============================================================
   Ademhaling
   ============================================================ */
const breath = { running: false, rate: settings.breathRate, start: 0, dur: 180, raf: 0, hrs: [], rr: [], unsub: null, lastLabel: '' };
const easeInOut = (x) => 0.5 - 0.5 * Math.cos(Math.PI * x);

function renderRate() {
  const r = breath.rate;
  $('#rate-value').textContent = nf1.format(r).replace(',0', '');
  const cycle = 60 / r;
  $('#rate-desc').textContent = `${nf1.format(r).replace(',0', '')} ademhalingen per minuut · ${nf1.format(cycle / 2).replace(',0', '')} s in, ${nf1.format(cycle / 2).replace(',0', '')} s uit`;
  $('#rate-down').disabled = r <= 4;
  $('#rate-up').disabled = r >= 10;
}
function changeRate(delta) {
  breath.rate = Math.min(10, Math.max(4, Math.round((breath.rate + delta) * 2) / 2));
  settings.breathRate = breath.rate; saveSettings();
  renderRate();
}

function startBreath() {
  breath.dur = Number($('input[name="breath-dur"]:checked').value);
  breath.running = true; breath.start = performance.now(); breath.hrs = []; breath.rr = []; breath.lastLabel = '';
  $('#breath-setup').hidden = true; $('#breath-summary').hidden = true; $('#breath-running').hidden = false;
  $('#breath-chart').hidden = false;
  if (state.source?.kind === 'demo') state.source.setBreathing(breath.rate);
  breath.unsub = addListener((d) => {
    if (d.hr) breath.hrs.push({ t: (performance.now() - breath.start) / 1000, hr: d.hr });
    breath.rr.push(...d.rr);
    $('#breath-hr').textContent = d.hr || '--';
    drawSparkline($('#breath-chart'), breath.hrs.slice(-90).map((p) => p.hr));
  });
  requestWakeLock();
  breathFrame();
}

function breathFrame() {
  if (!breath.running) return;
  const el = (performance.now() - breath.start) / 1000;
  const cycle = 60 / breath.rate;
  const ph = (el % cycle) / cycle;
  const inhale = ph < 0.5;
  const amt = inhale ? easeInOut(ph * 2) : 1 - easeInOut((ph - 0.5) * 2);
  const circle = $('#breath-circle');
  if (reducedMotion.matches) {
    circle.style.transform = 'scale(.85)';
    circle.style.opacity = String(0.45 + 0.55 * amt);
  } else {
    circle.style.transform = `scale(${0.55 + 0.45 * amt})`;
    circle.style.opacity = '1';
  }
  const label = inhale ? 'Adem in' : 'Adem uit';
  if (label !== breath.lastLabel) { $('#breath-label').textContent = label; breath.lastLabel = label; }
  $('#breath-timer').textContent = `${mmss(breath.dur - el)} resterend`;
  if (el >= breath.dur) { finishBreath(); return; }
  breath.raf = requestAnimationFrame(breathFrame);
}

function endBreathRun() {
  breath.running = false;
  cancelAnimationFrame(breath.raf);
  breath.unsub?.();
  if (state.source?.kind === 'demo') state.source.setBreathing(null);
  releaseWakeLock();
  $('#breath-running').hidden = true;
  $('#breath-label').textContent = 'Klaar?';
  $('#breath-timer').textContent = '';
  $('#breath-circle').style.transform = '';
  $('#breath-circle').style.opacity = '';
}

async function finishBreath(early = false) {
  const duration = (performance.now() - breath.start) / 1000;
  endBreathRun();
  if (duration < 30) {
    $('#breath-setup').hidden = false; $('#breath-chart').hidden = true;
    if (early) toast('Sessie gestopt. Korter dan 30 seconden, niet opgeslagen.');
    return;
  }
  const hrs = breath.hrs.map((p) => p.hr);
  const first = mean(breath.hrs.filter((p) => p.t < 30).map((p) => p.hr));
  const last = mean(breath.hrs.filter((p) => p.t > duration - 30).map((p) => p.hr));
  const a = breath.rr.length >= 20 ? analyze(breath.rr) : { rmssd: null };
  const rec = {
    type: 'breath', date: Date.now() - duration * 1000, duration, rate: breath.rate,
    meanHr: mean(hrs), startHr: first, endHr: last, rmssd: a.rmssd,
    samples: breath.hrs.map((p) => [Math.round(p.t * 10) / 10, p.hr]), rr: breath.rr,
    demo: state.source?.kind === 'demo',
  };
  await safeAdd(rec);

  $('#breath-summary').hidden = false;
  $('#sum-dur').textContent = mmss(duration);
  $('#sum-hr').textContent = fmt0(rec.meanHr);
  $('#sum-delta').textContent = first && last ? `${fmt0(first)} → ${fmt0(last)}` : '–';
  $('#sum-rmssd').textContent = fmt0(rec.rmssd);
  let text = `${mmss(duration)} rustig geademd op ${nf1.format(breath.rate).replace(',0', '')} ademhalingen per minuut.`;
  if (first && last) {
    const d = Math.round(first - last);
    text += d >= 2 ? ` Je hartslag daalde ${d} bpm.` : d <= -2 ? ` Je hartslag steeg ${-d} bpm.` : ' Je hartslag bleef stabiel.';
  } else if (!hrs.length) {
    text += ' Verbind je band om ook je hartslag te zien.';
  }
  $('#sum-text').textContent = text;
}

/* ============================================================
   Geschiedenis
   ============================================================ */
const ICONS = {
  hrv: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.3-8.8-8.6C1.9 8.2 4 5 7.2 5c2 0 3.4 1 4.8 2.8C13.4 6 14.8 5 16.8 5 20 5 22.1 8.2 20.8 11.4 19 15.7 12 20 12 20z"/></svg>',
  breath: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/></svg>',
  session: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l2.5-6 5 12 2.5-6h4"/></svg>',
  download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/></svg>',
};
const TITLES = { hrv: 'HRV-meting', breath: 'Ademsessie', session: 'Sessie-opname' };

let records = [];
async function renderHistory() {
  try { records = await db.all(); }
  catch { records = []; showError('De lokale opslag is niet beschikbaar. Mogelijk gebruik je privé-browsen.'); }
  const filter = $('input[name="hist-filter"]:checked').value;
  const list = $('#history-list');
  list.innerHTML = '';
  const shown = records.filter((r) => filter === 'all' || r.type === filter);
  for (const r of shown) list.append(historyItem(r));
  $('#history-empty').hidden = shown.length > 0;
  $('#btn-export').disabled = !records.length;
  $('#btn-clear').disabled = !records.length;

  const since = Date.now() - 30 * 86400000;
  const pts = records.filter((r) => r.type === 'hrv' && r.date >= since && r.rmssd).map((r) => ({ date: r.date, value: r.rmssd }));
  $('#trend-empty').hidden = pts.length > 0;
  $('#trend-chart').hidden = pts.length === 0;
  if (pts.length) {
    requestAnimationFrame(() => drawTrend($('#trend-chart'), pts));
    const avg = mean(pts.map((p) => p.value));
    $('#trend-chart').setAttribute('aria-label', `RMSSD-trend: ${pts.length} metingen in 30 dagen, gemiddeld ${fmt0(avg)} ms, laatste ${fmt0(pts[0].value)} ms.`);
  }
}

function historyItem(r) {
  const li = document.createElement('li');
  li.className = 'history-item';
  let metrics = '';
  if (r.type === 'hrv') metrics = `RMSSD ${fmt0(r.rmssd)} ms · ln ${nf2.format(r.lnRmssd)} · ${fmt0(r.meanHr)} bpm`;
  else if (r.type === 'breath') metrics = `${nf1.format(r.rate).replace(',0', '')}/min · gem. ${fmt0(r.meanHr)} bpm${r.rmssd ? ` · RMSSD ${fmt0(r.rmssd)} ms` : ''}`;
  else metrics = `gem. ${fmt0(r.meanHr)} bpm · ${fmt0(r.minHr)}–${fmt0(r.maxHr)}${r.rmssd ? ` · RMSSD ${fmt0(r.rmssd)} ms` : ''}`;
  const title = TITLES[r.type] || 'Sessie';
  const date = fmtDate.format(new Date(r.date));
  li.innerHTML = `
    <div class="history-icon">${ICONS[r.type] || ICONS.session}</div>
    <div class="history-body">
      <span class="history-title"></span>
      <span class="history-meta"></span>
      <span class="history-metrics"></span>
    </div>
    <div class="history-actions">
      <button type="button" data-act="csv">${ICONS.download}</button>
      <button type="button" data-act="del">${ICONS.trash}</button>
    </div>`;
  $('.history-title', li).textContent = title + (r.demo ? ' (demo)' : '');
  $('.history-meta', li).textContent = `${date} · ${durText(r.duration)}`;
  $('.history-metrics', li).textContent = metrics;
  const csvBtn = $('[data-act="csv"]', li);
  csvBtn.setAttribute('aria-label', `Exporteer ${title} van ${date} als CSV`);
  csvBtn.addEventListener('click', () => exportRecord(r));
  const delBtn = $('[data-act="del"]', li);
  delBtn.setAttribute('aria-label', `Verwijder ${title} van ${date}`);
  delBtn.addEventListener('click', async () => {
    if (await confirmDialog('Meting verwijderen?', `${title} van ${date} wordt definitief verwijderd.`)) {
      await db.remove(r.id);
      toast('Verwijderd.');
      renderHistory();
    }
  });
  return li;
}

/* CSV (puntkomma + decimale komma, zodat Excel in het Nederlands het goed opent) */
const csvNum = (v, d = 1) => (v == null || !isFinite(v) ? '' : v.toFixed(d).replace('.', ','));
const isoLocal = (t) => { const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };

function exportAll() {
  const head = ['type', 'datum', 'duur_s', 'rmssd_ms', 'ln_rmssd', 'sdnn_ms', 'gem_hartslag', 'min_hartslag', 'max_hartslag', 'slagen', 'gefilterd', 'ademtempo_per_min', 'demo'];
  const rows = [...records].sort((a, b) => a.date - b.date).map((r) => [
    r.type, isoLocal(r.date), csvNum(r.duration, 0), csvNum(r.rmssd), csvNum(r.lnRmssd, 3), csvNum(r.sdnn),
    csvNum(r.meanHr), csvNum(r.minHr, 0), csvNum(r.maxHr, 0), r.beats ?? '', r.removed ?? '', csvNum(r.rate), r.demo ? 'ja' : 'nee',
  ]);
  downloadCsv(`whoop-overzicht-${isoLocal(Date.now()).slice(0, 10)}.csv`, [head, ...rows]);
}

function exportRecord(r) {
  const name = `whoop-${r.type}-${isoLocal(r.date).replace(/[: ]/g, '-')}.csv`;
  if (r.type === 'hrv') {
    const f = filterRR(r.rr || []);
    let t = 0;
    const rows = (r.rr || []).map((rr, i) => { t += rr; return [i + 1, csvNum(t / 1000, 3), csvNum(rr, 1), f.flags[i] ? 'ja' : 'nee'] });
    downloadCsv(name, [['slag', 'tijd_s', 'rr_ms', 'behouden'], ...rows]);
  } else {
    const rows = (r.samples || []).map(([t, hr]) => [csvNum(t, 1), hr]);
    downloadCsv(name, [['tijd_s', 'hartslag_bpm'], ...rows]);
  }
}

async function downloadCsv(filename, rows) {
  const text = '﻿' + rows.map((r) => r.join(';')).join('\r\n');
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  if (isIOS && navigator.canShare) {
    try {
      const file = new File([blob], filename, { type: 'text/csv' });
      if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: filename }); return; }
    } catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast('CSV gedownload.');
}

async function safeAdd(rec) {
  try { await db.add(rec); }
  catch { showError('Opslaan is niet gelukt. Mogelijk is de lokale opslag vol of uitgeschakeld (privé-venster).'); }
}

/* ============================================================
   Instellingen-scherm
   ============================================================ */
function initSettings() {
  const form = $('#settings-form');
  form.age.value = settings.age ?? '';
  form.maxHr.value = settings.maxHr ?? '';
  form.restHr.value = settings.restHr ?? '';
  $$(`input[name="hrvDuration"]`).forEach((i) => { i.checked = Number(i.value) === Number(settings.hrvDuration); });
  $$(`input[name="theme"]`).forEach((i) => { i.checked = i.value === settings.theme; });
  updateMaxHelp();

  const num = (input, min, max) => {
    const v = parseInt(input.value, 10);
    const ok = !input.value || (v >= min && v <= max);
    input.setAttribute('aria-invalid', String(!ok));
    return input.value && ok ? v : null;
  };
  form.addEventListener('input', (e) => {
    const t = e.target;
    if (t.name === 'age') settings.age = num(t, 10, 100);
    if (t.name === 'maxHr') settings.maxHr = num(t, 120, 230);
    if (t.name === 'restHr') settings.restHr = num(t, 30, 110);
    if (t.name === 'hrvDuration') { settings.hrvDuration = Number(t.value); syncHrvDuration(); }
    if (t.name === 'theme') { settings.theme = t.value; applyTheme(); }
    saveSettings();
    updateMaxHelp();
    renderLive();
  });
  form.addEventListener('submit', (e) => e.preventDefault());
}
function updateMaxHelp() {
  const help = $('#max-help');
  if (settings.maxHr) help.textContent = `Je eigen waarde wordt gebruikt: ${settings.maxHr} bpm.`;
  else if (settings.age) help.textContent = `Berekend uit je leeftijd: ${maxHr()} bpm (208 − 0,7 × leeftijd).`;
  else help.textContent = 'Vul je leeftijd of eigen maximum in. Zonder gegevens rekenen we met 190 bpm.';
}
function syncHrvDuration() {
  $$('input[name="hrv-dur"]').forEach((i) => { i.checked = Number(i.value) === Number(settings.hrvDuration); });
}

/* ============================================================
   Onboarding
   ============================================================ */
const OB_STEPS = [
  {
    title: 'Live hartslag en HRV',
    text: 'Bekijk je hartslag live, doe een korte HRV-meting en adem rustig met de ademhalingsbegeleider. Alles blijft op je eigen toestel.',
    art: '<svg viewBox="0 0 64 64"><path d="M6 34h12l5-14 9 26 6-18 4 6h16"/></svg>',
  },
  {
    title: 'Bluefy of Chrome nodig',
    text: 'Safari ondersteunt geen Web Bluetooth. Gebruik op iPhone de gratis browser Bluefy. Op Android en computer werkt Chrome of Edge.',
    art: '<svg viewBox="0 0 64 64"><rect x="18" y="6" width="28" height="52" rx="6"/><path d="M26 22l12 12-6 5V17l6 5-12 12"/></svg>',
  },
  {
    title: 'Sluit de WHOOP-app',
    text: 'Zet in de officiële WHOOP-app "Hartslag uitzenden" aan en sluit de app daarna helemaal af. Dan kan deze app verbinding maken met je band.',
    art: '<svg viewBox="0 0 64 64"><rect x="12" y="12" width="40" height="40" rx="10"/><path d="M24 24l16 16M40 24L24 40"/></svg>',
  },
];
let obStep = 0;
function openOnboarding() {
  obStep = 0;
  $('#onboarding').hidden = false;
  renderOb();
  $('#ob-next').focus();
}
function renderOb() {
  const s = OB_STEPS[obStep];
  $('#ob-title').textContent = s.title;
  $('#ob-text').textContent = s.text;
  $('#ob-art').innerHTML = s.art;
  $('#ob-step').textContent = `Stap ${obStep + 1} van ${OB_STEPS.length}`;
  $$('.ob-dots span').forEach((d, i) => d.classList.toggle('on', i === obStep));
  $('#ob-next').textContent = obStep === OB_STEPS.length - 1 ? 'Aan de slag' : 'Volgende';
  $('#ob-skip').hidden = obStep === OB_STEPS.length - 1;
}
function closeOnboarding() {
  $('#onboarding').hidden = true;
  settings.onboarded = true; saveSettings();
  $('#main').focus();
}

/* ============================================================
   Algemene UI: router, meldingen, dialogen, wake lock
   ============================================================ */
function show(sel) { $(sel).hidden = false; }
function hide(sel) { $(sel).hidden = true; }
function showError(text) { $('#error-text').textContent = text; show('#error-notice'); }

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function confirmDialog(title, text) {
  return new Promise((resolve) => {
    const m = $('#confirm');
    const prevFocus = document.activeElement;
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    m.hidden = false;
    $('#confirm-cancel').focus();
    const done = (v) => {
      m.hidden = true;
      $('#confirm-ok').onclick = $('#confirm-cancel').onclick = null;
      document.removeEventListener('keydown', onKey);
      prevFocus?.focus?.();
      resolve(v);
    };
    const onKey = (e) => { if (e.key === 'Escape') done(false); };
    document.addEventListener('keydown', onKey);
    $('#confirm-ok').onclick = () => done(true);
    $('#confirm-cancel').onclick = () => done(false);
    m.onclick = (e) => { if (e.target === m) done(false); };
  });
}

function addListener(fn) { listeners.add(fn); return () => listeners.delete(fn); }

let wakeLock = null, wakeCount = 0;
async function requestWakeLock() {
  wakeCount++;
  try { if ('wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
function releaseWakeLock() {
  wakeCount = Math.max(0, wakeCount - 1);
  if (!wakeCount && wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    if (wakeCount && 'wakeLock' in navigator) { try { wakeLock = await navigator.wakeLock.request('screen'); } catch {} }
    if (state.status === 'lost' && state.source?.retry) state.source.retry().catch(onSourceError);
  }
});

const TABS = ['live', 'hrv', 'breath', 'history', 'settings'];
function route() {
  const tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'live';
  currentTab = tab;
  TABS.forEach((t) => { $(`#screen-${t}`).hidden = t !== tab; });
  $$('.tab').forEach((a) => {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (tab === 'live') { liveChart.start(); requestAnimationFrame(() => liveChart.draw()); } else liveChart.stop();
  if (tab === 'history') renderHistory();
  if (tab === 'hrv') updateHrvHint();
  window.scrollTo(0, 0);
}

/* ============================================================
   Start
   ============================================================ */
function init() {
  liveChart = new LiveChart($('#live-chart'));
  applyTheme();

  if (!BleSource.supported) {
    show('#no-bt-notice');
    $('#btn-connect').disabled = true;
    $('#btn-connect-all').disabled = true;
  } else if (!window.isSecureContext) {
    show('#insecure-notice');
  }

  if (isIOS && !isStandalone && !settings.iosHintDismissed) {
    $('#ios-hint-text').textContent = BleSource.supported
      ? 'Bewaar deze pagina als favoriet in Bluefy, zodat je de app snel terugvindt. Let op: een icoon op het beginscherm opent in Safari, en daar werkt Bluetooth niet.'
      : 'Tik op het deel-icoon en kies "Zet op beginscherm" om de app als icoon te bewaren. Voor de live verbinding met je band open je de app in Bluefy.';
    show('#ios-hint');
  }
  $('#ios-hint-close').addEventListener('click', () => { hide('#ios-hint'); settings.iosHintDismissed = true; saveSettings(); });

  $('#btn-connect').addEventListener('click', () => connectBle(false));
  $('#btn-connect-all').addEventListener('click', () => connectBle(true));
  $('#btn-demo').addEventListener('click', startDemo);
  $('#btn-disconnect').addEventListener('click', () => { stopSource(); toast('Verbinding verbroken.'); });
  $('#btn-retry').addEventListener('click', () => state.source?.retry?.().catch(onSourceError));
  $('#btn-record').addEventListener('click', () => (state.recording ? stopRecording() : startRecording()));
  $$('[data-dismiss]').forEach((b) => b.addEventListener('click', () => hide('#' + b.dataset.dismiss)));

  syncHrvDuration();
  $('#btn-hrv-start').addEventListener('click', startHrv);
  $('#btn-hrv-stop').addEventListener('click', () => cancelHrv());
  $('#btn-hrv-done').addEventListener('click', () => { $('#hrv-result').hidden = true; $('#hrv-intro').hidden = false; updateHrvHint(); });

  renderRate();
  $('#rate-down').addEventListener('click', () => changeRate(-0.5));
  $('#rate-up').addEventListener('click', () => changeRate(0.5));
  $('#btn-breath-start').addEventListener('click', startBreath);
  $('#btn-breath-stop').addEventListener('click', () => finishBreath(true));
  $('#btn-breath-done').addEventListener('click', () => { $('#breath-summary').hidden = true; $('#breath-setup').hidden = false; $('#breath-chart').hidden = true; });

  $$('input[name="hist-filter"]').forEach((i) => i.addEventListener('change', renderHistory));
  $('#btn-export').addEventListener('click', exportAll);
  $('#btn-clear').addEventListener('click', async () => {
    if (await confirmDialog('Alles verwijderen?', 'Al je metingen, ademsessies en opnames worden definitief van dit toestel verwijderd.')) {
      await db.clear(); toast('Alles verwijderd.'); renderHistory();
    }
  });

  initSettings();
  $('#btn-onboarding').addEventListener('click', openOnboarding);
  $('#ob-next').addEventListener('click', () => { if (obStep < OB_STEPS.length - 1) { obStep++; renderOb(); } else closeOnboarding(); });
  $('#ob-skip').addEventListener('click', closeOnboarding);
  $('#onboarding').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOnboarding(); });

  window.addEventListener('hashchange', route);
  window.addEventListener('resize', () => { liveChart.draw(); if (currentTab === 'history') renderHistory(); });
  route();
  onStatus({ status: 'idle' });
  if (!settings.onboarded) openOnboarding();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
