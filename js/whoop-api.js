// Koppeling met de officiële WHOOP-API via je eigen (gratis) proxy.
// Tokens blijven op dit toestel (localStorage). De proxy bewaart niets.
import { db } from './db.js';
import { dayKey } from './metrics.js';

const TOKENS_KEY = 'whoop.tokens';
const SYNC_KEY = 'whoop.lastSync';
const STATE_KEY = 'whoop.oauthState';

export function proxyBase(settings) {
  if (settings.whoopProxy) return settings.whoopProxy.replace(/\/+$/, '');
  if (/\.netlify\.app$/.test(location.hostname)) return `${location.origin}/api/whoop`;
  return '';
}

const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const write = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} };

export const isConnected = () => !!read(TOKENS_KEY)?.refresh_token || !!read(TOKENS_KEY)?.access_token;
export const lastSync = () => read(SYNC_KEY);
export function disconnect() { write(TOKENS_KEY, null); write(SYNC_KEY, null); }

export function startLogin(settings) {
  const base = proxyBase(settings);
  if (!base) throw new Error('Vul eerst het adres van je WHOOP-proxy in.');
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  const state = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  try { sessionStorage.setItem(STATE_KEY, state); } catch {}
  write(STATE_KEY, state); // terugval als sessionStorage niet bewaard blijft
  location.href = `${base}/login?state=${encodeURIComponent(state)}`;
}

/** Verwerkt #whoop=… of #whoop-error=… na het inloggen. Geeft 'ok', een foutmelding of null. */
export function handleRedirect() {
  const h = location.hash;
  if (h.startsWith('#whoop-error=')) {
    history.replaceState(null, '', `${location.pathname}#settings`);
    return decodeURIComponent(h.slice(13)) === 'access_denied' ? 'Je hebt geen toestemming gegeven.' : 'Inloggen bij WHOOP is mislukt.';
  }
  if (!h.startsWith('#whoop=')) return null;
  history.replaceState(null, '', `${location.pathname}#settings`);
  try {
    const b64 = h.slice(7).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
    const data = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    let expected = null;
    try { expected = sessionStorage.getItem(STATE_KEY); } catch {}
    expected = expected || read(STATE_KEY);
    write(STATE_KEY, null);
    if (!expected || data.state !== expected) return 'Beveiligingscontrole mislukt. Probeer opnieuw te koppelen.';
    saveTokens(data);
    return 'ok';
  } catch {
    return 'Het antwoord van WHOOP kon niet worden gelezen.';
  }
}

function saveTokens(t) {
  const old = read(TOKENS_KEY) || {};
  write(TOKENS_KEY, {
    access_token: t.access_token,
    refresh_token: t.refresh_token || old.refresh_token,
    expiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000,
  });
}

async function refresh(base) {
  const t = read(TOKENS_KEY);
  if (!t?.refresh_token) throw Object.assign(new Error('Opnieuw inloggen nodig'), { code: 'AUTH' });
  const res = await fetch(`${base}/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: t.refresh_token }) });
  if (!res.ok) { if (res.status < 500) disconnect(); throw Object.assign(new Error('Opnieuw inloggen nodig'), { code: 'AUTH' }); }
  saveTokens(await res.json());
}

async function api(base, path, params = {}, retried = false) {
  let t = read(TOKENS_KEY);
  if (!t) throw Object.assign(new Error('Niet gekoppeld'), { code: 'AUTH' });
  if (!t.access_token || t.expiresAt - 60000 < Date.now()) { await refresh(base); t = read(TOKENS_KEY); }
  const q = new URLSearchParams({ path, ...params });
  const res = await fetch(`${base}/data?${q}`, { headers: { Authorization: `Bearer ${t.access_token}` } });
  if (res.status === 401 && !retried) { await refresh(base); return api(base, path, params, true); }
  if (res.status === 429) throw new Error('WHOOP vraagt even te wachten (te veel verzoeken). Probeer het later opnieuw.');
  if (!res.ok) throw new Error(`WHOOP gaf een fout (${res.status}).`);
  return res.json();
}

async function collect(base, path, start, maxPages = 12) {
  const out = [];
  let nextToken;
  for (let i = 0; i < maxPages; i++) {
    const page = await api(base, path, { limit: '25', start, ...(nextToken ? { nextToken } : {}) });
    out.push(...(page.records || []));
    nextToken = page.next_token || page.nextToken;
    if (!nextToken) break;
  }
  return out;
}

const SPORTS = {
  running: 'Hardlopen', cycling: 'Fietsen', 'weightlifting': 'Krachttraining', 'functional fitness': 'Krachttraining',
  walking: 'Wandelen', hiit: 'HIIT', swimming: 'Zwemmen', yoga: 'Yoga', soccer: 'Teamsport', basketball: 'Teamsport',
};
const ms2min = (v) => (v == null ? null : v / 60000);

/**
 * Haalt slaap, herstel, cycli (inspanning) en trainingen op sinds de laatste sync
 * (eerste keer: 30 dagen) en slaat ze lokaal op. Geeft een samenvatting terug.
 */
export async function sync(settings, { mergeDay } = {}) {
  const base = proxyBase(settings);
  if (!base) throw new Error('Geen proxy-adres ingesteld.');
  const since = lastSync() ? lastSync() - 3 * 86400000 : Date.now() - 30 * 86400000;
  const start = new Date(since).toISOString();

  const [sleeps, recoveries, cycles, workouts] = await Promise.all([
    collect(base, '/v2/activity/sleep', start),
    collect(base, '/v2/recovery', start),
    collect(base, '/v2/cycle', start),
    collect(base, '/v2/activity/workout', start),
  ]);
  let body = null;
  try { body = await api(base, '/v2/user/measurement/body'); } catch {}

  // Bestaande WHOOP-records vinden, zodat we bijwerken in plaats van dubbel toevoegen
  const existing = new Map((await db.all()).filter((r) => r.whoopId).map((r) => [r.whoopId, r.id]));
  const upsert = (rec) => db.put(existing.has(rec.whoopId) ? { ...rec, id: existing.get(rec.whoopId) } : rec);

  const recBySleep = new Map(recoveries.filter((r) => r.sleep_id).map((r) => [r.sleep_id, r]));
  let nNights = 0, nWorkouts = 0, nDays = 0;

  for (const s of sleeps) {
    if (s.score_state !== 'SCORED' || !s.score) continue;
    const st = s.score.stage_summary || {};
    const need = s.score.sleep_needed || {};
    const startT = Date.parse(s.start), endT = Date.parse(s.end);
    const light = ms2min(st.total_light_sleep_time_milli) || 0;
    const deep = ms2min(st.total_slow_wave_sleep_time_milli) || 0;
    const rem = ms2min(st.total_rem_sleep_time_milli) || 0;
    const r = recBySleep.get(s.id);
    const rs = r?.score_state === 'SCORED' ? r.score : null;
    await upsert({
      type: 'night', source: 'whoop', whoopId: `sleep:${s.id}`, nap: !!s.nap,
      date: startT, duration: (endT - startT) / 1000,
      sleepHours: (light + deep + rem) / 60,
      lightMin: light, deepMin: deep, remMin: rem,
      wakeMin: ms2min(st.total_awake_time_milli) || 0, unknownMin: ms2min(st.total_no_data_time_milli) || 0,
      awakenings: st.disturbance_count, cycles: st.sleep_cycle_count,
      efficiency: s.score.sleep_efficiency_percentage != null ? s.score.sleep_efficiency_percentage / 100 : null,
      performance: s.score.sleep_performance_percentage, consistency: s.score.sleep_consistency_percentage,
      need: ['baseline_milli', 'need_from_sleep_debt_milli', 'need_from_recent_strain_milli', 'need_from_recent_nap_milli']
        .reduce((sum, k) => sum + (need[k] || 0), 0) / 3600000 || null,
      respRate: s.score.respiratory_rate,
      rmssd: rs?.hrv_rmssd_milli ?? null, minHr: rs?.resting_heart_rate ?? null,
      recoveryScore: rs?.recovery_score ?? null, calibrating: rs?.user_calibrating ?? null,
      spo2: rs?.spo2_percentage ?? null, skinTemp: rs?.skin_temp_celsius ?? null,
      samples: [], rr: [],
    });
    nNights++;
  }

  for (const w of workouts) {
    if (w.score_state !== 'SCORED' || !w.score) continue;
    const sc = w.score, z = sc.zone_durations || {};
    const startT = Date.parse(w.start), endT = Date.parse(w.end);
    const name = (w.sport_name || '').toLowerCase();
    await upsert({
      type: 'session', source: 'whoop', whoopId: `workout:${w.id}`,
      activity: SPORTS[name] || (w.sport_name ? w.sport_name[0].toUpperCase() + w.sport_name.slice(1) : 'Overig'),
      date: startT, duration: (endT - startT) / 1000,
      strain: sc.strain, kcal: sc.kilojoule != null ? sc.kilojoule / 4.184 : null,
      meanHr: sc.average_heart_rate, maxHr: sc.max_heart_rate, minHr: null,
      zoneSec: ['zero', 'one', 'two', 'three', 'four', 'five'].map((k) => (z[`zone_${k}_milli`] || 0) / 1000),
      distance: sc.distance_meter ?? null, samples: [], rr: [],
    });
    nWorkouts++;
  }

  for (const c of cycles) {
    if (c.score_state !== 'SCORED' || !c.score) continue;
    const key = dayKey(Date.parse(c.start) + 6 * 3600000); // cyclus begint 's avonds/'s nachts: hoort bij de dag erna
    await mergeDay?.(key, {
      whoopStrain: c.score.strain,
      whoopKcal: c.score.kilojoule != null ? c.score.kilojoule / 4.184 : null,
      whoopAvgHr: c.score.average_heart_rate, whoopMaxHr: c.score.max_heart_rate,
    });
    nDays++;
  }

  write(SYNC_KEY, Date.now());
  return {
    nights: nNights, workouts: nWorkouts, days: nDays,
    body: body ? { maxHr: body.max_heart_rate, weight: body.weight_kilogram, height: body.height_meter ? Math.round(body.height_meter * 100) : null } : null,
  };
}
