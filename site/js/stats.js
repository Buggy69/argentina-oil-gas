/* ===========================================================================
   Descriptive statistics.

   Two conventions are fixed here and stated wherever a number is shown,
   because both are places where dashboards routinely mislead:

   1. **p10 is the LOW value.** The statistical convention, not the reserves
      one. p10 < p50 < p90 always. Anyone reading this against a reserves
      report needs to know which way round it runs, so the UI says so rather
      than assuming.

   2. **Nulls are not zeros.** The source distinguishes "no declaration filed"
      (null) from "declared zero production". Every function here skips nulls
      and reports `missing` separately, so a well shut in for six months does
      not drag a mean down as if it had produced nothing.
   =========================================================================== */

/** Sorted copy of the finite values only. */
function clean(values) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v != null && Number.isFinite(v)) out.push(v);
  }
  out.sort((a, b) => a - b);
  return out;
}

/** Linear-interpolated quantile of an already-sorted array. */
export function quantileSorted(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * The full descriptive set for one column.
 * `n` counts values that exist; `missing` counts those that do not.
 */
export function describe(values) {
  const s = clean(values);
  const n = s.length;
  const missing = values.length - n;
  if (!n) return { n: 0, missing, mean: null, sd: null, min: null, max: null,
                   p10: null, p25: null, p50: null, p75: null, p90: null, sum: 0 };

  let sum = 0;
  for (const v of s) sum += v;
  const mean = sum / n;

  // Two-pass variance. The one-pass "sum of squares minus square of sum" form
  // loses catastrophic precision when the mean is large relative to the spread
  // — which is exactly the case for cumulative production.
  let ss = 0;
  for (const v of s) { const d = v - mean; ss += d * d; }
  const sd = n > 1 ? Math.sqrt(ss / (n - 1)) : 0;

  return {
    n, missing, sum, mean, sd,
    min: s[0], max: s[n - 1],
    p10: quantileSorted(s, 0.10),
    p25: quantileSorted(s, 0.25),
    p50: quantileSorted(s, 0.50),
    p75: quantileSorted(s, 0.75),
    p90: quantileSorted(s, 0.90),
  };
}

/**
 * Histogram bins.
 *
 * Freedman–Diaconis by default: bin width = 2·IQR·n^(-1/3). It is driven by
 * the interquartile range rather than the full range, so a handful of enormous
 * Vaca Muerta wells cannot force every other well into a single bar — which is
 * exactly what Sturges' rule or a fixed bin count would do on this data.
 */
export function histogram(values, { log = false, maxBins = 60 } = {}) {
  let s = clean(values);
  if (log) s = s.filter(v => v > 0).map(Math.log10);
  if (s.length < 2) return { bins: [], width: 0 };

  const iqr = quantileSorted(s, 0.75) - quantileSorted(s, 0.25);
  const lo = s[0], hi = s[s.length - 1];
  let width = iqr > 0 ? 2 * iqr * Math.pow(s.length, -1 / 3) : (hi - lo) / 20;
  if (!(width > 0)) width = (hi - lo) / 20 || 1;
  let count = Math.ceil((hi - lo) / width);
  if (count > maxBins) { count = maxBins; width = (hi - lo) / count; }
  if (count < 1) count = 1;

  const bins = new Array(count).fill(0).map((_, i) => ({
    x0: lo + i * width, x1: lo + (i + 1) * width, n: 0,
  }));
  for (const v of s) {
    let k = Math.floor((v - lo) / width);
    if (k >= count) k = count - 1;
    if (k < 0) k = 0;
    bins[k].n++;
  }
  return { bins, width, log };
}

/**
 * Lorenz curve and Gini coefficient.
 *
 * Included because it answers the question this dataset provokes hardest: how
 * concentrated is production? A basin where 5% of wells make 60% of the oil
 * behaves nothing like one where the top 5% make 12%, and a mean hides the
 * difference completely.
 */
export function lorenz(values, points = 100) {
  const s = clean(values).filter(v => v > 0);
  if (s.length < 2) return { curve: [], gini: null, n: s.length };
  let total = 0;
  for (const v of s) total += v;

  const curve = [[0, 0]];
  let cum = 0, gini = 0;
  for (let i = 0; i < s.length; i++) {
    const prev = cum / total;
    cum += s[i];
    // Trapezoid under the Lorenz curve, accumulated as we go.
    gini += (prev + cum / total) / 2 * (1 / s.length);
    if (i % Math.max(1, Math.floor(s.length / points)) === 0 || i === s.length - 1) {
      curve.push([(i + 1) / s.length * 100, cum / total * 100]);
    }
  }
  return { curve, gini: 1 - 2 * gini, n: s.length };
}

/** Pearson correlation over pairwise-complete observations. */
export function pearson(xs, ys) {
  let n = 0, sx = 0, sy = 0;
  for (let i = 0; i < xs.length; i++) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) { n++; sx += xs[i]; sy += ys[i]; }
  }
  if (n < 3) return null;
  const mx = sx / n, my = sy / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) {
    if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) continue;
    const a = xs[i] - mx, b = ys[i] - my;
    sxy += a * b; sxx += a * a; syy += b * b;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/**
 * Spearman: Pearson on ranks, with ties averaged.
 *
 * Reported alongside Pearson rather than instead of it. Production and
 * completion variables here are heavily skewed, so a Pearson coefficient can
 * be dominated by a few giant wells while Spearman describes the bulk
 * behaviour. Showing only one of the two would be a choice about the answer.
 *
 * PERFORMANCE NOTE — this matters at 85 k wells. The obvious implementation
 * builds an array of [x, y] pairs and sorts it with a comparator that indexes
 * into those pairs. That allocates one small array per well per pair of
 * variables, and with 21 variable pairs it froze the tab outright. This version
 * copies into typed arrays once and sorts an Int32Array of indices, so nothing
 * is allocated per element and the sort comparator touches contiguous memory.
 */
function ranksInto(src, out) {
  const n = src.length;
  const idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  // Array.prototype.sort on a TypedArray sorts numerically by default, but we
  // need an index sort, so the comparator is explicit.
  const order = Array.prototype.sort.call(idx, (a, b) => src[a] - src[b]);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && src[order[j + 1]] === src[order[i]]) j++;
    const avg = (i + j) / 2 + 1;      // average rank across the tied block
    for (let k = i; k <= j; k++) out[order[k]] = avg;
    i = j + 1;
  }
  return out;
}

export function spearman(xs, ys) {
  const n = xs.length;
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) k++;
  }
  if (k < 3) return null;

  const x = new Float64Array(k), y = new Float64Array(k);
  let p = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) continue;
    x[p] = xs[i]; y[p] = ys[i]; p++;
  }
  // Ranked within the pairwise-complete subset, which is what Spearman is
  // defined over — ranking globally and then dropping incomplete pairs would
  // leave gaps in the rank sequence and bias the coefficient.
  const rx = ranksInto(x, new Float64Array(k));
  const ry = ranksInto(y, new Float64Array(k));
  return pearson(rx, ry);
}

/**
 * Full correlation matrix, computed once.
 *
 * Returns { pearson, spearman } as square arrays. Computing it here rather than
 * per table cell is the difference between 21 evaluations and 42 — and, more to
 * the point, stops a render loop from re-deriving the same coefficient every
 * time it draws a cell.
 */
export function correlationMatrix(series) {
  const m = series.length;
  const P = Array.from({ length: m }, () => new Array(m).fill(null));
  const S = Array.from({ length: m }, () => new Array(m).fill(null));
  for (let i = 0; i < m; i++) {
    P[i][i] = 1; S[i][i] = 1;
    for (let j = i + 1; j < m; j++) {
      const p = pearson(series[i], series[j]);
      const s = spearman(series[i], series[j]);
      P[i][j] = P[j][i] = p;
      S[i][j] = S[j][i] = s;
    }
  }
  return { pearson: P, spearman: S };
}

/** Share of the total held by the top `frac` of contributors, by value. */
export function topShare(values, frac = 0.05) {
  const s = clean(values).filter(v => v > 0).sort((a, b) => b - a);
  if (!s.length) return null;
  let total = 0;
  for (const v of s) total += v;
  const k = Math.max(1, Math.round(s.length * frac));
  let top = 0;
  for (let i = 0; i < k; i++) top += s[i];
  return { share: top / total * 100, wells: k, of: s.length };
}
