/* ===========================================================================
   Units and number formatting.

   The source stores oil in m³ and gas in 10³ m³ (thousands of cubic metres —
   "Mm³" in Argentine usage, which trips up readers who expect millions). The
   dashboard offers oilfield units as a display-time conversion only: nothing
   is ever stored converted, so there is exactly one number of record and the
   toggle cannot introduce drift.

   The barrel factor is not a textbook constant. It was re-derived from the
   publisher's own redundant columns — monthly total, daily average and daily
   average in kbbl — in check 5 of the verification report, and comes out at
   6.28981 exactly.
   =========================================================================== */

import { EPOCH_YEAR } from './store.js?v=a9872ab70a';

export const M3_TO_BBL = 6.28981;      // oil:  1 m³   -> bbl
export const E3M3_TO_MCF = 35.3147;    // gas:  1 10³m³ -> Mcf

let oilfield = false;
export function setOilfieldUnits(on) { oilfield = !!on; }
export function usingOilfield() { return oilfield; }

/* Time basis of the production time series: daily rate (default) or the
   monthly volume the source actually stores.

   WHY DAILY IS THE DEFAULT: engineers quote production as a rate. A user read
   the Nov-2025 Neuquina shale bar — 2.75 M m³, a MONTH's volume — as m³ per
   day, converted it to 17 Mbbl/d and concluded the data was 17× Argentina's
   output. The data was right (577 kbbl/d); the axis said only "m³". Now every
   series axis states its time basis, and the default matches how people read. */
let dailyRate = true;
export function setDailyRate(on) { dailyRate = !!on; }
export function usingDailyRate() { return dailyRate; }

export const units = {
  oil:   () => (oilfield ? 'bbl' : 'm³'),
  gas:   () => (oilfield ? 'Mcf' : '10³ m³'),
  water: () => (oilfield ? 'bbl' : 'm³'),
  length: () => (oilfield ? 'ft' : 'm'),
  // Time-series units: the volume unit plus its time basis. Cumulative tiles,
  // tables and CSV totals are volumes and keep using the plain units above.
  oilSeries:   () => units.oil()   + (dailyRate ? '/d' : '/month'),
  gasSeries:   () => units.gas()   + (dailyRate ? '/d' : '/month'),
  waterSeries: () => units.water() + (dailyRate ? '/d' : '/month'),
  // The phrase the chart notes use, so a note and its axis can never disagree.
  seriesBasis: () => (dailyRate ? 'Daily average rate (monthly volume ÷ '
                      + 'calendar days of that month)' : 'Volume per month'),
};

/**
 * A monthly volume as the series should plot it: divided by the calendar
 * days of that month in rate mode, unchanged in volume mode.
 *
 * Calendar days, not the well's effective producing hours, because that is
 * how the publisher defines its own "promedio diario" column — and the
 * verification report's check 5 reproduces that column from the monthly
 * total this way. `monthIdx` counts months from January of EPOCH_YEAR, the
 * same index `monthLabel()` in store.js reads.
 */
export function perDay(v, monthIdx) {
  if (!dailyRate || v == null) return v;
  const y = EPOCH_YEAR + Math.floor(monthIdx / 12), m = monthIdx % 12;
  // Day 0 of the NEXT month is the last day of this one: its date is the
  // month's length, leap years included, with no table to maintain.
  return v / new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

/** Mean days per month (365.25 / 12) — for series with no calendar month,
 *  such as type curves plotted against months on production. */
export const MEAN_MONTH_DAYS = 30.4375;
export function perMeanDay(v) {
  return !dailyRate || v == null ? v : v / MEAN_MONTH_DAYS;
}

/**
 * Axis tick label. Like compact(), but with as many decimals as the tick
 * needs (up to 2, trailing zeros dropped).
 *
 * compact(v, 0) rounded 2.5 M to "3 M" and 1.5 M to "2 M", so an axis read
 * "3 M, 3 M, 2 M, 2 M, 1 M" — duplicate labels on distinct gridlines, which
 * made any value between them unreadable.
 */
export function axisNum(v) {
  if (v == null || Number.isNaN(v)) return '';
  const a = Math.abs(v);
  const trim = x => String(+x.toFixed(2));
  if (a >= 1e9) return trim(v / 1e9) + ' B';
  if (a >= 1e6) return trim(v / 1e6) + ' M';
  if (a >= 1e3) return trim(v / 1e3) + ' k';
  return trim(v);
}

export const convert = {
  oil:   v => (v == null ? null : oilfield ? v * M3_TO_BBL : v),
  gas:   v => (v == null ? null : oilfield ? v * E3M3_TO_MCF : v),
  water: v => (v == null ? null : oilfield ? v * M3_TO_BBL : v),
  length: v => (v == null ? null : oilfield ? v * 3.28084 : v),
};

/**
 * Compact number for axes and tiles: 1.2 M, 340 k, 8.7.
 *
 * Deliberately not Intl's "compact" notation, which localises the suffix and
 * would render "1.2 mil" or "1,2 M" depending on the reader's locale — on an
 * axis that has to stay narrow and unambiguous, a fixed suffix is better.
 */
export function compact(v, digits = 1) {
  if (v == null || Number.isNaN(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(digits) + ' B';
  if (a >= 1e6) return (v / 1e6).toFixed(digits) + ' M';
  if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e5 ? 0 : digits) + ' k';
  if (a >= 10) return v.toFixed(0);
  if (a >= 1) return v.toFixed(1);
  if (a === 0) return '0';
  return v.toPrecision(2);
}

/** Full number with thousands separators — for tables and tooltips. */
export function num(v, digits = 0) {
  if (v == null || Number.isNaN(v)) return '—';
  return v.toLocaleString('en-US', { maximumFractionDigits: digits,
                                     minimumFractionDigits: digits });
}

export function pct(v, digits = 1) {
  if (v == null || Number.isNaN(v)) return '—';
  return v.toFixed(digits) + '%';
}

/** Escape text before it goes into innerHTML. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Turn rows into a CSV blob, with the citation carried in the file itself. */
export function toCSV(rows, columns, citation) {
  const head = columns.join(',');
  const body = rows.map(r => columns.map(c => {
    const v = r[c];
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n');
  return (citation ? citation.split('\n').map(l => '# ' + l).join('\n') + '\n' : '')
       + head + '\n' + body + '\n';
}

export function downloadCSV(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export const CITATION =
  'Data: Secretaria de Energia de la Nacion (Argentina), "Produccion de petroleo y gas ' +
  'por pozo (Capitulo IV)" and "Datos de fractura de pozos (Adjunto IV)", ' +
  'datos.energia.gob.ar, CC BY 4.0.\n' +
  'Repackaged as Parquet by PetroData Repository (sumpalabs.com/petrodb), ' +
  'curated by Oscar Cortez, CC BY 4.0.\n' +
  'Oil in m3, gas in 10^3 m3 unless the header says otherwise.';
