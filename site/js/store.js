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

// Only parquetRead is needed now. The range-reading helpers
// (asyncBufferFromUrl, cachedAsyncBuffer, parquetMetadataAsync) were dropped
// with the year-sharded layout — see fetchBuffer below for why ranges are not
// usable on this host.
import { parquetRead, parquetMetadata } from '../vendor/hyparquet.mjs';
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

/**
 * Days-since-epoch to (year, month) with integer arithmetic only.
 *
 * The obvious `new Date(days * 86400000)` allocates an object per value, and
 * these columns have hundreds of thousands of values — 466 k across the cube
 * and the wells table, which measured as a large share of load time. This is
 * Howard Hinnant's civil-from-days algorithm: it shifts the epoch to 0000-03-01
 * so that the leap-day irregularity falls at the END of the year, which makes
 * the month a closed-form expression instead of a table lookup.
 */
function civilFromDays(z) {
  z += 719468;                                   // 1970-01-01 -> 0000-03-01 era
  const era = Math.floor(z / 146097);            // 146097 days = 400 years exactly
  const doe = z - era * 146097;                  // day of era, 0..146096
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);    // month index in the March-based year
  const m = mp + (mp < 10 ? 3 : -9);             // back to Jan=1
  return [y + (m <= 2 ? 1 : 0), m];
}

function toMonthIndex(v) {
  if (v == null) return -1;
  if (typeof v === 'number') {
    const [y, m] = civilFromDays(v);
    return (y - EPOCH_YEAR) * 12 + (m - 1);
  }
  // hyparquet hands back a Date for some encodings; honour it rather than
  // guessing at the underlying representation.
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
/**
 * Fetch a whole file into memory as an ArrayBuffer.
 *
 * WHY NOT asyncBufferFromUrl (which reads by HTTP range)
 * ------------------------------------------------------
 * GitHub Pages compresses `application/octet-stream` when the client accepts
 * gzip — which every browser does, and which `fetch()` cannot opt out of,
 * because `Accept-Encoding` is a forbidden header name the Fetch spec refuses
 * to let script set.
 *
 * When it compresses, it applies `Range` to the COMPRESSED stream:
 *
 *     Content-Range: bytes 0-1023/4618105     <- compressed total, not 4690132
 *
 * So a request for "the last 8 bytes" returns the last 8 bytes of the gzip
 * stream, the reader looks for the Parquet magic `PAR1` and finds noise, and
 * the whole file is declared invalid. Locally it all works, because a plain
 * dev server does not compress — which is exactly the kind of bug that only
 * exists in production.
 *
 * Fetching whole and letting the browser decode Content-Encoding transparently
 * sidesteps it entirely. These are files we read in full anyway, so nothing is
 * lost: gzip even makes the transfer slightly smaller.
 */
async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.arrayBuffer();
}

/**
 * Allocate the destination arrays for a column spec, at full row count.
 *
 * A spec entry is 'num' | 'cat' | 'date', or `{ labels: [...] }` for a column
 * already stored as integer codes — the labels come from a sidecar rather than
 * from the file, so nothing has to build a dictionary at all.
 */
function allocate(spec, n) {
  const cols = {};
  for (const name of Object.keys(spec)) {
    const kind = spec[name];
    if (kind && typeof kind === 'object' && kind.labels) {
      cols[name] = { kind: 'cat', codes: new Int32Array(n),
                     dict: kind.labels, coded: true };
    } else if (kind === 'cat') {
      cols[name] = { kind: 'cat', codes: new Int32Array(n), dict: [], index: new Map() };
    } else {
      cols[name] = { kind,
        values: kind === 'date' ? new Int32Array(n) : new Float64Array(n) };
    }
  }
  return cols;
}

async function decodeInto(file, spec, cols) {
  const names = Object.keys(spec);

  /* COLUMN CHUNKS, NOT ROWS.
   *
   * The first version asked for rowFormat:'array' and transposed in
   * onComplete. That is correct and it allocates one JavaScript array per row —
   * 296,154 of them for the cube, plus 85,417 for the wells table — which
   * measured 8.6 seconds of decoding before the page became usable.
   *
   * onChunk hands over one column's values for a slice of rows, which is how
   * the data is laid out on disk anyway. Values go straight into the
   * pre-allocated typed array at their row offset; no per-row object is ever
   * created, and the garbage collector has nothing to do. */
  await parquetRead({
    file, compressors, columns: names,
    onChunk: (chunk) => {
      const col = cols[chunk.columnName];
      if (!col) return;                       // a column we did not ask for
      const data = chunk.columnData;
      const start = Number(chunk.rowStart);
      const kind = col.kind;

      if (col.coded) {
        // Already integers in the file; the labels came from the sidecar.
        // This is the whole point of storing codes: a straight copy.
        const codes = col.codes;
        for (let i = 0; i < data.length; i++) {
          const v = data[i];
          codes[start + i] = (v == null) ? -1 : v;
        }
      } else if (kind === 'cat') {
        const { codes, dict, index } = col;
        for (let i = 0; i < data.length; i++) {
          const v = data[i];
          if (v == null) { codes[start + i] = -1; continue; }
          const s = String(v);
          let k = index.get(s);
          if (k === undefined) { k = dict.length; dict.push(s); index.set(s, k); }
          codes[start + i] = k;
        }
      } else if (kind === 'date') {
        const out = col.values;
        for (let i = 0; i < data.length; i++) out[start + i] = toMonthIndex(data[i]);
      } else {
        const out = col.values;
        // NaN is the null marker for numbers: it propagates correctly through
        // arithmetic and is skipped by every aggregate here, whereas 0 would
        // silently become a real measurement.
        for (let i = 0; i < data.length; i++) {
          const v = data[i];
          out[start + i] = (v == null) ? NaN : Number(v);
        }
      }
    },
  });

  // The string->code map is only needed while building; dropping it frees a
  // Map the size of each column's distinct-value count.
  for (const name of names) if (cols[name].index) delete cols[name].index;
  return cols;
}

export async function loadTable(url, spec, onProgress) {
  const file = await fetchBuffer(url);
  // Row count up front, straight from the footer, so every column array can be
  // allocated once at full size instead of grown.
  const n = Number(parquetMetadata(file).num_rows);
  const cols = allocate(spec, n);
  await decodeInto(file, spec, cols);
  if (onProgress) onProgress(n);
  return new Table(n, cols);
}

/**
 * Decode additional columns of the SAME file into a table already loaded.
 *
 * Decoding is the dominant cost of start-up, and most of `wells_slim`'s
 * columns are not needed to draw the first screen — nobody has opened the map
 * or the statistics page yet. Loading the handful the filter bar needs at boot
 * and the rest on first use moves that work out of the critical path.
 *
 * The file is fetched again rather than held in memory: the browser serves it
 * from cache, so this costs no network and keeps several megabytes of
 * ArrayBuffer from being retained for a page that may never need it.
 */
export async function extendTable(table, url, spec) {
  const missing = Object.fromEntries(
    Object.entries(spec).filter(([name]) => !table.cols[name]));
  if (!Object.keys(missing).length) return table;

  const file = await fetchBuffer(url);
  const cols = allocate(missing, table.n);
  await decodeInto(file, missing, cols);
  Object.assign(table.cols, cols);
  return table;
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
/** Must match BUCKETS in tools/04_build_web_data.py. */
export const WELL_BUCKETS = 256;

/**
 * One well's complete monthly history.
 *
 * Tier C is sharded by well: `data/wells/bucket=<idpozo % 256>/data.parquet`
 * holds the full history of every well in that bucket, so this is a single
 * whole-file GET of roughly half a megabyte — no range requests, and therefore
 * nothing for the host's gzip to corrupt (see fetchBuffer above for why that
 * matters).
 *
 * The bucket is fetched once and cached, because a reader comparing wells
 * usually opens several, and neighbouring ids share a bucket often enough to
 * make the second lookup free.
 */
const bucketCache = new Map();

export async function loadWellHistory(idpozo, base = 'data/wells') {
  const bucket = ((idpozo % WELL_BUCKETS) + WELL_BUCKETS) % WELL_BUCKETS;
  const url = `${base}/bucket=${bucket}/data.parquet`;

  let rowsPromise = bucketCache.get(url);
  if (!rowsPromise) {
    rowsPromise = (async () => {
      const file = await fetchBuffer(url);
      let all = [];
      await parquetRead({
        file, compressors, rowFormat: 'object',
        columns: ['idpozo', 'fecha', 'oil_m3', 'gas_e3m3', 'water_m3'],
        onComplete: (rows) => { all = rows; },
      });
      return all;
    })();
    bucketCache.set(url, rowsPromise);
  }

  const rows = await rowsPromise;
  const out = [];
  for (const r of rows) {
    if (Number(r.idpozo) !== idpozo) continue;
    out.push({
      month: toMonthIndex(r.fecha),
      oil: r.oil_m3 == null ? NaN : Number(r.oil_m3),
      gas: r.gas_e3m3 == null ? NaN : Number(r.gas_e3m3),
      water: r.water_m3 == null ? NaN : Number(r.water_m3),
    });
  }
  out.sort((a, b) => a.month - b.month);
  return out;
}
