/* Statistics — the descriptive layer.

   The single most important thing on this page is the UNIT OF OBSERVATION
   banner. "Mean oil production" means something completely different per
   well-month and per well, and a dashboard that does not say which it is
   showing is not reporting a statistic, it is producing a number. Every panel
   here states its unit explicitly.

   p10 is the LOW value — the statistical convention, stated in the header of
   the table rather than left for the reader to infer. */

import { getSource, selectRows, valueAt } from '../query.js?v=a9872ab70a';
import { queryFilters } from '../state.js?v=a9872ab70a';
import { compact, num, convert, units, esc, pct, axisNum } from '../format.js?v=a9872ab70a';
import { draw, baseOption, merge, barSeries, lineSeries } from '../charts.js?v=a9872ab70a';
import { describe, histogram, lorenz, correlationMatrix, topShare,
         quantileSorted } from '../stats.js?v=a9872ab70a';
import { label as i18nLabel } from '../i18n.js?v=a9872ab70a';

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
        <p class="selection" data-selection></p>
        <p class="note"><strong>p10 is the low value</strong> (statistical
          convention: p10 &lt; p50 &lt; p90). “Missing” counts wells with no
          value for this variable — never treated as zero.</p>
        <div class="scroll-x"><table class="data" id="st-table"></table></div>
      </section>

      <section class="card half">
        <h2>Distribution</h2>
        <p class="selection" data-selection></p>
        <p class="note" id="st-hist-note"></p>
        <div id="st-hist" class="chart"></div>
      </section>

      <section class="card half">
        <h2>Concentration — Lorenz curve</h2>
        <p class="selection" data-selection></p>
        <p class="note">How unevenly the selected variable is distributed across
          wells. The straight line is perfect equality; the further the curve
          sags below it, the more the total rests on a few wells.</p>
        <div id="st-lorenz" class="chart"></div>
        <p class="source" id="st-gini"></p>
      </section>

      <section class="card">
        <h2>Water by producing formation</h2>
        <p class="selection" data-selection></p>
        <p class="note">Where the water comes from, stratigraphically, as far as
          public data allows. <strong>The data has no perforation depths, no
          formation tops and no TVD of the water entry.</strong> What it has is
          each well's producing formation, its total depth and its elevation. So:
          each bubble is one formation, placed at its lifetime water cut (liquid
          basis, water ÷ (oil + water)) and at the <em>median total depth minus
          elevation</em> of its <strong>measured-vertical</strong> wells — for a
          vertical well that approximates the subsea depth of its bottom, not of
          its perforations. Formations with fewer than 3 such wells have no
          depth and appear only in the table; a negative value means the well
          bottoms above sea level (high ground, shallow well). The order is a
          depth proxy within a basin, not a stratigraphic column — structure
          moves a formation up and down across a basin. Bubble area ∝
          cumulative water.
          Lifetime per-well totals: the Period filter does not apply here.</p>
        <div id="st-wf" class="chart"></div>
        <div class="scroll-x"><table class="data" id="st-wf-table"></table></div>
      </section>

      <section class="card">
        <h2>Correlation between well-level variables</h2>
        <p class="selection" data-selection></p>
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
      axisLabel: { formatter: axisNum } },
    series: [barSeries('wells', h.bins.map(b => b.n), s1)],
  }));

  /* --- Lorenz ----------------------------------------------------------- */
  const lz = lorenz(values);
  const s2 = getComputedStyle(document.documentElement).getPropertyValue('--s2').trim();
  const axisColor = getComputedStyle(document.documentElement).getPropertyValue('--axis').trim();
  draw(root.querySelector('#st-lorenz'), merge(baseOption(), {
    legend: { show: false }, grid: { bottom: 42 },   // room for the axis title
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

  waterByFormation(root, wells, idx);
}

/* --- water by producing formation --------------------------------------- */

const MIN_VERT = 3;   // fewer measured-vertical wells than this: no depth

/**
 * One row per producing formation in the selection: lifetime oil, water and
 * injected water summed over its wells, and the distribution of (total depth
 * − elevation) over its MEASURED-vertical wells only. Directional and
 * horizontal depths are measured depth along the hole, and "Unknown"
 * trajectories are never imputed (CLAUDE.md), so neither enters the depth.
 */
function waterByFormation(root, wells, idx) {
  const C = wells.cols;
  const by = new Map();
  for (const i of idx) {
    const f = valueAt(wells, 'formation', i) ?? '(sin dato)';
    let r = by.get(f);
    if (!r) by.set(f, r = { f, wells: 0, oil: 0, water: 0, inj: 0, depths: [] });
    r.wells++;
    r.oil += C.cum_oil_m3.values[i] || 0;
    r.water += C.cum_water_m3.values[i] || 0;
    r.inj += C.cum_water_inj_m3?.values[i] || 0;
    const d = C.depth_m.values[i], z = C.elevation_m?.values[i];
    if (valueAt(wells, 'trajectory_class', i) === 'Vertical'
        && Number.isFinite(d) && d > 0 && Number.isFinite(z)) r.depths.push(d - z);
  }
  const rows = [...by.values()].filter(r => r.water > 0 || r.inj > 0);
  for (const r of rows) {
    r.wc = r.oil + r.water > 0 ? 100 * r.water / (r.oil + r.water) : null;
    r.depths.sort((a, b) => a - b);
    r.d = r.depths.length >= MIN_VERT
      ? { p10: quantileSorted(r.depths, 0.1), p50: quantileSorted(r.depths, 0.5),
          p90: quantileSorted(r.depths, 0.9) } : null;
  }
  // Shallow → deep where a depth exists (a proxy for stratigraphic order
  // within one basin, not a stratigraphic column), the rest by water volume.
  rows.sort((a, b) => (a.d && b.d) ? a.d.p50 - b.d.p50
    : a.d ? -1 : b.d ? 1 : b.water - a.water);

  const len = v => convert.length(v);
  const placed = rows.filter(r => r.d && r.wc != null);
  const wMax = Math.max(1, ...placed.map(r => r.water));
  // Name the eight biggest water producers on the chart; the tooltip names all.
  const named = new Set([...placed].sort((a, b) => b.water - a.water).slice(0, 8).map(r => r.f));
  const color = getComputedStyle(document.documentElement).getPropertyValue('--s1').trim();
  draw(root.querySelector('#st-wf'), merge(baseOption(), {
    legend: { show: false },
    grid: { left: 64, right: 24, top: 40, bottom: 46 },
    tooltip: { trigger: 'item', formatter: p => {
      const r = p.data.r;
      return `<strong>${esc(i18nLabel('formation', r.f))}</strong><br>` +
        `Water cut ${num(r.wc, 1)} % · cum water ${compact(convert.water(r.water), 2)} ${units.water()}<br>` +
        `TD − elevation, ${num(r.depths.length)} vertical wells: P10 ${num(len(r.d.p10))} · ` +
        `P50 ${num(len(r.d.p50))} · P90 ${num(len(r.d.p90))} ${units.length()}`;
    } },
    xAxis: { type: 'value', min: 0, max: 100, name: 'lifetime water cut (%)',
             nameLocation: 'middle', nameGap: 28, nameTextStyle: { fontSize: 11 } },
    // Depth increases downward. On an inverted axis the default name position
    // ('end') is the BOTTOM, where it collided with the x-axis title; 'start'
    // puts it at the top, above the shallowest values.
    yAxis: { type: 'value', inverse: true, nameLocation: 'start',
             name: `median TD − elevation, vertical wells (${units.length()})`,
             nameTextStyle: { fontSize: 11, align: 'left' } },
    series: [{
      type: 'scatter',
      data: placed.map(r => ({ value: [r.wc, len(r.d.p50)], r,
        symbolSize: 8 + 34 * Math.sqrt(r.water / wMax),
        // Most water cuts sit near 100 %, where a right-hand label is clipped.
        label: { show: named.has(r.f), formatter: r.f, position: r.wc > 70 ? 'left' : 'right',
                 fontSize: 10,
                 // Text wears the ink token, never the series colour.
                 color: getComputedStyle(document.documentElement).getPropertyValue('--ink-2').trim() } })),
      itemStyle: { color, opacity: 0.55, borderColor: getComputedStyle(document.documentElement)
        .getPropertyValue('--surface-1').trim(), borderWidth: 2 },
    }],
  }));

  root.querySelector('#st-wf-table').innerHTML = `
    <thead><tr><th>Formation</th><th>Wells</th><th>Cum water (${units.water()})</th>
      <th>Water cut</th><th>Water injected (${units.water()})</th>
      <th>Vertical wells</th>
      <th>TD − elev. P10 / P50 / P90 (${units.length()})</th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td>${esc(i18nLabel('formation', r.f))}</td>
      <td>${num(r.wells)}</td>
      <td>${compact(convert.water(r.water), 2)}</td>
      <td>${r.wc != null ? num(r.wc, 1) + ' %' : '—'}</td>
      <td>${r.inj > 0 ? compact(convert.water(r.inj), 2) : '—'}</td>
      <td>${num(r.depths.length)}</td>
      <td>${r.d ? `${num(len(r.d.p10))} / ${num(len(r.d.p50))} / ${num(len(r.d.p90))}` : '—'}</td>
    </tr>`).join('')}</tbody>`;
}

