/* ===========================================================================
   The in-browser columnar store.

   WHY COLUMNS AND NOT ROWS
   ------------------------
   The obvious way to hold 296 k cube rows in JavaScript is an array of 296 k
   objects. That costs roughly a hundred megabytes and makes the garbage
   collector do most of the work of every filter pass. Instead each column
   becomes one flat array:

     numbers      -> Float64Array          (contiguous, no boxing)
     categories   -> Int32Array of codes + a string dictionary

   A filter then reduces to integer comparisons over contiguous memory, which
   is why re-filtering the whole cube takes single-digit milliseconds rather
   than hundreds. It is the same reason the Parquet files on disk are columnar:
   the shape that makes a scan cheap is the same at both ends of the wire.

   WHY hyparquet
   -------------
   It reads Parquet in 58 KB of JavaScript, supports column projection (so we
   decode only the columns asked for) and can read a remote file through HTTP
   range requests. DuckDB-WASM would give real SQL but costs 34 MB of
   WebAssembly, which is the wrong trade for a page that must open quickly on
   a phone.
   =========================================================================== */

import { asyncBufferFromUrl, parquetRead } from '../vendor/hyparquet.mjs';
import { compressors } from '../vendor/hyparquet-compressors.mjs';

/** Milliseconds in a day — Parquet DATE columns are days since the epoch. */
const DAY_MS = 86400000;

/**
 * Turn whatever hyparquet hands back for a DATE column into a month index:
 * months elapsed since January 2006, the first month in the data.
 *
 * Integers compare and group far faster than Date objects or 'YYYY-MM'
 * strings, and every time axis in this dashboard is monthly, so nothing below
 * a month is ever needed.
 */
export const EPOCH_YEAR = 2006;
function toMonthIndex(v) {
  if (v == null) return -1;
  const d = v instanceof Date ? v : new Date(v * DAY_MS);
  return (d.getUTCFullYear() - EPOCH_YEAR) * 12 + d.getUTCMonth();
}
export function monthLabel(idx) {
  const y = EPOCH_YEAR + Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}
export function monthYear(idx) { return EPOCH_YEAR + Math.floor(idx / 12); }

/**
 * A loaded table: column name -> descriptor.
 *   { kind: 'num',  values: Float64Array }
 *   { kind: 'cat',  codes: Int32Array, dict: string[] }   // -1 = null
 *   { kind: 'date', values: Int32Array }                  // month index
 */
export class Table {
  constructor(n, cols) { this.n = n; this.cols = cols; }
  col(name) {
    const c = this.cols[name];
    if (!c) throw new Error(`no column "${name}" (have: ${Object.keys(this.cols)})`);
    return c;
  }
  /** Distinct values of a categorical column, with row counts, most common first. */
  domain(name) {
    const c = this.col(name);
    const counts = new Int32Array(c.dict.length);
    for (let i = 0; i < this.n; i++) { const k = c.codes[i]; if (k >= 0) counts[k]++; }
    return c.dict
      .map((value, i) => ({ value, count: counts[i] }))
      .filter(d => d.count > 0)
      .sort((a, b) => b.count - a.count);
  }
}

/**
 * Read a Parquet file into columnar form.
 *
 * `spec` maps column name -> 'num' | 'cat' | 'date'. Only the listed columns
 * are decoded; hyparquet skips the rest of the file's column chunks entirely,
 * which is why loading is proportional to what we use rather than to what the
 * file contains.
 */
export async function loadTable(url, spec, onProgress) {
  const names = Object.keys(spec);
  const file = await asyncBufferFromUrl({ url });

  // One read for all requested columns, delivered as arrays-of-values per row.
  // We transpose immediately and never retain the row arrays, so the peak
  // allocation is one row-group's worth rather than the whole table's.
  let n = 0;
  const cols = {};
  for (const name of names) {
    cols[name] = spec[name] === 'cat'
      ? { kind: 'cat', codes: null, dict: [], index: new Map() }
      : { kind: spec[name], values: null };
  }

  await parquetRead({
    file, compressors, columns: names, rowFormat: 'array',
    onComplete: (rows) => {
      n = rows.length;
      for (let c = 0; c < names.length; c++) {
        const name = names[c], kind = spec[name], col = cols[name];
        if (kind === 'cat') {
          const codes = new Int32Array(n);
          for (let i = 0; i < n; i++) {
            const v = rows[i][c];
            if (v == null) { codes[i] = -1; continue; }
            const s = String(v);
            let k = col.index.get(s);
            if (k === undefined) { k = col.dict.length; col.dict.push(s); col.index.set(s, k); }
            codes[i] = k;
          }
          col.codes = codes;
        } else if (kind === 'date') {
          const out = new Int32Array(n);
          for (let i = 0; i < n; i++) out[i] = toMonthIndex(rows[i][c]);
          col.values = out;
        } else {
          const out = new Float64Array(n);
          // NaN is the null marker for numbers: it propagates correctly through
          // arithmetic and is skipped by every aggregate here, whereas 0 would
          // silently become a real measurement.
          for (let i = 0; i < n; i++) {
            const v = rows[i][c];
            out[i] = (v == null) ? NaN : Number(v);
          }
          col.values = out;
        }
      }
      if (onProgress) onProgress(n);
    },
  });

  for (const name of names) if (cols[name].kind === 'cat') delete cols[name].index;
  return new Table(n, cols);
}

/** Fetch and parse JSON, with a useful error if the path is wrong. */
export async function loadJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/**
 * Tier C: one well's monthly history, read straight out of the yearly files
 * with HTTP range requests.
 *
 * The files are sorted by idpozo, so a given well's rows sit inside one or two
 * Parquet row groups. hyparquet reads the footer, uses the per-row-group
 * min/max statistics to decide which groups can possibly contain the well, and
 * fetches only those byte ranges. That is why this costs a few hundred
 * kilobytes instead of the 97 MB the full history occupies.
 */
export async function loadWellHistory(idpozo, years, base = 'data/monthly') {
  const out = [];
  await Promise.all(years.map(async (year) => {
    const file = await asyncBufferFromUrl({ url: `${base}/anio=${year}/data.parquet` });
    await parquetRead({
      file, compressors, rowFormat: 'object',
      columns: ['idpozo', 'fecha', 'oil_m3', 'gas_e3m3', 'water_m3'],
      onComplete: (rows) => {
        for (const r of rows) {
          if (Number(r.idpozo) !== idpozo) continue;
          out.push({
            month: toMonthIndex(r.fecha),
            oil: r.oil_m3 == null ? NaN : Number(r.oil_m3),
            gas: r.gas_e3m3 == null ? NaN : Number(r.gas_e3m3),
            water: r.water_m3 == null ? NaN : Number(r.water_m3),
          });
        }
      },
    });
  }));
  out.sort((a, b) => a.month - b.month);
  return out;
}
