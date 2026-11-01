// Afgeleide maten uit hartslag en RR-intervallen.
// Dit zijn eigen benaderingen op basis van gepubliceerde methodes,
// niet de (geheime) algoritmes van WHOOP.
import { filterRR, rmssd } from './hrv.js';

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
export function sd(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
export function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/* ---------- Datum ---------- */
export function dayKey(t = Date.now()) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d + n, 12).getTime());
}

/* ---------- Zones & inspanning ---------- */
/** Zone 0–5 op basis van hartslagreserve (Karvonen). */
export function zoneIndex(hr, rest, max) {
  const pct = (hr - rest) / Math.max(1, max - rest);
  return pct < 0.5 ? 0 : pct < 0.6 ? 1 : pct < 0.7 ? 2 : pct < 0.8 ? 3 : pct < 0.9 ? 4 : 5;
}
/** Edwards-TRIMP-gewichten per zone (minuten × gewicht). Zone 0 telt minimaal mee. */
export const ZONE_WEIGHT = [0.03, 1, 2, 3, 4, 5];

/** Inspanning op een schaal van 0–21 uit TRIMP (logaritmisch afvlakkend). */
export function strainFromTrimp(trimp) {
  return 21 * (1 - Math.exp(-Math.max(0, trimp) / 180));
}

/** TRIMP, tijd per zone en kcal uit een reeks [tijd_s, hartslag]. */
export function workload(samples, profile) {
  const zoneSec = [0, 0, 0, 0, 0, 0];
  let trimp = 0, kcal = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = Math.min(5, samples[i][0] - samples[i - 1][0]);
    const hr = samples[i][1];
    if (!(dt > 0) || !hr) continue;
    const z = zoneIndex(hr, profile.rest, profile.max);
    zoneSec[z] += dt;
    trimp += (dt / 60) * ZONE_WEIGHT[z];
    kcal += (kcalPerMinute(hr, profile) * dt) / 60;
  }
  return { zoneSec, trimp, strain: strainFromTrimp(trimp), kcal };
}

/* ---------- Calorieën ---------- */
/** Ruststofwisseling (Mifflin-St Jeor), kcal/dag. */
export function bmr({ weight = 75, height = 178, age = 35, sex = 'x' }) {
  const base = 10 * weight + 6.25 * height - 5 * age;
  return sex === 'm' ? base + 5 : sex === 'v' ? base - 161 : base - 78;
}
/** kcal per minuut: Keytel e.a. (2005) bij inspanning, anders ruststofwisseling. */
export function kcalPerMinute(hr, p) {
  const w = p.weight || 75, a = p.age || 35;
  const male = (-55.0969 + 0.6309 * hr + 0.1988 * w + 0.2017 * a) / 4.184;
  const female = (-20.4022 + 0.4472 * hr - 0.1263 * w + 0.074 * a) / 4.184;
  const active = p.sex === 'm' ? male : p.sex === 'v' ? female : (male + female) / 2;
  const rest = bmr(p) / 1440;
  return Math.max(rest, active);
}

/* ---------- VO2max ---------- */
/** Uth–Sørensen: VO2max ≈ 15,3 × HRmax / HRrust (ml/kg/min). */
export function vo2max(maxHr, restHr) {
  if (!maxHr || !restHr) return null;
  return 15.3 * (maxHr / restHr);
}

/* ---------- Stress ---------- */
/** Stress 0–3 uit hartslag en live RMSSD t.o.v. je eigen basis. */
export function stressScore(hr, liveRmssd, { rest, max, baseRmssd }) {
  if (!hr) return null;
  const hrPart = clamp((hr - rest) / (0.3 * Math.max(1, max - rest)), 0, 1);
  if (liveRmssd && baseRmssd) {
    const hrvPart = clamp(1 - liveRmssd / baseRmssd, 0, 1);
    return 3 * (0.55 * hrPart + 0.45 * hrvPart);
  }
  return 3 * hrPart;
}
export const stressLabel = (s) => (s == null ? '–' : s < 1 ? 'Laag' : s < 2 ? 'Gemiddeld' : 'Hoog');

/* ---------- Ademfrequentie ---------- */
/**
 * Schat de ademfrequentie uit de respiratoire sinusaritmie in RR-intervallen:
 * herbemonsteren op 4 Hz, trend verwijderen, Hann-venster en het dominante
 * spectrale piekje tussen 0,1 en 0,5 Hz zoeken.
 */
export function respiratoryRate(rr) {
  const { kept } = filterRR(rr);
  if (kept.length < 40) return null;
  const t = []; let acc = 0;
  for (const x of kept) { acc += x / 1000; t.push(acc); }
  const fs = 4;
  const n = Math.floor((t[t.length - 1] - t[0]) * fs);
  if (n < 160) return null;
  const y = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const ti = t[0] + i / fs;
    while (j < t.length - 2 && t[j + 1] < ti) j++;
    const f = (ti - t[j]) / (t[j + 1] - t[j]);
    y[i] = kept[j] + f * (kept[j + 1] - kept[j]);
  }
  // Lineaire trend verwijderen
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += y[i]; sxx += i * i; sxy += i * y[i]; }
  const b = (n * sxy - sx * sy) / (n * sxx - sx * sx), a = (sy - b * sx) / n;
  for (let i = 0; i < n; i++) y[i] = (y[i] - (a + b * i)) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));

  let best = 0, bestF = null;
  for (let f = 0.1; f <= 0.5; f += 0.004) {
    let re = 0, im = 0;
    const w = (2 * Math.PI * f) / fs;
    for (let i = 0; i < n; i++) { re += y[i] * Math.cos(w * i); im += y[i] * Math.sin(w * i); }
    const p = re * re + im * im;
    if (p > best) { best = p; bestF = f; }
  }
  return bestF ? bestF * 60 : null;
}

/* ---------- Nachtanalyse ---------- */
/** Verdeelt RR in blokken van 5 minuten en berekent per blok RMSSD en hartslag. */
export function segmentNight(rr, segSec = 300) {
  const segs = [];
  let cur = [], acc = 0;
  for (const x of rr) {
    cur.push(x); acc += x;
    if (acc >= segSec * 1000) { segs.push(cur); cur = []; acc = 0; }
  }
  if (acc >= (segSec * 1000) / 2) segs.push(cur);
  return segs.map((s) => {
    const f = filterRR(s);
    const m = mean(f.kept);
    return { rmssd: rmssd(f.diffs), hr: m ? 60000 / m : null, rr: s };
  });
}

export function analyzeNight(rr) {
  const segs = segmentNight(rr).filter((s) => s.hr && s.rmssd);
  if (!segs.length) return null;
  const hrs = segs.map((s) => s.hr);
  // Gemiddelde over de rustigste helft van de nacht (laagste hartslag)
  const calm = [...segs].sort((a, b) => a.hr - b.hr).slice(0, Math.max(1, Math.ceil(segs.length / 2)));
  const resp = segs.filter((_, i) => i % 3 === 0).map((s) => respiratoryRate(s.rr)).filter(Boolean);
  return {
    minHr: Math.min(...hrs),
    meanHr: mean(hrs),
    rmssd: mean(calm.map((s) => s.rmssd)),
    respRate: median(resp),
    segments: segs.map((s) => [Math.round(s.hr * 10) / 10, Math.round(s.rmssd * 10) / 10]),
  };
}

/* ---------- Herstel ---------- */
/** Cumulatieve normale verdeling (benadering). */
const phi = (z) => 1 / (1 + Math.exp(-1.702 * z));

/**
 * Herstel 1–99 % uit ln(RMSSD) en rusthartslag t.o.v. je eigen basis
 * (vorige 30 dagen, zelfde soort meting), plus slaap t.o.v. je behoefte.
 */
export function recoveryScore(today, baseline, sleep) {
  const lnB = baseline.map((b) => Math.log(b.rmssd));
  const rhB = baseline.map((b) => b.rhr).filter(Boolean);
  if (lnB.length < 3) return { score: null, calibrating: lnB.length };
  const zHrv = (Math.log(today.rmssd) - mean(lnB)) / Math.max(0.12, sd(lnB) || 0);
  const zRhr = today.rhr && rhB.length >= 3 ? (mean(rhB) - today.rhr) / Math.max(1.5, sd(rhB) || 0) : 0;
  let zSleep = 0;
  if (sleep && sleep.hours && sleep.need) zSleep = clamp((sleep.hours - sleep.need) / 1, -2, 1);
  const z = clamp(0.65 * zHrv + 0.25 * zRhr + 0.1 * zSleep, -3, 3);
  return { score: clamp(Math.round(100 * phi(z + 0.2)), 1, 99), zHrv, zRhr, zSleep };
}
export const recoveryBand = (s) => (s == null ? null : s >= 67 ? 'groen' : s >= 34 ? 'geel' : 'rood');

/** Aanbevolen inspanningsbereik voor vandaag op basis van herstel. */
export function strainTarget(rec) {
  if (rec == null) return null;
  if (rec >= 67) return { lo: 14, hi: 18, text: 'Je lichaam is goed hersteld. Een stevige training kan vandaag.' };
  if (rec >= 34) return { lo: 10, hi: 14, text: 'Gemiddeld herstel. Train gerust, maar houd het gematigd.' };
  return { lo: 0, hi: 10, text: 'Laag herstel. Kies vandaag voor rust, wandelen of lichte beweging.' };
}

/** Slaapbehoefte (uren): basis + extra na inspanning + deel van recente slaapschuld. */
export function sleepNeed(base, strainToday, recentNights) {
  let need = base;
  if (strainToday > 10) need += (strainToday - 10) * 0.06;
  const debt = recentNights.slice(0, 3).reduce((s, n) => s + Math.max(0, n.need - n.hours), 0);
  need += Math.min(1.5, debt * 0.25);
  return need;
}
