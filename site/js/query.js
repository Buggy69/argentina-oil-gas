/* ===========================================================================
   THE QUERY SEAM.

   Every view in this application asks for data through `query(spec)` and
   through nothing else. No view touches the Parquet reader, the typed arrays,
   or any URL. That rule exists for one reason: the data will not always live
   in files next to the page.

   Today `query()` compiles a spec against in-memory columns. The day the data
   moves into a real database, the same spec compiles to SQL and is posted to
   an endpoint — and not one view changes, because a view never knew where the
   rows came from.

   A *structured* spec rather than a SQL string is the deliberate choice here.
   A SQL string would leak one engine's dialect into every view and would have
   to be re-parsed to be re-targeted. A spec is data: it can be validated,
   cached by key, sent over a wire, or compiled to whatever the backend speaks.

   SPEC SHAPE
   ----------
     {
       source:   'cube' | 'wells' | 'typecurve',
       filters:  { column: [allowed values] | {min, max} },
       groupBy:  ['column', …],          // omit for a grand total
       measures: [{ as, col, agg }],     // agg: sum | mean | count | countDistinct
       orderBy:  'measureName',
       limit:    number,
     }
   =========================================================================== */

const registry = new Map();

/** Called once at boot; makes a loaded Table addressable by name. */
export function registerSource(name, table) { registry.set(name, table); }
export function getSource(name) {
  const t = registry.get(name);
  if (!t) throw new Error(`source "${name}" is not loaded`);
  return t;
}

/**
 * Build a row mask for a set of filters.
 *
 * Categorical filters are resolved to integer code sets *once*, before the
 * scan, so the inner loop compares integers rather than strings. A filter
 * naming a value that does not exist in this table yields an empty set, which
 * correctly matches nothing.
 */
/**
 * Which of these filters this source cannot honour.
 *
 * This exists because the alternative is silent wrongness. A filter naming a
 * column the table does not have used to be skipped quietly, so selecting a
 * concession and watching a national time series not move looked like "this
 * block is most of the basin" rather than "that filter did nothing". Callers ask
 * this first and tell the user, or route to a source that does have the column.
 */
export function unsupportedFilters(source, filters = {}) {
  const table = getSource(source);
  return Object.entries(filters)
    .filter(([name, sel]) =>
      sel != null && (!Array.isArray(sel) || sel.length > 0) && !table.cols[name])
    .map(([name]) => name);
}

/**
 * Selected values that exist in the filter bar but not in this source.
 *
 * The subtler sibling of the above, and the one that actually bit: the column
 * was present, the *value* was not, so the filter matched zero rows and the
 * chart came out blank with no explanation. That happened because the filter
 * lists are built from the well table while the charts read a cube, and the cube
 * used to fold rare operators into "Other". The caps are gone, but the check
 * stays — it is cheap, and it turns a future regression of that class into a
 * visible message instead of an empty canvas.
 */
export function unmatchedValues(source, filters = {}) {
  const table = getSource(source);
  const out = {};
  for (const [name, sel] of Object.entries(filters)) {
    if (!Array.isArray(sel) || !sel.length) continue;
    const col = table.cols[name];
    if (!col || col.kind !== 'cat') continue;
    const missing = sel.filter(v => !col.dict.includes(String(v)));
    if (missing.length) out[name] = missing;
  }
  return out;
}

export function buildMask(table, filters = {}) {
  const n = table.n;
  const mask = new Uint8Array(n).fill(1);

  for (const [name, sel] of Object.entries(filters)) {
    if (sel == null) continue;
    if (Array.isArray(sel)) {
      if (sel.length === 0) continue;           // empty selection = no constraint
      const col = table.cols[name];
      if (!col) {
        // Not a dimension of this source. Loud in development, because a
        // silently-ignored filter shows plausible-looking wrong numbers.
        console.warn(`[query] filter "${name}" ignored: not a column of this `
          + `source. Use unsupportedFilters() to surface this to the user.`);
        continue;
      }
      if (col.kind !== 'cat') continue;
      const allowed = new Set();
      for (const v of sel) {
        const k = col.dict.indexOf(String(v));
        if (k >= 0) allowed.add(k);
      }
      const codes = col.codes;
      for (let i = 0; i < n; i++) if (mask[i] && !allowed.has(codes[i])) mask[i] = 0;
    } else if (typeof sel === 'object') {
      const col = table.cols[name];
      if (!col) continue;
      const v = col.kind === 'date' ? col.values : col.values;
      const lo = sel.min ?? -Infinity, hi = sel.max ?? Infinity;
      // NaN fails every comparison, so a null value is excluded from a range
      // filter automatically — which is the correct behaviour: "unknown depth"
      // is not "depth between 1000 and 2000".
      for (let i = 0; i < n; i++) if (mask[i] && !(v[i] >= lo && v[i] <= hi)) mask[i] = 0;
    }
  }
  return mask;
}

/** Key for one group: the concatenated codes of its groupBy columns. */
function groupKey(cols, i) {
  let k = '';
  for (let c = 0; c < cols.length; c++) {
    const col = cols[c];
    k += (col.kind === 'cat' ? col.codes[i] : col.values[i]) + '';
  }
  return k;
}

/**
 * Run a spec. Returns plain row objects — small enough to hand to a chart,
 * because a grouped result is orders of magnitude smaller than its input.
 */
export function query(spec) {
  const table = getSource(spec.source);
  const mask = buildMask(table, spec.filters);
  const groupBy = spec.groupBy || [];
  const measures = spec.measures || [];
  const gcols = groupBy.map(name => table.col(name));

  // Accumulator per group. `distinct` sets are only allocated for measures that
  // ask for them — countDistinct over 296 k rows is the one genuinely
  // expensive aggregate here, so it is never paid for by accident.
  const groups = new Map();
  const n = table.n;

  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const key = groupBy.length ? groupKey(gcols, i) : '';
    let g = groups.get(key);
    if (!g) {
      g = { _i: i, sums: new Float64Array(measures.length),
            counts: new Int32Array(measures.length), sets: [] };
      for (let m = 0; m < measures.length; m++) {
        g.sets.push(measures[m].agg === 'countDistinct' ? new Set() : null);
      }
      groups.set(key, g);
    }
    for (let m = 0; m < measures.length; m++) {
      const spec_m = measures[m];
      if (spec_m.agg === 'count') { g.counts[m]++; continue; }
      const col = table.cols[spec_m.col];
      if (!col) continue;
      const v = col.kind === 'cat' ? col.codes[i] : col.values[i];
      if (spec_m.agg === 'countDistinct') { g.sets[m].add(v); continue; }
      if (Number.isNaN(v)) continue;   // nulls do not participate in sum/mean
      g.sums[m] += v;
      g.counts[m]++;
    }
  }

  const rows = [];
  for (const g of groups.values()) {
    const row = {};
    for (let c = 0; c < groupBy.length; c++) {
      const col = gcols[c];
      row[groupBy[c]] = col.kind === 'cat'
        ? (col.codes[g._i] >= 0 ? col.dict[col.codes[g._i]] : null)
        : col.values[g._i];
    }
    for (let m = 0; m < measures.length; m++) {
      const spec_m = measures[m];
      row[spec_m.as] =
        spec_m.agg === 'count' ? g.counts[m]
        : spec_m.agg === 'countDistinct' ? g.sets[m].size
        : spec_m.agg === 'mean' ? (g.counts[m] ? g.sums[m] / g.counts[m] : null)
        : g.sums[m];
    }
    rows.push(row);
  }

  if (spec.orderBy) {
    // Descending is the default, because every caller that orders is asking
    // "which are the biggest". (b - a) is descending; multiplying it by -1 for
    // 'desc' would invert it — which is exactly the bug this comment replaces,
    // and it silently turned "top 12 operators" into the bottom 12.
    const k = spec.orderBy, dir = spec.order === 'asc' ? -1 : 1;
    rows.sort((a, b) => dir * ((b[k] ?? -Infinity) - (a[k] ?? -Infinity)));
  }
  return spec.limit ? rows.slice(0, spec.limit) : rows;
}

/**
 * Row indices passing a filter — for views that need the underlying rows
 * (the map, the well table) rather than an aggregate.
 */
export function selectRows(source, filters) {
  const table = getSource(source);
  const mask = buildMask(table, filters);
  const idx = [];
  for (let i = 0; i < table.n; i++) if (mask[i]) idx.push(i);
  return idx;
}

/** Read a value out of a table at a row index, resolving dictionary codes. */
export function valueAt(table, name, i) {
  const col = table.cols[name];
  if (!col) return null;
  if (col.kind === 'cat') return col.codes[i] >= 0 ? col.dict[col.codes[i]] : null;
  const v = col.values[i];
  return Number.isNaN(v) ? null : v;
}
