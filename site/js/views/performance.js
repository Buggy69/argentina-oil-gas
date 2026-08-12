/* Well performance — production re-indexed to months since first production.

   Type curves are pre-computed at build time rather than derived in the
   browser, because deriving them needs every well's full monthly history —
   the one thing the tiering exists to avoid downloading. Groups with fewer
   than five wells are suppressed at build time: a P10–P90 band over three
   wells looks authoritative and means nothing.

   The band is P10–P90 with P50 drawn on top. P10 is the LOW value. */

import { query, getSource, selectRows, valueAt } from '../query.js';
import { queryFilters } from '../state.js';
import { compact, num, convert, units, esc } from '../format.js';
import { draw, baseOption, merge, lineSeries, makeScale, legendHTML, palette }
  from '../charts.js';
import { label as i18nLabel } from '../i18n.js';

let splitBy = 'trajectory';
let fluid = 'oil';
let sortKey = 'oil', sortDir = 'desc';
let subtypeFilter = 'SHALE';

export function render(root, ctx) {
  root.innerHTML = `
    <div class="grid">
      <section class="card">
        <div class="controls">
          <label>Compare
            <select id="pf-split">
              <option value="trajectory">Horizontal vs vertical</option>
              <option value="subtype">Shale vs tight vs conventional</option>
              <option value="vintage">By vintage (year of first production)</option>
            </select>
          </label>
          <label>Fluid
            <select id="pf-fluid">
              <option value="oil">Oil</option>
              <option value="gas">Gas</option>
              <option value="water">Water</option>
            </select>
          </label>
          <label id="pf-sub-wrap">Resource subtype
            <select id="pf-sub">
              <option value="SHALE">Shale</option>
              <option value="TIGHT">Tight</option>
              <option value="No informado">Not reported</option>
              <option value="ALL">All</option>
            </select>
          </label>
        </div>
        <div class="callout">
          Each curve is the <strong>median well</strong> at that month of its own
          life, with a P10–P90 band across wells. It is not the average of a
          basin's output, and it is not a forecast — it is what the population of
          wells actually did, month by month, after they started.
        </div>
      </section>

      <section class="card">
        <h2 id="pf-title">Oil type curves</h2>
        <p class="note" id="pf-note"></p>
        <div id="pf-chart" class="chart tall"></div>
        <div id="pf-legend"></div>
      </section>

      <section class="card half">
        <h2>Completion intensity against outcome</h2>
        <p class="note">Proppant per metre of lateral versus cumulative oil, one
          point per well. Unit of observation: one well.</p>
        <div id="pf-scatter" class="chart"></div>
        <div id="pf-scatter-legend"></div>
      </section>

      <section class="card half">
        <h2>Best wells in the selection</h2>
        <p class="note">Click a column header to sort, again to reverse. Click a
          row to load that well's full monthly history — one small file fetched
          on demand, not the whole dataset.</p>
        <div class="scroll-x" style="max-height:300px"><table class="data" id="pf-top"></table></div>
        <div id="pf-well" class="chart short" style="margin-top:12px"></div>
      </section>
    </div>`;

  root.querySelector('#pf-split').addEventListener('change', e => {
    splitBy = e.target.value; update(root, ctx);
  });
  root.querySelector('#pf-sub').addEventListener('change', e => {
    subtypeFilter = e.target.value; update(root, ctx);
  });
  root.querySelector('#pf-fluid').addEventListener('change', e => {
    fluid = e.target.value; update(root, ctx);
  });
  // Sortable table: clicking a header sorts by it, clicking again reverses.
  root.querySelector('#pf-top').addEventListener('click', (e) => {
    const key = e.target.closest('th[data-sort]')?.dataset.sort;
    if (!key) return;
    if (sortKey === key) sortDir = sortDir === 'desc' ? 'asc' : 'desc';
    else { sortKey = key; sortDir = 'desc'; }
    update(root, ctx);
  });

  update(root, ctx);
}

export function update(root, ctx) {
  const f = queryFilters(null);
  root.querySelector('#pf-sub-wrap').style.display =
    splitBy === 'subtype' ? 'none' : '';

  /* --- type curves -----------------------------------------------------
     EVERY dimension the type-curve table carries is forwarded. It used to
     forward only trajectory and basin, so filtering to one operator left the
     curves showing the whole country while looking like a filtered result —
     the worst kind of bug, because nothing about the chart said so. The table
     now carries operator, formation and block as well, and anything it still
     cannot honour is reported to the reader below rather than dropped. */
  const TC_DIMS = ['trajectory', 'cuenca', 'operator', 'formation', 'area',
                   'sub_tipo_recurso'];
  const tcFilters = {};
  for (const k of TC_DIMS) {
    if (!f[k]) continue;
    // The type-curve table calls the resource subtype `subtype`.
    tcFilters[k === 'sub_tipo_recurso' ? 'subtype' : k] = f[k];
  }
  // The dropdown only applies when the global filter has not already set it.
  if (splitBy !== 'subtype' && subtypeFilter !== 'ALL' && !tcFilters.subtype) {
    tcFilters.subtype = [subtypeFilter];
  }
  const tcIgnored = Object.keys(f).filter(k =>
    !TC_DIMS.includes(k) && k !== 'fecha' && (!Array.isArray(f[k]) || f[k].length));

  const dim = splitBy === 'subtype' ? 'subtype'
            : splitBy === 'vintage' ? 'vintage' : 'trajectory';

  const rows = query({
    source: 'typecurve', filters: tcFilters,
    groupBy: ['month_on_prod', dim],
    measures: [
      { as: 'p10', col: `${fluid}_p10`, agg: 'mean' },
      { as: 'p50', col: `${fluid}_p50`, agg: 'mean' },
      { as: 'p90', col: `${fluid}_p90`, agg: 'mean' },
      { as: 'wells', col: 'wells', agg: 'sum' },
    ],
  });

  const months = [...new Set(rows.map(r => r.month_on_prod))].sort((a, b) => a - b)
    .filter(m => m <= 60);
  let cats = [...new Set(rows.map(r => String(r[dim])))].filter(c => c !== 'null');
  if (dim === 'vintage') {
    cats = cats.map(Number).filter(Number.isFinite).sort((a, b) => b - a)
      .slice(0, 6).map(String);
  } else cats.sort();

  const scale = makeScale(cats);
  const byCat = new Map();
  for (const r of rows) {
    const k = String(r[dim]);
    if (!byCat.has(k)) byCat.set(k, new Map());
    byCat.get(k).set(r.month_on_prod, r);
  }

  // Oil, gas and water are different measures in different units — the fluid
  // selector switches the whole chart rather than adding a second y-axis.
  const convFluid = fluid === 'gas' ? convert.gas
                  : fluid === 'water' ? convert.water : convert.oil;
  const fluidUnit = fluid === 'gas' ? units.gas()
                  : fluid === 'water' ? units.water() : units.oil();

  const series = [];
  // Only draw the P10–P90 band when comparing at most three groups; more than
  // that and overlapping translucent bands become unreadable, so the medians
  // carry the comparison alone.
  const withBand = cats.length <= 3;
  for (const c of cats) {
    const m = byCat.get(c); if (!m) continue;
    const col = scale(c);
    if (withBand) {
      series.push({
        name: c + ' P10', type: 'line', stack: 'band-' + c, showSymbol: false,
        lineStyle: { opacity: 0 }, silent: true,
        data: months.map(x => convFluid(m.get(x)?.p10 ?? 0)),
      });
      series.push({
        name: c + ' P10–P90', type: 'line', stack: 'band-' + c, showSymbol: false,
        lineStyle: { opacity: 0 }, silent: true,
        areaStyle: { color: col, opacity: 0.16 },
        data: months.map(x => {
          const r = m.get(x); if (!r) return 0;
          return convFluid(Math.max(0, (r.p90 ?? 0) - (r.p10 ?? 0)));
        }),
      });
    }
    series.push(lineSeries(c, months.map(x => {
      const r = m.get(x); return r ? convFluid(r.p50) : null;
    }), col));
  }

  const totalWells = rows.filter(r => r.month_on_prod === 0)
    .reduce((a, r) => a + (r.wells || 0), 0);
  root.querySelector('#pf-title').textContent =
    `${fluid[0].toUpperCase()}${fluid.slice(1)} type curves`;
  const pooled = rows.length > months.length * cats.length;
  root.querySelector('#pf-note').innerHTML =
    `Median monthly ${fluid} per well, ${fluidUnit}, against months since that
     well's first production. ${num(totalWells)} wells enter at month 0.
     ${tcIgnored.length ? `<span style="color:var(--s4)">⚠ ${esc(tcIgnored.join(', '))}
       ${tcIgnored.length > 1 ? 'are' : 'is'} not a type-curve dimension, so
       ${tcIgnored.length > 1 ? 'they are' : 'it is'} not applied here.</span>` : ''}
     ${pooled ? `<em>Percentiles are pre-computed per group and averaged when
       several groups are pooled, so a pooled band is an approximation of the
       true percentile — exact when the filter narrows to a single group.</em>` : ''}
     ${withBand ? 'Shaded band is P10–P90 across wells (p10 = low).'
                : 'Bands are omitted above three groups — overlapping translucent bands stop being readable.'}
     Groups with fewer than five wells are not published.`;

  draw(root.querySelector('#pf-chart'), merge(baseOption(), {
    legend: { show: false }, grid: { bottom: 14 },
    tooltip: { trigger: 'axis',
      formatter: ps => {
        const shown = ps.filter(p => !/P10/.test(p.seriesName));
        return `Month ${shown[0]?.axisValue}<br>` + shown.map(p =>
          `${esc(p.seriesName)}: ${compact(p.value, 1)} ${fluidUnit}`).join('<br>');
      } },
    xAxis: { type: 'category', data: months,
      name: 'months on production', nameLocation: 'middle', nameGap: 26,
      nameTextStyle: { fontSize: 11 },
      axisLabel: { interval: 5 } },
    yAxis: { type: 'value', axisLabel: { formatter: v => compact(v, 0) } },
    series,
  }));
  root.querySelector('#pf-legend').innerHTML =
    legendHTML(cats.map(c => ({ label: esc(i18nLabel(dim === 'subtype' ? 'sub_tipo_recurso' : dim, c)), color: scale(c) })));

  /* --- intensity scatter ------------------------------------------------ */
  const wells = getSource('wells');
  const idx = selectRows('wells', f);
  const traj = wells.cols.trajectory;
  const pal = palette();
  const trajOrder = ['Horizontal', 'Unknown', 'Vertical'];
  const groups = new Map();
  for (const i of idx) {
    const x = wells.cols.proppant_kg_per_m.values[i];
    const y = wells.cols.cum_oil_m3.values[i];
    if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) continue;
    const k = traj.codes[i] >= 0 ? traj.dict[traj.codes[i]] : 'Unknown';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push([x, convert.oil(y), i]);
  }
  const colorOf = k => pal[Math.max(0, trajOrder.indexOf(k))] ?? pal[0];
  draw(root.querySelector('#pf-scatter'), merge(baseOption(), {
    legend: { show: false }, grid: { bottom: 14 },
    tooltip: { trigger: 'item', formatter: p =>
      `<strong>${esc(valueAt(wells, 'sigla', p.data[2]) ?? '')}</strong><br>` +
      `${num(p.data[0], 0)} kg proppant per m<br>` +
      `${compact(p.data[1], 2)} ${units.oil()} cumulative` },
    xAxis: { type: 'log', name: 'proppant kg per m of lateral',
      nameLocation: 'middle', nameGap: 26, nameTextStyle: { fontSize: 11 },
      axisLabel: { formatter: v => compact(v, 0) } },
    yAxis: { type: 'log', axisLabel: { formatter: v => compact(v, 0) } },
    series: [...groups.entries()].map(([k, data]) => ({
      name: k, type: 'scatter', data, symbolSize: 6, large: true,
      itemStyle: { color: colorOf(k), opacity: 0.6 },
    })),
  }));
  root.querySelector('#pf-scatter-legend').innerHTML =
    legendHTML([...groups.keys()].map(k => ({ label: esc(i18nLabel('trajectory', k)), color: colorOf(k) })));

  /* --- top wells -------------------------------------------------------- */
  const ranked = idx
    .map(i => ({ i, oil: wells.cols.cum_oil_m3.values[i] }))
    .filter(r => Number.isFinite(r.oil))
    .sort((a, b) => b.oil - a.oil).slice(0, 30);

  const SORTS = {
    sigla: (i) => valueAt(wells, 'sigla', i) ?? '',
    cuenca: (i) => valueAt(wells, 'cuenca', i) ?? '',
    trajectory: (i) => valueAt(wells, 'trajectory_class', i) ?? '',
    oil: (i) => wells.cols.cum_oil_m3.values[i],
    gas: (i) => wells.cols.cum_gas_e3m3.values[i],
    water: (i) => wells.cols.cum_water_m3.values[i],
  };
  const getVal = SORTS[sortKey] || SORTS.oil;
  const dirMul = sortDir === 'asc' ? 1 : -1;
  const ranked = idx
    .map(i => ({ i, v: getVal(i) }))
    .filter(r => r.v != null && !(typeof r.v === 'number' && Number.isNaN(r.v)))
    .sort((a, b) => dirMul * (typeof a.v === 'string'
      ? a.v.localeCompare(b.v) : a.v - b.v))
    .slice(0, 50);

  const arrow = (k) => sortKey === k ? (sortDir === 'desc' ? ' ▾' : ' ▴') : '';
  const th = (k, text) =>
    `<th data-sort="${k}" style="cursor:pointer;user-select:none"
        title="Sort by ${esc(text)}" aria-sort="${
          sortKey === k ? (sortDir === 'desc' ? 'descending' : 'ascending') : 'none'
        }">${esc(text)}${arrow(k)}</th>`;

  root.querySelector('#pf-top').innerHTML = `
    <thead><tr>
      ${th('sigla', 'Well')}${th('cuenca', 'Basin')}${th('trajectory', 'Trajectory')}
      ${th('oil', `Cum oil (${units.oil()})`)}
      ${th('gas', `Cum gas (${units.gas()})`)}
      ${th('water', `Cum water (${units.water()})`)}
    </tr></thead>
    <tbody>${ranked.map(r => `
      <tr data-idpozo="${valueAt(wells, 'idpozo', r.i)}" style="cursor:pointer">
        <td>${esc(valueAt(wells, 'sigla', r.i) ?? '')}</td>
        <td>${esc(i18nLabel('cuenca', valueAt(wells, 'cuenca', r.i)) ?? '')}</td>
        <td>${esc(valueAt(wells, 'trajectory_class', r.i) ?? '')}</td>
        <td>${num(convert.oil(wells.cols.cum_oil_m3.values[r.i]), 0)}</td>
        <td>${num(convert.gas(wells.cols.cum_gas_e3m3.values[r.i]), 0)}</td>
        <td>${num(convert.water(wells.cols.cum_water_m3.values[r.i]), 0)}</td>
      </tr>`).join('')}</tbody>`;

  root.querySelector('#pf-top').onclick = async (e) => {
    const tr = e.target.closest('tr[data-idpozo]');
    if (!tr) return;
    const id = Number(tr.dataset.idpozo);
    const el = root.querySelector('#pf-well');
    el.classList.add('is-busy');
    const { loadWellHistory, monthLabel } = await import('../store.js');
    // One whole-file GET of the well's bucket — see store.js. The bucket is
    // cached, so opening a second well from the same bucket costs nothing.
    const hist = await loadWellHistory(id);
    el.classList.remove('is-busy');
    const s1 = palette()[0];
    draw(el, merge(baseOption(), {
      legend: { show: false }, grid: { bottom: 12 },
      tooltip: { trigger: 'axis', valueFormatter: v => compact(v, 1) + ' ' + units.oil() },
      xAxis: { type: 'category', data: hist.map(h => monthLabel(h.month)),
        axisLabel: { interval: Math.ceil(hist.length / 8) } },
      yAxis: { type: 'value', axisLabel: { formatter: v => compact(v, 0) } },
      series: [lineSeries('Oil', hist.map(h => convert.oil(h.oil)), s1)],
    }));
  };
}
