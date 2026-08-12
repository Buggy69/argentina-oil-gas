/* Statistics — the descriptive layer.

   The single most important thing on this page is the UNIT OF OBSERVATION
   banner. "Mean oil production" means something completely different per
   well-month and per well, and a dashboard that does not say which it is
   showing is not reporting a statistic, it is producing a number. Every panel
   here states its unit explicitly.

   p10 is the LOW value — the statistical convention, stated in the header of
   the table rather than left for the reader to infer. */

import { getSource, selectRows } from '../query.js';
import { queryFilters } from '../state.js';
import { compact, num, convert, units, esc, pct } from '../format.js';
import { draw, baseOption, merge, barSeries, lineSeries } from '../charts.js';
import { describe, histogram, lorenz, correlationMatrix, topShare } from '../stats.js';
import { label as i18nLabel } from '../i18n.js';

const MEASURES = [
  ['cum_oil_m3', 'Cumulative oil', 'oil'],
  ['cum_gas_e3m3', 'Cumulative gas', 'gas'],
  ['cum_water_m3', 'Cumulative water', 'water'],
  ['depth_m', 'Well depth', 'length'],
  ['lateral_m', 'Lateral length', 'length'],
  ['stages', 'Fracture stages', 'raw'],
  ['proppant_t', 'Proppant mass (t)', 'raw'],
  ['proppant_kg_per_m', 'Proppant intensity (kg/m)', 'raw'],
  ['stage_spacing_m', 'Stage spacing (m)', 'raw'],
  ['producing_months', 'Producing months', 'raw'],
  ['gor_m3_m3', 'GOR (m³/m³)', 'raw'],
];

let measure = 'cum_oil_m3';
let logScale = true;
let groupDim = 'trajectory';

export function render(root, ctx) {
  root.innerHTML = `
    <div class="grid">
      <section class="card">
        <div class="controls">
          <label>Variable
            <select id="st-measure">${MEASURES.map(([v, l]) =>
              `<option value="${v}"${v === measure ? ' selected' : ''}>${l}</option>`).join('')}
            </select>
          </label>
          <label>Compare across
            <select id="st-group">
              <option value="trajectory">Trajectory</option>
              <option value="sub_tipo_recurso">Resource subtype</option>
              <option value="cuenca">Basin</option>
              <option value="well_fluid">Well fluid type</option>
            </select>
          </label>
          <span class="seg" role="group" aria-label="Axis scale">
            <button id="st-log" aria-pressed="${logScale}">Log scale</button>
            <button id="st-lin" aria-pressed="${!logScale}">Linear</button>
          </span>
        </div>
        <div class="callout" id="st-unit-banner"></div>
      </section>

      <section class="card">
        <h2>Descriptive statistics</h2>
        <p class="note"><strong>p10 is the low value</strong> (statistical
          convention: p10 &lt; p50 &lt; p90). “Missing” counts wells with no
          value for this variable — never treated as zero.</p>
        <div class="scroll-x"><table class="data" id="st-table"></table></div>
      </section>

      <section class="card half">
        <h2>Distribution</h2>
        <p class="note" id="st-hist-note"></p>
        <div id="st-hist" class="chart"></div>
      </section>

      <section class="card half">
        <h2>Concentration — Lorenz curve</h2>
        <p class="note">How unevenly the selected variable is distributed across
          wells. The straight line is perfect equality; the further the curve
          sags below it, the more the total rests on a few wells.</p>
        <div id="st-lorenz" class="chart"></div>
        <p class="source" id="st-gini"></p>
      </section>

      <section class="card">
        <h2>Correlation between well-level variables</h2>
        <p class="note">Unit of observation: <strong>one well</strong>. Pearson
          below the diagonal, Spearman (rank) above it. They are shown together
          on purpose — production data is heavily skewed, so a Pearson value can
          be driven by a handful of giant wells while Spearman describes the bulk.</p>
        <div class="scroll-x"><table class="data" id="st-corr"></table></div>
      </section>
    </div>`;

  root.querySelector('#st-measure').addEventListener('change', e => {
    measure = e.target.value; update(root, ctx);
  });
  root.querySelector('#st-group').addEventListener('change', e => {
    groupDim = e.target.value; update(root, ctx);
  });
  root.querySelector('#st-log').addEventListener('click', () => {
    logScale = true; sync(root); update(root, ctx);
  });
  root.querySelector('#st-lin').addEventListener('click', () => {
    logScale = false; sync(root); update(root, ctx);
  });

  update(root, ctx);
}

function sync(root) {
  root.querySelector('#st-log').setAttribute('aria-pressed', String(logScale));
  root.querySelector('#st-lin').setAttribute('aria-pressed', String(!logScale));
}

/** Convert a stored value into display units for the chosen measure. */
function conv(v, kind) {
  if (v == null) return null;
  return kind === 'oil' ? convert.oil(v)
       : kind === 'gas' ? convert.gas(v)
       : kind === 'water' ? convert.water(v)
       : kind === 'length' ? convert.length(v)
       : v;
}
function unitLabel(kind) {
  return kind === 'oil' ? units.oil() : kind === 'gas' ? units.gas()
       : kind === 'water' ? units.water() : kind === 'length' ? units.length() : '';
}

export function update(root, ctx) {
  const wells = getSource('wells');
  const idx = selectRows('wells', queryFilters(null));
  const [, mLabel, kind] = MEASURES.find(m => m[0] === measure);
  const u = unitLabel(kind);

  root.querySelector('#st-unit-banner').innerHTML =
    `<strong>Unit of observation: one well.</strong> ${num(idx.length)} wells in
     the current selection. Every figure on this page is a statistic over wells,
     not over well-months — a well producing for 15 years counts once.`;

  const col = wells.cols[measure];
  const values = idx.map(i => conv(col?.values[i], kind));

  /* --- descriptive table, overall and by group ------------------------- */
  const gcol = wells.cols[groupDim];
  const groups = new Map();
  if (gcol && gcol.kind === 'cat') {
    for (const i of idx) {
      const k = gcol.codes[i] >= 0 ? gcol.dict[gcol.codes[i]] : '(sin dato)';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(conv(col?.values[i], kind));
    }
  }
  const rows = [['All selected wells', describe(values)]]
    .concat([...groups.entries()]
      .map(([k, v]) => [k, describe(v)])
      .sort((a, b) => b[1].n - a[1].n));

  root.querySelector('#st-table').innerHTML = `
    <thead><tr>
      <th>${esc(mLabel)}${u ? ' (' + u + ')' : ''}</th>
      <th>n</th><th>missing</th><th>mean</th><th>sd</th>
      <th>min</th><th>p10</th><th>p25</th><th>median</th><th>p75</th><th>p90</th><th>max</th>
    </tr></thead>
    <tbody>${rows.map(([k, d]) => `<tr>
      <td>${esc(k === 'All selected wells' ? k : i18nLabel(groupDim, k))}</td><td>${num(d.n)}</td><td>${num(d.missing)}</td>
      <td>${compact(d.mean, 2)}</td><td>${compact(d.sd, 2)}</td>
      <td>${compact(d.min, 2)}</td><td>${compact(d.p10, 2)}</td>
      <td>${compact(d.p25, 2)}</td><td>${compact(d.p50, 2)}</td>
      <td>${compact(d.p75, 2)}</td><td>${compact(d.p90, 2)}</td>
      <td>${compact(d.max, 2)}</td>
    </tr>`).join('')}</tbody>`;

  /* --- histogram -------------------------------------------------------- */
  const h = histogram(values, { log: logScale });
  const s1 = getComputedStyle(document.documentElement).getPropertyValue('--s1').trim();
  root.querySelector('#st-hist-note').innerHTML =
    `${esc(mLabel)}${u ? ' in ' + u : ''}, ${h.bins.length} bins by the
     Freedman–Diaconis rule (driven by the interquartile range, so a few
     outsized wells cannot flatten the rest into one bar).
     ${logScale ? 'Log₁₀ axis; zero and negative values are excluded from a log view.' : ''}`;

  draw(root.querySelector('#st-hist'), merge(baseOption(), {
    legend: { show: false }, grid: { bottom: 12 },
    tooltip: { trigger: 'axis',
      formatter: (ps) => {
        const b = h.bins[ps[0].dataIndex];
        const lo = logScale ? Math.pow(10, b.x0) : b.x0;
        const hi = logScale ? Math.pow(10, b.x1) : b.x1;
        return `${compact(lo, 2)} – ${compact(hi, 2)} ${u}<br>${num(b.n)} wells`;
      } },
    xAxis: { type: 'category', data: h.bins.map(b =>
        logScale ? compact(Math.pow(10, b.x0), 1) : compact(b.x0, 1)),
      axisLabel: { interval: Math.ceil(h.bins.length / 8) } },
    yAxis: { type: 'value', name: 'wells', nameTextStyle: { fontSize: 11,
      color: getComputedStyle(document.documentElement).getPropertyValue('--ink-muted').trim() },
      axisLabel: { formatter: v => compact(v, 0) } },
    series: [barSeries('wells', h.bins.map(b => b.n), s1)],
  }));

  /* --- Lorenz ----------------------------------------------------------- */
  const lz = lorenz(values);
  const s2 = getComputedStyle(document.documentElement).getPropertyValue('--s2').trim();
  const axisColor = getComputedStyle(document.documentElement).getPropertyValue('--axis').trim();
  draw(root.querySelector('#st-lorenz'), merge(baseOption(), {
    legend: { show: false }, grid: { bottom: 12 },
    tooltip: { trigger: 'axis',
      formatter: ps => ps.map(p =>
        `${p.seriesName}: ${p.value[1].toFixed(1)}% of total from the lowest ${p.value[0].toFixed(0)}% of wells`).join('<br>') },
    xAxis: { type: 'value', max: 100, name: '% of wells (lowest first)',
      nameLocation: 'middle', nameGap: 26,
      nameTextStyle: { fontSize: 11, color: axisColor },
      axisLabel: { formatter: v => v + '%' } },
    yAxis: { type: 'value', max: 100, axisLabel: { formatter: v => v + '%' } },
    series: [
      lineSeries('Perfect equality', [[0, 0], [100, 100]], axisColor,
        { lineStyle: { width: 1, color: axisColor } }),
      lineSeries('Observed', lz.curve, s2, { areaStyle: { color: s2, opacity: 0.14 } }),
    ],
  }));
  const ts = topShare(values, 0.05);
  root.querySelector('#st-gini').textContent = lz.gini == null
    ? 'Not enough positive values to compute concentration.'
    : `Gini ${lz.gini.toFixed(3)} over ${num(lz.n)} wells with a positive value. `
      + (ts ? `The top 5% (${num(ts.wells)} wells) hold ${ts.share.toFixed(1)}% of the total.` : '');

  /* --- correlation matrix ---------------------------------------------- */
  const corrVars = ['cum_oil_m3', 'cum_gas_e3m3', 'lateral_m', 'stages',
                    'proppant_t', 'depth_m', 'producing_months'];
  const label = (k) => MEASURES.find(m => m[0] === k)?.[1] ?? k;
  // Typed arrays, and the matrix computed once — see the performance note in
  // stats.js. Building these as ordinary arrays and correlating per table cell
  // is enough to lock up the tab at this row count.
  const series = corrVars.map(v => {
    const src = wells.cols[v]?.values;
    const out = new Float64Array(idx.length);
    for (let k = 0; k < idx.length; k++) out[k] = src ? src[idx[k]] : NaN;
    return out;
  });
  const M = correlationMatrix(series);

  // Diverging blue<->red with a neutral midpoint: two hues that read as
  // opposite, never a rainbow, never a hue at zero.
  const posHue = getComputedStyle(document.documentElement).getPropertyValue('--s1').trim();
  const negHue = getComputedStyle(document.documentElement).getPropertyValue('--s8').trim();
  const cell = (r) => {
    if (r == null) return { bg: 'transparent', text: '—' };
    const mag = Math.min(1, Math.abs(r));
    const hue = r >= 0 ? posHue : negHue;
    return { bg: hue + Math.round(mag * 170).toString(16).padStart(2, '0'),
             text: r.toFixed(2) };
  };

  root.querySelector('#st-corr').innerHTML = `
    <thead><tr><th></th>${corrVars.map(v => `<th>${esc(label(v))}</th>`).join('')}</tr></thead>
    <tbody>${corrVars.map((rv, i) => `<tr><td>${esc(label(rv))}</td>${
      corrVars.map((cv, j) => {
        if (i === j) return `<td style="color:var(--ink-muted)">1.00</td>`;
        const r = j > i ? M.spearman[i][j] : M.pearson[i][j];
        const c = cell(r);
        return `<td style="background:${c.bg}">${c.text}</td>`;
      }).join('')}</tr>`).join('')}</tbody>`;
}
