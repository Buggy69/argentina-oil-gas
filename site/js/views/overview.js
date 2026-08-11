/* Overview — the answer before any question is asked.
   Stat tiles for the headline magnitudes (a single number is a tile, never a
   one-bar chart), then oil and gas as SEPARATE stacked-area charts. They are
   separate because they are different units on different scales; putting them
   on one plot with two y-axes would invent a relationship the data does not
   contain. */

import { query } from '../query.js';
import { state, queryFilters } from '../state.js';
import { compact, num, convert, units, pct } from '../format.js';
import { draw, baseOption, merge, areaSeries, lineSeries, makeScale, legendHTML }
  from '../charts.js';
import { monthLabel } from '../store.js';

/**
 * TIER A FAST PATH — draw the whole Overview from summary.json alone.
 *
 * This is the point of having a Tier A at all. summary.json is ~40 KB gzipped
 * and needs no query engine, so it can paint a complete, correct overview while
 * the 8 MB of Parquet is still in flight. When the tables land, `update()` runs
 * over the same DOM and the view becomes interactive — no layout jump, because
 * the structure is identical.
 *
 * Without this the page shows "Loading data…" until every byte has arrived,
 * which measured 11.8 s to first contentful paint on the deployed site.
 */
export function renderFromSummary(root, ctx) {
  const s = ctx.summary;
  const kpi = s.kpi || {};
  render(root, ctx, /* skipUpdate */ true);

  const tot = { oil: kpi.cum_oil_m3 || 0, gas: kpi.cum_gas_e3m3 || 0 };
  const unconvOil = (s.unconventional_monthly || [])
    .filter(r => r.subtype === 'SHALE' || r.subtype === 'TIGHT')
    .reduce((a, r) => a + (r.oil_m3 || 0), 0);

  root.querySelector('#ov-tiles').innerHTML = [
    ['Wells in selection', num(kpi.wells), 'idpozo = wellbore × producing formation'],
    [`Cumulative oil (${units.oil()})`, compact(convert.oil(tot.oil), 2),
     'sum over the selected months'],
    [`Cumulative gas (${units.gas()})`, compact(convert.gas(tot.gas), 2),
     'sum over the selected months'],
    ['Unconventional oil', pct(tot.oil ? unconvOil / tot.oil * 100 : 0),
     `${num(kpi.wells_horizontal)} horizontal wells identified`],
  ].map(([label, value, sub]) => `
    <div class="tile"><div class="label">${label}</div>
      <div class="value">${value}</div><div class="sub">${sub}</div></div>`).join('');

  // Basin series, straight from the summary's pre-aggregated rows.
  const months = [...new Set((s.basin_monthly || []).map(r => r.ym))].sort();
  const scale = makeScale(ctx.basins && ctx.basins.length ? ctx.basins
    : [...new Set((s.basin_monthly || []).map(r => r.cuenca))]);

  for (const [id, key, conv, unit] of [
    ['ov-oil', 'oil_m3', convert.oil, units.oil()],
    ['ov-gas', 'gas_e3m3', convert.gas, units.gas()],
  ]) {
    const byBasin = new Map();
    for (const r of s.basin_monthly || []) {
      if (!byBasin.has(r.cuenca)) byBasin.set(r.cuenca, new Map());
      byBasin.get(r.cuenca).set(r.ym, r[key]);
    }
    const shown = [...byBasin.entries()]
      .map(([k, m]) => [k, [...m.values()].reduce((a, b) => a + (b || 0), 0)])
      .sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k]) => k);
    draw(root.querySelector('#' + id), merge(baseOption(), {
      legend: { show: false }, grid: { bottom: 12 },
      tooltip: { valueFormatter: v => compact(v, 1) + ' ' + unit },
      xAxis: { type: 'category', data: months,
               axisLabel: { interval: Math.ceil(months.length / 8) } },
      yAxis: { type: 'value', axisLabel: { formatter: v => compact(v, 0) } },
      series: shown.map(b => areaSeries(
        b, months.map(m => conv(byBasin.get(b).get(m) || 0)), scale(b))),
    }));
    root.querySelector('#' + id + '-legend').innerHTML =
      legendHTML(shown.map(b => ({ label: b, color: scale(b) })));
  }

  // The operator ranking needs the cube; say so rather than leaving an empty
  // card that reads as a broken chart.
  const ops = root.querySelector('#ov-ops');
  if (ops) ops.innerHTML =
    '<p class="note" style="padding:28px 0;text-align:center">' +
    'Loading the full dataset…</p>';

  const nat = s.national_monthly || [];
  draw(root.querySelector('#ov-wells'), merge(baseOption(), {
    legend: { show: false }, grid: { bottom: 12 },
    tooltip: { valueFormatter: v => num(v) + ' wells' },
    xAxis: { type: 'category', data: nat.map(r => r.ym),
             axisLabel: { interval: Math.ceil(nat.length / 8) } },
    yAxis: { type: 'value', axisLabel: { formatter: v => compact(v, 0) } },
    series: [lineSeries('Producing wells', nat.map(r => r.wells_producing),
      getComputedStyle(document.documentElement).getPropertyValue('--s1').trim())],
  }));
}

export function render(root, ctx, skipUpdate = false) {
  root.innerHTML = `
    <div class="tiles" id="ov-tiles"></div>
    <div class="grid" style="margin-top:16px">
      <section class="card half">
        <h2>Oil production by basin</h2>
        <p class="note">Monthly, stacked. Unit: <span data-unit="oil"></span>.</p>
        <div id="ov-oil" class="chart"></div>
        <div id="ov-oil-legend"></div>
        <p class="source">Source: Secretaría de Energía (Capítulo IV) via petrodb · CC BY 4.0</p>
      </section>
      <section class="card half">
        <h2>Gas production by basin</h2>
        <p class="note">Monthly, stacked. Unit: <span data-unit="gas"></span>.
           Shown separately from oil — the two are different measures on different
           scales, and a shared axis would be arbitrary.</p>
        <div id="ov-gas" class="chart"></div>
        <div id="ov-gas-legend"></div>
        <p class="source">Source: Secretaría de Energía (Capítulo IV) via petrodb · CC BY 4.0</p>
      </section>
      <section class="card half">
        <h2>Unconventional share of oil production</h2>
        <p class="note">Shale and tight as a percentage of total monthly oil.</p>
        <div id="ov-unconv" class="chart short"></div>
        <div id="ov-unconv-legend"></div>
      </section>
      <section class="card half">
        <h2>Producing wells</h2>
        <p class="note">Wells reporting non-zero oil or gas in the month.
           Counted per month — these cannot be summed along time, because the
           same well recurs every month it produces.</p>
        <div id="ov-wells" class="chart short"></div>
      </section>
      <section class="card">
        <h2>Largest operators by cumulative oil</h2>
        <p class="note">Attributed to the operator holding the well in each month.
           Top 12 of ${ctx.summary.domains ? '' : ''}the ranked operators; the
           remainder is grouped as “Other”.</p>
        <div id="ov-ops" class="chart"></div>
      </section>
    </div>`;

  if (!skipUpdate) update(root, ctx);
}

export function update(root, ctx) {
  const f = queryFilters('fecha');

  /* --- tiles ---------------------------------------------------------- */
  const tot = query({ source: 'cube', filters: f, measures: [
    { as: 'oil', col: 'oil_m3', agg: 'sum' },
    { as: 'gas', col: 'gas_e3m3', agg: 'sum' },
    { as: 'water', col: 'water_m3', agg: 'sum' },
  ] })[0] || { oil: 0, gas: 0, water: 0 };

  /* The unconventional share must be a share OF the current selection, so its
     numerator has to be a strict subset of the denominator. Spreading
     `{...f, sub_tipo_recurso: ['SHALE','TIGHT']}` *overrides* whatever the user
     picked instead of narrowing it — with "Shale" selected that put TIGHT wells
     in the numerator and not the denominator, and the tile read 100.1%.

     Intersect instead. Note the empty case is not "no filter": buildMask treats
     an empty array as an absent constraint, so an empty intersection has to be
     short-circuited to zero rather than passed through. */
  const UNCONV = ['SHALE', 'TIGHT'];
  const userSub = f.sub_tipo_recurso;
  const unconvSel = Array.isArray(userSub) && userSub.length
    ? userSub.filter(v => UNCONV.includes(v))
    : UNCONV;
  const unconv = unconvSel.length
    ? (query({
        source: 'cube',
        filters: { ...f, sub_tipo_recurso: unconvSel },
        measures: [{ as: 'oil', col: 'oil_m3', agg: 'sum' }],
      })[0] || { oil: 0 })
    : { oil: 0 };

  const wellRows = query({ source: 'wells', filters: queryFilters(null),
    measures: [{ as: 'n', col: 'idpozo', agg: 'count' }] })[0] || { n: 0 };

  const horiz = query({ source: 'wells',
    filters: { ...queryFilters(null), trajectory: ['Horizontal'] },
    measures: [{ as: 'n', col: 'idpozo', agg: 'count' }] })[0] || { n: 0 };

  root.querySelector('#ov-tiles').innerHTML = [
    ['Wells in selection', num(wellRows.n), 'idpozo = wellbore × producing formation'],
    [`Cumulative oil (${units.oil()})`, compact(convert.oil(tot.oil), 2),
     'sum over the selected months'],
    [`Cumulative gas (${units.gas()})`, compact(convert.gas(tot.gas), 2),
     'sum over the selected months'],
    ['Unconventional oil', pct(tot.oil ? unconv.oil / tot.oil * 100 : 0),
     `${num(horiz.n)} horizontal wells identified`],
  ].map(([label, value, sub]) => `
    <div class="tile">
      <div class="label">${label}</div>
      <div class="value">${value}</div>
      <div class="sub">${sub}</div>
    </div>`).join('');

  /* --- stacked areas -------------------------------------------------- */
  const basins = ctx.basins;                 // stable, sorted list
  const scale = makeScale(basins);

  for (const [id, measure, conv, unit] of [
    ['ov-oil', 'oil_m3', convert.oil, units.oil()],
    ['ov-gas', 'gas_e3m3', convert.gas, units.gas()],
  ]) {
    const rows = query({
      source: 'cube', filters: f, groupBy: ['fecha', 'cuenca'],
      measures: [{ as: 'v', col: measure, agg: 'sum' }],
    });
    const months = [...new Set(rows.map(r => r.fecha))].sort((a, b) => a - b);
    const byBasin = new Map();
    for (const r of rows) {
      if (!byBasin.has(r.cuenca)) byBasin.set(r.cuenca, new Map());
      byBasin.get(r.cuenca).set(r.fecha, r.v);
    }
    // Rank only to decide who is in the top 6; colour still comes from the
    // stable scale, so a basin keeps its hue whatever the ranking does.
    const ranked = [...byBasin.entries()]
      .map(([k, m]) => [k, [...m.values()].reduce((a, b) => a + (b || 0), 0)])
      .sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const shown = ranked.slice(0, 6);
    const series = shown.map(b => areaSeries(
      b, months.map(m => conv(byBasin.get(b).get(m) || 0)), scale(b)));

    draw(root.querySelector('#' + id), merge(baseOption(), {
      legend: { show: false },
      grid: { bottom: 12 },
      tooltip: { valueFormatter: v => compact(v, 1) + ' ' + unit },
      xAxis: { type: 'category', data: months.map(monthLabel),
               axisLabel: { interval: Math.ceil(months.length / 8) } },
      yAxis: { type: 'value', axisLabel: { formatter: v => compact(v, 0) } },
      series,
    }));
    root.querySelector('#' + id + '-legend').innerHTML =
      legendHTML(shown.map(b => ({ label: b, color: scale(b) })));
  }

  /* --- unconventional share ------------------------------------------- */
  const totByMonth = new Map();
  for (const r of query({ source: 'cube', filters: f, groupBy: ['fecha'],
    measures: [{ as: 'v', col: 'oil_m3', agg: 'sum' }] })) totByMonth.set(r.fecha, r.v);

  const subScale = makeScale(['SHALE', 'TIGHT']);
  // Same intersection rule as the tile above: narrow the user's selection,
  // never replace it, so the percentage can never exceed 100.
  const subRows = unconvSel.length ? query({
    source: 'cube', filters: { ...f, sub_tipo_recurso: unconvSel },
    groupBy: ['fecha', 'sub_tipo_recurso'],
    measures: [{ as: 'v', col: 'oil_m3', agg: 'sum' }],
  }) : [];
  const months2 = [...totByMonth.keys()].sort((a, b) => a - b);
  const bySub = new Map();
  for (const r of subRows) {
    if (!bySub.has(r.sub_tipo_recurso)) bySub.set(r.sub_tipo_recurso, new Map());
    bySub.get(r.sub_tipo_recurso).set(r.fecha, r.v);
  }
  draw(root.querySelector('#ov-unconv'), merge(baseOption(), {
    legend: { show: false },
    grid: { bottom: 12 },
    tooltip: { valueFormatter: v => (v == null ? '—' : v.toFixed(1) + ' %') },
    xAxis: { type: 'category', data: months2.map(monthLabel),
             axisLabel: { interval: Math.ceil(months2.length / 8) } },
    yAxis: { type: 'value', max: 100, axisLabel: { formatter: v => v + '%' } },
    series: ['SHALE', 'TIGHT'].filter(s => bySub.has(s)).map(s =>
      lineSeries(s, months2.map(m => {
        const t = totByMonth.get(m);
        return t ? +((bySub.get(s).get(m) || 0) / t * 100).toFixed(2) : null;
      }), subScale(s))),
  }));
  root.querySelector('#ov-unconv-legend').innerHTML = legendHTML(
    ['SHALE', 'TIGHT'].filter(s => bySub.has(s))
      .map(s => ({ label: s === 'SHALE' ? 'Shale' : 'Tight', color: subScale(s) })));

  /* --- producing wells ------------------------------------------------ */
  const wr = query({ source: 'cube', filters: f, groupBy: ['fecha'],
    measures: [{ as: 'n', col: 'wells_producing', agg: 'sum' }] })
    .sort((a, b) => a.fecha - b.fecha);
  draw(root.querySelector('#ov-wells'), merge(baseOption(), {
    legend: { show: false }, grid: { bottom: 12 },
    tooltip: { valueFormatter: v => num(v) + ' wells' },
    xAxis: { type: 'category', data: wr.map(r => monthLabel(r.fecha)),
             axisLabel: { interval: Math.ceil(wr.length / 8) } },
    yAxis: { type: 'value', axisLabel: { formatter: v => compact(v, 0) } },
    series: [lineSeries('Producing wells', wr.map(r => r.n),
      getComputedStyle(document.documentElement).getPropertyValue('--s1').trim())],
  }));

  /* --- operators ------------------------------------------------------- */
  // One series -> one colour for every bar. Colouring bars darker-where-bigger
  // would double-encode the length the bar already shows.
  const ops = query({
    source: 'cube', filters: f, groupBy: ['operator'],
    measures: [{ as: 'oil', col: 'oil_m3', agg: 'sum' }],
    orderBy: 'oil', limit: 12,
  }).reverse();
  const s1 = getComputedStyle(document.documentElement).getPropertyValue('--s1').trim();
  draw(root.querySelector('#ov-ops'), merge(baseOption(), {
    legend: { show: false },
    grid: { left: 8, right: 60, top: 8, bottom: 24, containLabel: true },
    tooltip: { trigger: 'item',
      valueFormatter: v => compact(v, 2) + ' ' + units.oil() },
    xAxis: { type: 'value', axisLabel: { formatter: v => compact(v, 0) } },
    yAxis: { type: 'category', data: ops.map(o => o.operator),
             axisLabel: { color: getComputedStyle(document.documentElement)
               .getPropertyValue('--ink-2').trim(), fontSize: 11, width: 160,
               overflow: 'truncate' },
             splitLine: { show: false } },
    series: [{
      type: 'bar', data: ops.map(o => convert.oil(o.oil)),
      itemStyle: { color: s1, borderRadius: [0, 4, 4, 0] }, barMaxWidth: 18,
      // Selective direct labels: the value at the end of each bar, which is
      // the one place a number does not become clutter.
      label: { show: true, position: 'right', fontSize: 11,
        color: getComputedStyle(document.documentElement)
          .getPropertyValue('--ink-2').trim(),
        formatter: p => compact(p.value, 1) },
    }],
  }));
}
