/* ===========================================================================
   Filter state, shared by every view, and mirrored into the URL.

   Two things matter here:

   1. There is ONE filter object. Per-chart filters are an anti-pattern — a
      reader cannot tell which slice a given card is showing — so every view
      renders against this and re-renders when it changes.

   2. State lives in the URL hash. That makes a filtered view *citable*: a
      colleague opens the link and sees exactly the same slice, without the
      page needing a server or a session. For a dashboard whose purpose is
      analysis someone will want to point at, that is a feature and not a
      convenience.
   =========================================================================== */

const listeners = new Set();

export const state = {
  view: 'overview',
  filters: {},            // dimension -> [selected values]
  monthRange: null,       // {min, max} in month-index units
  oilfield: false,
};

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function emit() {
  writeHash();
  for (const fn of listeners) fn(state);
}

export function setView(view) {
  if (state.view === view) return;
  state.view = view;
  emit();
}

export function toggleFilter(dim, value) {
  const cur = state.filters[dim] || [];
  const i = cur.indexOf(value);
  const next = i >= 0 ? cur.filter(v => v !== value) : cur.concat(value);
  if (next.length) state.filters[dim] = next; else delete state.filters[dim];
  emit();
}

export function setFilter(dim, values) {
  if (values && values.length) state.filters[dim] = values.slice();
  else delete state.filters[dim];
  emit();
}

export function clearFilters() {
  state.filters = {};
  state.monthRange = null;
  emit();
}

export function setMonthRange(range) { state.monthRange = range; emit(); }
export function setOilfield(on) { state.oilfield = !!on; emit(); }

export function activeFilterCount() {
  return Object.values(state.filters).reduce((a, v) => a + v.length, 0)
       + (state.monthRange ? 1 : 0);
}

/**
 * Filters as the query layer wants them, with the time range folded in.
 * `dateColumn` differs by source (the cube has `fecha`; wells do not), so the
 * caller says which column — or passes null to leave time out entirely.
 */
export function queryFilters(dateColumn = 'fecha') {
  const f = { ...state.filters };
  if (dateColumn && state.monthRange) f[dateColumn] = { ...state.monthRange };
  return f;
}

/* --- URL sync ------------------------------------------------------------
   Encoded as  #/view?dim=a|b&dim2=c  — readable, and short enough that a
   filtered link survives being pasted into chat clients that break long URLs.
   Values are encoded individually so that a category containing a pipe or an
   ampersand cannot corrupt the parse.
   ------------------------------------------------------------------------ */
function writeHash() {
  const parts = [];
  for (const [dim, values] of Object.entries(state.filters)) {
    parts.push(`${encodeURIComponent(dim)}=${values.map(encodeURIComponent).join('|')}`);
  }
  if (state.monthRange) parts.push(`t=${state.monthRange.min}-${state.monthRange.max}`);
  if (state.oilfield) parts.push('u=field');
  const hash = `#/${state.view}` + (parts.length ? '?' + parts.join('&') : '');
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

export function readHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  if (!raw) return;
  const [view, qs] = raw.split('?');
  if (view) state.view = view;
  state.filters = {};
  state.monthRange = null;
  if (!qs) return;
  for (const pair of qs.split('&')) {
    const [k, v] = pair.split('=');
    if (!k || v == null) continue;
    if (k === 't') {
      const [a, b] = v.split('-').map(Number);
      if (Number.isFinite(a) && Number.isFinite(b)) state.monthRange = { min: a, max: b };
    } else if (k === 'u') {
      state.oilfield = v === 'field';
    } else {
      state.filters[decodeURIComponent(k)] = v.split('|').map(decodeURIComponent);
    }
  }
}
