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

## Offset fracs and refracs (added 2026-11-20)
A user asked why LLL-1558 and LLL-1577 (Loma Campana, YPF) jump in rate. Each jump
follows a neighbouring pad's frac. The tab now searches `frac_jobs.parquet` for jobs
on other wells whose **wellhead** lies within a chosen radius (off / 300 / 500 /
1,000 / 1,500 m, default 1,000 m) and that started while the target was producing,
plus the target's own later jobs (refracs). Jobs in adjacent months form one episode.
Each episode is a dashed marker on the target's rate curve. The card lists the wells,
the nearest distance, and the target's mean rate over the 3 months before and over
months 1–3 and 4–6 after. "After" is split because a parent is often shut in or
cleaning up right after a neighbour's frac, so a gain shows up later.

Verified on the page against a manual SQL search: LLL-1558 has 3 episodes (6, 5 and 5
wells; Aug 2021, Apr 2022, Nov 2022; 504–660 m). LLL-1577 has 1 episode (LLL-1679 to
1683, Feb 2023, 300–333 m). Limits: the distance is between wellheads, not laterals;
only reported jobs are included (mostly 2010 onward); there are no pressures, so a
match in time is a prompt to look, not proof of a frac hit.

## Load recovery (added 2026-11-20)
A "Load recovery" fluid option shows produced water as a percentage of the frac water
pumped (summed over all reported jobs), monthly and cumulative. It has exact P10–P90
references, like the other fluids. Wells without frac water are excluded and counted.
The per-lateral switch is disabled, because a ratio is already normalized. Flowback
and formation water are not separated, so above 100 % the well has produced formation
water. The page matched DuckDB: LLL-1558 is at 15 / 18 / 20 % at 6 / 12 / 24 months;
the VM median is 25 % at 12 months, over 1,885 wells. After the 2021–22 offset fracs,
LLL-1558's cumulative load recovery climbs from ~20 % to ~95 %, consistent with the
neighbours' frac water being produced through it.

## Limits
Lateral normalization removes only the first-order effect of well length. Across
1,895 VMUT horizontal wells with at least 12 months, cumulative oil vs lateral length
gives r = 0.19. Completion intensity, landing, spacing, parent–child effects and
vintage all remain.
