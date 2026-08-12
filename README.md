# Argentina Oil & Gas — open production dashboard

**→ [buggy69.github.io/argentina-oil-gas](https://buggy69.github.io/argentina-oil-gas/)**

Built by **Maximilian Haas**.

An interactive analysis of Argentina's public well-level oil and gas production
data, 2006–2025. Static site, no server, no accounts, no tracking. Open it on a
phone or a laptop and slice 17.8 million well-months yourself.

## This is public data

**Every figure on this site comes from public open-government data.** Argentina's
*Secretaría de Energía* requires operators to declare production well by well and
month by month, and publishes those declarations openly under a Creative Commons
Attribution licence. Nothing here is proprietary, confidential or commercially
sourced, and nothing is company-internal. Anyone can download the same files and
reproduce every number.

**Cite as:**

> Secretaría de Energía de la Nación (Argentina). *Producción de petróleo y gas
> por pozo (Capítulo IV)* and *Datos de fractura de pozos de hidrocarburos
> (Adjunto IV)*. [datos.energia.gob.ar](https://datos.energia.gob.ar/).
> Licensed **CC BY 4.0**. Accessed 2026-08-10.
>
> *PetroData Repository* (`sumpalabs/petrodb`), curated by Oscar Cortez —
> Parquet repackaging of the above. [sumpalabs.com/petrodb](https://sumpalabs.com/petrodb/).
> Licensed **CC BY 4.0**. Snapshot 2026-08-10.

Attribution travels with the data: it is in the page footer, on the Data & method
page, in `CITATION.cff`, in `site/PROVENANCE.json` with a checksum for every
file, and in the header of every CSV a user exports.

This analysis is independent and non-commercial. Neither publisher has reviewed
or endorsed it.

## What is in the data

| | |
|---|---|
| Wells | 85,417 (`idpozo` = wellbore × producing formation) |
| Well-months | 17,775,911, 2006-01 → 2025-12 |
| Basins | Neuquina, Golfo San Jorge, Austral, Cuyana, Noroeste, + minor |
| Per month, per well | oil (m³), gas (10³ m³), water, injection, effective hours |
| Per well | basin, province, field, formation, operator history, resource type (conventional / shale / tight), coordinates, depth |
| Completions | lateral length, stage count, proppant tonnage, fluid volume, treating pressure — for the 4,604 wells with a fracture record |
| Filters | basin, province, **block/concession**, **field**, formation, operator, oil/gas well type, **trajectory (H/D/V)**, well-name marker, resource type, shale/tight, period — each searchable, accent-insensitive |

## Verified, not assumed

Everything was reconciled against the publisher's own independently-produced
monthly series before the site was built. Summed by basin over 240 months,
petrodb agrees with the official series to **−0.0% … −0.4%**. The barrel factor
(6.28981 bbl/m³) and the gas unit (10³ m³) were re-derived from the publisher's
own redundant columns rather than taken from a textbook, and 84,208 of 84,210
comparable wells match the registry's own geometry bit-for-bit.

Known defects in the source are left visible rather than cleaned away — negative
volumes from retroactive corrections, five rows claiming more production hours
than their month contains, and the fact that **trajectory is unknown for 91.2%
of wells** because it only exists where a fracture was reported or the well name
carries a trajectory marker. Full detail:
[`docs/verification_report.md`](docs/verification_report.md).

## Running the pipeline

```powershell
$PY = "C:\Users\mhaas\AppData\Local\anaconda3\envs\geomech\python.exe"

& $PY tools\00_download_portal.py     # official reference + fracture data
& $PY tools\01_ingest_petrodb.py      # resolve year partitions, build warehouse
& $PY tools\02_verify.py              # → docs/verification_report.md
& $PY tools\03_enrich.py              # trajectory, completions, temporal joins
& $PY tools\04_build_web_data.py      # → site/data/  (the three tiers)
& $PY tools\05_vendor_assets.py       # → site/vendor/ (pinned, committed)
& $PY tools\06_build_basemap.py       # → site/data/geo/ (Natural Earth, public domain)
```

Then serve `site/` with any static file server:

```powershell
& $PY tools\serve.py 8765
```

Use `tools/serve.py`, not `python -m http.server`: the latter sends no cache
headers and does not implement HTTP Range, which makes browser testing silently
unreliable — a fix lands and the page keeps executing the cached module.

Requires the `geomech` conda env with `duckdb` and `pyarrow`.

## How it is put together

Three data tiers, chosen so the first screen paints before the analysis engine
has finished loading:

| Tier | File | Size | Job |
|---|---|---|---|
| A | `summary.json` | 40 KB gzipped | instant first paint, no engine needed |
| B | `agg_monthly.parquet` | 5.6 MB | 396,278-row cube — every facet filter and chart |
| B | `wells_slim.parquet` | 3.1 MB | one row per well — map, statistics |
| B | `agg_block.parquet` | 4.2 MB, lazy | block/field cube — all 455 concessions and 1,181 fields, fetched only when one is used |
| B | `typecurve.parquet` | 0.3 MB | pre-computed P10/P50/P90 decline curves |
| C | `wells/bucket=N/` | 93 MB in 256 buckets | full history, sharded by well; one bucket fetched when you open a well |

**Two cubes, not one.** The main cube carries the dimensions people break a time
series down by. Blocks and fields live in a second cube because folding 455
concessions into the first measured at 2.01× rows and ~9 MB — and a top-80 cut
would still have collapsed 375 blocks into "Other", so the question that
motivated it could not be asked of most blocks. Both reconcile to the same total
oil at +0.000000%.

**No top-N caps anywhere.** Every value the filter bar offers is a real value in
the data. Capping operators at 25 once meant selecting a smaller operator drew a
blank chart with no explanation.

Tier C is sharded **by well** (`idpozo % 256`), not by year, so opening a well is
a single whole-file GET of about 400 KB. Measured on the largest horizontal well
in the dataset: **1 request, 341 KB, 417 ms** for its full 24-month history.

The obvious design — one file per year, sorted by well, pulled apart with HTTP
range requests — is better on paper and does not work here. **GitHub Pages gzips
this content type whenever the client accepts gzip, and then applies `Range` to
the compressed stream.** Byte offsets computed against the real file address the
wrong data, and a browser cannot opt out, because `Accept-Encoding` is a
forbidden header that `fetch()` may not set. Sharding by well sidesteps ranges
entirely. It also turned out *smaller* (93 MB vs 105 MB): grouping each well's
whole history contiguously compresses better than grouping by year.

**Zero external hosts at runtime.** The Parquet reader (hyparquet, 58 KB) and the
chart library are vendored into `site/vendor/`. No CDN, no fonts, no map tiles,
no analytics. A page with no third-party requests cannot be broken by anyone's
corporate web filter — which matters, because the upstream data host is itself
blocked on some corporate networks.

## Designed to outgrow this

The pipeline never names a data location: everything goes through a driver in
`tools/sources/` selected by `config.toml`, and the frontend routes every query
through a single `query()` entry point in `site/js/query.js`. Moving to an object
store or a live database is a driver plus a config line, not a rewrite. See
`tools/sources/base.py` and `tools/sources/sql_database.py`.

`.github/workflows/refresh.yml` rebuilds the site weekly and republishes only if
the verification suite passes.

## Licence

Code MIT (`LICENSE`). Data CC BY 4.0 from the publishers above — attribution is
carried in the page footer, on the Data & method page, in `CITATION.cff`, in
`site/PROVENANCE.json`, and in the header of every CSV export.
