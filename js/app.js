import { BleSource } from './ble.js';
import { DemoSource } from './demo.js';
import { analyze, filterRR } from './hrv.js';
import { db } from './db.js';
import { LiveChart, drawSparkline, drawTrend } from './chart.js';
import {
  mean, sd, median, clamp, dayKey, addDays, zoneIndex, ZONE_WEIGHT, strainFromTrimp, workload,
  kcalPerMinute, vo2max, stressScore, stressLabel, respiratoryRate, analyzeNight,
  recoveryScore, strainTarget, sleepNeed,
} from './metrics.js';

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
const fmtDay = new Intl.DateTimeFormat('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtClock = new Intl.DateTimeFormat('nl-NL', { hour: '2-digit', minute: '2-digit' });
const fmt0 = (v) => (v == null || !isFinite(v) ? '–' : nf0.format(v));
const fmt1 = (v) => (v == null || !isFinite(v) ? '–' : nf1.format(v));
const mmss = (s) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const hmm = (h) => { if (h == null || !isFinite(h)) return '–'; const m = Math.round(h * 60); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
const durText = (s) => (s >= 5400 ? `${hmm(s / 3600)} u` : s >= 90 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);
const rateText = (r) => nf1.format(r).replace(',0', '');
const noonOf = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d, 12).getTime(); };

/* ============================================================
   Instellingen
   ============================================================ */
const SETTINGS_KEY = 'whoop.settings';
const defaults = {
  age: null, maxHr: null, restHr: null, sex: 'x', weight: null, height: null, sleepNeed: 8,
  hrvDuration: 60, theme: 'dark', breathRate: 6, onboarded: false, iosHintDismissed: false,
};
const settings = (() => {
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
  catch { return { ...defaults }; }
})();
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {} }

function maxHr() {
  if (settings.maxHr) return settings.maxHr;
  if (settings.age) return Math.round(208 - 0.7 * settings.age); // Tanaka
  return 190;
}
/** Rusthartslag: eigen invoer, anders gemeten basis, anders 60. */
function restHr() { return settings.restHr || base.restHr || 60; }
function profile() {
  return { rest: restHr(), max: maxHr(), weight: settings.weight, height: settings.height, age: settings.age, sex: settings.sex };
}

const ZONES = ['Rust', 'Zone 1 · Herstel', 'Zone 2 · Licht', 'Zone 3 · Matig', 'Zone 4 · Zwaar', 'Zone 5 · Maximaal'];
const ZONE_SHORT = ['Rust', 'Z1', 'Z2', 'Z3', 'Z4', 'Z5'];
function zoneFor(hr) { const n = zoneIndex(hr, restHr(), maxHr()); return { n, label: ZONES[n] }; }

/* ============================================================
   Thema
   ============================================================ */
const lightQuery = matchMedia('(prefers-color-scheme: light)');
function applyTheme() {
  const t = settings.theme === 'system' ? (lightQuery.matches ? 'light' : 'dark') : settings.theme;
  document.documentElement.dataset.theme = t;
  $('#meta-theme').setAttribute('content', t === 'light' ? '#f4f5f8' : '#0b0d10');
  liveChart?.draw();
  if (currentTab === 'trends') renderTrends();
}
lightQuery.addEventListener?.('change', () => settings.theme === 'system' && applyTheme());

/* ============================================================
   Toestand
   ============================================================ */
const state = {
  source: null, status: 'idle', hr: null, contact: null, battery: null,
  hrHist: [], rrHist: [], rrSeen: false, connectedAt: 0, lastData: 0,
  liveRmssd: null, stress: null, lastSampleS: 0, recording: null,
};
const base = { restHr: null, rmssd: null };      // persoonlijke basiswaarden
let day = null;                                    // dagtotalen van vandaag
let dayDirty = false;
const listeners = new Set();
let liveChart;
let currentTab = 'today';
let currentPanel = 'hrv';

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
  try { await src.request(acceptAll); }
  catch (err) { state.source = null; onSourceError(err); onStatus({ status: 'idle' }); }
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
  Object.assign(state, { hr: null, battery: null, rrSeen: false, contact: null, hrHist: [], rrHist: [], liveRmssd: null, stress: null, lastSampleS: 0 });
  liveChart?.clear();
  flushDay();
  onStatus({ status: 'idle' });
  onBattery(null);
  renderLive();
}

function onSourceError(err) {
  if (err?.code === 'NO_HR_SERVICE') {
    show('#no-hr-notice');
    if (currentTab !== 'live') location.hash = 'live';
    $('#no-hr-notice').scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'center' });
    return;
  }
  const name = err?.name || '';
  if (name === 'NotFoundError' && /cancel/i.test(String(err?.message))) { toast('Geen band gekozen.'); return; }
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
  if (status !== 'connected') state.lastSampleS = 0;

  const label = {
    idle: 'Niet verbonden',
    connecting: 'Verbinden…',
    connected: isDemo ? 'Demo' : 'Verbonden',
    reconnecting: `Opnieuw verbinden${attempt ? ` (${attempt}${max ? `/${max}` : ''})` : ''}…`,
    lost: 'Verbinding verloren',
  }[status] || status;
  $('#status-pill').dataset.status = isDemo && status === 'connected' ? 'demo' : status;
  $('#status-text').textContent = label;
  $('#night-status').textContent = night.running && status !== 'connected' ? `${label} De meting loopt door.` : '';

  const active = status !== 'idle';
  $('#actions-idle').hidden = active;
  $('#actions-connected').hidden = !active;
  $('#btn-retry').hidden = status !== 'lost';
  $('#btn-disconnect').textContent = isDemo ? 'Demo stoppen' : 'Verbinding verbreken';
  $('#btn-record').disabled = status !== 'connected' && !state.recording;

  if (status === 'reconnecting' && state.source?.kind === 'ble') $('#hero-sub').textContent = 'Verbinding weg. We proberen automatisch opnieuw te verbinden…';
  else if (status === 'lost') $('#hero-sub').textContent = 'Kon niet opnieuw verbinden. Breng de band dichterbij en tik op "Opnieuw verbinden".';
  if (status !== 'connected') stopBeat();
  renderLive();
  updateMeasureHints();
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
  const nowS = Date.now() / 1000;
  state.lastData = Date.now();
  const valid = d.hr > 0 && d.hr < 255;
  if (valid) {
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

  const rrs = state.rrHist.filter((p) => p.t >= t - 60000).map((p) => p.rr);
  state.liveRmssd = rrs.length >= 10 ? analyze(rrs).rmssd : null;
  state.stress = valid && state.contact !== false
    ? stressScore(d.hr, state.liveRmssd, { rest: restHr(), max: maxHr(), baseRmssd: base.rmssd })
    : null;

  // Dagtotalen bijwerken (inspanning, zones, kcal, stress)
  if (valid && state.contact !== false) {
    if (state.lastSampleS) accumulateDay(Math.min(5, nowS - state.lastSampleS), d.hr);
    state.lastSampleS = nowS;
  }

  if (state.recording && valid) {
    state.recording.samples.push([Math.round((Date.now() - state.recording.start) / 100) / 10, d.hr]);
    state.recording.rr.push(...d.rr);
  }
  listeners.forEach((fn) => fn(d));
  renderLive();
  if (!beatTimer) scheduleBeat();
}

/* ============================================================
   Dagtotalen
   ============================================================ */
const emptyDay = (date) => ({ date, trimp: 0, zoneSec: [0, 0, 0, 0, 0, 0], kcal: 0, stressSum: 0, stressSec: 0, maxHr: 0, demo: false });

async function loadDay() {
  const key = dayKey();
  try { day = (await db.getIn('days', key)) || emptyDay(key); } catch { day = emptyDay(key); }
}
function accumulateDay(dt, hr) {
  if (!(dt > 0) || !day) return;
  if (day.date !== dayKey()) { flushDay(); day = emptyDay(dayKey()); }
  const p = profile();
  const z = zoneIndex(hr, p.rest, p.max);
  day.zoneSec[z] += dt;
  day.trimp += (dt / 60) * ZONE_WEIGHT[z];
  day.kcal += (kcalPerMinute(hr, p) * dt) / 60;
  day.maxHr = Math.max(day.maxHr, hr);
  if (state.stress != null) { day.stressSum += state.stress * dt; day.stressSec += dt; }
  if (state.source?.kind === 'demo') day.demo = true;
  dayDirty = true;
}
async function flushDay() {
  if (!day || !dayDirty) return;
  dayDirty = false;
  try { await db.putIn('days', { ...day, zoneSec: [...day.zoneSec] }); } catch {}
}
setInterval(flushDay, 15000);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushDay(); });
window.addEventListener('pagehide', flushDay);

/* ============================================================
   Persoonlijke basiswaarden en dagindex
   ============================================================ */
let records = [];
let daysMap = new Map();
let journalMap = new Map();

/** Primaire meting per dag: nachtmeting (op de dag van ontwaken), anders eerste HRV-meting. */
function buildIndex(recs) {
  const primary = new Map(), sleep = new Map();
  const sorted = [...recs].sort((a, b) => a.date - b.date);
  for (const r of sorted) {
    if (r.type === 'night' && r.rmssd) {
      const k = dayKey(r.date + r.duration * 1000);
      primary.set(k, { kind: 'night', rmssd: r.rmssd, rhr: r.minHr, resp: r.respRate, rec: r });
      sleep.set(k, (sleep.get(k) || 0) + r.duration / 3600);
    }
  }
  for (const r of sorted) {
    if (r.type === 'hrv' && r.rmssd) {
      const k = dayKey(r.date);
      if (!primary.has(k)) primary.set(k, { kind: 'hrv', rmssd: r.rmssd, rhr: r.meanHr, resp: r.respRate, rec: r });
    }
  }
  return { primary, sleep };
}
let index = { primary: new Map(), sleep: new Map() };

function recoveryFor(key) {
  const p = index.primary.get(key);
  if (!p) return null;
  const baseline = [];
  for (let i = 1; i <= 30; i++) {
    const q = index.primary.get(addDays(key, -i));
    if (q && q.kind === p.kind) baseline.push(q);
  }
  const hours = index.sleep.get(key);
  const res = recoveryScore(p, baseline, hours ? { hours, need: settings.sleepNeed } : null);
  return { ...res, primary: p };
}

async function refreshData() {
  try {
    [records, daysMap, journalMap] = await Promise.all([
      db.all(),
      db.allIn('days').then((l) => new Map(l.map((d) => [d.date, d]))),
      db.allIn('journal').then((l) => new Map(l.map((j) => [j.date, j]))),
    ]);
  } catch {
    records = []; daysMap = new Map(); journalMap = new Map();
  }
  if (day) daysMap.set(day.date, day);
  index = buildIndex(records);
  // Basis: laatste 14 dagen
  const today = dayKey();
  const rhrN = [], rhrH = [], rm = [];
  for (let i = 0; i < 14; i++) {
    const p = index.primary.get(addDays(today, -i));
    if (!p) continue;
    if (p.kind === 'night' && p.rhr) rhrN.push(p.rhr);
    if (p.kind === 'hrv') { if (p.rhr) rhrH.push(p.rhr); rm.push(p.rmssd); }
  }
  base.restHr = median(rhrN.length ? rhrN : rhrH);
  base.rmssd = rm.length ? mean(rm) : null;
}

const strainOf = (key) => {
  const d = key === day?.date ? day : daysMap.get(key);
  return d ? strainFromTrimp(d.trimp) : null;
};

/* ============================================================
   Vandaag
   ============================================================ */
const RING = 2 * Math.PI * 52;
function setScoreRing(id, frac) {
  const el = $(id);
  el.style.strokeDashoffset = String(RING * (1 - clamp(frac || 0, 0, 1)));
  el.style.opacity = frac > 0.005 ? '1' : '0';
}

const JOURNAL = [
  ['alcohol', 'Alcohol'], ['cafeine', 'Cafeïne na 14:00'], ['laat-eten', 'Laat gegeten'],
  ['scherm', 'Scherm in bed'], ['sport', 'Gesport'], ['stress', 'Stressvolle dag'],
  ['meditatie', 'Gemediteerd'], ['ziek', 'Ziek of grieperig'], ['reizen', 'Gereisd'], ['hydratatie', 'Genoeg water'],
];

async function renderToday() {
  await refreshData();
  const key = dayKey();
  $('#today-date').textContent = fmtDay.format(new Date());

  // Herstel
  const rec = recoveryFor(key);
  const recEl = $('#score-recovery');
  $('#today-cta').hidden = !!rec;
  if (!rec) {
    $('#rec-val').textContent = '–'; $('#rec-sub').textContent = 'geen meting'; setScoreRing('#ring-recovery', 0);
    recEl.style.setProperty('--rec-color', 'var(--muted)');
    recEl.setAttribute('aria-label', 'Herstel: nog geen meting vandaag');
  } else if (rec.score == null) {
    $('#rec-val').textContent = '…'; $('#rec-sub').textContent = `kalibreren ${rec.calibrating}/3`; setScoreRing('#ring-recovery', rec.calibrating / 3);
    recEl.style.setProperty('--rec-color', 'var(--accent)');
    recEl.setAttribute('aria-label', `Herstel wordt gekalibreerd: ${rec.calibrating} van 3 metingen`);
  } else {
    const color = rec.score >= 67 ? 'var(--zone-2)' : rec.score >= 34 ? 'var(--zone-3)' : 'var(--zone-5)';
    recEl.style.setProperty('--rec-color', color);
    $('#rec-val').textContent = `${rec.score}%`;
    $('#rec-sub').textContent = rec.primary.kind === 'night' ? 'uit nachtmeting' : 'uit ochtendmeting';
    setScoreRing('#ring-recovery', rec.score / 100);
    recEl.setAttribute('aria-label', `Herstel ${rec.score} procent`);
  }

  // Inspanning
  const strain = strainOf(key) || 0;
  $('#strain-val').textContent = fmt1(strain);
  setScoreRing('#ring-strain', strain / 21);
  $('#score-strain').setAttribute('aria-label', `Inspanning ${fmt1(strain)} van 21`);

  // Slaap
  const hours = index.sleep.get(key);
  const needLast = settings.sleepNeed;
  $('#sleep-val').textContent = hours ? hmm(hours) : '–';
  $('#sleep-sub').textContent = hours ? `${nf0.format((hours / needLast) * 100)}% van behoefte` : 'geen nachtmeting';
  setScoreRing('#ring-sleep', hours ? hours / needLast : 0);
  $('#score-sleep').setAttribute('aria-label', hours ? `Slaap ${hmm(hours)} uur` : 'Slaap: geen nachtmeting');

  // Inspanningsdoel
  const target = strainTarget(rec?.score);
  if (target) {
    $('#target-range').textContent = `doel ${target.lo}–${target.hi}`;
    $('#target-text').textContent = `${target.text} Nu: ${fmt1(strain)}.`;
    $('#target-zone').style.left = `${(target.lo / 21) * 100}%`;
    $('#target-zone').style.width = `${((target.hi - target.lo) / 21) * 100}%`;
  } else {
    $('#target-range').textContent = '';
    $('#target-text').textContent = rec?.score == null && rec ? 'Na 3 metingen krijg je een persoonlijk advies.' : 'Doe eerst een ochtendmeting, dan krijg je een advies voor vandaag.';
    $('#target-zone').style.width = '0';
  }
  $('#target-now').style.left = `${(strain / 21) * 100}%`;

  // Statistieken
  const d = day && day.date === key ? day : daysMap.get(key);
  const stressAvg = d && d.stressSec > 60 ? d.stressSum / d.stressSec : null;
  $('#t-stress').textContent = fmt1(stressAvg);
  $('#t-stress-l').textContent = stressAvg != null ? stressLabel(stressAvg).toLowerCase() : '';
  $('#t-kcal').textContent = d && d.kcal ? fmt0(d.kcal) : '–';
  $('#t-rhr').textContent = fmt0(rec?.primary.rhr);
  $('#t-hrv').textContent = fmt0(rec?.primary.rmssd);
  $('#t-resp').textContent = fmt1(rec?.primary.resp);
  $('#t-vo2').textContent = fmt0(vo2max(maxHr(), base.restHr || settings.restHr));

  renderZones(d?.zoneSec || [0, 0, 0, 0, 0, 0]);

  // Slaapbehoefte vannacht
  const recent = [];
  for (let i = 0; i < 3; i++) { const h = index.sleep.get(addDays(key, -i)); if (h) recent.push({ hours: h, need: settings.sleepNeed }); }
  const need = sleepNeed(settings.sleepNeed, strain, recent);
  $('#need-val').textContent = `${hmm(need)} u`;
  const parts = [`Basis ${hmm(settings.sleepNeed)}`];
  if (strain > 10) parts.push(`+${nf0.format((strain - 10) * 0.06 * 60)} min door inspanning`);
  const extra = need - settings.sleepNeed - (strain > 10 ? (strain - 10) * 0.06 : 0);
  if (extra > 0.01) parts.push(`+${nf0.format(extra * 60)} min voor slaaptekort`);
  const bed = new Date(); bed.setHours(7, 0, 0, 0); bed.setTime(bed.getTime() - need * 3600000);
  $('#need-text').textContent = `${parts.join(' · ')}. Wil je om 7:00 op? Ga dan rond ${fmtClock.format(bed)} naar bed.`;

  renderJournal(key);
}

function renderZones(zs) {
  const total = zs.reduce((a, b) => a + b, 0);
  const bar = $('#zone-bar'); bar.innerHTML = '';
  const legend = $('#zone-legend'); legend.innerHTML = '';
  zs.forEach((sec, i) => {
    const seg = document.createElement('span');
    seg.style.width = total ? `${(sec / total) * 100}%` : '0';
    seg.style.background = `var(--zone-${i})`;
    bar.append(seg);
    const li = document.createElement('li');
    li.innerHTML = `<i style="background:var(--zone-${i})"></i>`;
    li.append(`${ZONE_SHORT[i]} ${sec >= 3600 ? hmm(sec / 3600) + ' u' : Math.round(sec / 60) + ' min'}`);
    legend.append(li);
  });
  $('#zones-total').textContent = total ? `${durText(total)} gemeten` : '';
  bar.setAttribute('aria-label', 'Tijd in zones vandaag: ' + zs.map((s, i) => `${ZONE_SHORT[i]} ${Math.round(s / 60)} minuten`).join(', '));
}

function renderJournal(key) {
  const fs = $('#journal');
  const entry = journalMap.get(key) || { date: key, items: {} };
  $$('label', fs).forEach((l) => l.remove());
  for (const [id, label] of JOURNAL) {
    const l = document.createElement('label');
    l.innerHTML = '<input type="checkbox"><span></span>';
    const input = $('input', l);
    input.value = id; input.checked = !!entry.items[id];
    $('span', l).textContent = label;
    input.addEventListener('change', async () => {
      entry.items[id] = input.checked;
      journalMap.set(key, entry);
      try { await db.putIn('journal', entry); } catch {}
    });
    fs.append(l);
  }
}

/* ============================================================
   Live-scherm
   ============================================================ */
let lastAnnounce = 0;
function renderLive() {
  const hr = state.hr;
  const connected = state.status === 'connected';
  const stale = connected && state.lastData && Date.now() - state.lastData > 5000;
  $('#hr-number').textContent = hr && state.status !== 'idle' ? String(hr) : '--';

  if (hr && state.status !== 'idle') {
    const z = zoneFor(hr);
    document.documentElement.style.setProperty('--zone', `var(--zone-${z.n})`);
    liveChart.color = `--zone-${z.n}`;
    $('#zone-chip').textContent = z.label;
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

  const idle = state.status === 'idle';
  const t60 = performance.now() - 60000;
  const hrs = state.hrHist.filter((p) => p.t >= t60).map((p) => p.hr);
  $('#live-avg').textContent = idle ? '–' : fmt0(mean(hrs));
  $('#live-minmax').textContent = hrs.length && !idle ? `${Math.min(...hrs)}–${Math.max(...hrs)}` : '–';

  const rmssdEl = $('#live-rmssd');
  if (idle) rmssdEl.textContent = '–';
  else if (state.liveRmssd) rmssdEl.textContent = fmt0(state.liveRmssd);
  else if (!state.rrSeen && state.connectedAt && Date.now() - state.connectedAt > 15000) { rmssdEl.textContent = 'n.v.t.'; rmssdEl.title = 'Je band stuurt geen RR-intervallen'; }
  else rmssdEl.textContent = '…';

  $('#live-stress').textContent = idle ? '–' : fmt1(state.stress);
  $('#live-stress-l').textContent = !idle && state.stress != null ? stressLabel(state.stress).toLowerCase() : '';
  if (state.recording) {
    const w = workload(state.recording.samples, profile());
    $('#live-strain').textContent = fmt1(w.strain);
    $('#live-kcal').textContent = fmt0(w.kcal);
    $('#record-info').textContent = `Training loopt · ${mmss((Date.now() - state.recording.start) / 1000)} · inspanning en kcal van deze training`;
  } else {
    $('#live-strain').textContent = day ? fmt1(strainFromTrimp(day.trimp)) : '–';
    $('#live-kcal').textContent = day && day.kcal ? fmt0(day.kcal) : '–';
  }

  if (hr && connected && Date.now() - lastAnnounce > 30000) {
    lastAnnounce = Date.now();
    $('#hr-sr').textContent = `Hartslag ${hr} slagen per minuut, ${zoneFor(hr).label}.`;
  }
}

let beatTimer = null;
function scheduleBeat() {
  clearTimeout(beatTimer); beatTimer = null;
  const fresh = state.lastData && Date.now() - state.lastData < 5000;
  if (!state.hr || state.status !== 'connected' || !fresh) return;
  beatTimer = setTimeout(() => { pulse(); scheduleBeat(); }, 60000 / state.hr);
}
function stopBeat() { clearTimeout(beatTimer); beatTimer = null; }
function pulse() {
  if (reducedMotion.matches || document.hidden || currentTab !== 'live') return;
  for (const el of [$('#heart'), $('#hr-number')]) { el.classList.remove('beat'); void el.offsetWidth; el.classList.add('beat'); }
}
setInterval(() => {
  if (state.status !== 'idle') renderLive();
  if (!beatTimer) scheduleBeat();
}, 1000);

// Training
function startRecording() {
  state.recording = { start: Date.now(), samples: [], rr: [], activity: $('#activity').value };
  $('#btn-record').setAttribute('aria-pressed', 'true');
  $('#btn-record-text').textContent = 'Stop training';
  $('#record-info').hidden = false;
  $('#activity').disabled = true;
  requestWakeLock();
  renderLive();
}
async function stopRecording() {
  const rec = state.recording;
  state.recording = null;
  $('#btn-record').setAttribute('aria-pressed', 'false');
  $('#btn-record-text').textContent = 'Start training';
  $('#record-info').hidden = true;
  $('#activity').disabled = false;
  releaseWakeLock();
  if (!rec) return;
  const duration = (Date.now() - rec.start) / 1000;
  const hrs = rec.samples.map((s) => s[1]);
  if (duration < 10 || hrs.length < 5) { toast('Training te kort, niet opgeslagen.'); return; }
  const w = workload(rec.samples, profile());
  const a = analyze(rec.rr);
  await safeAdd({
    type: 'session', activity: rec.activity, date: rec.start, duration,
    meanHr: mean(hrs), minHr: Math.min(...hrs), maxHr: Math.max(...hrs),
    strain: w.strain, kcal: w.kcal, zoneSec: w.zoneSec, rmssd: a.rmssd,
    samples: rec.samples, rr: rec.rr, demo: state.source?.kind === 'demo',
  });
  toast(`Training opgeslagen: inspanning ${fmt1(w.strain)}, ${fmt0(w.kcal)} kcal.`);
  renderLive();
}

/* ============================================================
   Meten: HRV
   ============================================================ */
const hrv = { running: false, phase: null, rr: [], start: 0, dur: 60, timer: null, unsub: null };
const RING_LEN = 2 * Math.PI * 88;

function updateMeasureHints() {
  const ok = state.status === 'connected';
  const demo = state.source?.kind === 'demo';
  const need = 'Verbind eerst je band op het tabblad Live, of start daar de demo-modus.';
  $('#btn-hrv-start').disabled = !ok && !hrv.running;
  $('#hrv-hint').textContent = ok ? (demo ? 'Je meet nu met gesimuleerde demo-data.' : '') : need;
  $('#btn-night-start').disabled = !ok;
  $('#night-hint').textContent = ok ? (demo ? 'Demo-modus: de nacht wordt gesimuleerd in echte tijd.' : '') : need;
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
function setRing(frac) { $('#hrv-ring').style.strokeDashoffset = String(RING_LEN * (1 - clamp(frac, 0, 1))); }
function endHrvRun() {
  clearInterval(hrv.timer); hrv.unsub?.(); hrv.running = false;
  releaseWakeLock();
  $('#hrv-running').hidden = true;
}
function cancelHrv(message) {
  endHrvRun();
  $('#hrv-intro').hidden = false;
  updateMeasureHints();
  if (message) { $('#hrv-hint').textContent = message; toast(message); }
}
async function finishHrv() {
  const duration = (Date.now() - hrv.start) / 1000;
  endHrvRun();
  const a = analyze(hrv.rr);
  const minBeats = Math.max(20, Math.round(duration / 3));
  if (!a.rmssd || a.beats < minBeats) {
    $('#hrv-intro').hidden = false;
    updateMeasureHints();
    $('#hrv-hint').textContent = `Te weinig bruikbare slagen (${a.beats}${a.removed ? `, ${a.removed} weggefilterd` : ''}). Blijf stiller zitten, controleer of de band goed aansluit en probeer het opnieuw.`;
    return;
  }
  const rec = {
    type: 'hrv', date: Date.now() - duration * 1000, duration,
    rmssd: a.rmssd, lnRmssd: a.lnRmssd, sdnn: a.sdnn, meanHr: a.meanHr,
    respRate: respiratoryRate(hrv.rr),
    beats: a.beats, removed: a.removed, rr: hrv.rr, demo: state.source?.kind === 'demo',
  };
  let prev = [];
  try { const weekAgo = Date.now() - 7 * 86400000; prev = (await db.all()).filter((r) => r.type === 'hrv' && r.date >= weekAgo && r.rmssd); } catch {}
  await safeAdd(rec);
  await refreshData();
  showHrvResult(rec, prev, recoveryFor(dayKey()));
}

function showHrvResult(rec, prev, recovery) {
  $('#hrv-result').hidden = false;
  $('#res-date').textContent = `${fmtDate.format(new Date(rec.date))} · ${durText(rec.duration)}${rec.demo ? ' · demo' : ''}`;
  $('#res-rmssd').textContent = fmt0(rec.rmssd);
  $('#res-ln').textContent = nf2.format(rec.lnRmssd);
  $('#res-sdnn').textContent = fmt0(rec.sdnn);
  $('#res-hr').textContent = fmt0(rec.meanHr);
  $('#res-beats').textContent = fmt0(rec.beats);
  $('#res-resp').textContent = fmt1(rec.respRate);
  $('#res-rec').textContent = recovery?.score != null ? `${recovery.score}%` : recovery ? `kalibreren ${recovery.calibrating}/3` : '–';
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
    const small = Math.abs(diff) < 5;
    cmp.innerHTML = '';
    cmp.append(
      document.createTextNode(small ? 'Je zit ' : ''),
      Object.assign(document.createElement('strong'), { textContent: small ? 'rond' : `${nf0.format(Math.abs(diff))}% ${diff > 0 ? 'boven' : 'onder'}` }),
      document.createTextNode(` je 7-daagse gemiddelde van ${fmt0(avg)} ms (${prev.length} ${prev.length === 1 ? 'meting' : 'metingen'}).`),
    );
  }
}

/* ============================================================
   Meten: ademhaling
   ============================================================ */
const breath = { running: false, rate: settings.breathRate, start: 0, dur: 180, raf: 0, hrs: [], rr: [], unsub: null, lastLabel: '' };
const easeInOut = (x) => 0.5 - 0.5 * Math.cos(Math.PI * x);

function renderRate() {
  const r = breath.rate, half = rateText(60 / r / 2);
  $('#rate-value').textContent = rateText(r);
  $('#rate-desc').textContent = `${rateText(r)} ademhalingen per minuut · ${half} s in, ${half} s uit`;
  $('#rate-down').disabled = r <= 4;
  $('#rate-up').disabled = r >= 10;
}
function changeRate(delta) {
  breath.rate = clamp(Math.round((breath.rate + delta) * 2) / 2, 4, 10);
  settings.breathRate = breath.rate; saveSettings();
  renderRate();
}
function startBreath() {
  breath.dur = Number($('input[name="breath-dur"]:checked').value);
  Object.assign(breath, { running: true, start: performance.now(), hrs: [], rr: [], lastLabel: '' });
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
  if (reducedMotion.matches) { circle.style.transform = 'scale(.85)'; circle.style.opacity = String(0.45 + 0.55 * amt); }
  else { circle.style.transform = `scale(${0.55 + 0.45 * amt})`; circle.style.opacity = '1'; }
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
  let text = `${mmss(duration)} rustig geademd op ${rateText(breath.rate)} ademhalingen per minuut.`;
  if (first && last) {
    const dd = Math.round(first - last);
    text += dd >= 2 ? ` Je hartslag daalde ${dd} bpm.` : dd <= -2 ? ` Je hartslag steeg ${-dd} bpm.` : ' Je hartslag bleef stabiel.';
  } else if (!hrs.length) text += ' Verbind je band om ook je hartslag te zien.';
  $('#sum-text').textContent = text;
}

/* ============================================================
   Meten: nacht
   ============================================================ */
const night = { running: false, start: 0, samples: [], rr: [], unsub: null, timer: null, lastS: 0 };

function startNight() {
  if (state.status !== 'connected') return;
  Object.assign(night, { running: true, start: Date.now(), samples: [], rr: [], lastS: -30 });
  if (state.source) state.source.persistent = true;
  night.unsub = addListener((d) => {
    const t = (Date.now() - night.start) / 1000;
    night.rr.push(...d.rr);
    // Hartslag elke 30 s bewaren (genoeg voor een grafiek, klein in opslag)
    if (d.hr && t - night.lastS >= 30) { night.samples.push([Math.round(t), d.hr]); night.lastS = t; }
    $('#night-hr').textContent = d.hr || '--';
  });
  $('#night-overlay').hidden = false;
  requestWakeLock();
  const tick = () => {
    $('#night-clock').textContent = fmtClock.format(new Date());
    $('#night-elapsed').textContent = hmm((Date.now() - night.start) / 3600000);
  };
  tick();
  night.timer = setInterval(tick, 5000);
  $('#btn-night-stop').focus();
}

async function stopNight() {
  if (!(await confirmDialog('Nachtmeting stoppen?', 'Je nacht wordt geanalyseerd en opgeslagen.', 'Stoppen', false))) return;
  clearInterval(night.timer);
  night.unsub?.();
  night.running = false;
  if (state.source) state.source.persistent = false;
  releaseWakeLock();
  $('#night-overlay').hidden = true;
  const duration = (Date.now() - night.start) / 1000;
  const res = analyzeNight(night.rr);
  if (duration < 20 * 60 || !res) {
    toast(duration < 20 * 60 ? 'Nachtmeting te kort (minder dan 20 minuten), niet opgeslagen.' : 'Te weinig bruikbare gegevens om je nacht te analyseren.');
    return;
  }
  const rec = {
    type: 'night', date: night.start, duration, ...res,
    samples: night.samples, rr: night.rr, demo: state.source?.kind === 'demo',
  };
  await safeAdd(rec);
  await refreshData();
  showNightResult(rec);
}

function showNightResult(rec) {
  $('#night-intro').hidden = true;
  $('#night-result').hidden = false;
  $('#night-date').textContent = `${fmtDate.format(new Date(rec.date))} – ${fmtClock.format(new Date(rec.date + rec.duration * 1000))}`;
  $('#night-dur').textContent = hmm(rec.duration / 3600);
  $('#night-min').textContent = fmt0(rec.minHr);
  $('#night-rmssd').textContent = fmt0(rec.rmssd);
  $('#night-resp').textContent = fmt1(rec.respRate);
  const r = recoveryFor(dayKey(rec.date + rec.duration * 1000));
  $('#night-rec').textContent = r?.score != null ? `${r.score}%` : r ? `kalibreren ${r.calibrating}/3` : '–';
  const need = settings.sleepNeed, hours = rec.duration / 3600;
  $('#night-text').textContent = hours >= need
    ? `Je lag ${hmm(hours)} uur in bed. Dat dekt je slaapbehoefte van ${hmm(need)} uur.`
    : `Je lag ${hmm(hours)} uur in bed, ${nf0.format((need - hours) * 60)} minuten minder dan je behoefte van ${hmm(need)} uur.`;
  requestAnimationFrame(() => drawSparkline($('#night-chart'), (rec.segments || []).map((s) => s[0])));
}

/* ============================================================
   Trends
   ============================================================ */
const ICONS = {
  hrv: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.3-8.8-8.6C1.9 8.2 4 5 7.2 5c2 0 3.4 1 4.8 2.8C13.4 6 14.8 5 16.8 5 20 5 22.1 8.2 20.8 11.4 19 15.7 12 20 12 20z"/></svg>',
  breath: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/></svg>',
  session: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l2.5-6 5 12 2.5-6h4"/></svg>',
  night: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
  download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/></svg>',
};
const TITLES = { hrv: 'HRV-meting', breath: 'Ademsessie', session: 'Training', night: 'Nachtmeting' };
const METRICS = {
  recovery: { title: 'Herstel', unit: '%', get: (k) => recoveryFor(k)?.score },
  hrv: { title: 'HRV (RMSSD)', unit: 'ms', get: (k) => index.primary.get(k)?.rmssd },
  rhr: { title: 'Rusthartslag', unit: 'bpm', get: (k) => index.primary.get(k)?.rhr },
  strain: { title: 'Inspanning', unit: '', get: (k) => strainOf(k) || null },
  sleep: { title: 'Slaap', unit: 'u', get: (k) => index.sleep.get(k) },
  resp: { title: 'Ademfrequentie', unit: '/min', get: (k) => index.primary.get(k)?.resp },
};

function series(metric, days = 30) {
  const out = [];
  const today = dayKey();
  for (let i = days - 1; i >= 0; i--) {
    const k = addDays(today, -i);
    const v = METRICS[metric].get(k);
    if (v != null && isFinite(v)) out.push({ date: noonOf(k), value: v, key: k });
  }
  return out;
}

async function renderTrends() {
  await refreshData();
  // Grafiek
  const metric = $('input[name="trend-metric"]:checked').value;
  const pts = series(metric);
  const m = METRICS[metric];
  $('#trend-title').textContent = m.title;
  $('#trend-empty').hidden = pts.length > 0;
  $('#trend-chart').hidden = pts.length === 0;
  if (pts.length) {
    requestAnimationFrame(() => drawTrend($('#trend-chart'), pts));
    $('#trend-chart').setAttribute('aria-label', `${m.title} over 30 dagen: ${pts.length} dagen met gegevens, gemiddeld ${fmt1(mean(pts.map((p) => p.value)))} ${m.unit}, laatste ${fmt1(pts[pts.length - 1].value)} ${m.unit}.`);
  }
  renderWeekReport();
  renderMonitor();
  renderInsights();
  renderHistoryList();
}

function weekAvg(metric, from, to) {
  const vals = [];
  for (let i = from; i < to; i++) {
    const v = METRICS[metric].get(addDays(dayKey(), -i));
    if (v != null && isFinite(v)) vals.push(v);
  }
  return vals.length ? mean(vals) : null;
}
function renderWeekReport() {
  const el = $('#week-report'); el.innerHTML = '';
  const rows = [
    ['recovery', 'Herstel', (v) => `${fmt0(v)}%`, 1, 0],
    ['hrv', 'HRV', (v) => `${fmt0(v)} ms`, 1, 0],
    ['rhr', 'Rusthartslag', (v) => `${fmt0(v)} bpm`, -1, 0],
    ['strain', 'Inspanning', (v) => fmt1(v), 0, 1],
    ['sleep', 'Slaap', (v) => `${hmm(v)} u`, 1, 2],
  ];
  for (const [k, label, f, good, dec] of rows) {
    const cur = weekAvg(k, 0, 7), prev = weekAvg(k, 7, 14);
    const div = document.createElement('div');
    let delta = '', cls = 'flat';
    if (cur != null && prev != null) {
      const d = cur - prev;
      const shown = dec === 2 ? `${nf0.format(Math.abs(d) * 60)} min` : dec === 1 ? nf1.format(Math.abs(d)) : nf0.format(Math.abs(d));
      delta = Math.abs(d) < (dec === 2 ? 1 / 60 : dec === 1 ? 0.1 : 0.5) ? 'gelijk' : `${d > 0 ? '▲' : '▼'} ${shown}`;
      if (delta !== 'gelijk' && good) cls = d * good > 0 ? 'up' : 'down';
    }
    div.innerHTML = '<span class="r-label"></span><span class="r-val"></span><span class="r-delta"></span>';
    $('.r-label', div).textContent = label;
    $('.r-val', div).textContent = cur != null ? f(cur) : '–';
    const de = $('.r-delta', div); de.textContent = delta || (cur != null ? 'geen vergelijking' : 'geen gegevens'); de.className = `r-delta ${cls}`;
    el.append(div);
  }
  const since = Date.now() - 7 * 86400000;
  const trainings = records.filter((r) => r.type === 'session' && r.date >= since);
  const div = document.createElement('div');
  div.innerHTML = '<span class="r-label">Trainingen</span><span class="r-val"></span><span class="r-delta flat"></span>';
  $('.r-val', div).textContent = String(trainings.length);
  $('.r-delta', div).textContent = trainings.length ? `${fmt0(trainings.reduce((s, r) => s + (r.kcal || 0), 0))} kcal` : 'deze week';
  el.append(div);
}

function renderMonitor() {
  const ul = $('#monitor'); ul.innerHTML = '';
  const today = dayKey();
  const items = [
    ['rhr', 'Rusthartslag', 'bpm', 0],
    ['hrv', 'HRV (RMSSD)', 'ms', 0],
    ['resp', 'Ademfrequentie', '/min', 1],
  ];
  for (const [k, name, unit, dec] of items) {
    let latest = null, latestKey = null;
    for (let i = 0; i < 3 && latest == null; i++) { const kk = addDays(today, -i); const v = METRICS[k].get(kk); if (v != null) { latest = v; latestKey = kk; } }
    const hist = [];
    for (let i = 1; i <= 30; i++) { const kk = addDays(latestKey || today, -i); const v = METRICS[k].get(kk); if (v != null) hist.push(v); }
    const li = document.createElement('li');
    li.innerHTML = '<div><div class="m-name"></div><div class="m-range"></div></div><div class="m-right"><span class="m-val"></span><span class="badge"></span></div>';
    $('.m-name', li).textContent = name;
    const fmtV = (v) => (dec ? fmt1(v) : fmt0(v));
    $('.m-val', li).textContent = latest != null ? `${fmtV(latest)} ${unit}` : '–';
    const badge = $('.badge', li);
    if (hist.length >= 5 && latest != null) {
      const mu = mean(hist), s = Math.max(sd(hist) || 0, mu * 0.03);
      $('.m-range', li).textContent = `Normaal: ${fmtV(mu - 1.5 * s)}–${fmtV(mu + 1.5 * s)} ${unit}`;
      const z = (latest - mu) / s;
      if (Math.abs(z) <= 1.5) { badge.textContent = 'Binnen bereik'; badge.className = 'badge badge-ok'; }
      else { badge.textContent = z > 0 ? 'Hoger dan normaal' : 'Lager dan normaal'; badge.className = 'badge badge-warn'; }
    } else {
      $('.m-range', li).textContent = `Basis opbouwen (${hist.length}/5 dagen)`;
      badge.textContent = 'Kalibreren'; badge.className = 'badge badge-none';
    }
    ul.append(li);
  }
  // VO2max
  const li = document.createElement('li');
  li.innerHTML = '<div><div class="m-name">VO₂max (schatting)</div><div class="m-range">15,3 × max. hartslag / rusthartslag</div></div><div class="m-right"><span class="m-val"></span></div>';
  const v = vo2max(maxHr(), base.restHr || settings.restHr);
  $('.m-val', li).textContent = v ? `${fmt0(v)} ml/kg/min` : '–';
  ul.append(li);
}

function renderInsights() {
  const ul = $('#insights'); ul.innerHTML = '';
  const rows = [];
  for (const [id, label] of JOURNAL) {
    const yes = [], no = [];
    for (const [key, entry] of journalMap) {
      const r = recoveryFor(key)?.score;
      if (r == null) continue;
      (entry.items[id] ? yes : no).push(r);
    }
    rows.push({ id, label, yes, no, diff: yes.length >= 3 && no.length >= 3 ? mean(yes) - mean(no) : null });
  }
  const ready = rows.filter((r) => r.diff != null).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  if (!ready.length) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="muted small"></span>';
    $('span', li).textContent = 'Vul elke ochtend je dagboek in bij Vandaag en doe een meting. Zodra een gewoonte minstens 3 keer wel en 3 keer niet voorkomt, zie je hier het effect op je herstel.';
    ul.append(li);
    return;
  }
  for (const r of ready) {
    const li = document.createElement('li');
    li.innerHTML = '<div><div class="m-name"></div><div class="m-range"></div></div><span class="m-val"></span>';
    $('.m-name', li).textContent = r.label;
    $('.m-range', li).textContent = `${r.yes.length}× wel, ${r.no.length}× niet`;
    const v = $('.m-val', li);
    v.textContent = `${r.diff > 0 ? '+' : '−'}${nf0.format(Math.abs(r.diff))}% herstel`;
    v.className = `m-val ${Math.abs(r.diff) < 3 ? 'flat' : r.diff > 0 ? 'up' : 'down'}`;
    ul.append(li);
  }
}

let historyLimit = 15;
function renderHistoryList() {
  const filter = $('input[name="hist-filter"]:checked').value;
  const list = $('#history-list');
  list.innerHTML = '';
  const all = records.filter((r) => filter === 'all' || r.type === filter);
  const shown = all.slice(0, historyLimit);
  for (const r of shown) list.append(historyItem(r));
  $('#history-empty').hidden = shown.length > 0;
  const more = $('#btn-more');
  more.hidden = all.length <= historyLimit;
  more.textContent = `Toon meer (${all.length - shown.length})`;
  $('#btn-export').disabled = !records.length;
  $('#btn-export-days').disabled = !records.length && !daysMap.size;
}

function historyItem(r) {
  const li = document.createElement('li');
  li.className = 'history-item';
  let metrics = '';
  if (r.type === 'hrv') metrics = `RMSSD ${fmt0(r.rmssd)} ms · ln ${nf2.format(r.lnRmssd)} · ${fmt0(r.meanHr)} bpm`;
  else if (r.type === 'breath') metrics = `${rateText(r.rate)}/min · gem. ${fmt0(r.meanHr)} bpm${r.rmssd ? ` · RMSSD ${fmt0(r.rmssd)} ms` : ''}`;
  else if (r.type === 'night') metrics = `laagste ${fmt0(r.minHr)} bpm · HRV ${fmt0(r.rmssd)} ms · ${fmt1(r.respRate)}/min`;
  else metrics = `inspanning ${fmt1(r.strain)} · gem. ${fmt0(r.meanHr)} bpm · ${fmt0(r.kcal)} kcal`;
  const title = r.type === 'session' && r.activity ? `${TITLES.session} · ${r.activity}` : TITLES[r.type] || 'Sessie';
  const date = fmtDate.format(new Date(r.date));
  li.innerHTML = `
    <div class="history-icon">${ICONS[r.type] || ICONS.session}</div>
    <div class="history-body"><span class="history-title"></span><span class="history-meta"></span><span class="history-metrics"></span></div>
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
      await db.remove(r.id); toast('Verwijderd.'); renderTrends();
    }
  });
  return li;
}

/* ---------- CSV ---------- */
const csvNum = (v, d = 1) => (v == null || !isFinite(v) ? '' : v.toFixed(d).replace('.', ','));
const isoLocal = (t) => { const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };

function exportAll() {
  const head = ['type', 'activiteit', 'datum', 'duur_s', 'rmssd_ms', 'ln_rmssd', 'sdnn_ms', 'gem_hartslag', 'min_hartslag', 'max_hartslag', 'ademfrequentie', 'inspanning', 'kcal', 'slagen', 'gefilterd', 'ademtempo_per_min', 'demo'];
  const rows = [...records].sort((a, b) => a.date - b.date).map((r) => [
    r.type, r.activity || '', isoLocal(r.date), csvNum(r.duration, 0), csvNum(r.rmssd), csvNum(r.lnRmssd, 3), csvNum(r.sdnn),
    csvNum(r.meanHr), csvNum(r.minHr, 0), csvNum(r.maxHr, 0), csvNum(r.respRate), csvNum(r.strain), csvNum(r.kcal, 0),
    r.beats ?? '', r.removed ?? '', csvNum(r.rate), r.demo ? 'ja' : 'nee',
  ]);
  downloadCsv(`whoop-metingen-${dayKey()}.csv`, [head, ...rows]);
}

function exportDays() {
  const keys = new Set([...daysMap.keys(), ...index.primary.keys(), ...journalMap.keys()]);
  const sorted = [...keys].sort();
  const head = ['datum', 'herstel_pct', 'hrv_ms', 'rusthartslag', 'ademfrequentie', 'slaap_u', 'inspanning', 'kcal', 'stress_gem', ...ZONE_SHORT.map((z) => `min_${z.toLowerCase()}`), ...JOURNAL.map(([id]) => `dagboek_${id}`)];
  const rows = sorted.map((k) => {
    const p = index.primary.get(k), d = daysMap.get(k), j = journalMap.get(k);
    return [
      k, recoveryFor(k)?.score ?? '', csvNum(p?.rmssd), csvNum(p?.rhr), csvNum(p?.resp), csvNum(index.sleep.get(k), 2),
      csvNum(d ? strainFromTrimp(d.trimp) : null), csvNum(d?.kcal, 0), csvNum(d && d.stressSec ? d.stressSum / d.stressSec : null, 2),
      ...(d ? d.zoneSec.map((s) => csvNum(s / 60, 0)) : ZONE_SHORT.map(() => '')),
      ...JOURNAL.map(([id]) => (j ? (j.items[id] ? 'ja' : 'nee') : '')),
    ];
  });
  downloadCsv(`whoop-dagen-${dayKey()}.csv`, [head, ...rows]);
}

function exportRecord(r) {
  const name = `whoop-${r.type}-${isoLocal(r.date).replace(/[: ]/g, '-')}.csv`;
  if (r.type === 'hrv') {
    const f = filterRR(r.rr || []);
    let t = 0;
    const rows = (r.rr || []).map((rr, i) => { t += rr; return [i + 1, csvNum(t / 1000, 3), csvNum(rr, 1), f.flags[i] ? 'ja' : 'nee']; });
    downloadCsv(name, [['slag', 'tijd_s', 'rr_ms', 'behouden'], ...rows]);
  } else if (r.type === 'night') {
    const rows = (r.segments || []).map(([hr, rm], i) => [i * 5, csvNum(hr), csvNum(rm)]);
    downloadCsv(name, [['minuut', 'hartslag_bpm', 'rmssd_ms'], ...rows]);
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
   Voorbeelddata
   ============================================================ */
async function hasSampleData() {
  try { return (await db.all()).some((r) => r.sample); } catch { return false; }
}
async function updateSampleButton() {
  $('#btn-sample').textContent = (await hasSampleData()) ? 'Voorbeelddata verwijderen' : 'Voorbeelddata van 3 weken laden';
}
async function toggleSampleData() {
  if (await hasSampleData()) {
    const all = await db.all();
    for (const r of all.filter((x) => x.sample)) await db.remove(r.id);
    for (const d of await db.allIn('days')) if (d.sample) await db.deleteIn('days', d.date);
    for (const j of await db.allIn('journal')) if (j.sample) await db.deleteIn('journal', j.date);
    toast('Voorbeelddata verwijderd.');
  } else {
    await generateSampleData();
    toast('Voorbeelddata geladen. Kijk bij Vandaag en Trends.');
  }
  await loadDay();
  updateSampleButton();
}

async function generateSampleData() {
  const rnd = (a, b) => a + Math.random() * (b - a);
  const today = dayKey();
  let prevStrain = 10;
  for (let i = 21; i >= 0; i--) {
    const key = addDays(today, -i);
    const [y, m, d] = key.split('-').map(Number);
    const j = { date: key, sample: true, items: {} };
    for (const [id] of JOURNAL) j.items[id] = Math.random() < (id === 'hydratatie' ? 0.6 : id === 'ziek' ? 0.05 : 0.3);
    // Herstel wordt beïnvloed door alcohol, laat eten en inspanning van gisteren
    let effect = 0;
    if (j.items.alcohol) effect -= 0.18;
    if (j.items['laat-eten']) effect -= 0.07;
    if (j.items.meditatie) effect += 0.05;
    if (j.items.ziek) effect -= 0.3;
    effect -= (prevStrain - 11) * 0.015;
    const hours = clamp(rnd(6.2, 8.6) - (j.items.scherm ? 0.4 : 0), 5, 9.5);
    const wake = new Date(y, m - 1, d, 6, Math.round(rnd(30, 75))).getTime();
    const nightRmssd = 62 * Math.exp(effect + rnd(-0.08, 0.08));
    const minHr = 51 - effect * 12 + rnd(-1.5, 1.5);
    const segs = [];
    for (let s = 0; s < hours * 12; s++) segs.push([Math.round((minHr + 6 * Math.exp(-s / 25) + rnd(0, 3)) * 10) / 10, Math.round(nightRmssd * rnd(0.8, 1.15) * 10) / 10]);
    await db.add({ type: 'night', date: wake - hours * 3600000, duration: hours * 3600, minHr, meanHr: minHr + 4, rmssd: nightRmssd, respRate: rnd(13.2, 15.2), segments: segs, samples: [], rr: [], demo: true, sample: true });
    const mRmssd = 48 * Math.exp(effect + rnd(-0.1, 0.1));
    await db.add({ type: 'hrv', date: wake + 15 * 60000, duration: 60, rmssd: mRmssd, lnRmssd: Math.log(mRmssd), sdnn: mRmssd * 1.1, meanHr: minHr + 9, respRate: rnd(12, 16), beats: 60, removed: Math.round(rnd(0, 3)), rr: [], demo: true, sample: true });
    if (i > 0) {
      const trained = Math.random() < 0.5;
      const zoneSec = [rnd(4, 9) * 3600, rnd(20, 60) * 60, rnd(10, 40) * 60, trained ? rnd(10, 35) * 60 : rnd(0, 5) * 60, trained ? rnd(5, 25) * 60 : 0, trained ? rnd(0, 8) * 60 : 0];
      const trimp = zoneSec.reduce((s, z, k) => s + (z / 60) * ZONE_WEIGHT[k], 0);
      prevStrain = strainFromTrimp(trimp);
      await db.putIn('days', { date: key, trimp, zoneSec, kcal: rnd(2100, 2600) + (trained ? rnd(300, 800) : 0), stressSum: rnd(0.6, 1.6) * 30000, stressSec: 30000, maxHr: trained ? rnd(160, 185) : rnd(110, 130), demo: true, sample: true });
      if (trained) {
        const acts = ['Hardlopen', 'Fietsen', 'Krachttraining', 'HIIT'];
        const dur = rnd(35, 75) * 60, mHr = rnd(130, 155);
        await db.add({ type: 'session', activity: acts[Math.floor(Math.random() * acts.length)], date: new Date(y, m - 1, d, 18).getTime(), duration: dur, meanHr: mHr, minHr: mHr - 30, maxHr: mHr + 25, strain: rnd(9, 16), kcal: (dur / 60) * rnd(8, 13), zoneSec: [], samples: [], rr: [], demo: true, sample: true });
      }
    }
    await db.putIn('journal', j);
  }
}

/* ============================================================
   Instellingen-scherm
   ============================================================ */
function initSettings() {
  const form = $('#settings-form');
  for (const k of ['age', 'maxHr', 'restHr', 'weight', 'height']) form[k].value = settings[k] ?? '';
  form.sleepNeed.value = settings.sleepNeed ?? 8;
  for (const k of ['hrvDuration', 'theme', 'sex']) $$(`input[name="${k}"]`).forEach((i) => { i.checked = String(i.value) === String(settings[k]); });
  updateMaxHelp();
  const num = (input, min, max, float = false) => {
    const v = float ? parseFloat(String(input.value).replace(',', '.')) : parseInt(input.value, 10);
    const ok = !input.value || (v >= min && v <= max);
    input.setAttribute('aria-invalid', String(!ok));
    return input.value && ok ? v : null;
  };
  form.addEventListener('input', (e) => {
    const t = e.target;
    if (t.name === 'age') settings.age = num(t, 10, 100);
    if (t.name === 'maxHr') settings.maxHr = num(t, 120, 230);
    if (t.name === 'restHr') settings.restHr = num(t, 30, 110);
    if (t.name === 'weight') settings.weight = num(t, 30, 250, true);
    if (t.name === 'height') settings.height = num(t, 120, 230);
    if (t.name === 'sleepNeed') settings.sleepNeed = num(t, 5, 11, true) || 8;
    if (t.name === 'sex') settings.sex = t.value;
    if (t.name === 'hrvDuration') { settings.hrvDuration = Number(t.value); syncHrvDuration(); }
    if (t.name === 'theme') { settings.theme = t.value; applyTheme(); }
    saveSettings(); updateMaxHelp(); renderLive();
  });
  form.addEventListener('submit', (e) => e.preventDefault());
}
function updateMaxHelp() {
  const help = $('#max-help');
  if (settings.maxHr) help.textContent = `Je eigen waarde wordt gebruikt: ${settings.maxHr} bpm.`;
  else if (settings.age) help.textContent = `Berekend uit je leeftijd: ${maxHr()} bpm (208 − 0,7 × leeftijd).`;
  else help.textContent = 'Vul je leeftijd of eigen maximum in. Zonder gegevens rekenen we met 190 bpm.';
}
function syncHrvDuration() { $$('input[name="hrv-dur"]').forEach((i) => { i.checked = Number(i.value) === Number(settings.hrvDuration); }); }

/* ============================================================
   Onboarding
   ============================================================ */
const OB_STEPS = [
  { title: 'Hartslag, HRV en herstel', text: 'Bekijk je hartslag live, meet je HRV, volg herstel, inspanning, slaap en stress, en adem rustig met de begeleider. Alles blijft op je eigen toestel.', art: '<svg viewBox="0 0 64 64"><path d="M6 34h12l5-14 9 26 6-18 4 6h16"/></svg>' },
  { title: 'Bluefy of Chrome nodig', text: 'Safari ondersteunt geen Web Bluetooth. Gebruik op iPhone de gratis browser Bluefy. Op Android en computer werkt Chrome of Edge.', art: '<svg viewBox="0 0 64 64"><rect x="18" y="6" width="28" height="52" rx="6"/><path d="M26 22l12 12-6 5V17l6 5-12 12"/></svg>' },
  { title: 'Sluit de WHOOP-app', text: 'Zet in de officiële WHOOP-app "Hartslag uitzenden" aan en sluit de app daarna helemaal af. Dan kan deze app verbinding maken met je band.', art: '<svg viewBox="0 0 64 64"><rect x="12" y="12" width="40" height="40" rx="10"/><path d="M24 24l16 16M40 24L24 40"/></svg>' },
];
let obStep = 0;
function openOnboarding() { obStep = 0; $('#onboarding').hidden = false; renderOb(); $('#ob-next').focus(); }
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
function closeOnboarding() { $('#onboarding').hidden = true; settings.onboarded = true; saveSettings(); $('#main').focus(); }

/* ============================================================
   Algemene UI
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

function confirmDialog(title, text, okLabel = 'Verwijderen', danger = true) {
  return new Promise((resolve) => {
    const m = $('#confirm');
    const prevFocus = document.activeElement;
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    $('#confirm-ok').textContent = okLabel;
    $('#confirm-ok').className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
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
    if (currentTab === 'today') renderToday();
  }
});

const TABS = ['today', 'live', 'measure', 'trends', 'settings'];
const LEGACY = { hrv: 'measure/hrv', breath: 'measure/breath', history: 'trends' };
function route() {
  let h = location.hash.slice(1);
  if (LEGACY[h]) { location.replace('#' + LEGACY[h]); return; }
  const [tab0, panel] = h.split('/');
  const tab = TABS.includes(tab0) ? tab0 : 'today';
  const changed = tab !== currentTab;
  currentTab = tab;
  TABS.forEach((t) => { $(`#screen-${t}`).hidden = t !== tab; });
  $$('.tab').forEach((a) => (a.dataset.tab === tab ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  if (tab === 'measure') {
    if (['hrv', 'breath', 'night'].includes(panel)) currentPanel = panel;
    ['hrv', 'breath', 'night'].forEach((p) => { $(`#panel-${p}`).hidden = p !== currentPanel; });
    $$('.subnav a').forEach((a) => (a.dataset.panel === currentPanel ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
    updateMeasureHints();
  }
  if (tab === 'live') { liveChart.start(); requestAnimationFrame(() => liveChart.draw()); } else liveChart.stop();
  if (tab === 'today') renderToday();
  if (tab === 'trends') renderTrends();
  if (tab === 'settings') updateSampleButton();
  if (changed) window.scrollTo(0, 0);
}

/* ============================================================
   Start
   ============================================================ */
async function init() {
  liveChart = new LiveChart($('#live-chart'));
  applyTheme();
  await loadDay();

  if (!BleSource.supported) {
    show('#no-bt-notice');
    $('#btn-connect').disabled = true;
    $('#btn-connect-all').disabled = true;
  } else if (!window.isSecureContext) show('#insecure-notice');

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
  $('#btn-hrv-done').addEventListener('click', () => { $('#hrv-result').hidden = true; $('#hrv-intro').hidden = false; updateMeasureHints(); });

  renderRate();
  $('#rate-down').addEventListener('click', () => changeRate(-0.5));
  $('#rate-up').addEventListener('click', () => changeRate(0.5));
  $('#btn-breath-start').addEventListener('click', startBreath);
  $('#btn-breath-stop').addEventListener('click', () => finishBreath(true));
  $('#btn-breath-done').addEventListener('click', () => { $('#breath-summary').hidden = true; $('#breath-setup').hidden = false; $('#breath-chart').hidden = true; });

  $('#btn-night-start').addEventListener('click', startNight);
  $('#btn-night-stop').addEventListener('click', stopNight);
  $('#btn-night-done').addEventListener('click', () => { $('#night-result').hidden = true; $('#night-intro').hidden = false; });

  $$('input[name="hist-filter"]').forEach((i) => i.addEventListener('change', () => { historyLimit = 15; renderHistoryList(); }));
  $('#btn-more').addEventListener('click', () => { historyLimit += 30; renderHistoryList(); });
  $$('input[name="trend-metric"]').forEach((i) => i.addEventListener('change', renderTrends));
  $('#btn-export').addEventListener('click', exportAll);
  $('#btn-export-days').addEventListener('click', exportDays);
  $('#btn-clear').addEventListener('click', async () => {
    if (await confirmDialog('Alles verwijderen?', 'Al je metingen, nachten, trainingen, dagtotalen en dagboeknotities worden definitief van dit toestel verwijderd.')) {
      await db.clear(); await loadDay(); toast('Alles verwijderd.'); renderTrends();
    }
  });

  initSettings();
  $('#btn-onboarding').addEventListener('click', openOnboarding);
  $('#btn-sample').addEventListener('click', toggleSampleData);
  $('#ob-next').addEventListener('click', () => { if (obStep < OB_STEPS.length - 1) { obStep++; renderOb(); } else closeOnboarding(); });
  $('#ob-skip').addEventListener('click', closeOnboarding);
  $('#onboarding').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOnboarding(); });

  window.addEventListener('hashchange', route);
  window.addEventListener('resize', () => { liveChart.draw(); if (currentTab === 'trends') renderTrends(); });
  await refreshData();
  currentTab = null;
  route();
  onStatus({ status: 'idle' });
  if (!settings.onboarded) openOnboarding();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
