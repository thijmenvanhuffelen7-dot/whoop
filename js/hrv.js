// HRV-berekeningen op RR-intervallen (ms).

/**
 * Filtert artefacten:
 *  - RR buiten [min, max] ms
 *  - RR die meer dan maxDev (fractie) afwijkt van het vorige interval
 * Opvolgende verschillen worden alleen berekend tussen twee behouden
 * intervallen die in de ruwe reeks direct na elkaar kwamen.
 */
export function filterRR(rr, { min = 300, max = 2000, maxDev = 0.2 } = {}) {
  const kept = [];
  const diffs = [];
  const flags = [];      // per ruw interval: behouden ja/nee
  let removed = 0;
  let prev = null;       // vorige (plausibele) ruwe interval
  let prevKept = false;

  for (const x of rr) {
    const inRange = x >= min && x <= max;
    let ok = inRange;
    if (ok && prev != null && Math.abs(x - prev) / prev > maxDev) ok = false;

    if (ok) {
      if (prevKept) diffs.push(x - kept[kept.length - 1]);
      kept.push(x);
    } else {
      removed++;
    }
    flags.push(ok);
    prevKept = ok;
    prev = inRange ? x : null;
  }
  return { kept, diffs, flags, removed, total: rr.length };
}

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

export function rmssd(diffs) {
  if (diffs.length < 2) return null;
  return Math.sqrt(mean(diffs.map((d) => d * d)));
}

export function sdnn(rr) {
  if (rr.length < 3) return null;
  const m = mean(rr);
  return Math.sqrt(rr.reduce((s, x) => s + (x - m) ** 2, 0) / (rr.length - 1));
}

/** Volledige analyse van een reeks ruwe RR-intervallen. */
export function analyze(rawRR, opts) {
  const f = filterRR(rawRR, opts);
  const r = rmssd(f.diffs);
  const meanRR = f.kept.length ? mean(f.kept) : null;
  return {
    rmssd: r,
    lnRmssd: r ? Math.log(r) : null,
    sdnn: sdnn(f.kept),
    meanHr: meanRR ? 60000 / meanRR : null,
    beats: f.kept.length,
    removed: f.removed,
    total: f.total,
  };
}
