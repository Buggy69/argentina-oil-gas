/* Map — 85 k wells at their real coordinates.

   No basemap tiles. Two reasons: a tile server is a third-party host (and this
   page makes no third-party requests by design), and the shape that matters
   here is the shape the wells themselves draw — the basins are legible from
   the drilling pattern alone.

   Colour-by is deliberately restricted to dimensions with at most THREE
   categories. A scatter puts every pair of colours side by side, and the
   palette is only validated colourblind-safe for all pairs up to three slots.
   For anything higher-cardinality the view switches to emphasis — one category
   in colour, the rest in grey — which carries the same information without
   asking hue to do work it cannot do safely. */

import { getSource, selectRows, valueAt } from '../query.js';
import { queryFilters, state } from '../state.js';
import { num, compact, convert, units, esc } from '../format.js';
import { draw, baseOption, merge, palette, OTHER_GREY, legendHTML } from '../charts.js';

const COLOR_BY = [
  ['trajectory', 'Trajectory', 3],
  ['tipo_recurso', 'Resource type', 3],
  ['well_fluid', 'Well fluid type', 3],
  ['cuenca', 'Basin (highlight one)', 99],
];

let colorBy = 'trajectory';
let highlight = null;
let sizeBy = 'cum_oil_m3';

export function render(root, ctx) {
  root.innerHTML = `
    <div class="grid">
      <section class="card">
        <div class="controls">
          <label>Colour by
            <select id="mp-color">${COLOR_BY.map(([v, l]) =>
              `<option value="${v}"${v === colorBy ? ' selected' : ''}>${l}</option>`).join('')}
            </select>
          </label>
          <label>Size by
            <select id="mp-size">
              <option value="cum_oil_m3">Cumulative oil</option>
              <option value="cum_gas_e3m3">Cumulative gas</option>
              <option value="lateral_m">Lateral length</option>
              <option value="none">Uniform</option>
            </select>
          </label>
          <span id="mp-highlight-wrap" hidden>
            <label>Highlight <select id="mp-highlight"></select></label>
          </span>
        </div>
      </section>
      <section class="card">
        <h2>Well locations</h2>
        <p class="note" id="mp-note"></p>
        <div id="mp-chart" class="chart map"></div>
        <div id="mp-legend"></div>
        <p class="source">Coordinates are WGS 84 decimal degrees as published
          (SRID 4326, confirmed by decoding the geometry). Wells without a
          coordinate are omitted and counted below.</p>
      </section>
    </div>`;

  root.querySelector('#mp-color').addEventListener('change', e => {
    colorBy = e.target.value; highlight = null; update(root, ctx);
  });
  root.querySelector('#mp-size').addEventListener('change', e => {
    sizeBy = e.target.value; update(root, ctx);
  });
  root.querySelector('#mp-highlight').addEventListener('change', e => {
    highlight = e.target.value; update(root, ctx);
  });

  update(root, ctx);
}

export function update(root, ctx) {
  const wells = getSource('wells');
  const idx = selectRows('wells', queryFilters(null));
  const lon = wells.cols.lon.values, lat = wells.cols.lat.values;

  const meta = COLOR_BY.find(c => c[0] === colorBy);
  const emphasisMode = meta[2] > 3;
  const gcol = wells.cols[colorBy];

  // In emphasis mode one category is picked out and everything else greys back.
  const hlWrap = root.querySelector('#mp-highlight-wrap');
  hlWrap.hidden = !emphasisMode;
  if (emphasisMode) {
    const domain = wells.domain(colorBy).slice(0, 20);
    if (!highlight) highlight = domain[0]?.value ?? null;
    root.querySelector('#mp-highlight').innerHTML = domain.map(d =>
      `<option value="${esc(d.value)}"${d.value === highlight ? ' selected' : ''}>${esc(d.value)} (${num(d.count)})</option>`).join('');
  }

  const sizeCol = sizeBy === 'none' ? null : wells.cols[sizeBy]?.values;
  let sizeMax = 1;
  if (sizeCol) for (const i of idx) { const v = sizeCol[i]; if (v > sizeMax) sizeMax = v; }

  // Group points by colour class so each class is one series — that is what
  // makes the legend meaningful and lets a class be toggled off.
  /* Argentina's bounding box, the same one the verification report uses.
     Two wells in the source carry coordinates far outside the country. Left in,
     they set the axis extent to roughly 200° of longitude and squash the entire
     country into a few pixels — so a pair of bad rows would silently destroy
     the view for all 84,241 good ones. They are excluded and counted, never
     quietly moved. */
  const BBOX = { lonMin: -74, lonMax: -53, latMin: -56, latMax: -21 };

  const classes = new Map();
  let missing = 0, outside = 0;
  for (const i of idx) {
    const x = lon[i], y = lat[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) { missing++; continue; }
    if (x < BBOX.lonMin || x > BBOX.lonMax || y < BBOX.latMin || y > BBOX.latMax) {
      outside++; continue;
    }
    let key;
    if (emphasisMode) {
      const v = gcol.codes[i] >= 0 ? gcol.dict[gcol.codes[i]] : null;
      key = v === highlight ? highlight : 'Other';
    } else {
      key = gcol.codes[i] >= 0 ? gcol.dict[gcol.codes[i]] : '(sin dato)';
    }
    if (!classes.has(key)) classes.set(key, []);
    // sqrt sizing: the eye reads a disc by area, so radius must scale with the
    // square root of the value or big wells look quadratically bigger.
    const s = sizeCol ? 2 + 7 * Math.sqrt(Math.max(0, sizeCol[i] || 0) / sizeMax) : 3;
    classes.get(key).push([x, y, s, i]);
  }

  const order = [...classes.keys()].filter(k => k !== 'Other' && k !== '(sin dato)').sort();
  const pal = palette();
  const colorOf = (k) => (k === 'Other' || k === '(sin dato)')
    ? OTHER_GREY() : pal[Math.min(order.indexOf(k), 2)] ?? OTHER_GREY();

  const keys = order.concat([...classes.keys()].filter(k => k === 'Other' || k === '(sin dato)'));

  // `large: true` is ECharts' fast path for huge scatters, but it renders every
  // point at ONE size — a function symbolSize is silently ignored and, worse,
  // the layer draws nothing at all. So: large mode only when every marker is
  // the same size anyway; otherwise progressive rendering, which still streams
  // 84 k points onto the canvas in chunks without blocking.
  const uniform = sizeCol == null;
  const series = keys.map(k => ({
    name: k, type: 'scatter',
    ...(uniform
      ? { large: true, largeThreshold: 2000, symbolSize: 4 }
      : { progressive: 6000, progressiveThreshold: 3000,
          symbolSize: (d) => d[2] }),
    data: classes.get(k),
    itemStyle: { color: colorOf(k), opacity: k === 'Other' ? 0.35 : 0.7 },
    emphasis: { itemStyle: { borderColor: getComputedStyle(document.documentElement)
      .getPropertyValue('--surface-1').trim(), borderWidth: 2 } },
  }));

  /* Aspect correction.
     Longitude and latitude are both "degrees", but a degree of longitude spans
     less ground than a degree of latitude, by cos(latitude) — about 0.75 at
     Argentina's mid-latitudes. Plot raw degrees into a wide, short card and the
     country comes out stretched sideways, which is simply a wrong map.

     The fix is to size the PLOT RECTANGLE to the data's true aspect and centre
     it, rather than padding the data range to fill the card. Padding the range
     was the first attempt and it "worked" — at the cost of showing 126° of
     empty ocean either side of a sliver of Argentina. Argentina is tall and
     narrow, so the plot ends up a tall column with margin on both sides, which
     is what an honest equirectangular map of it looks like. */
  let lo = Infinity, hi = -Infinity, la = Infinity, lb = -Infinity;
  for (const pts of classes.values()) for (const p of pts) {
    if (p[0] < lo) lo = p[0]; if (p[0] > hi) hi = p[0];
    if (p[1] < la) la = p[1]; if (p[1] > lb) lb = p[1];
  }
  if (!Number.isFinite(lo)) { lo = -74; hi = -53; la = -56; lb = -21; }
  const padX = (hi - lo) * 0.03, padY = (lb - la) * 0.03;
  lo -= padX; hi += padX; la -= padY; lb += padY;

  const el = root.querySelector('#mp-chart');
  const MARGIN = { left: 52, right: 16, top: 12, bottom: 46 };
  const availW = Math.max(40, el.clientWidth - MARGIN.left - MARGIN.right);
  const availH = Math.max(40, el.clientHeight - MARGIN.top - MARGIN.bottom);
  const kLon = Math.cos((la + lb) / 2 * Math.PI / 180);
  const dataAspect = ((hi - lo) * kLon) / (lb - la);

  let gridW, gridH;
  if (dataAspect < availW / availH) { gridH = availH; gridW = availH * dataAspect; }
  else { gridW = availW; gridH = availW / dataAspect; }
  const gridLeft = MARGIN.left + (availW - gridW) / 2;
  const gridTop = MARGIN.top + (availH - gridH) / 2;

  const shown = idx.length - missing - outside;
  root.querySelector('#mp-note').innerHTML =
    `${num(shown)} wells plotted${missing ? `, ${num(missing)} omitted for having no coordinate` : ''}${outside ? `, ${num(outside)} omitted for plotting outside Argentina` : ''}.
     Marker area is proportional to ${sizeBy === 'none' ? 'nothing (uniform)' :
     esc(({ cum_oil_m3: 'cumulative oil', cum_gas_e3m3: 'cumulative gas',
            lateral_m: 'lateral length' })[sizeBy])}.
     ${emphasisMode ? 'Basin has more than three categories, so this view highlights one against grey rather than assigning colours that would not stay distinguishable for colourblind readers on a scatter.' : ''}`;

  draw(root.querySelector('#mp-chart'), merge(baseOption(), {
    legend: { show: false },
    // containLabel must stay off: it re-flows the grid to fit axis labels,
    // which would undo the aspect ratio computed just above.
    grid: { left: gridLeft, top: gridTop, width: gridW, height: gridH,
            containLabel: false },
    tooltip: {
      trigger: 'item',
      formatter: (p) => {
        const i = p.data[3];
        const oil = valueAt(wells, 'cum_oil_m3', i);
        return `<strong>${esc(valueAt(wells, 'sigla', i) ?? '—')}</strong><br>` +
          `${esc(valueAt(wells, 'cuenca', i) ?? '')} · ${esc(valueAt(wells, 'formation', i) ?? '')}<br>` +
          `${esc(valueAt(wells, 'operator', i) ?? '')}<br>` +
          `${esc(valueAt(wells, 'trajectory', i) ?? '')}` +
          (valueAt(wells, 'lateral_m', i) ? ` · ${num(valueAt(wells, 'lateral_m', i))} m lateral` : '') +
          `<br>Cum oil ${compact(convert.oil(oil), 2)} ${units.oil()}`;
      },
    },
    xAxis: { type: 'value', name: 'longitude', nameLocation: 'middle',
      min: +lo.toFixed(3), max: +hi.toFixed(3),
      nameGap: 24, nameTextStyle: { fontSize: 11 },
      axisLabel: { formatter: v => v.toFixed(1) + '°' },
      splitLine: { show: true, lineStyle: { color: getComputedStyle(document.documentElement)
        .getPropertyValue('--grid').trim(), type: 'solid' } } },
    yAxis: { type: 'value',
      min: +la.toFixed(3), max: +lb.toFixed(3),
      axisLabel: { formatter: v => v.toFixed(1) + '°' } },
    series,
  }));

  root.querySelector('#mp-legend').innerHTML = legendHTML(
    keys.map(k => ({ label: esc(k), color: colorOf(k) })));
}
