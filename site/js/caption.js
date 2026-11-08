/* ===========================================================================
   The selection caption printed under every chart title.

   WHY EVERY CARD CARRIES IT
   -------------------------
   The filter bar says what is selected, but a chart travels without it: people
   screenshot a single card into a slide or a chat. User feedback (Nov 2026) was
   exactly this — a Neuquina + Shale water chart whose title still read
   "Produced water by basin", so nothing on the image said which slice it was.
   A chart that cannot be read on its own is not finished.

   One function, painted by app.js into every `[data-selection]` element after
   each render — the same mechanism as the `[data-unit]` spans — so no view
   needs code of its own and a new card gets the caption by adding one tag.
   =========================================================================== */

import { state } from './state.js?v=a9872ab70a';
import { label } from './i18n.js?v=a9872ab70a';
import { monthLabel } from './store.js?v=a9872ab70a';

/* Facets shown in the filter bar. `source` says which table the facet's domain
   comes from — the cube for time-varying dimensions, wells for static ones.
   Lives here rather than in app.js because the caption needs the same
   human-readable names: one list, so the two can never disagree. */
export const FACETS = [
  ['cuenca', 'Basin', 'wells'],
  ['provincia', 'Province', 'wells'],
  ['area', 'Block / concession', 'wells'],
  ['yacimiento', 'Field', 'wells'],
  ['formation', 'Formation', 'wells'],
  ['operator', 'Operator', 'wells'],
  ['well_fluid', 'Oil / gas well', 'wells'],
  ['trajectory_class', 'Trajectory', 'wells'],
  ['trajectory', 'Trajectory (measured only)', 'wells'],
  ['name_marker', 'Well name marker', 'wells'],
  ['tipo_recurso', 'Resource type', 'wells'],
  ['sub_tipo_recurso', 'Shale / tight', 'wells'],
];

const DIM_LABEL = Object.fromEntries(FACETS.map(([dim, name]) => [dim, name]));

// Beyond three values a caption stops being readable on a phone. The rest is
// counted, never dropped, and the full list goes into the hover tooltip.
const SHOWN_PER_DIM = 3;

/**
 * The current selection as `{ text, full }`.
 *
 * `text` is what the card prints; `full` lists every value and becomes the
 * element's tooltip. They are equal unless a dimension was abbreviated.
 */
export function selectionText() {
  const short = [], full = [];
  // FACETS order, so the caption reads in the same order as the filter bar;
  // any dimension not in the bar (a deep link) still appears, at the end.
  const dims = [...FACETS.map(([d]) => d).filter(d => state.filters[d]),
                ...Object.keys(state.filters).filter(d => !(d in DIM_LABEL))];
  for (const dim of dims) {
    const values = (state.filters[dim] || []).map(v => label(dim, v));
    if (!values.length) continue;
    const name = DIM_LABEL[dim] || dim;
    const extra = values.length - SHOWN_PER_DIM;
    short.push(`${name}: ${values.slice(0, SHOWN_PER_DIM).join(', ')}`
               + (extra > 0 ? ` +${extra} more` : ''));
    full.push(`${name}: ${values.join(', ')}`);
  }
  const r = state.monthRange;
  if (r) {
    const span = `${monthLabel(r.min)} → ${monthLabel(r.max)}`;
    short.push(span); full.push(span);
  }
  if (!short.length) {
    const all = 'All of Argentina — no filters';
    return { text: all, full: all };
  }
  return { text: short.join(' · '), full: full.join(' · ') };
}

/**
 * Write the caption into every `[data-selection]` under `root`.
 *
 * `pending` is for the Overview's fast path, which paints national totals from
 * summary.json before the filterable tables exist. If the URL already carries
 * filters, printing them over national numbers would be a false label, so the
 * caption says what is really on screen until the real render replaces it.
 */
export function paintSelection(root = document, { pending = false } = {}) {
  const sel = selectionText();
  const filtered = Object.keys(state.filters).length > 0 || !!state.monthRange;
  const text = pending && filtered
    ? 'All of Argentina — your filters apply once the data has loaded…'
    : sel.text;
  for (const el of root.querySelectorAll('[data-selection]')) {
    el.textContent = text;
    el.title = pending && filtered ? '' : sel.full;
    el.classList.toggle('is-filtered', filtered && !pending);
  }
}
