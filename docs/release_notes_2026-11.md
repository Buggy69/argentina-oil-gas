# Release notes: November 2026 (user-feedback round)

Live: https://buggy69.github.io/argentina-oil-gas/

## Versions (git tags)

| Tag | Commit | State |
|---|---|---|
| `v2026.11-before-feedback` | `ee94bb9` | **Before.** Refresh fixed; no feedback changes yet |
| `v2026.11-fb1-selection-caption` | `0bbfad5` | + feedback 1: filters shown on every chart |
| `v2026.11-fb2-daily-rates` | `2b4db40` | + feedback 2: daily rates, axis units and labels |
| `v2026.11-after-feedback` | this commit | **After.** + feedback 3: Compare wells tab, and these notes |

**Look at an old version without touching `main`:**
```
git worktree add ../petrodb_before v2026.11-before-feedback
python tools/serve.py 8766        # run inside ../petrodb_before
git worktree remove ../petrodb_before
```
**Compare code:** `git diff v2026.11-before-feedback v2026.11-after-feedback -- site/js`

## New
- **Compare wells tab.** Up to 8 horizontal wells, any field or operator, plotted
  against months on production. Rate or cumulative; as produced or per 1,000 m (ft)
  of lateral. The target is shown against exact P10–P90 bands for **VM horizontal**
  and **its own field**, and is excluded from its own reference. A scorecard gives
  cumulative at 6, 12 and 24 months and the percentile rank. The wells are stored in
  the URL (`w=`). Method: `docs/compare_wells_method.md`.
- **Daily rates by default** (calendar days). These reproduce the publisher's
  `total_diario` exactly (Nov 2025: 859.3 kbbl/d). A "Monthly volumes" checkbox
  (`r=month`) switches to monthly totals.

## Improved
- A selection caption under every chart title (`caption.js`).
- Unit shown on the y-axis. `axisNum()` stops axis labels repeating ("3 M, 3 M").
- National figures in notes replaced by values computed for the selection.

## Fixed
- Weekly refresh: the portal blocks GitHub's servers (since late Oct 2026), so the
  refresh now falls back to a committed snapshot, kept current by a weekly
  scheduled task on Max's laptop.
- The oilfield-units checkbox redrew in the old unit (it emitted before setting the
  flag).

## Feedback and replies

**1. Filters not shown on charts (ES).** Neuquina + Shale water chart still titled
"by basin", with a national note.
> ¡Gracias, tenía razón! Ahora cada gráfico muestra los filtros activos debajo del
> título, y el texto de agua/petróleo se calcula para la selección: en Neuquina +
> Shale el agua es ~0,5× el petróleo, frente a ~10× a nivel país. "Shale" es el
> subtipo de recurso declarado, no una formación. En Neuquina es casi todo Vaca
> Muerta (99,4 % del petróleo), pero no exactamente; para ver solo Vaca Muerta,
> agregue **Formation = VMUT**.

**2. Implausible oil values.** A monthly volume of 2.8 M m³ was read as a daily rate.
> Good catch. The data was right, but the chart was ambiguous: 2.75 M m³ was
> Neuquina shale's **monthly** volume for Nov 2025, which is 577 kbbl/d (Argentina
> total: 859 kbbl/d, matching the official daily average). Charts now default to
> **daily rates**, with the unit on the axis and no more duplicated axis labels.

**3. Well vs well and normalization.**
> There's now a **Compare wells** tab: any horizontal wells, any operator, raw or
> per 1,000 m lateral, against Vaca Muerta and same-field P10–P90 references, with a
> percentile scorecard. As you expected, dispersion is large: lateral length alone
> correlates with cumulative oil at only r = 0.19, so design, landing and spacing
> still matter. We'd welcome the call to decide which further normalizations would
> be most useful (per stage, per tonne of proppant, etc.).

## Open / next
- Production from the portal itself: 2026 data (the official series already
  reaches 2026-01; the site ends 2025-12).
- Further normalizations after the call with the user who sent feedback 3.
- Phone width: right edge cut off in headless screenshots (already in the "before"
  version too); check on a real phone.
- `PROVENANCE.json` lists `hz_monthly.parquet` only after the next CI refresh.

## Ideas: geomechanics, modelling, clients
- Cumulative withdrawal per block or field over time as a depletion history for
  4D / coupled (Visage, Intersect–Visage) models.
- Field P10/P50/P90 curves as history-matching targets.
- Real completion-design distributions (lateral, stages, proppant/m) as Kinetix
  benchmarks and UMB play-template parameters.
- Parent–child screening: frac dates + locations + monthly production.
- Injection volumes (7.1 billion m³) mapped against faults for fault-reactivation
  and induced-seismicity screening.
- Client benchmark scorecards, new-area screening, course material.
- A PTP script to load wells and their attributes into Petrel (coordinates are
  already WGS84).
