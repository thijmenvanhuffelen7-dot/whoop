// Lichte canvas-grafieken zonder externe bibliotheken.

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function setup(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function smoothPath(ctx, pts) {
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last.x, last.y);
}

/** Scrollende hartslaggrafiek over een vast tijdvenster. */
export class LiveChart {
  constructor(canvas, { windowMs = 60000, minSpan = 20 } = {}) {
    this.canvas = canvas;
    this.windowMs = windowMs;
    this.minSpan = minSpan;
    this.points = [];
    this.color = '--zone-0';
    this.running = false;
    this.yMin = null; this.yMax = null;
    this._frame = this._frame.bind(this);
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)');
  }

  push(t, v) {
    this.points.push({ t, v });
    const cut = t - this.windowMs - 4000;
    while (this.points.length && this.points[0].t < cut) this.points.shift();
    if (this.reduced.matches || !this.running) this.draw();
  }

  clear() { this.points = []; this.yMin = this.yMax = null; this.draw(); }

  start() {
    if (this.running) return;
    this.running = true;
    if (!this.reduced.matches) requestAnimationFrame(this._frame);
  }
  stop() { this.running = false; }

  _frame() {
    if (!this.running) return;
    this.draw();
    if (!this.reduced.matches) requestAnimationFrame(this._frame);
  }

  draw() {
    const { ctx, w, h } = setup(this.canvas);
    if (!w || !h) return;
    const padL = 4, padR = 34, padT = 10, padB = 10;
    const now = this.reduced.matches || !this.points.length
      ? (this.points.at?.(-1)?.t ?? performance.now())
      : Math.max(performance.now() - 1000, this.points[this.points.length - 1].t - 1000);
    const t0 = now - this.windowMs;
    const vis = this.points.filter((p) => p.t >= t0 - 2000);

    // Y-bereik vloeiend aanpassen
    let lo = 50, hi = 90;
    if (vis.length) {
      lo = Math.min(...vis.map((p) => p.v));
      hi = Math.max(...vis.map((p) => p.v));
      const mid = (lo + hi) / 2;
      const span = Math.max(hi - lo + 8, this.minSpan);
      lo = mid - span / 2; hi = mid + span / 2;
    }
    const k = this.yMin == null ? 1 : 0.08;
    this.yMin = this.yMin == null ? lo : this.yMin + (lo - this.yMin) * k;
    this.yMax = this.yMax == null ? hi : this.yMax + (hi - this.yMax) * k;

    const x = (t) => padL + ((t - t0) / this.windowMs) * (w - padL - padR);
    const y = (v) => padT + (1 - (v - this.yMin) / (this.yMax - this.yMin)) * (h - padT - padB);

    // Rasterlijnen
    ctx.strokeStyle = css('--grid');
    ctx.fillStyle = css('--muted');
    ctx.font = '11px ' + css('--font');
    ctx.lineWidth = 1;
    const step = niceStep(this.yMax - this.yMin);
    for (let v = Math.ceil(this.yMin / step) * step; v <= this.yMax; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR + 4, yy); ctx.stroke();
      ctx.fillText(String(Math.round(v)), w - padR + 8, yy + 4);
    }

    if (vis.length < 2) return;
    const pts = vis.map((p) => ({ x: x(p.t), y: y(p.v) }));
    const color = css(this.color) || css('--accent');

    ctx.save();
    ctx.beginPath(); ctx.rect(padL, 0, w - padL - padR, h); ctx.clip();
    // Vulling
    const grad = ctx.createLinearGradient(0, padT, 0, h);
    grad.addColorStop(0, hexA(color, 0.28));
    grad.addColorStop(1, hexA(color, 0));
    ctx.beginPath(); smoothPath(ctx, pts);
    ctx.lineTo(pts[pts.length - 1].x, h); ctx.lineTo(pts[0].x, h); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();
    // Lijn
    ctx.beginPath(); smoothPath(ctx, pts);
    ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();
    // Laatste punt
    const lp = pts[pts.length - 1];
    if (lp.x <= w - padR + 1) {
      ctx.beginPath(); ctx.arc(lp.x, lp.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill();
    }
  }
}

/** Eenvoudige sparkline. */
export function drawSparkline(canvas, values, colorVar = '--accent') {
  const { ctx, w, h } = setup(canvas);
  if (values.length < 2) return;
  const lo = Math.min(...values) - 2, hi = Math.max(...values) + 2;
  const pts = values.map((v, i) => ({ x: 2 + (i / (values.length - 1)) * (w - 4), y: 4 + (1 - (v - lo) / (hi - lo)) * (h - 8) }));
  ctx.beginPath(); smoothPath(ctx, pts);
  ctx.strokeStyle = css(colorVar); ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
}

/** Trendgrafiek: punten per meting + lijn van het 7-daags gemiddelde. */
export function drawTrend(canvas, points, { days = 30 } = {}) {
  const { ctx, w, h } = setup(canvas);
  if (!points.length) return;
  const padL = 4, padR = 34, padT = 12, padB = 24;
  const end = startOfDay(Date.now()) + 86400000;
  const start = end - days * 86400000;
  const vals = points.map((p) => p.value);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const span = Math.max(hi - lo, 10);
  lo = Math.max(0, lo - span * 0.2); hi = hi + span * 0.2;

  const x = (t) => padL + ((t - start) / (end - start)) * (w - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);

  ctx.strokeStyle = css('--grid'); ctx.fillStyle = css('--muted');
  ctx.font = '11px ' + css('--font'); ctx.lineWidth = 1;
  const step = niceStep(hi - lo);
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    const yy = Math.round(y(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR + 4, yy); ctx.stroke();
    ctx.fillText(String(Math.round(v)), w - padR + 8, yy + 4);
  }
  const fmt = new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'short' });
  [start + 86400000, start + (end - start) / 2, end - 86400000].forEach((t, i) => {
    const label = fmt.format(new Date(t));
    const tw = ctx.measureText(label).width;
    const xx = i === 0 ? padL : i === 1 ? x(t) - tw / 2 : w - padR - tw;
    ctx.fillText(label, xx, h - 6);
  });

  const accent = css('--accent');
  // 7-daags voortschrijdend gemiddelde
  const sorted = [...points].sort((a, b) => a.date - b.date);
  const avg = sorted.map((p) => {
    const win = sorted.filter((q) => q.date <= p.date && q.date > p.date - 7 * 86400000);
    return { x: x(p.date), y: y(win.reduce((s, q) => s + q.value, 0) / win.length) };
  });
  if (avg.length > 1) {
    ctx.beginPath(); smoothPath(ctx, avg);
    ctx.strokeStyle = hexA(accent, 0.9); ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.stroke();
  }
  for (const p of sorted) {
    ctx.beginPath(); ctx.arc(x(p.date), y(p.value), 3.5, 0, Math.PI * 2);
    ctx.fillStyle = hexA(accent, 0.45); ctx.fill();
  }
}

function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
function niceStep(range) {
  const raw = range / 3;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * mag;
}
function hexA(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Hypnogram: fases per minuut (0 wakker, 1 licht, 2 diep, 3 REM, -1 geen data). */
export function drawHypnogram(canvas, stages, startTime) {
  const { ctx, w, h } = setup(canvas);
  if (!stages.length) return;
  const rows = [0, 3, 1, 2]; // van boven naar beneden: wakker, REM, licht, diep
  const labels = ['Wakker', 'REM', 'Licht', 'Diep'];
  const colors = { 0: css('--st-wake'), 1: css('--st-light'), 2: css('--st-deep'), 3: css('--st-rem') };
  const padL = 52, padR = 6, padT = 6, padB = 22;
  const rowH = (h - padT - padB) / 4;
  const x = (i) => padL + (i / stages.length) * (w - padL - padR);
  ctx.font = '11px ' + css('--font');
  ctx.fillStyle = css('--muted');
  ctx.strokeStyle = css('--grid');
  rows.forEach((s, r) => {
    const y = padT + r * rowH;
    ctx.fillText(labels[r], 0, y + rowH / 2 + 4);
    ctx.beginPath(); ctx.moveTo(padL, Math.round(y + rowH) + 0.5); ctx.lineTo(w - padR, Math.round(y + rowH) + 0.5); ctx.stroke();
  });
  // Blokken per aaneengesloten fase
  let i = 0;
  while (i < stages.length) {
    const s = stages[i];
    let j = i;
    while (j < stages.length && stages[j] === s) j++;
    if (s >= 0) {
      const r = rows.indexOf(s);
      ctx.fillStyle = colors[s];
      const y = padT + r * rowH + rowH * 0.18;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x(i), y, Math.max(1.5, x(j) - x(i)), rowH * 0.64, 3); else ctx.rect(x(i), y, Math.max(1.5, x(j) - x(i)), rowH * 0.64);
      ctx.fill();
    }
    i = j;
  }
  // Tijdlabels
  ctx.fillStyle = css('--muted');
  const fmt = new Intl.DateTimeFormat('nl-NL', { hour: '2-digit', minute: '2-digit' });
  const ticks = 4;
  for (let k = 0; k <= ticks; k++) {
    const idx = Math.round((k / ticks) * stages.length);
    const label = fmt.format(new Date(startTime + idx * 60000));
    const tw = ctx.measureText(label).width;
    ctx.fillText(label, clampX(x(idx) - tw / 2, padL, w - padR - tw), h - 6);
  }
}
function clampX(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
