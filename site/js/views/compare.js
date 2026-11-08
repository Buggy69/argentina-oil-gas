/* Compare wells — any horizontal well against any other, and against the
   distribution of its peers.

   Asked for by a user working on unconventionals (Nov 2026): compare well vs
   well "no matter the field or the customer", and set a target well against a
   normalized production curve for Vaca Muerta and for the target's own field,
   horizontal wells only.

   WHY THE REFERENCE IS COMPUTED HERE, NOT PRE-BAKED
   The Well-performance type curves are percentiles per fixed group, averaged
   when groups are pooled — an approximation. Here the reference set depends on
   the target well (its field) and on the normalization (wells without a
   lateral length drop out), so it cannot be known at build time. All
   horizontal well-months are only ~138k rows (data/hz_monthly.parquet), so the
   percentiles below are EXACT, computed over exactly the wells named in the
   caption.

   WHAT "MONTH" MEANS
   x is months since the well's own first production (month 0 = the first,
   usually partial, month), the same axis as the type curves. A well "reaches"
   month m if the dataset extends that far past its first production; months
   it then did not declare count as zero toward its cumulative but are absent
   from the rate — NULL is not zero (CLAUDE.md, facts about the data). */

import { state, setWells, activeFilterCount } from '../state.js?v=a9872ab70a';
import { compact, num, convert, units, esc, fold, perDay, axisNum,
         usingDailyRate } from '../format.js?v=a9872ab70a';
import { draw, baseOption, merge, lineSeries, palette, axisUnit, legendHTML,
         OTHER_GREY } from '../charts.js?v=a9872ab70a';
import { quantileSorted } from '../stats.js?v=a9872ab70a';
import { getSource, valueAt } from '../query.js?v=a9872ab70a';
import { label as i18nLabel } from '../i18n.js?v=a9872ab70a';

const MAX_WELLS = 8;          // one per palette colour; more stops being readable
const MIN_REF = 5;            // fewer wells than this is not a distribution
const MIN_LATERAL_M = 500;    // the project's own horizontal threshold
const MONTHS = 120;           // hz_monthly is capped at month 119
const CHECKPOINTS = [6, 12, 24];
const COL = { oil: 'oil_m3', gas: 'gas_e3m3', water: 'water_m3' };

let fluid = 'oil';
let perLateral = false;
let showVM = true, showField = true;

/* --- index over the horizontal-well table ------------------------------- */

let idx = null;

/** Per-well row ranges and attributes, built once per loaded table. */
function buildIndex(ctx) {
  if (idx && idx.hz === ctx.hz) return idx;
  const hz = ctx.hz, wells = getSource('wells');
  const rowOf = new Map();
  const ids = wells.cols.idpozo.values;
  for (let i = 0; i < wells.n; i++) rowOf.set(ids[i], i);

  // hz is sorted by (idpozo, month_on_prod), so each well is one contiguous
  // run of rows: store [start, end) instead of copying its values out.
  const span = new Map();
  const hid = hz.cols.idpozo.values, fe = hz.cols.fecha.values;
  const mo = hz.cols.month_on_prod.values;
  let lastMonth = -1;
  for (let r = 0; r < hz.n; r++) {
    const s = span.get(hid[r]);
    if (s) s[1] = r + 1; else span.set(hid[r], [r, r + 1]);
    if (fe[r] > lastMonth) lastMonth = fe[r];
  }

  const meta = new Map();
  for (const [id, [a]] of span) {
    const i = rowOf.get(id);
    if (i === undefined) continue;
    const first = fe[a] - mo[a];             // calendar month of month 0
    const lat = wells.cols.lateral_m.values[i];
    const m = {
      id, first,
      // The last month-on-production this well COULD have reported, given
      // where the dataset ends. Cumulatives are defined up to here.
      age: Math.min(MONTHS - 1, lastMonth - first),
      sigla: valueAt(wells, 'sigla', i) ?? String(id),
      field: valueAt(wells, 'yacimiento', i),
      operator: valueAt(wells, 'operator', i),
      formation: valueAt(wells, 'formation', i),
      lateral: Number.isFinite(lat) && lat > 0 ? lat : null,
      cumOil: wells.cols.cum_oil_m3.values[i] || 0,
    };
    m.key = fold(`${m.sigla} ${m.field ?? ''} ${m.operator ?? ''}`);
    meta.set(id, m);
  }
  idx = { hz, span, meta, lastMonth };
  return idx;
}

/* --- one well's curves --------------------------------------------------- */

/** Divisor that turns a volume into "per 1,000 m (or ft) of lateral". */
function lateralFactor(m) {
  if (!perLateral) return 1;
  if (m.lateral == null || m.lateral < MIN_LATERAL_M) return null;
  return 1000 / convert.length(m.lateral);
}

/**
 * Rate and cumulative per month on production, already converted to the
 * display units and normalization. Returns null when the well cannot be
 * normalized (no usable lateral length) — the caller says so, never guesses.
 */
function curves(m) {
  const k = lateralFactor(m);
  if (k == null) return null;
  const conv = convert[fluid];
  const { hz, span } = idx;
  const [a, b] = span.get(m.id);
  const v = hz.cols[COL[fluid]].values, mo = hz.cols.month_on_prod.values;
  const vol = new Float64Array(MONTHS).fill(NaN);
  for (let r = a; r < b; r++) vol[mo[r]] = v[r];

  const rate = new Array(MONTHS).fill(null), cum = new Array(MONTHS).fill(null);
  let c = 0;
  for (let t = 0; t <= m.age; t++) {
    if (Number.isFinite(vol[t])) {
      // perDay divides by THIS calendar month's days — exact, because unlike
      // a type curve we know which month each row is.
      rate[t] = conv(perDay(vol[t], m.first + t)) * k;
      c += vol[t];
    }
    cum[t] = conv(c) * k;
  }
  return { rate, cum };
}

/* --- reference distributions --------------------------------------------- */

/** Exact P10/P50/P90 at every month across the member wells. */
function reference(members) {
  const rates = Array.from({ length: MONTHS }, () => []);
  const cums = Array.from({ length: MONTHS }, () => []);
  for (const m of members) {
    const c = curves(m);
    if (!c) continue;
    for (let t = 0; t < MONTHS; t++) {
      if (c.rate[t] != null) rates[t].push(c.rate[t]);
      if (c.cum[t] != null) cums[t].push(c.cum[t]);
    }
  }
  const stat = (arr) => {
    if (arr.length < MIN_REF) return null;
    arr.sort((x, y) => x - y);
    return { p10: quantileSorted(arr, 0.1), p50: quantileSorted(arr, 0.5),
             p90: quantileSorted(arr, 0.9), n: arr.length, sorted: arr };
  };
  return { rate: rates.map(stat), cum: cums.map(stat) };
}

/** Share of the reference strictly below x, as a whole percentile. */
function rankIn(sorted, x) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < x) lo = mid + 1; else hi = mid; }
  return Math.round(lo / sorted.length * 100);
}

/* --- render -------------------------------------------------------------- */

export function render(root, ctx) {
  root.innerHTML = `
    <div class="grid">
      <section class="card">
        <h2>Compare wells</h2>
        <p class="note">Any horizontal well against any other, whatever the field
           or operator, and against the spread of its peers: all Vaca Muerta
           horizontal wells, and the horizontal wells of the target's own field.
           The first well added is the <strong>target</strong>.</p>
        <div class="callout" id="cw-filter-note" hidden>The filter bar does not
           apply to this tab. The reference wells are chosen by the target well
           — its formation and its field — so a filter here would silently change
           what "its peers" means.</div>
        <div class="controls">
          <label>Add well
            <input type="search" id="cw-search" autocomplete="off"
                   placeholder="Well name, field or operator"></label>
          <label>Fluid
            <select id="cw-fluid">
              <option value="oil">Oil</option>
              <option value="gas">Gas</option>
              <option value="water">Water</option>
            </select></label>
          <span class="seg" role="group" aria-label="Normalization">
            <button id="cw-raw" type="button">As produced</button>
            <button id="cw-lat" type="button">Per 1,000 <span data-unit="length"></span> lateral</button>
          </span>
          <label><input type="checkbox" id="cw-ref-vm"> Vaca Muerta reference</label>
          <label><input type="checkbox" id="cw-ref-field"> Target's field reference</label>
        </div>
        <div id="cw-results" class="cw-results"></div>
        <div id="cw-chips" class="cw-chips"></div>
      </section>

      <section class="card" id="cw-rate-card">
        <h2>Production rate by month on production</h2>
        <p class="selection is-filtered" id="cw-ref-caption"></p>
        <p class="note" id="cw-rate-note"></p>
        <div id="cw-rate" class="chart"></div>
        <div id="cw-legend"></div>
      </section>

      <section class="card" id="cw-cum-card">
        <h2>Cumulative production by month on production</h2>
        <p class="note" id="cw-cum-note"></p>
        <div id="cw-cum" class="chart"></div>
      </section>

      <section class="card" id="cw-table-card">
        <h2>Scorecard</h2>
        <p class="note">Cumulative at 6, 12 and 24 months, and where that places
           the well among its reference wells: <strong>P72 means it out-produced
           72% of them</strong> at that age. “—” means the well has not reached
           that month yet; nothing is extrapolated.</p>
        <div class="scroll-x"><table class="data" id="cw-table"></table></div>
      </section>

      <section class="card">
        <h2>What the normalization can and cannot remove</h2>
        <p class="note">Dividing by lateral length removes the first-order effect
           of a longer well, nothing more. Completion design (proppant and fluid
           intensity, stage spacing), landing zone, well spacing and parent–child
           interference, choke strategy and vintage all remain in the comparison.
           Across 1,895 Vaca Muerta horizontal wells with at least a year of
           production, cumulative oil correlates with lateral length at only
           r = 0.19 — so read a per-metre gap as a prompt to look at design, not
           as a verdict. Lateral length is the fracture-reported horizontal
           branch; wells without one (or under 500 m) are left out of the
           per-metre view and counted in the caption, never estimated.</p>
      </section>
    </div>`;

  const search = root.querySelector('#cw-search');
  search.addEventListener('input', () => showResults(root, search.value));
  root.querySelector('#cw-results').addEventListener('click', (e) => {
    const b = e.target.closest('[data-add]');
    if (!b) return;
    const id = Number(b.dataset.add);
    search.value = '';
    root.querySelector('#cw-results').innerHTML = '';
    if (!state.wells.includes(id) && state.wells.length < MAX_WELLS) {
      setWells(state.wells.concat(id));
    }
  });
  root.querySelector('#cw-chips').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove]');
    const tg = e.target.closest('[data-target]');
    if (rm) setWells(state.wells.filter(w => w !== Number(rm.dataset.remove)));
    if (tg) {
      const id = Number(tg.dataset.target);
      setWells([id, ...state.wells.filter(w => w !== id)]);
    }
  });
  root.querySelector('#cw-fluid').value = fluid;
  root.querySelector('#cw-fluid').addEventListener('change', (e) => {
    fluid = e.target.value; update(root, ctx);
  });
  root.querySelector('#cw-raw').addEventListener('click', () => {
    perLateral = false; update(root, ctx);
  });
  root.querySelector('#cw-lat').addEventListener('click', () => {
    perLateral = true; update(root, ctx);
  });
  root.querySelector('#cw-ref-vm').checked = showVM;
  root.querySelector('#cw-ref-field').checked = showField;
  root.querySelector('#cw-ref-vm').addEventListener('change', (e) => {
    showVM = e.target.checked; update(root, ctx);
  });
  root.querySelector('#cw-ref-field').addEventListener('change', (e) => {
    showField = e.target.checked; update(root, ctx);
  });

  update(root, ctx);
}

/** Search results; with an empty box, suggest the three largest VM wells. */
function showResults(root, text) {
  const box = root.querySelector('#cw-results');
  const term = fold(text.trim());
  const all = [...idx.meta.values()];
  let hits;
  if (term.length >= 2) {
    hits = all.filter(m => m.key.includes(term));
  } else if (!state.wells.length) {
    hits = all.filter(m => m.formation === 'VMUT');
  } else { box.innerHTML = ''; return; }
  hits.sort((a, b) => b.cumOil - a.cumOil);
  const full = state.wells.length >= MAX_WELLS;
  box.innerHTML = (term.length >= 2 ? '' : '<span class="note">Try: </span>') +
    hits.slice(0, term.length >= 2 ? 12 : 3).map(m => `
      <button type="button" class="cw-hit" data-add="${m.id}"
              ${full || state.wells.includes(m.id) ? 'disabled' : ''}>
        <strong>${esc(m.sigla)}</strong>
        <span>${esc(m.field ?? '—')} · ${esc(m.operator ?? '—')} ·
          ${m.lateral ? num(convert.length(m.lateral)) + ' ' + units.length() : 'no lateral'}</span>
      </button>`).join('') +
    (term.length >= 2 && !hits.length
      ? '<span class="note">No horizontal well matches. Only horizontal wells can be compared here.</span>' : '') +
    (full ? `<span class="note">Up to ${MAX_WELLS} wells — remove one to add another.</span>` : '');
}

export function update(root, ctx) {
  buildIndex(ctx);
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  root.querySelector('#cw-filter-note').hidden = activeFilterCount() === 0;
  root.querySelector('#cw-raw').setAttribute('aria-pressed', String(!perLateral));
  root.querySelector('#cw-lat').setAttribute('aria-pressed', String(perLateral));

  // Wells from a shared link that are not horizontal (or unknown) are dropped
  // with a note rather than silently.
  const chosen = state.wells.map(id => idx.meta.get(id)).filter(Boolean);
  const dropped = state.wells.length - chosen.length;
  const pal = palette();

  root.querySelector('#cw-chips').innerHTML = chosen.map((m, i) => `
    <span class="cw-chip">
      <span class="swatch" style="background:${pal[i]}"></span>
      <strong>${esc(m.sigla)}</strong>
      <span class="note">${esc(m.field ?? '—')} · ${esc(m.operator ?? '—')}</span>
      ${i === 0 ? '<span class="cw-tag">target</span>'
                : `<button type="button" class="btn-quiet" data-target="${m.id}">make target</button>`}
      <button type="button" class="btn-quiet" data-remove="${m.id}"
              aria-label="Remove ${esc(m.sigla)}">✕</button>
    </span>`).join('') +
    (dropped ? `<span class="note">${dropped} well${dropped > 1 ? 's' : ''} from the
      link ${dropped > 1 ? 'are' : 'is'} not horizontal or not in the data, and
      ${dropped > 1 ? 'were' : 'was'} left out.</span>` : '');

  const empty = !chosen.length;
  for (const id of ['#cw-rate-card', '#cw-cum-card', '#cw-table-card']) {
    root.querySelector(id).hidden = empty;
  }
  if (empty) { showResults(root, ''); return; }
  root.querySelector('#cw-results').innerHTML = '';

  /* --- reference sets ---------------------------------------------------- */
  const target = chosen[0];
  const norm = perLateral ? ` per 1,000 ${units.length()}` : '';
  const refs = [];
  const peers = [...idx.meta.values()].filter(m => m.id !== target.id);
  const usable = m => !perLateral || (m.lateral != null && m.lateral >= MIN_LATERAL_M);
  if (showVM) {
    const all = peers.filter(m => m.formation === 'VMUT');
    refs.push({ key: 'vm', name: 'Vaca Muerta horizontal', all,
                members: all.filter(usable), color: OTHER_GREY(), dash: 'dashed' });
  }
  if (showField && target.field) {
    const all = peers.filter(m => m.field === target.field);
    refs.push({ key: 'field', name: `${i18nLabel('yacimiento', target.field)} horizontal`,
                all, members: all.filter(usable), color: css('--ink-2'), dash: 'dotted' });
  }
  for (const r of refs) r.stats = reference(r.members);

  root.querySelector('#cw-ref-caption').textContent = refs.length
    ? 'Reference — ' + refs.map(r => `${r.name}: ${num(r.members.length)} wells` +
        (r.all.length > r.members.length
          ? ` (${num(r.all.length - r.members.length)} excluded: no lateral ≥ 500 m reported)` : '')
      ).join(' · ') + ` · target ${target.sigla} excluded from its own reference`
    : 'No reference curve selected.';

  /* --- well curves -------------------------------------------------------- */
  const series = chosen.map((m, i) => ({ m, color: pal[i], c: curves(m) }));
  const unnormalizable = series.filter(s => !s.c).map(s => s.m.sigla);

  const rateUnit = units[fluid + 'Series']() + norm;
  const cumUnit = units[fluid]() + norm;
  let lastT = 1;
  for (const s of series) if (s.c) lastT = Math.max(lastT, s.m.age);
  const xs = Array.from({ length: lastT }, (_, k) => k + 1);   // months 1..lastT

  const warn = unnormalizable.length
    ? ` <span style="color:var(--s4)">⚠ ${esc(unnormalizable.join(', '))}: no lateral
        ≥ 500 m reported, so not shown per 1,000 ${units.length()}.</span>` : '';
  root.querySelector('#cw-rate-note').innerHTML =
    `${usingDailyRate()
      ? 'Daily rate: each month’s volume ÷ that month’s calendar days'
      : 'Volume per month'}, in ${esc(rateUnit)}. Month 0 — the partial first
     month — is left out here and included in the cumulative. Reference bands are
     the exact P10–P90 (p10 = low) across the reference wells producing in that
     month, with the median dashed; a month with fewer than ${MIN_REF} wells is
     not drawn.` + warn;
  root.querySelector('#cw-cum-note').innerHTML =
    `Cumulative ${fluid} in ${esc(cumUnit)}, from month 0. Months a well did not
     declare add nothing; a well is drawn only as far as the data reaches.` + warn;

  const bandSeries = (r, pick, x) => {
    const st = r.stats[pick];
    const at = t => st[t];
    return [
      { name: r.name + ' P10', type: 'line', stack: 'band-' + pick + r.key,
        showSymbol: false, silent: true, lineStyle: { opacity: 0 },
        data: x.map(t => at(t)?.p10 ?? null) },
      { name: r.name + ' P10–P90', type: 'line', stack: 'band-' + pick + r.key,
        showSymbol: false, silent: true, lineStyle: { opacity: 0 },
        areaStyle: { color: r.color, opacity: 0.14 },
        data: x.map(t => (at(t) ? at(t).p90 - at(t).p10 : null)) },
      lineSeries(r.name + ' P50', x.map(t => at(t)?.p50 ?? null), r.color,
        { lineStyle: { type: r.dash, width: 2 } }),
    ];
  };

  const chartFor = (el, pick, x, unit) => draw(root.querySelector(el), merge(baseOption(), {
    legend: { show: false }, grid: { bottom: 14, top: 30 },
    tooltip: { trigger: 'axis', formatter: ps => {
      const shown = ps.filter(p => !/P10/.test(p.seriesName) && p.value != null);
      return `Month ${shown[0]?.axisValue ?? ''}<br>` + shown.map(p =>
        `${esc(p.seriesName)}: ${compact(p.value, 2)} ${esc(unit)}`).join('<br>');
    } },
    xAxis: { type: 'category', data: x, name: 'months on production',
      nameLocation: 'middle', nameGap: 26, nameTextStyle: { fontSize: 11 },
      axisLabel: { interval: Math.max(0, Math.ceil(x.length / 10) - 1) } },
    yAxis: { type: 'value', ...axisUnit(unit), axisLabel: { formatter: axisNum } },
    series: [
      ...refs.flatMap(r => bandSeries(r, pick, x)),
      ...series.filter(s => s.c).map(s =>
        lineSeries(s.m.sigla, x.map(t => s.c[pick][t]), s.color,
          { lineStyle: { width: s === series[0] ? 3 : 2 } })),
    ],
  }));
  chartFor('#cw-rate', 'rate', xs, rateUnit);
  chartFor('#cw-cum', 'cum', [0, ...xs], cumUnit);

  root.querySelector('#cw-legend').innerHTML = legendHTML([
    ...series.map(s => ({ label: esc(s.m.sigla) + (s === series[0] ? ' (target)' : ''),
                          color: s.color })),
    ...refs.map(r => ({ label: esc(r.name) + ' — median and P10–P90', color: r.color })),
  ]);

  /* --- scorecard ---------------------------------------------------------- */
  const cell = (s, t) => {
    if (!s.c || t > s.m.age) return '<td>—</td>';
    const v = s.c.cum[t];
    const ranks = refs.map(r => {
      const st = r.stats.cum[t];
      return st ? `P${rankIn(st.sorted, v)} ${r.key === 'vm' ? 'VM' : 'field'}` : null;
    }).filter(Boolean);
    return `<td>${compact(v, 2)}${ranks.length
      ? `<br><span class="note">${ranks.join(' · ')}</span>` : ''}</td>`;
  };
  const refRow = r => `<tr><td><em>${esc(r.name)} median</em></td><td></td><td></td>` +
    CHECKPOINTS.map(t => {
      const st = r.stats.cum[t];
      return `<td>${st ? compact(st.p50, 2) + `<br><span class="note">n = ${num(st.n)}</span>` : '—'}</td>`;
    }).join('') + '</tr>';

  root.querySelector('#cw-table').innerHTML = `
    <thead><tr><th>Well</th><th>Field · operator</th>
      <th>Lateral (${units.length()})</th>
      ${CHECKPOINTS.map(t => `<th>Cum ${t} mo (${esc(cumUnit)})</th>`).join('')}
    </tr></thead>
    <tbody>
      ${series.map(s => `<tr>
        <td><span class="swatch" style="background:${s.color}"></span>
            ${esc(s.m.sigla)}${s === series[0] ? ' <span class="cw-tag">target</span>' : ''}</td>
        <td>${esc(s.m.field ?? '—')} · ${esc(s.m.operator ?? '—')}</td>
        <td>${s.m.lateral ? num(convert.length(s.m.lateral)) : '—'}</td>
        ${CHECKPOINTS.map(t => cell(s, t)).join('')}
      </tr>`).join('')}
      ${refs.map(refRow).join('')}
    </tbody>`;
}
