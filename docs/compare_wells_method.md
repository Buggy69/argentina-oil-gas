# Compare wells — method

The **Compare wells** tab (added Nov 2026 from user feedback) sets any horizontal
well against any other, and against the distribution of its peers.

## Data
`site/data/hz_monthly.parquet`, built by `tools/04_build_web_data.py` (section 3c):
every well with `trajectory_class = 'Horizontal'`, one row per declared month,
re-indexed to **months since first production** (0–119), the same axis as the type
curves. About 138k rows across 2,703 wells, 1.4 MB. Well attributes (name, field,
operator, formation, lateral length) come from `wells_slim.parquet`.

## Curves
- **Rate**: a month's volume ÷ that month's calendar days (the publisher's own
  definition of a daily average), or the monthly volume with the global
  "Monthly volumes" toggle. Month 0 is usually a partial month, so the rate chart
  starts at month 1.
- **Cumulative**: the sum of declared volumes from month 0. A well is drawn up to
  the last month the dataset could contain for it. A month it did not declare adds
  nothing, and is not treated as a measured zero rate.
- **Per 1,000 m (or ft) of lateral**: divide by the fracture-reported horizontal
  branch length. Wells with no lateral, or one under 500 m, are excluded from this
  view and **counted** in the caption. Nothing is imputed.

## References
- **Vaca Muerta horizontal**: all horizontal wells with producing formation `VMUT`.
- **Target's field, horizontal**: all horizontal wells in the target's `yacimiento`.
- The target is excluded from its own reference.
- Statistics are **exact** percentiles (linear interpolation, the same as DuckDB
  `quantile_cont`) over the reference wells present at each month. A month with fewer
  than 5 wells is not drawn. p10 is the low value.
- **Scorecard rank** `Pxx` is the share of reference wells with a strictly lower
  cumulative at that age.

## Verification (2026-11-08)
For YPF.Nq.LACh-89(h) (La Amarga Chica), per 1,000 m, field reference:

| month | n | field P50 (m³/1,000 m) | target | rank |
|---|---|---|---|---|
| 6 | 266 | 9,909.0 | 15,266.1 | P96 |
| 12 | 232 | 15,842.9 | 27,127.2 | P99 |
| 24 | 184 | 23,988.3 | 40,481.2 | P99 |

These were computed independently in SQL over the same parquet, and the page matched
every value, including the 8 field wells excluded for no lateral.

## Limits
Lateral normalization removes only the first-order effect of well length. Across
1,895 VMUT horizontal wells with at least 12 months, cumulative oil vs lateral length
gives r = 0.19. Completion intensity, landing, spacing, parent–child effects and
vintage all remain.
