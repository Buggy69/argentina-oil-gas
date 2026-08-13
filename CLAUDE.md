# petrodb_dashboard — working notes

Public, interactive dashboard over Argentina's open oil & gas production data.
Static site, no server, published to GitHub Pages at
**https://buggy69.github.io/argentina-oil-gas/** (repo `Buggy69/argentina-oil-gas`).
Plan of record: `C:\Users\mhaas\.claude\plans\i-want-to-make-delightful-eich.md`.

## Run things with

```powershell
$PY = "C:\Users\mhaas\AppData\Local\anaconda3\envs\geomech\python.exe"

& $PY tools\00_download_portal.py    # official reference + fracture data
& $PY tools\01_ingest_petrodb.py     # resolve year partitions, build warehouse
& $PY tools\02_verify.py             # -> docs/verification_report.md
& $PY tools\03_enrich.py             # trajectory, completions, temporal joins
& $PY tools\04_build_web_data.py     # -> site/data/ (all tiers)
& $PY tools\05_vendor_assets.py      # -> site/vendor/ (pinned, committed)
& $PY tools\06_build_basemap.py      # -> site/data/geo/ (Natural Earth)
& $PY tools\07_stamp_version.py      # cache-busting ?v= stamps (CI runs this too)
& $PY tools\build_docx.py            # docs -> .docx

& $PY tools\serve.py 8765            # local preview — NOT python -m http.server
```

`geomech` (Python 3.12.13) + duckdb 1.5.5 + pyarrow 25.0.1 + shapely + geopandas.
**No node/npm on this machine**, so the frontend has no build step: plain ES
modules and vendored libraries. `pandoc` (conda) for the .docx deliverables.

---

## THE LESSONS. Read these before changing anything.

Nearly every one cost real time, and several shipped wrong numbers to a live
page before being caught.

### Verification

1. **Verify the delivery, not just the data.** The single most expensive failure
   here: the data pipeline was verified exhaustively while the *shipping* path
   was never checked. Result — a syntax error and an unpushed commit sat live for
   a day while every symptom got misattributed to caching.
2. **`git push` is part of "done".** A commit on this machine is not a deploy.
   Check `git rev-parse origin/main` before claiming anything is live.
3. **Test the deployed URL, not localhost.** Two bugs existed *only* in
   production: the gzip/Range corruption and the module-cache staleness. A dev
   server does not compress and sends no-store, so both were invisible locally.
4. **Check your own test harness before believing it.** Two false results here:
   `curl` output in PowerShell is an ARRAY of lines, so `$txt -notmatch 'x'`
   filters the array instead of returning a boolean and reports MISS for
   perfectly good files; and importing `/js/state.js` when the app runs
   `state.js?v=abc` gives a *different module instance* with its own state, so
   driving it proves nothing. Read the version off the page's own script tag.
5. **A silently-ignored filter is worse than an error.** Three separate
   instances: the type curves forwarded only two of six dimensions; the cube
   capped operators at top-25 so selecting a smaller one drew a blank chart; and
   facet lists were capped at 60 values so most blocks were unselectable.
   `unsupportedFilters()` and `unmatchedValues()` now exist to make this loud.
6. **Report the distribution, not the extreme.** The coordinate check first
   printed a max deviation of 0.287° and looked like a failure; the distribution
   showed 84,208 of 84,210 wells identical bit-for-bit and two revised outliers.

### The host dictates the architecture

7. **GitHub Pages gzips `application/octet-stream` and applies `Range` to the
   COMPRESSED stream.** HTTP-range reads of Parquet are therefore impossible
   there, and `fetch()` cannot opt out — `Accept-Encoding` is a forbidden header.
   Tier C is sharded by well (`idpozo % 256`) so each drill-down is one ordinary
   whole-file GET. It also came out *smaller* than the year-sharded layout.
8. **Pages sends `Cache-Control: max-age=600` and cannot be configured.** A hard
   reload re-fetches the entry script but commonly serves DYNAMIC imports from
   cache, so the shell updates while views do not and the site looks like it
   ignored the deploy. `tools/07_stamp_version.py` stamps every module URL with a
   content hash; the hash ignores existing stamps, so unchanged code produces an
   unchanged deploy. **After a deploy, index.html itself is still cached for up
   to 10 minutes — one Ctrl+Shift+R, then it self-heals forever.**
9. **`.nojekyll` is mandatory.** Jekyll silently drops any path containing `=`,
   which would 404 every `bucket=`/`anio=` directory.
10. **Pages cannot serve a subfolder**, hence the Actions-based deploy of `site/`.

### Performance — what worked and what didn't

11. **Parquet decode in JS costs ~150–220 ms per 296k-row column, whatever the
    type.** The only lever that matters is *how many columns* are decoded before
    the page is usable. Lazy-loading columns per view is the fix, applied to both
    `wells_slim` and the cube.
12. **Tried and reverted, with measurements, so nobody repeats them:** Snappy
    instead of ZSTD (8% faster decode for +2.5 MB — decompression was never the
    bottleneck); a run-length dictionary fast path (no measurable change);
    `<link rel="preload" as="fetch">` for data files (**made it 4× worse** —
    `crossorigin` does not match the app's same-origin `fetch()`, so every file
    downloaded twice).
13. **The fix that mattered was not an optimisation.** Rendering the Overview
    from the 40 KB `summary.json` makes the page usable at ~1 s regardless of
    what the Parquet is doing. Making slow work faster was worth less than making
    it not block.
14. Paint metrics from an automated or backgrounded tab are meaningless — the
    browser throttles rendering. The app marks `tierA-rendered`,
    `tables-decoded`, `interactive`; append `?perf` to log them.

### Build correctness

15. **`dims.json` is written ONCE, at the end, after every table has registered
    its label tables.** Writing it earlier bit twice — first the block cube, then
    the type curves — each shipping coded columns whose dictionaries decoded
    empty, so every value looked absent. There is now a guard that fails the
    build on a missing or empty label table.
16. **Never patch code with regex.** The duplicate `const ranked` that broke the
    Well-performance view came from a regex replacement that inserted the new
    block without removing the old. Use Edit with exact context.
17. **Do not rewrite source files with PowerShell `Set-Content`.** It re-encoded
    UTF-8 as ANSI and added a BOM, mangling every accented character and em-dash.
    Recover with `git checkout --` and redo with Edit.
18. Aggregation self-checks are cheap and catch the worst class of bug: the cube
    totals are compared back to the ungrouped source (`rel Δ < 1e-9`), and the
    temporal joins assert the row count is unchanged — an overlapping range join
    would silently duplicate well-months and inflate everything downstream.

### Network and access

19. **`huggingface.co` is blocked on the SLB network** (filter category
    "artificial-intelligence"; a warn-and-continue page a browser can click
    through but a script cannot). The raw petrodb Parquet was downloaded by hand.
    The weekly refresh runs in GitHub Actions, whose runners are not on that
    network. **Do not attempt to bypass the filter locally.**
20. **`datos.energia.gob.ar` is reachable and scriptable** — the upstream
    publisher, used for verification, first-production dates and the fracture
    table. `raw.githubusercontent.com`, jsDelivr and npm are reachable too.

---

## Rules that are not obvious from the code

- **No script names a data location.** Everything goes through a driver from
  `tools/sources/` selected by `config.toml`. See `tools/sources/base.py`.
- **No frontend view fetches for itself.** Every query goes through
  `site/js/query.js::query(spec)` — a structured spec, not SQL, so the backend
  can change without touching a view.
- **Zero external hosts at runtime.** hyparquet, ECharts and the basemap are
  vendored/compiled in. No CDN, no fonts, no map tiles, no analytics. Note the
  trap: jsDelivr `+esm` bundles import `/npm/...` as absolute paths;
  `05_vendor_assets.py` resolves those recursively and rewrites them.
- **hyparquet, not DuckDB-WASM** — 58 KB against 34 MB of WebAssembly, for
  querying a pre-aggregated cube. Deliberate deviation from the original plan.
- **Two cubes.** `agg_monthly` carries the dimensions people break a time series
  down by; `agg_block` carries all 455 concessions and 1,181 fields and is
  lazy-loaded. Folding blocks into the main cube measured at 2.01× rows and ~9 MB.
- **No top-N caps anywhere.** Every value the filter bar offers is a real value.
- **Spanish is the data, English is an annotation.** Stored values, filter state,
  URLs and CSV exports keep the publisher's exact string; the English gloss is
  display-only (`site/js/i18n.js`). Toponyms are not translated.

## Facts about the data worth not re-deriving

- `prod_pet` is m³; `prod_gas` is **10³ m³** ("Mm³" in Argentine usage — thousands,
  not millions). Oil conversion **6.28981 bbl/m³** is the publisher's own factor,
  re-derived from their redundant columns, not a textbook value.
- `coordenadax`/`coordenaday` are **already WGS84 decimal degrees**; the `geom`
  WKB carries SRID 4326 (`0101000020E6100000`). No reprojection anywhere.
- **`idpozo` is wellbore × producing formation**, not a physical wellbore. Never
  call a count of `idpozo` a well count without saying which.
- **Trajectory is not in the production data.** `tipopozo` is fluid type.
  - `trajectory` — measured, from fracture-reported lateral length (≥ 500 m).
  - `name_marker` — the naming convention: `(h)` horizontal, `(d)` directional.
    99.1% sensitive, 97.1% precise against the measurement.
  - `trajectory_class` — combined, measurement wins: Horizontal 2,819,
    Directional 3,581, Vertical 1,114, **Unknown 77,903 (91.2%), never imputed**.
- **Landing points do not exist in this data.** Checked both well registries and
  the fracture table: the finest geological granularity anywhere is
  `formacion_productiva = "vaca muerta"`, a single value. No member/`nivel`/
  `unidad` column exists. `profundidad` is total depth, not a landing TVD.
- **Water is the largest stream**: 6.9 billion m³ produced across 47,848 wells
  (91% water cut), plus 7.1 billion m³ injected — more volume than the oil.
- Formation codes map 1:1 to names (77 of them), so `VMUT` displays as
  `VMUT (Vaca Muerta)`. The pairs are emitted by the build, not hard-coded.
- Production gaps are NULL, not zero — keep them distinguishable in statistics.
- **`p10` is the LOW value** (statistical convention, not the reserves one).
- Real source defects, reported not cleaned: 43 negative oil months (retroactive
  corrections), 5 rows whose `tef` exceeds the hours in their month (max 3,058 h
  against a 744 h ceiling — clamped before any rate is computed).
- Type-curve percentiles are pre-computed per group; pooling several groups
  averages percentiles, which is an approximation (exact for a single group).
  The chart says so.

## Known gaps

- The weekly refresh (Friday 06:00 UTC) has **never been observed running**.
- Deep-linking straight to `#/map` cold is ~8 s; via the Overview it is ~2 s.
- `docs/` does not yet document the water columns in the type-curve and block
  cubes, nor `07_stamp_version.py`.

## Style

Code is annotated for a reader who is expert in the physics and newer to
programming: explain *why*, at the level of what the machine is actually doing,
not what the line says. Never explain petroleum engineering.
