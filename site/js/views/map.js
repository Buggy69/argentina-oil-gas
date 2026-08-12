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
import { loadJSON } from '../store.js';
import { label as i18nLabel } from '../i18n.js';

/* The basemap is Argentina's 24 provinces, the national outline and the
   neighbouring countries, compiled into the site at build time from Natural
   Earth (public domain). 117 KB, fetched once when this view first opens —
   there is no tile server anywhere in this application, so the map cannot be
   broken by a filter or an outage that has nothing to do with us. */
let basemapPromise = null;
let neighbourNames = [];

async function ensureBasemap() {
  if (!basemapPromise) {
    basemapPromise = loadJSON('data/geo/basemap.json').then((geo) => {
      neighbourNames = geo.features
        .filter(f => f.properties.layer === 'neighbour')
        .map(f => f.properties.name);
      echarts.registerMap('argentina', geo);
      return geo;
    });
  }
  return basemapPromise;
}

const COLOR_BY = [
  // Horizontal / Directional / Vertical are three coloured slots; Unknown falls
  // to grey, which is not a palette slot — so this stays inside the three-colour
  // limit an all-pairs scatter requires.
  ['trajectory_class', 'Trajectory (H / D / V)', 3],
  ['trajectory', 'Trajectory (measured only)', 3],
  ['tipo_recurso', 'Resource type', 3],
  ['well_fluid', 'Well fluid type', 3],
  ['cuenca', 'Basin (highlight one)', 99],
];

let colorBy = 'trajectory_class';
let highlight = null;
let sizeBy = 'cum_oil_m3';

export async function render(root, ctx) {
  await ensureBasemap();
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
          coordinate are omitted and counted above. Drag to pan, scroll or pinch
          to zoom. Provincial and national boundaries from
          <a href="https://www.naturalearthdata.com/" rel="noopener">Natural Earth</a>
          (public domain), compiled into this page — no map tiles are loaded
          from anywhere.</p>
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
    //
    // The floor is 2.6 px, not 0: production is so skewed that scaling from
    // zero renders the ordinary well — the overwhelming majority — as a
    // sub-pixel dot, and the map showed empty space where 44,000 Golfo San
    // Jorge wells actually are. A visible minimum keeps "a well exists here"
    // legible while area still carries the magnitude.
    const s = sizeCol ? 2.6 + 7 * Math.sqrt(Math.max(0, sizeCol[i] || 0) / sizeMax) : 3;
    classes.get(key).push([x, y, s, i]);
  }

  /* Classes that are an absence of information get grey, not a hue.
     'Unknown' belongs here: it is not a fourth kind of well, it is the wells
     whose kind we cannot state. Leaving it out of this list was a real bug —
     `order` then held four entries, the palette index was clamped at 2, and
     Vertical and Unknown were drawn in the SAME colour.
     Keeping the coloured set at three also holds the map inside the
     three-slot limit an all-pairs scatter needs to stay colourblind-safe. */
  const NEUTRAL = new Set(['Other', '(sin dato)', 'Unknown', 'Not indicated',
                           'No informado']);

  const order = [...classes.keys()].filter(k => !NEUTRAL.has(k)).sort();
  const pal = palette();
  const colorOf = (k) => {
    if (NEUTRAL.has(k)) return OTHER_GREY();
    const i = order.indexOf(k);
    return (i >= 0 && i < 3) ? pal[i] : OTHER_GREY();
  };

  // Coloured classes first, then the neutral ones — the legend reads as
  // "these are the kinds, and this is the remainder".
  const keys = order.concat([...classes.keys()].filter(k => NEUTRAL.has(k)));

  // `large: true` is ECharts' fast path for huge scatters, but it renders every
  // point at ONE size — a function symbolSize is silently ignored and, worse,
  // the layer draws nothing at all. So: large mode only when every marker is
  // the same size anyway; otherwise progressive rendering, which still streams
  // 84 k points onto the canvas in chunks without blocking.
  const uniform = sizeCol == null;
  const series = keys.map(k => ({
    name: k, type: 'scatter',
    coordinateSystem: 'geo',      // plot in lon/lat against the basemap
    ...(uniform
      ? { large: true, largeThreshold: 2000, symbolSize: 4 }
      : { progressive: 6000, progressiveThreshold: 3000,
          symbolSize: (d) => d[2] }),
    data: classes.get(k),
    itemStyle: { color: colorOf(k), opacity: k === 'Other' ? 0.35 : 0.7 },
    emphasis: { itemStyle: { borderColor: getComputedStyle(document.documentElement)
      .getPropertyValue('--surface-1').trim(), borderWidth: 2 } },
  }));

  /* The geo component handles the projection and the aspect ratio itself, which
     replaces a block of hand-rolled arithmetic that computed the plot rectangle
     from cos(latitude). It also brings pan and zoom (`roam`) for free — mouse
     wheel and drag on a desktop, pinch on a phone. */
  const css = (v) => getComputedStyle(document.documentElement)
    .getPropertyValue(v).trim();

  const geo = {
    map: 'argentina',
    roam: true,
    top: 10, bottom: 30,
    // Frame Argentina, not the union of everything in the file. Without this
    // the view is sized to include the clipped corner of Brazil, which shrinks
    // the country and pushes it off-centre; the neighbours still draw, they
    // just extend past the frame as context should.
    boundingCoords: [[-74.5, -21.0], [-52.5, -56.0]],
    // Regions are scenery, not data: no hover highlight, no selection, so the
    // wells stay the only interactive thing on the canvas.
    silent: false,
    emphasis: { disabled: true },
    selectedMode: false,
    itemStyle: {
      areaColor: css('--map-land'),
      borderColor: css('--grid'),
      borderWidth: 1,
    },
    regions: [
      // Neighbours recede: they are context, not subject.
      ...neighbourNames.map(name => ({
        name,
        itemStyle: { areaColor: 'transparent', borderColor: css('--grid'),
                     borderWidth: 0.5, opacity: 0.55 },
      })),
      // The national border reads heavier than the internal province lines.
      { name: 'Argentina',
        itemStyle: { areaColor: 'transparent', borderColor: css('--axis'),
                     borderWidth: 1.5 } },
    ],
  };

  const shown = idx.length - missing - outside;
  root.querySelector('#mp-note').innerHTML =
    `${num(shown)} wells plotted${missing ? `, ${num(missing)} omitted for having no coordinate` : ''}${outside ? `, ${num(outside)} omitted for plotting outside Argentina` : ''}.
     Marker area is proportional to ${sizeBy === 'none' ? 'nothing (uniform)' :
     esc(({ cum_oil_m3: 'cumulative oil', cum_gas_e3m3: 'cumulative gas',
            lateral_m: 'lateral length' })[sizeBy])}.
     ${emphasisMode ? 'Basin has more than three categories, so this view highlights one against grey rather than assigning colours that would not stay distinguishable for colourblind readers on a scatter.' : ''}`;

  draw(root.querySelector('#mp-chart'), merge(baseOption(), {
    legend: { show: false },
    grid: undefined,
    geo,
    tooltip: {
      trigger: 'item',
      formatter: (p) => {
        const i = p.data[3];
        const oil = valueAt(wells, 'cum_oil_m3', i);
        return `<strong>${esc(valueAt(wells, 'sigla', i) ?? '—')}</strong><br>` +
          `${esc(i18nLabel('cuenca', valueAt(wells, 'cuenca', i)) ?? '')} · ${esc(i18nLabel('formation', valueAt(wells, 'formation', i)) ?? '')}<br>` +
          `${esc(valueAt(wells, 'operator', i) ?? '')}<br>` +
          `${esc(valueAt(wells, 'trajectory', i) ?? '')}` +
          (valueAt(wells, 'lateral_m', i) ? ` · ${num(valueAt(wells, 'lateral_m', i))} m lateral` : '') +
          `<br>Cum oil ${compact(convert.oil(oil), 2)} ${units.oil()}`;
      },
    },
    // No xAxis/yAxis: the geo component supplies the coordinate system, and
    // leaving degree axes in place would double up on it.
    xAxis: undefined,
    yAxis: undefined,
    series,
  }));

  root.querySelector('#mp-legend').innerHTML = legendHTML(
    keys.map(k => ({ label: esc(i18nLabel(colorBy, k)), color: colorOf(k) })));
}
