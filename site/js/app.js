/* ===========================================================================
   Bootstrap and routing.

   LOADING ORDER IS THE USER EXPERIENCE
   ------------------------------------
   summary.json is 40 KB gzipped and needs no engine, so the first screen can
   paint before anything else has arrived. The Parquet tiers load after, in
   parallel, and the view re-renders when they land. That ordering is why the
   page is useful on a phone in about a second instead of after seven megabytes.
   =========================================================================== */

import { loadTable, loadJSON, monthLabel } from './store.js';
import { registerSource, getSource } from './query.js';
import { state, onChange, readHash, setView, toggleFilter, clearFilters,
         setOilfield, setMonthRange, activeFilterCount } from './state.js';
import { setOilfieldUnits, units, num, esc } from './format.js';
import { resizeAll, disposeAll } from './charts.js';

const VIEWS = {
  overview:    () => import('./views/overview.js'),
  explorer:    () => import('./views/explorer.js'),
  map:         () => import('./views/map.js'),
  statistics:  () => import('./views/statistics.js'),
  performance: () => import('./views/performance.js'),
  about:       () => import('./views/about.js'),
};

/* Facets shown in the filter bar. `source` says which table the facet's domain
   comes from — the cube for time-varying dimensions, wells for static ones. */
const FACETS = [
  ['cuenca', 'Basin', 'wells'],
  ['provincia', 'Province', 'wells'],
  ['formation', 'Formation', 'wells'],
  ['operator', 'Operator', 'wells'],
  ['well_fluid', 'Oil / gas well', 'wells'],
  ['trajectory', 'Trajectory', 'wells'],
  ['tipo_recurso', 'Resource type', 'wells'],
  ['sub_tipo_recurso', 'Shale / tight', 'wells'],
];

const ctx = { summary: null, cube: null, wells: null, typecurve: null,
              provenance: null, basins: [], years: [], ready: false };

let current = null;   // { name, module }

/* --- theme ---------------------------------------------------------------
   The toggle stamps data-theme on <html> so it beats the OS preference in
   both directions, and the choice persists. Charts must be re-rendered on a
   change because ECharts resolves colours at draw time, not from CSS. */
function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  document.getElementById('theme-toggle').addEventListener('click', () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark'
      || (!document.documentElement.hasAttribute('data-theme')
          && matchMedia('(prefers-color-scheme: dark)').matches);
    const next = isDark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    renderView(true);
  });
}

/* --- filter bar ---------------------------------------------------------- */
function buildFilterBar() {
  const host = document.getElementById('facets');
  host.innerHTML = '';

  for (const [dim, label, source] of FACETS) {
    const table = ctx[source === 'wells' ? 'wells' : 'cube'];
    if (!table || !table.cols[dim]) continue;
    const domain = table.domain(dim).slice(0, 60);

    const d = document.createElement('details');
    d.className = 'facet';
    d.innerHTML = `
      <summary></summary>
      <div class="facet-panel">
        <div class="facet-tools">
          <button class="btn-quiet" data-act="all">All</button>
          <button class="btn-quiet" data-act="none">None</button>
        </div>
        ${domain.map(o => `
          <label><input type="checkbox" value="${esc(o.value)}">
            <span>${esc(o.value)}</span>
            <span class="count">${num(o.count)}</span></label>`).join('')}
      </div>`;

    d.querySelector('.facet-panel').addEventListener('change', (e) => {
      if (e.target.type !== 'checkbox') return;
      toggleFilter(dim, e.target.value);
    });
    d.querySelector('[data-act="none"]').addEventListener('click', () => {
      const sel = state.filters[dim];
      if (sel) { delete state.filters[dim]; syncFilterBar(); renderView(); }
    });
    d.querySelector('[data-act="all"]').addEventListener('click', () => {
      delete state.filters[dim];
      syncFilterBar(); renderView();
    });

    d.dataset.dim = dim;
    d.dataset.label = label;
    host.appendChild(d);
  }

  /* Time range. A month slider rather than a date picker: the data is monthly,
     so offering days would promise a precision that does not exist. */
  const cube = ctx.cube;
  const months = cube.cols.fecha.values;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < cube.n; i++) { const v = months[i];
    if (v < lo) lo = v; if (v > hi) hi = v; }
  ctx.monthBounds = { lo, hi };

  const t = document.createElement('details');
  t.className = 'facet';
  t.dataset.dim = '__time';
  t.dataset.label = 'Period';
  t.innerHTML = `
    <summary></summary>
    <div class="facet-panel" style="min-width:280px">
      <label style="display:block">From <output id="t-from"></output>
        <input type="range" id="t-min" min="${lo}" max="${hi}" value="${lo}" style="width:100%"></label>
      <label style="display:block">To <output id="t-to"></output>
        <input type="range" id="t-max" min="${lo}" max="${hi}" value="${hi}" style="width:100%"></label>
      <div class="facet-tools"><button class="btn-quiet" data-act="reset">Full period</button></div>
    </div>`;
  host.appendChild(t);

  const tmin = t.querySelector('#t-min'), tmax = t.querySelector('#t-max');
  const apply = () => {
    let a = Number(tmin.value), b = Number(tmax.value);
    if (a > b) [a, b] = [b, a];
    t.querySelector('#t-from').textContent = monthLabel(a);
    t.querySelector('#t-to').textContent = monthLabel(b);
    setMonthRange((a === lo && b === hi) ? null : { min: a, max: b });
  };
  tmin.addEventListener('input', apply);
  tmax.addEventListener('input', apply);
  t.querySelector('[data-act="reset"]').addEventListener('click', () => {
    tmin.value = lo; tmax.value = hi; apply();
  });
  t.querySelector('#t-from').textContent = monthLabel(lo);
  t.querySelector('#t-to').textContent = monthLabel(hi);

  document.getElementById('filterbar').hidden = false;
  syncFilterBar();
}

function syncFilterBar() {
  for (const d of document.querySelectorAll('.facet')) {
    const dim = d.dataset.dim, label = d.dataset.label;
    if (dim === '__time') {
      const r = state.monthRange;
      d.classList.toggle('active', !!r);
      d.querySelector('summary').textContent = r
        ? `${label}: ${monthLabel(r.min)} → ${monthLabel(r.max)}` : label;
      continue;
    }
    const sel = state.filters[dim] || [];
    d.classList.toggle('active', sel.length > 0);
    d.querySelector('summary').textContent =
      sel.length === 0 ? label
      : sel.length === 1 ? `${label}: ${sel[0]}`
      : `${label}: ${sel.length} selected`;
    for (const cb of d.querySelectorAll('input[type=checkbox]')) {
      cb.checked = sel.includes(cb.value);
    }
  }
  const n = activeFilterCount();
  document.getElementById('selection-summary').textContent =
    n === 0 ? 'No filters — showing everything' : `${n} filter${n > 1 ? 's' : ''} active`;
}

/* --- view routing -------------------------------------------------------- */
async function renderView(force = false) {
  const name = VIEWS[state.view] ? state.view : 'overview';
  const main = document.getElementById('main');

  for (const b of document.querySelectorAll('.tabs button')) {
    b.setAttribute('aria-selected', String(b.dataset.view === name));
  }

  if (!ctx.ready) return;

  if (force || !current || current.name !== name) {
    const mod = await VIEWS[name]();
    current = { name, module: mod };
    // Tear the old charts down before their elements are discarded. ECharts
    // instances do not clean themselves up when their container is removed.
    disposeAll();
    main.innerHTML = '';
    const root = document.createElement('div');
    main.appendChild(root);
    current.root = root;
    await mod.render(root, ctx);
  } else {
    // Hold the previous render at reduced opacity while recomputing — no
    // skeleton flash, no layout jump.
    current.root.classList.add('is-busy');
    current.module.update(current.root, ctx);
    current.root.classList.remove('is-busy');
  }
  refreshUnitLabels();
  resizeAll();
}

function refreshUnitLabels() {
  for (const el of document.querySelectorAll('[data-unit]')) {
    el.textContent = units[el.dataset.unit]?.() ?? '';
  }
}

/* --- boot ---------------------------------------------------------------- */
async function boot() {
  initTheme();
  readHash();
  setOilfieldUnits(state.oilfield);
  document.getElementById('unit-toggle').checked = state.oilfield;

  for (const b of document.querySelectorAll('.tabs button')) {
    b.addEventListener('click', () => setView(b.dataset.view));
  }
  document.getElementById('reset-filters').addEventListener('click', () => {
    clearFilters(); syncFilterBar();
  });
  document.getElementById('unit-toggle').addEventListener('change', (e) => {
    setOilfield(e.target.checked);
    setOilfieldUnits(e.target.checked);
  });

  const detail = document.getElementById('boot-detail');
  const say = (s) => { if (detail) detail.textContent = s; };

  say('summary');
  ctx.summary = await loadJSON('data/summary.json');
  // The summary carries full dates; the data is monthly, so showing a day
  // would promise a precision that does not exist.
  const ym = (s) => String(s ?? '').slice(0, 7);
  document.getElementById('coverage').textContent =
    `${ym(ctx.summary.coverage.first_month)} – ${ym(ctx.summary.coverage.last_month)}`;

  say('production cube (4.5 MB)');
  const [cube, wells, typecurve, provenance] = await Promise.all([
    loadTable('data/agg_monthly.parquet', {
      fecha: 'date', cuenca: 'cat', provincia: 'cat', tipo_recurso: 'cat',
      sub_tipo_recurso: 'cat', formation: 'cat', operator: 'cat',
      well_fluid: 'cat', trajectory: 'cat',
      // No idpozo here on purpose: the cube is aggregated, so an individual
      // well id does not exist at this grain. Well-level questions go to the
      // `wells` source instead.
      wells: 'num', wells_producing: 'num', oil_m3: 'num', gas_e3m3: 'num',
      water_m3: 'num', water_inj_m3: 'num',
    }),
    loadTable('data/wells_slim.parquet', {
      idpozo: 'num', sigla: 'cat', cuenca: 'cat', provincia: 'cat', area: 'cat',
      yacimiento: 'cat', formation: 'cat', tipo_recurso: 'cat',
      sub_tipo_recurso: 'cat', operator: 'cat', well_fluid: 'cat',
      well_state: 'cat', trajectory: 'cat', completion_type: 'cat',
      lon: 'num', lat: 'num', depth_m: 'num', producing_months: 'num',
      // Month indices, used to fetch only the years a well actually produced in
      // when its full history is opened.
      first_prod_month: 'date', last_prod_month: 'date',
      cum_oil_m3: 'num', cum_gas_e3m3: 'num', cum_water_m3: 'num',
      lateral_m: 'num', stages: 'num', proppant_t: 'num',
      proppant_kg_per_m: 'num', stage_spacing_m: 'num', gor_m3_m3: 'num',
    }),
    loadTable('data/typecurve.parquet', {
      trajectory: 'cat', subtype: 'cat', cuenca: 'cat', vintage: 'num',
      month_on_prod: 'num', wells: 'num',
      oil_p10: 'num', oil_p50: 'num', oil_p90: 'num', gas_p50: 'num',
    }),
    loadJSON('PROVENANCE.json').catch(() => ({})),
  ]);

  registerSource('cube', cube);
  registerSource('wells', wells);
  registerSource('typecurve', typecurve);
  ctx.cube = cube; ctx.wells = wells; ctx.typecurve = typecurve;
  ctx.provenance = provenance;
  /* Stable colour ordering, computed once over the FULL dataset.
     Ranked by total oil-equivalent so the basins and operators that matter get
     the strong slots, and never recomputed for a selection — that is what stops
     a filter from repainting the series that survive it. */
  ctx.order = {};
  for (const [dim] of FACETS) {
    if (!cube.cols[dim]) { ctx.order[dim] = wells.domain(dim).map(d => d.value); continue; }
    const totals = new Map();
    const codes = cube.cols[dim].codes, dict = cube.cols[dim].dict;
    const oil = cube.cols.oil_m3.values, gas = cube.cols.gas_e3m3.values;
    for (let i = 0; i < cube.n; i++) {
      const k = codes[i]; if (k < 0) continue;
      const v = (oil[i] || 0) + (gas[i] || 0);
      totals.set(k, (totals.get(k) || 0) + (Number.isNaN(v) ? 0 : v));
    }
    ctx.order[dim] = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => dict[k]);
  }
  ctx.basins = ctx.order.cuenca || wells.domain('cuenca').map(d => d.value);
  ctx.years = [...new Set(
    Array.from(cube.cols.fecha.values).map(m => 2006 + Math.floor(m / 12))
  )].sort();
  ctx.ready = true;

  buildFilterBar();
  onChange(() => { syncFilterBar(); renderView(); });
  window.addEventListener('hashchange', () => { readHash(); syncFilterBar(); renderView(true); });

  await renderView(true);
}

boot().catch(err => {
  console.error(err);
  document.getElementById('main').innerHTML =
    `<div class="boot"><p class="boot-title">Could not load the data.</p>
     <p class="boot-detail">${esc(err.message)}</p></div>`;
});
