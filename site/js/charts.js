/* ===========================================================================
   Chart helpers — one place where the visual rules are enforced.

   The rules being enforced, and why each exists:

   * **Colour follows the entity, never its rank.** `colorFor(name)` hashes a
     stable list of series names to fixed slots, so filtering a series away
     does not repaint the survivors. A reader who learned "Neuquina is blue"
     stays right.
   * **Slots are assigned in order and never cycled.** Past eight series the
     tail folds into "Other" (grey). A ninth generated hue would be
     indistinguishable from an existing one under colour-vision deficiency.
   * **Never two y-axes.** There is no option to add one. Oil (m³) and gas
     (10³ m³) live on separate charts; the alignment of two scales on one plot
     is arbitrary and invents correlations that are not in the data.
   * **Thin marks, hairline grid, no dashes.** Set once in `baseOption`.
   * **A 2px surface gap between stacked fills** rather than a border drawn
     around each segment.
   =========================================================================== */

const css = (name) => getComputedStyle(document.documentElement)
  .getPropertyValue(name).trim();

/** The eight categorical slots, read live so a theme switch picks up new hues. */
export function palette() {
  return [1, 2, 3, 4, 5, 6, 7, 8].map(i => css(`--s${i}`));
}
export const OTHER_GREY = () => css('--ink-muted');

/**
 * Fixed name -> slot assignment.
 *
 * `orderedNames` must already be in the order the slots should be handed out,
 * and that order must be computed from the WHOLE dataset, never from the
 * current selection. Both halves matter:
 *
 *   - Stable across filters, so a reader who learned "Neuquina is blue" stays
 *     right when they exclude a province.
 *   - Ranked by real importance rather than alphabetically, because with eight
 *     slots and a long tail, an alphabetical order spends slot 1 on Austral and
 *     pushes Noroeste past slot 8 into grey — where it becomes indistinguishable
 *     from the "Other" bucket, which is a different thing entirely.
 *
 * Anything past slot 8, plus 'Other' and null, is grey. That is deliberate: a
 * ninth generated hue would not survive a colour-vision check.
 */
export function makeScale(orderedNames) {
  const map = new Map();
  let slot = 0;
  for (const n of orderedNames) {
    if (n == null || n === 'Other' || map.has(n)) continue;
    map.set(n, slot++);
  }
  return (name) => {
    if (name === 'Other' || name == null) return OTHER_GREY();
    const i = map.get(name);
    if (i === undefined || i >= 8) return OTHER_GREY();
    return palette()[i];
  };
}

/** Shared chart chrome. Everything recessive; the data carries the emphasis. */
export function baseOption() {
  const ink2 = css('--ink-2'), muted = css('--ink-muted');
  const grid = css('--grid'), axis = css('--axis'), surface = css('--surface-1');
  return {
    backgroundColor: 'transparent',
    animationDuration: 220,
    textStyle: { fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
    grid: { left: 58, right: 18, top: 18, bottom: 34, containLabel: true },
    tooltip: {
      trigger: 'axis',
      backgroundColor: surface,
      borderColor: axis,
      borderWidth: 1,
      textStyle: { color: css('--ink-1'), fontSize: 12 },
      axisPointer: { type: 'line', lineStyle: { color: axis, width: 1 } },
    },
    xAxis: {
      axisLine: { lineStyle: { color: axis } },
      axisTick: { show: false },
      axisLabel: { color: muted, fontSize: 11 },
      splitLine: { show: false },
    },
    yAxis: {
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: muted, fontSize: 11 },
      // Solid hairline gridlines. Dashed grid reads as "threshold" or
      // "projection" when it is only a grid.
      splitLine: { lineStyle: { color: grid, width: 1, type: 'solid' } },
    },
    legend: {
      type: 'scroll', bottom: 0, itemGap: 14, itemWidth: 11, itemHeight: 11,
      icon: 'roundRect',
      textStyle: { color: ink2, fontSize: 12 },
    },
  };
}

/** Deep merge good enough for option objects (plain objects and arrays only). */
export function merge(a, b) {
  const out = Array.isArray(a) ? a.slice() : { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) &&
        out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = merge(out[k], v);
    } else out[k] = v;
  }
  return out;
}

const charts = new Map();

/** Create or update a chart bound to an element id. */
export function draw(el, option) {
  if (!el) return null;
  let c = charts.get(el);
  if (!c || c.isDisposed?.()) {
    c = echarts.init(el, null, { renderer: 'canvas' });
    charts.set(el, c);
  }
  // notMerge:true — stale series from a previous render must not survive a
  // filter change, which is exactly the bug that makes a dashboard show data
  // the user has just excluded.
  c.setOption(option, { notMerge: true, lazyUpdate: false });
  return c;
}

/** Resize live charts, and drop any whose element has left the document.
 *
 * Without the isConnected check this silently becomes a leak with teeth: a view
 * switch replaces the DOM, the old chart objects stay in this Map holding their
 * canvases and their data, and every later resize re-renders them. With an 84 k
 * point scatter among them that is enough to freeze the tab on navigation.
 */
export function resizeAll() {
  for (const [el, c] of charts) {
    if (!el.isConnected) { c.dispose(); charts.delete(el); continue; }
    c.resize();
  }
}

export function disposeAll() {
  for (const c of charts.values()) c.dispose();
  charts.clear();
}

window.addEventListener('resize', () => resizeAll());

/** A line series with the house mark spec: 2px, no point clutter, smooth off. */
export function lineSeries(name, data, color, extra = {}) {
  return merge({
    name, type: 'line', data, showSymbol: false, symbolSize: 8,
    lineStyle: { width: 2, color }, itemStyle: { color },
    emphasis: { focus: 'series' },
  }, extra);
}

/** A stacked-area series with a 2px surface gap between adjacent fills. */
export function areaSeries(name, data, color, stack = 'total', extra = {}) {
  return merge({
    name, type: 'line', stack, data, showSymbol: false,
    lineStyle: { width: 2, color: css('--surface-1') },  // the gap, not a border
    itemStyle: { color },
    areaStyle: { color, opacity: 0.85 },
    emphasis: { focus: 'series' },
  }, extra);
}

/** Bars: 4px rounded data-end anchored to the baseline. */
export function barSeries(name, data, color, horizontal = false, extra = {}) {
  return merge({
    name, type: 'bar', data,
    itemStyle: { color, borderRadius: horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0] },
    barMaxWidth: 26,
    emphasis: { focus: 'series' },
  }, extra);
}

/** Render a legend in HTML so identity is never carried by colour alone. */
export function legendHTML(entries) {
  return `<div class="legend">` + entries.map(e =>
    `<span class="key"><span class="swatch" style="background:${e.color}"></span>${e.label}</span>`
  ).join('') + `</div>`;
}
