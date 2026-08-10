/* Explorer — the analysis surface.

   The filter bar above already narrows the slice; this view chooses how to
   *break it down*. Series colour is assigned from the full domain of the
   chosen dimension, so removing a category from the filter never repaints the
   ones that remain. */

import { query } from '../query.js';
import { queryFilters } from '../state.js';
import { compact, num, convert, units, toCSV, downloadCSV, CITATION, esc } from '../format.js';
import { draw, baseOption, merge, lineSeries, areaSeries, makeScale, legendHTML }
  from '../charts.js';
import { monthLabel } from '../store.js';

const DIMENSIONS = [
  ['cuenca', 'Basin'],
  ['provincia', 'Province'],
  ['formation', 'Formation'],
  ['operator', 'Operator'],
  ['well_fluid', 'Well fluid type'],
  ['trajectory', 'Trajectory'],
  ['tipo_recurso', 'Resource type'],
  ['sub_tipo_recurso', 'Resource subtype'],
];

let dim = 'cuenca';
let stacked = true;

export function render(root, ctx) {
  root.innerHTML = `
    <div class="grid">
      <section class="card">
        <div class="controls">
          <label>Break down by
            <select id="ex-dim">
              ${DIMENSIONS.map(([v, l]) =>
                `<option value="${v}"${v === dim ? ' selected' : ''}>${l}</option>`).join('')}
            </select>
          </label>
          <span class="seg" role="group" aria-label="Chart style">
            <button id="ex-stack" aria-pressed="${stacked}">Stacked</button>
            <button id="ex-line" aria-pressed="${!stacked}">Lines</button>
          </span>
          <button class="btn-quiet" id="ex-csv">Download this selection (CSV)</button>
        </div>
      </section>

      <section class="card half">
        <h2>Oil — monthly</h2>
        <p class="note">Unit: <span data-unit="oil"></span>. Top 8 categories;
           the remainder is folded into “Other” rather than given a ninth colour.</p>
        <div id="ex-oil" class="chart"></div>
        <div id="ex-oil-legend"></div>
      </section>

      <section class="card half">
        <h2>Gas — monthly</h2>
        <p class="note">Unit: <span data-unit="gas"></span>. Separate chart, one
           axis — never a second y-scale.</p>
        <div id="ex-gas" class="chart"></div>
        <div id="ex-gas-legend"></div>
      </section>

      <section class="card">
        <h2 id="ex-table-title">Breakdown</h2>
        <p class="note">The table is the accessible twin of the charts above —
           every plotted value is readable here as a number.</p>
        <div class="scroll-x"><table class="data" id="ex-table"></table></div>
      </section>
    </div>`;

  root.querySelector('#ex-dim').addEventListener('change', (e) => {
    dim = e.target.value; update(root, ctx);
  });
  root.querySelector('#ex-stack').addEventListener('click', () => {
    stacked = true; syncButtons(root); update(root, ctx);
  });
  root.querySelector('#ex-line').addEventListener('click', () => {
    stacked = false; syncButtons(root); update(root, ctx);
  });
  root.querySelector('#ex-csv').addEventListener('click', () => exportCSV());

  update(root, ctx);
}

function syncButtons(root) {
  root.querySelector('#ex-stack').setAttribute('aria-pressed', String(stacked));
  root.querySelector('#ex-line').setAttribute('aria-pressed', String(!stacked));
}

let lastRows = [], lastCols = [];

export function update(root, ctx) {
  const f = queryFilters('fecha');
  const label = DIMENSIONS.find(d => d[0] === dim)[1];

  // Stable colour scale, seeded from the globally-ranked ordering computed at
  // boot — not from the current selection, and not alphabetically.
  const scale = makeScale(ctx.order?.[dim] || ctx.cube.domain(dim).map(d => d.value));

  for (const [id, measure, conv, unit] of [
    ['ex-oil', 'oil_m3', convert.oil, units.oil()],
    ['ex-gas', 'gas_e3m3', convert.gas, units.gas()],
  ]) {
    const rows = query({
      source: 'cube', filters: f, groupBy: ['fecha', dim],
      measures: [{ as: 'v', col: measure, agg: 'sum' }],
    });
    const months = [...new Set(rows.map(r => r.fecha))].sort((a, b) => a - b);

    const totals = new Map();
    for (const r of rows) totals.set(r[dim], (totals.get(r[dim]) || 0) + (r.v || 0));
    const top = [...totals.entries()].sort((a, b) => b[1] - a[1])
      .slice(0, 8).map(([k]) => k);
    const topSet = new Set(top);

    const byCat = new Map();
    for (const r of rows) {
      const k = topSet.has(r[dim]) ? r[dim] : 'Other';
      if (!byCat.has(k)) byCat.set(k, new Map());
      byCat.get(k).set(r.fecha, (byCat.get(k).get(r.fecha) || 0) + (r.v || 0));
    }
    const cats = top.concat(byCat.has('Other') ? ['Other'] : []);
    const series = cats.map(c => {
      const data = months.map(m => conv(byCat.get(c)?.get(m) || 0));
      return stacked ? areaSeries(c, data, scale(c))
                     : lineSeries(c, data, scale(c));
    });

    draw(root.querySelector('#' + id), merge(baseOption(), {
      legend: { show: false }, grid: { bottom: 12 },
      tooltip: { valueFormatter: v => compact(v, 1) + ' ' + unit },
      xAxis: { type: 'category', data: months.map(monthLabel),
               axisLabel: { interval: Math.ceil(months.length / 8) } },
      yAxis: { type: 'value', axisLabel: { formatter: v => compact(v, 0) } },
      series,
    }));
    root.querySelector('#' + id + '-legend').innerHTML =
      legendHTML(cats.map(c => ({ label: esc(c ?? '(sin dato)'), color: scale(c) })));
  }

  /* --- table ----------------------------------------------------------- */
  const agg = query({
    source: 'cube', filters: f, groupBy: [dim],
    measures: [
      { as: 'oil', col: 'oil_m3', agg: 'sum' },
      { as: 'gas', col: 'gas_e3m3', agg: 'sum' },
      { as: 'water', col: 'water_m3', agg: 'sum' },
      { as: 'wells', col: 'wells', agg: 'sum' },
    ],
    orderBy: 'oil',
  });
  const grandOil = agg.reduce((a, r) => a + (r.oil || 0), 0);

  root.querySelector('#ex-table-title').textContent = `Breakdown by ${label.toLowerCase()}`;
  root.querySelector('#ex-table').innerHTML = `
    <thead><tr>
      <th>${esc(label)}</th>
      <th>Oil (${units.oil()})</th><th>share</th>
      <th>Gas (${units.gas()})</th>
      <th>Water (${units.water()})</th>
    </tr></thead>
    <tbody>${agg.map(r => `<tr>
      <td>${esc(r[dim] ?? '(sin dato)')}</td>
      <td>${num(convert.oil(r.oil), 0)}</td>
      <td>${grandOil ? (r.oil / grandOil * 100).toFixed(1) + '%' : '—'}</td>
      <td>${num(convert.gas(r.gas), 0)}</td>
      <td>${num(convert.water(r.water), 0)}</td>
    </tr>`).join('')}</tbody>`;

  lastCols = [dim, 'oil_' + units.oil(), 'gas_' + units.gas(), 'water_' + units.water()];
  lastRows = agg.map(r => ({
    [dim]: r[dim],
    ['oil_' + units.oil()]: convert.oil(r.oil),
    ['gas_' + units.gas()]: convert.gas(r.gas),
    ['water_' + units.water()]: convert.water(r.water),
  }));
}

function exportCSV() {
  downloadCSV(`argentina_${dim}_selection.csv`,
              toCSV(lastRows, lastCols, CITATION));
}
