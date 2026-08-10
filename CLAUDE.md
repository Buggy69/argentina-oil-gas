# petrodb_dashboard — working notes

Public, interactive dashboard over Argentina's open oil & gas production data.
Static site, no server, published to GitHub Pages. Plan of record:
`C:\Users\mhaas\.claude\plans\i-want-to-make-delightful-eich.md`.

## Run things with

```powershell
$PY = "C:\Users\mhaas\AppData\Local\anaconda3\envs\geomech\python.exe"
& $PY tools\01_ingest_petrodb.py
```

`geomech` (Python 3.12.13) + duckdb 1.5.5 + pyarrow 25.0.1. There is **no
node/npm on this machine**, so the frontend has no build step: plain ES modules
and vendored libraries. `pandoc` is needed for the .docx deliverables.

## Rules that are not obvious from the code

- **No script names a data location.** Everything goes through a driver from
  `tools/sources/` selected by `config.toml`. This is what makes the eventual
  move to an object store or a live database a config edit. See
  `tools/sources/base.py` for the reasoning.
- **No frontend view touches DuckDB directly.** Every query goes through
  `site/js/query.js::runSQL`. Same reason.
- **Zero external hosts at runtime.** DuckDB-WASM, ECharts and fonts are
  vendored into `site/vendor/`. No CDN, no Google Fonts, no map tiles. A page
  with no third-party requests cannot be broken by anyone's corporate web
  filter — which is the whole point, given the next item.
- **`huggingface.co` is blocked on the SLB network** (web filter category
  "artificial-intelligence"; a warn-and-continue interstitial that a browser
  can click through but a script cannot). The raw petrodb Parquet was therefore
  downloaded by hand. Automated refresh runs in GitHub Actions, whose runners
  are not on that network. Do not attempt to bypass the filter locally.
- **`datos.energia.gob.ar` is reachable** and is the upstream publisher. It is
  used for verification (the small `serie-histórica` series), for first
  production dates, and for the fracture table.

## Facts about the data worth not re-deriving

- `prod_pet` is m³; `prod_gas` is **10³ m³** ("Mm³" in Argentine usage, i.e.
  thousands, not millions). Confirmed against the publisher's own daily and
  kbbl columns — see verification check 5. Oil conversion 6.28981 bbl/m³ is the
  publisher's own factor, not a textbook one.
- `coordenadax` / `coordenaday` are **already WGS84 decimal degrees**. The
  `geom` WKB carries SRID 4326 (`0101000020E6100000`). No reprojection.
- `idpozo` is wellbore × producing formation, **not** a physical wellbore. A
  well producing from two formations appears twice. Never count `idpozo` and
  call it a well count without saying which.
- **Trajectory (vertical/horizontal) is not in petrodb.** `tipopozo` is fluid
  type. Trajectory comes from the portal's fracture table via
  `longitud_rama_horizontal_m`, and is therefore known only for fractured
  wells. The third state is **Unknown** and it is never imputed.
- Production gaps are NULL, not zero. Keep them distinguishable in statistics.
- `p10` follows the statistical convention: **p10 is the low value.**

## Style

Code is annotated for a reader who is expert in the physics and newer to
programming: explain *why*, at the level of what the machine is actually doing,
not what the line says. Never explain petroleum engineering.
