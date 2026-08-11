"""Stage 4 — emit the three data tiers the browser downloads.

THE SIZING PROBLEM
------------------
17.8 M well-months cannot be shipped to a phone. But a dashboard that only
shows pre-chosen slices is not analysis. The resolution is three tiers with
different jobs:

  A  summary.json      ~100 KB, no engine needed. First paint is instant.
  B  agg_monthly       a pre-aggregated cube over the dimensions people filter
     wells_slim        by, plus every well as a row. Loaded into DuckDB-WASM at
                       start; all facet filtering and statistics run on these.
  C  monthly/anio=*    the full well-month history, one file per year, sorted by
                       idpozo. Never loaded whole — fetched by HTTP range
                       request when the user drills into individual wells.

WHY TIER C WORKS OVER HTTP
--------------------------
Parquet stores min/max statistics per row group in its footer. Sorting by
idpozo means a given well's rows live in one or two row groups, so DuckDB reads
the footer, finds the byte ranges it needs, and issues Range requests for those
alone. Sorting is not cosmetic here — it is the entire reason a browser can
query 17.8 M rows without downloading them.

Run:  python tools/04_build_web_data.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import json
import shutil
from datetime import datetime, timezone

from tools.config import CFG, path
from tools.sources import sha256
from tools.warehouse import open_warehouse

SITE = path(CFG["paths"]["site_data"])
B = CFG["build"]


def mb(n: int) -> float:
    return n / 1_048_576


def main() -> int:
    con, src = open_warehouse()
    SITE.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------ 0 --
    # Top-N maps. High-cardinality dimensions are capped so the cube does not
    # explode: 700-odd operators would multiply the row count without anyone
    # ever filtering on the 400th. Ranking is by cumulative oil-equivalent, so
    # "Other" is genuinely the tail and not an arbitrary alphabetical cut.
    print("ranking high-cardinality dimensions …")
    con.execute(f"""
        CREATE OR REPLACE TABLE dim_operator AS
        SELECT operator_latest AS name,
               row_number() OVER (ORDER BY sum(coalesce(cum_oil_m3,0)
                                             + coalesce(cum_gas_e3m3,0)) DESC) AS rnk
        FROM well_attrs WHERE operator_latest IS NOT NULL
        GROUP BY 1 QUALIFY rnk <= {B['top_n_operators']}
    """)
    con.execute(f"""
        CREATE OR REPLACE TABLE dim_formation AS
        SELECT formprod AS name,
               row_number() OVER (ORDER BY sum(coalesce(cum_oil_m3,0)
                                             + coalesce(cum_gas_e3m3,0)) DESC) AS rnk
        FROM well_attrs WHERE formprod IS NOT NULL
        GROUP BY 1 QUALIFY rnk <= {B['top_n_formations']}
    """)

    # ------------------------------------------------------------------ 1 --
    # Tier B, part 1: the cube.
    #
    # Every dimension here is something a user filters by. `fecha` is the only
    # one that is not a well attribute, which matters for counting: within a
    # single month a well falls in exactly one cell, so summing `wells` across
    # cells of one month is correct. Across months it is not — the same well
    # recurs — so the frontend treats well counts as a per-month series and
    # never sums them along time. That constraint is documented in the JSON
    # sidecar so a future reader cannot miss it.
    print("building agg_monthly cube …")
    con.execute("""
        CREATE OR REPLACE TABLE agg_monthly AS
        SELECT
            p.fecha,
            a.cuenca, a.provincia,
            a.tipo_recurso, a.sub_tipo_recurso,
            coalesce(fo.name, 'Other')  AS formation,
            coalesce(op.name, 'Other')  AS operator,
            coalesce(p.well_fluid_asof, 'No informado') AS well_fluid,
            a.trajectory,
            count(DISTINCT p.idpozo)                            AS wells,
            count(DISTINCT p.idpozo) FILTER (
                WHERE coalesce(p.prod_pet,0) + coalesce(p.prod_gas,0) > 0) AS wells_producing,
            sum(p.prod_pet)  AS oil_m3,
            sum(p.prod_gas)  AS gas_e3m3,
            sum(p.prod_agua) AS water_m3,
            sum(p.iny_agua)  AS water_inj_m3,
            sum(p.tef)       AS effective_hours
        FROM prod_monthly p
        JOIN well_attrs a USING (idpozo)
        LEFT JOIN dim_operator  op ON op.name = p.operator_asof
        LEFT JOIN dim_formation fo ON fo.name = a.formprod
        GROUP BY ALL
    """)
    cube_rows = con.execute("SELECT count(*) FROM agg_monthly").fetchone()[0]
    print(f"  cube rows: {cube_rows:,}")

    con.execute(f"""
        COPY (SELECT * FROM agg_monthly ORDER BY fecha, cuenca)
        TO '{(SITE / 'agg_monthly.parquet').as_posix()}'
        (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000)
    """)

    # ------------------------------------------------------------------ 2 --
    # Tier B, part 2: one row per well. This drives the map, the well-level
    # statistics and every facet that is a well attribute rather than a
    # time-varying one.
    print("building wells_slim …")
    con.execute(f"""
        COPY (
            SELECT idpozo, sigla, cuenca, provincia, area, yacimiento,
                   formprod AS formation, formacion AS formation_reported,
                   tipo_recurso, sub_tipo_recurso, clasificacion,
                   operator_latest AS operator, well_fluid_latest AS well_fluid,
                   well_state_latest AS well_state, lift_method_latest AS lift_method,
                   trajectory, completion_type,
                   round(lon, 6) AS lon, round(lat, 6) AS lat,
                   profundidad AS depth_m,
                   first_prod_declared, first_prod_month, last_prod_month,
                   producing_months,
                   cum_oil_m3, cum_gas_e3m3, cum_water_m3,
                   lateral_m, stages, proppant_t, water_m3 AS frac_water_m3,
                   max_pressure_psi,
                   proppant_kg_per_m, water_m3_per_m, stage_spacing_m, gor_m3_m3
            FROM well_attrs ORDER BY cuenca, idpozo
        ) TO '{(SITE / 'wells_slim.parquet').as_posix()}'
        (FORMAT parquet, COMPRESSION zstd)
    """)

    # ------------------------------------------------------------------ 3 --
    # Tier C: the full well-month history, sharded BY WELL rather than by year.
    #
    # THE HOST DICTATES THIS LAYOUT
    # ------------------------------
    # The obvious layout is one file per year, sorted by idpozo, letting the
    # browser pull one well out with HTTP range requests guided by Parquet's
    # row-group statistics. That is a good design and it does not work on
    # GitHub Pages: Pages gzips application/octet-stream whenever the client
    # accepts gzip (browsers always do, and fetch() is forbidden from saying
    # otherwise), and it then applies Range to the COMPRESSED stream. Byte
    # offsets computed against the real file address the wrong data, and the
    # Parquet footer check fails outright.
    #
    # So: shard by well. Each bucket holds the complete history of every well
    # whose id falls in it, which makes a drill-down exactly one small
    # whole-file GET — no ranges, nothing for the CDN's compression to break,
    # and the browser decodes Content-Encoding transparently.
    #
    # The modulus is the tuning knob: more buckets means a smaller download per
    # well and more files. 256 puts each bucket near half a megabyte.
    BUCKETS = 256
    print(f"building tier C ({BUCKETS} buckets sharded by well) …")
    wells_dir = SITE / "wells"
    if wells_dir.exists():
        shutil.rmtree(wells_dir)
    # Removed by the reshard; delete any stale copy from a previous build so the
    # published site cannot serve a layout the code no longer reads.
    if (SITE / "monthly").exists():
        shutil.rmtree(SITE / "monthly")

    tier_c: dict[str, dict] = {}
    for b in range(BUCKETS):
        dest = wells_dir / f"bucket={b}"
        dest.mkdir(parents=True, exist_ok=True)
        out = dest / "data.parquet"
        con.execute(f"""
            COPY (
                SELECT idpozo, fecha, prod_pet AS oil_m3, prod_gas AS gas_e3m3,
                       prod_agua AS water_m3, tef AS effective_hours
                FROM prod_monthly
                WHERE idpozo % {BUCKETS} = {b}
                ORDER BY idpozo, fecha
            ) TO '{out.as_posix()}'
            (FORMAT parquet, COMPRESSION zstd)
        """)
        tier_c[str(b)] = {"bytes": out.stat().st_size, "sha256": sha256(out)}
    tier_c_buckets = BUCKETS

    # ------------------------------------------------------------- 3b ------
    # Tier B, part 3: pre-computed type curves.
    #
    # A type curve needs per-well production re-indexed to months *since that
    # well started*, then a distribution across wells at each month index.
    # Doing that in the browser would mean pulling the full well-month history
    # — the one thing the tiering exists to avoid. Since the groupings people
    # actually compare (trajectory, resource subtype, basin, vintage) are few,
    # the whole distribution is small enough to precompute exactly.
    #
    # p10 is the LOW value here — the statistical convention, not the reserves
    # one. Stated in the sidecar so no reader has to guess which way it runs.
    print("building type curves …")
    con.execute("""
        CREATE OR REPLACE TABLE typecurve AS
        WITH base AS (
            SELECT
                p.idpozo, p.fecha, p.prod_pet, p.prod_gas,
                a.trajectory,
                coalesce(a.sub_tipo_recurso, 'No informado') AS subtype,
                a.cuenca,
                year(a.first_prod_month) AS vintage,
                date_diff('month', a.first_prod_month, p.fecha) AS m
            FROM prod_monthly p
            JOIN well_attrs a USING (idpozo)
            WHERE a.first_prod_month IS NOT NULL
              AND p.fecha >= a.first_prod_month
        )
        SELECT trajectory, subtype, cuenca, vintage, m AS month_on_prod,
               count(DISTINCT idpozo)                       AS wells,
               round(quantile_cont(prod_pet, 0.10), 2)      AS oil_p10,
               round(quantile_cont(prod_pet, 0.50), 2)      AS oil_p50,
               round(quantile_cont(prod_pet, 0.90), 2)      AS oil_p90,
               round(avg(prod_pet), 2)                      AS oil_mean,
               round(quantile_cont(prod_gas, 0.50), 2)      AS gas_p50,
               round(avg(prod_gas), 2)                      AS gas_mean
        FROM base
        WHERE m BETWEEN 0 AND 119        -- ten years is past any useful reading
        GROUP BY ALL
        HAVING count(DISTINCT idpozo) >= 5   -- a "distribution" over <5 wells
                                             -- is not one; suppress rather than
                                             -- draw a confident-looking band
    """)
    tc_rows = con.execute("SELECT count(*) FROM typecurve").fetchone()[0]
    print(f"  typecurve rows: {tc_rows:,}")
    con.execute(f"""
        COPY (SELECT * FROM typecurve ORDER BY trajectory, subtype, cuenca,
                                                vintage, month_on_prod)
        TO '{(SITE / 'typecurve.parquet').as_posix()}'
        (FORMAT parquet, COMPRESSION zstd)
    """)

    # ------------------------------------------------------------------ 4 --
    # Tier A: the instant-paint summary. Small enough to inline-parse before
    # the SQL engine has even finished loading.
    print("building summary.json …")

    def rows(sql: str) -> list[dict]:
        cur = con.execute(sql)
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]

    summary = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "note_on_well_counts": (
            "Well counts are per-month. A well recurs across months, so counts "
            "may be summed across categories within one month but never along "
            "time; aggregate them over a period with max or mean instead."
        ),
        "units": {"oil": "m3", "gas": "e3m3 (10^3 m3)", "water": "m3",
                  "m3_to_bbl": CFG["units"]["m3_to_bbl"],
                  "e3m3_to_mcf": CFG["units"]["mm3_to_mcf"]},
        "coverage": rows("""
            SELECT min(fecha) AS first_month, max(fecha) AS last_month,
                   count(DISTINCT fecha) AS months
            FROM agg_monthly""")[0],
        "kpi": rows("""
            SELECT (SELECT count(*) FROM well_attrs)                     AS wells,
                   (SELECT count(*) FROM well_attrs WHERE has_production) AS wells_with_production,
                   (SELECT count(*) FROM well_attrs WHERE trajectory = 'Horizontal') AS wells_horizontal,
                   (SELECT count(*) FROM well_attrs WHERE trajectory = 'Vertical')   AS wells_vertical,
                   (SELECT count(*) FROM well_attrs WHERE trajectory = 'Unknown')    AS wells_unknown_trajectory,
                   (SELECT sum(oil_m3)   FROM agg_monthly) AS cum_oil_m3,
                   (SELECT sum(gas_e3m3) FROM agg_monthly) AS cum_gas_e3m3""")[0],
        "national_monthly": rows("""
            SELECT strftime(fecha, '%Y-%m') AS ym,
                   round(sum(oil_m3), 1) AS oil_m3,
                   round(sum(gas_e3m3), 1) AS gas_e3m3,
                   round(sum(water_m3), 1) AS water_m3,
                   sum(wells_producing) AS wells_producing
            FROM agg_monthly GROUP BY 1 ORDER BY 1"""),
        "basin_monthly": rows("""
            SELECT strftime(fecha, '%Y-%m') AS ym, cuenca,
                   round(sum(oil_m3), 1) AS oil_m3,
                   round(sum(gas_e3m3), 1) AS gas_e3m3
            FROM agg_monthly GROUP BY 1, 2 ORDER BY 1, 2"""),
        "unconventional_monthly": rows("""
            SELECT strftime(fecha, '%Y-%m') AS ym,
                   coalesce(sub_tipo_recurso, 'No informado') AS subtype,
                   round(sum(oil_m3), 1) AS oil_m3,
                   round(sum(gas_e3m3), 1) AS gas_e3m3
            FROM agg_monthly GROUP BY 1, 2 ORDER BY 1, 2"""),
        "domains": {
            d: rows(f"""SELECT coalesce({d}, '(sin dato)') AS value, count(*) AS wells
                        FROM well_attrs GROUP BY 1 ORDER BY 2 DESC""")
            for d in ("cuenca", "provincia", "tipo_recurso", "sub_tipo_recurso",
                      "trajectory", "well_fluid_latest", "clasificacion")
        },
        "data_quality": json.loads(
            (path("docs") / "verification_findings.json").read_text(encoding="utf-8")
        ) if (path("docs") / "verification_findings.json").exists() else {},
    }
    summary_path = SITE / "summary.json"
    summary_path.write_text(json.dumps(summary, separators=(",", ":"), default=str),
                            encoding="utf-8")

    # ------------------------------------------------------ self-check ----
    # Aggregation is where a dashboard most easily starts lying: one wrong join
    # and every headline number is quietly inflated. Compare the cube's totals
    # back to the ungrouped source they came from.
    print("\ncube reproduces the source totals")
    print("-" * 70)
    base = con.execute(
        "SELECT sum(prod_pet), sum(prod_gas) FROM prod_monthly").fetchone()
    cube = con.execute(
        "SELECT sum(oil_m3), sum(gas_e3m3) FROM agg_monthly").fetchone()
    agg_ok = True
    for label, a, b in (("oil m³", base[0], cube[0]), ("gas 10³m³", base[1], cube[1])):
        # Floating-point summation reorders under GROUP BY, so demand a
        # relative match rather than bit equality — but a tight one: 1e-9 is
        # far below any real aggregation error and far above float noise.
        rel = abs(a - b) / abs(a)
        agg_ok &= rel < 1e-9
        print(f"  {label:<12}source {a:>20,.1f}   cube {b:>20,.1f}   "
              f"rel Δ {rel:.2e}  {'OK' if rel < 1e-9 else 'MISMATCH'}")

    # ------------------------------------------------------------- gate ----
    # Budgets apply to what crosses the wire. GitHub Pages serves text with
    # gzip, so judging summary.json by its size on disk would fail it for a
    # cost the user never pays. Parquet is already compressed internally and
    # gains nothing from transport encoding, so it is judged as stored.
    import gzip

    print("\nsize budget (JSON judged gzipped — that is what the browser fetches)")
    print("-" * 70)
    agg = SITE / "agg_monthly.parquet"
    wells_p = SITE / "wells_slim.parquet"
    tier_c_total = sum(v["bytes"] for v in tier_c.values())
    tier_c_max = max(v["bytes"] for v in tier_c.values())
    summary_gz = len(gzip.compress(summary_path.read_bytes(), 9))
    for label, size, budget, extra in (
        ("summary.json (tier A)", summary_gz, 200 * 1024,
         f"{mb(summary_path.stat().st_size):.2f} MB raw"),
        ("agg_monthly.parquet (tier B)", agg.stat().st_size, 8 * 1_048_576,
         f"{cube_rows:,} rows"),
        ("wells_slim.parquet (tier B)", wells_p.stat().st_size, 5 * 1_048_576, ""),
        ("typecurve.parquet (tier B)", (SITE / "typecurve.parquet").stat().st_size,
         3 * 1_048_576, f"{tc_rows:,} rows"),
        (f"wells/ (tier C, {tier_c_buckets} buckets)", tier_c_total,
         B["tier_c_max_total_mb"] * 1_048_576, ""),
        ("largest tier C bucket", tier_c_max, B["tier_c_max_file_mb"] * 1_048_576,
         "= the cost of opening one well"),
    ):
        ok = "OK " if size <= budget else "OVER"
        print(f"  {ok} {label:<30}{mb(size):>8.2f} MB   budget {mb(budget):>7.1f} MB"
              f"   {extra}")

    over = (summary_gz > 200 * 1024
            or agg.stat().st_size > 8 * 1_048_576
            or wells_p.stat().st_size > 5 * 1_048_576
            or tier_c_total > B["tier_c_max_total_mb"] * 1_048_576
            or tier_c_max > B["tier_c_max_file_mb"] * 1_048_576
            or not agg_ok)

    # ------------------------------------------------------- provenance ----
    provenance = {
        "generated": summary["generated"],
        "snapshot": CFG["project"]["snapshot"],
        "petrodb": src.fingerprint(),
        "portal": json.loads(
            (path(CFG["paths"]["raw"], "portal") / "_portal_manifest.json")
            .read_text(encoding="utf-8")),
        "outputs": {
            "summary.json": {"bytes": summary_path.stat().st_size,
                             "sha256": sha256(summary_path)},
            "agg_monthly.parquet": {"bytes": agg.stat().st_size,
                                    "rows": cube_rows, "sha256": sha256(agg)},
            "wells_slim.parquet": {"bytes": wells_p.stat().st_size,
                                   "sha256": sha256(wells_p)},
            "typecurve.parquet": {"bytes": (SITE / "typecurve.parquet").stat().st_size,
                                  "rows": tc_rows,
                                  "sha256": sha256(SITE / "typecurve.parquet")},
            "wells_buckets": tier_c,
        },
        "tier_c_layout": {
            "path": "data/wells/bucket=<idpozo % 256>/data.parquet",
            "buckets": tier_c_buckets,
            "why": ("Sharded by well, not by year: GitHub Pages gzips this "
                    "content type and applies Range to the compressed stream, "
                    "so range-based reads cannot work. One whole small file "
                    "per drill-down instead."),
        },
        "licence": {
            "petrodb": "CC BY 4.0 — sumpalabs/petrodb, curated by Oscar Cortez",
            "portal": ("CC BY 4.0 — Secretaría de Energía de la Nación, "
                       "datos.energia.gob.ar"),
        },
    }
    (path("site") / "PROVENANCE.json").write_text(
        json.dumps(provenance, indent=2, default=str), encoding="utf-8")

    print(f"\nwritten to {SITE}")
    con.close()
    return 1 if over else 0


if __name__ == "__main__":
    raise SystemExit(main())
