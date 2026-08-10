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

export const M3_TO_BBL = 6.28981;      // oil:  1 m³   -> bbl
export const E3M3_TO_MCF = 35.3147;    // gas:  1 10³m³ -> Mcf

let oilfield = false;
export function setOilfieldUnits(on) { oilfield = !!on; }
export function usingOilfield() { return oilfield; }

export const units = {
  oil:   () => (oilfield ? 'bbl' : 'm³'),
  gas:   () => (oilfield ? 'Mcf' : '10³ m³'),
  water: () => (oilfield ? 'bbl' : 'm³'),
  length: () => (oilfield ? 'ft' : 'm'),
};

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
