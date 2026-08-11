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

/* wells_slim is split in two.
   CORE is what the filter bar and the Overview need, and nothing else — it is
   on the critical path, so every column here delays the first usable screen.
   DETAIL is everything the Map, Statistics and Well-performance views need; it
   is decoded on first navigation to one of those, by which point the user has
   told us they want it. Decoding is the dominant start-up cost, so this is the
   difference between paying for all thirty columns up front and paying for
   nine. */
const WELLS_CORE = {
  idpozo: 'num', cuenca: 'cat', provincia: 'cat', formation: 'cat',
  operator: 'cat', well_fluid: 'cat', trajectory: 'cat',
  tipo_recurso: 'cat', sub_tipo_recurso: 'cat',
};

const WELLS_DETAIL = {
  sigla: 'cat', area: 'cat', yacimiento: 'cat', well_state: 'cat',
  completion_type: 'cat',
  lon: 'num', lat: 'num', depth_m: 'num', producing_months: 'num',
  first_prod_month: 'date', last_prod_month: 'date',
  cum_oil_m3: 'num', cum_gas_e3m3: 'num', cum_water_m3: 'num',
  lateral_m: 'num', stages: 'num', proppant_t: 'num',
  proppant_kg_per_m: 'num', stage_spacing_m: 'num', gor_m3_m3: 'num',
};

/** Views that read anything from WELLS_DETAIL. */
const NEEDS_WELL_DETAIL = new Set(['map', 'statistics', 'performance']);
/** Views that break the cube down by a dimension outside CUBE_CORE. */
const NEEDS_CUBE_DETAIL = new Set(['explorer']);

// Assigned during boot, once dims.json has supplied the label tables.
let CUBE_CORE = null, CUBE_DETAIL = null;

const ctx = { summary: null, cube: null, wells: null, typecurve: null,
              provenance: null, basins: [], years: [], ready: false };

/** Decode the detail columns once, on demand. Memoised by the promise itself. */
let wellDetailPromise = null;
ctx.ensureWellDetail = async () => {
  if (!wellDetailPromise) {
    const { extendTable } = await import('./store.js');
    wellDetailPromise = extendTable(ctx.wells, 'data/wells_slim.parquet', WELLS_DETAIL);
  }
  return wellDetailPromise;
};

let cubeDetailPromise = null;
ctx.ensureCubeDetail = async () => {
  if (!cubeDetailPromise) {
    cubeDetailPromise = (async () => {
      const { extendTable } = await import('./store.js');
      await extendTable(ctx.cube, 'data/agg_monthly.parquet', CUBE_DETAIL);
      // The stable colour ordering needs the dimensions that just arrived.
      computeOrder(Object.keys(CUBE_DETAIL));
      return ctx.cube;
    })();
  }
  return cubeDetailPromise;
};

/** Rank a dimension's values by total oil-equivalent, over the whole dataset.
 *  Stable across filters — that is what stops a filter repainting the series
 *  that survive it. */
function computeOrder(dims) {
  const cube = ctx.cube;
  const oil = cube.cols.oil_m3.values, gas = cube.cols.gas_e3m3.values;
  for (const dim of dims) {
    const col = cube.cols[dim];
    if (!col || col.kind !== 'cat') continue;
    const totals = new Map();
    const codes = col.codes;
    for (let i = 0; i < cube.n; i++) {
      const k = codes[i]; if (k < 0) continue;
      const v = (oil[i] || 0) + (gas[i] || 0);
      totals.set(k, (totals.get(k) || 0) + (Number.isNaN(v) ? 0 : v));
    }
    ctx.order[dim] = [...totals.entries()].sort((a, b) => b[1] - a[1])
      .map(([k]) => col.dict[k]);
  }
}

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
    // Views that read per-well detail wait for those columns to be decoded.
    // The first such navigation pays for it; every later one is instant.
    if (NEEDS_WELL_DETAIL.has(name) || NEEDS_CUBE_DETAIL.has(name)) {
      main.innerHTML = '<div class="boot"><p class="boot-title">Preparing '
        + 'data…</p></div>';
      if (NEEDS_WELL_DETAIL.has(name)) await ctx.ensureWellDetail();
      if (NEEDS_CUBE_DETAIL.has(name)) await ctx.ensureCubeDetail();
    }
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

  /* TIER A FAST PATH.
     Paint a complete Overview from the 40 KB summary before a single byte of
     Parquet has arrived. Everything below this point is an upgrade of a page
     the reader can already use, rather than a wait they have to sit through. */
  if ((VIEWS[state.view] ? state.view : 'overview') === 'overview') {
    try {
      const ov = await import('./views/overview.js');
      const main = document.getElementById('main');
      main.innerHTML = '';
      const root = document.createElement('div');
      main.appendChild(root);
      current = { name: 'overview', module: ov, root };
      ov.renderFromSummary(root, ctx);
      refreshUnitLabels();
      // Honest self-measurement. Paint metrics from an automated or
      // backgrounded tab are unreliable (the browser throttles rendering when
      // the tab is not visible), so the app records when its own milestones
      // actually completed. Readable at any time via performance.getEntriesByType('mark').
      performance.mark('tierA-rendered');
    } catch (e) {
      // The fast path is an optimisation; if it fails the full render still
      // runs a moment later, so never let it break the boot.
      console.warn('fast path skipped:', e);
    }
  }

  say('production cube (4.5 MB)');

  // The cube's dimensions are stored as integer codes with their labels in a
  // small sidecar, so decoding them is a copy rather than 2.4 million string
  // materialisations. dims.json is a few kilobytes and arrives with summary.
  const dims = await loadJSON('data/dims.json');
  const coded = (name) => ({ labels: dims[name] || [] });

  /* The cube is split for the same reason wells_slim is, and the measurement
     that justifies it: decode costs ~150-220 ms per 296k-row column whatever
     the type, so the only lever is how many columns are decoded before the page
     is usable. The Overview needs eight; the other six exist for the Explorer's
     break-down dimensions, and are decoded when someone opens it.
     Note the facet lists come from `wells`, not the cube, so the filter bar is
     complete from the start regardless. */
  CUBE_CORE = {
    fecha: 'date',
    cuenca: coded('cuenca'), sub_tipo_recurso: coded('sub_tipo_recurso'),
    operator: coded('operator'),
    oil_m3: 'num', gas_e3m3: 'num', water_m3: 'num', wells_producing: 'num',
  };
  CUBE_DETAIL = {
    provincia: coded('provincia'), tipo_recurso: coded('tipo_recurso'),
    formation: coded('formation'), well_fluid: coded('well_fluid'),
    trajectory: coded('trajectory'),
    // No idpozo anywhere here on purpose: the cube is aggregated, so an
    // individual well id does not exist at this grain. Well-level questions go
    // to the `wells` source instead.
    wells: 'num', water_inj_m3: 'num',
  };

  const [cube, wells, typecurve, provenance] = await Promise.all([
    loadTable('data/agg_monthly.parquet', CUBE_CORE),
    loadTable('data/wells_slim.parquet', WELLS_CORE),
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
  // Stable colour ordering for the dimensions available now; the rest are
  // ranked when the Explorer pulls them in.
  ctx.order = {};
  computeOrder(Object.keys(CUBE_CORE));
  for (const [dim] of FACETS) {
    if (!ctx.order[dim]) ctx.order[dim] = wells.domain(dim).map(d => d.value);
  }
  ctx.basins = ctx.order.cuenca || wells.domain('cuenca').map(d => d.value);
  ctx.years = [...new Set(
    Array.from(cube.cols.fecha.values).map(m => 2006 + Math.floor(m / 12))
  )].sort();
  ctx.ready = true;

  performance.mark('tables-decoded');

  buildFilterBar();
  onChange(() => { syncFilterBar(); renderView(); });
  window.addEventListener('hashchange', () => { readHash(); syncFilterBar(); renderView(true); });

  await renderView(true);
  performance.mark('interactive');

  // One line, only when asked for. Anyone can check the page's real timings in
  // their own browser rather than taking a README's word for them.
  if (location.search.includes('perf')) {
    const m = Object.fromEntries(performance.getEntriesByType('mark')
      .map(e => [e.name, Math.round(e.startTime) + ' ms']));
    console.log('[petrodb] load milestones', m);
  }
}

boot().catch(err => {
  console.error(err);
  document.getElementById('main').innerHTML =
    `<div class="boot"><p class="boot-title">Could not load the data.</p>
     <p class="boot-detail">${esc(err.message)}</p></div>`;
});
