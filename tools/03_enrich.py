"""Stage 3 — build the derived tables the dashboard actually queries.

WHAT GETS MATERIALISED AND WHY
------------------------------
The raw views stay views (see tools/warehouse.py). These three are real tables
because they are the product of genuine computation and are read many times:

  well_frac     one row per well, aggregated from per-job fracture records —
                and the source of the trajectory class.
  well_attrs    one row per well: identity, location, resource class, first and
                last production, cumulative volumes, completion attributes.
  prod_monthly  one row per well-month, carrying the operator and the fluid
                class *as they were in that month* rather than as they are now.

THE TEMPORAL JOIN IS THE INTERESTING PART
-----------------------------------------
Operator and well class both change over time. Attributing twenty years of a
block's production to whoever holds it today is a defensible view, but it is
not the same question as "who produced this in 2014", and the two give very
different answers when a block changes hands. Both are built here; the
dashboard says which one is on screen.

Run:  python tools/03_enrich.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tools.config import CFG, path
from tools.warehouse import open_warehouse

PORTAL = path(CFG["paths"]["raw"], "portal")
HORIZONTAL_M = 500.0  # justified in docs/verification_report.md, check 9


def main() -> int:
    con, _ = open_warehouse()
    frac = str(PORTAL / "fractura_adjunto_iv.csv")
    padron = str(PORTAL / "padron_primera_produccion.csv")

    # ------------------------------------------------------------------ 1 --
    # Fracture jobs -> one row per well.
    #
    # A well can be fractured several times (refracs, or a job reported per
    # stage batch). Aggregation rules differ by quantity and are not
    # interchangeable: lateral length is a property of the wellbore, so take
    # the max rather than the sum; proppant and water are consumed per job, so
    # they add; pressure is an observed peak, so it maxes.
    print("building well_frac …")
    con.execute(f"""
        CREATE OR REPLACE TABLE well_frac AS
        SELECT
            idpozo,
            count(*)                                    AS frac_jobs,
            max(longitud_rama_horizontal_m)             AS lateral_m,
            sum(cantidad_fracturas)                     AS stages,
            sum(coalesce(arena_bombeada_nacional_tn, 0)
              + coalesce(arena_bombeada_importada_tn, 0)) AS proppant_t,
            sum(agua_inyectada_m3)                      AS water_m3,
            max(presion_maxima_psi)                     AS max_pressure_psi,
            max(potencia_equipos_fractura_hp)           AS max_hhp,
            min(TRY_CAST(fecha_inicio_fractura AS DATE)) AS frac_first,
            max(TRY_CAST(fecha_fin_fractura    AS DATE)) AS frac_last,
            mode(tipo_terminacion)                      AS completion_type,
            mode(formacion_productiva)                  AS frac_formation
        FROM read_csv_auto('{frac}')
        GROUP BY idpozo
    """)

    # ------------------------------------------------------------------ 2 --
    # Per-well production history. `tef` is clamped before it is used for
    # anything rate-like: check 7 of the verification report found declarations
    # with up to 3,058 effective hours in a month whose ceiling is 744.
    print("building well_prod_summary …")
    con.execute("""
        CREATE OR REPLACE TABLE well_prod_summary AS
        SELECT
            idpozo,
            min(fecha) FILTER (WHERE coalesce(prod_pet,0) + coalesce(prod_gas,0) > 0)
                AS first_prod_month,
            max(fecha) FILTER (WHERE coalesce(prod_pet,0) + coalesce(prod_gas,0) > 0)
                AS last_prod_month,
            count(*) FILTER (WHERE coalesce(prod_pet,0) + coalesce(prod_gas,0) > 0)
                AS producing_months,
            sum(prod_pet)  AS cum_oil_m3,
            sum(prod_gas)  AS cum_gas_e3m3,
            sum(prod_agua) AS cum_water_m3,
            sum(iny_agua)  AS cum_water_inj_m3,
            sum(least(tef, 24 * date_diff('day', fecha, fecha + INTERVAL 1 MONTH)))
                AS total_effective_hours
        FROM monthly_production
        GROUP BY idpozo
    """)

    # ------------------------------------------------------------------ 3 --
    # The static per-well table the map and the well-level statistics read.
    #
    # `trajectory` is the four-state classification: no fracture record at all
    # means Unknown, and Unknown is never quietly folded into Vertical.
    print("building well_attrs …")
    con.execute(f"""
        CREATE OR REPLACE TABLE well_attrs AS
        WITH padron AS (
            SELECT idpozo, make_date(anio, mes, 1) AS first_prod_declared
            FROM read_csv_auto('{padron}')
        ),
        latest_op AS (
            -- The operator holding the well at the end of its history.
            SELECT idpozo, empresa, idempresa
            FROM (
                SELECT idpozo, empresa, idempresa,
                       row_number() OVER (PARTITION BY idpozo
                                          ORDER BY valid_from DESC) AS rn
                FROM well_operator_history
            ) WHERE rn = 1
        ),
        latest_state AS (
            SELECT idpozo, tipopozo, tipoestado, tipoextraccion
            FROM (
                SELECT idpozo, tipopozo, tipoestado, tipoextraccion,
                       row_number() OVER (PARTITION BY idpozo
                                          ORDER BY event_date DESC) AS rn
                FROM well_events
            ) WHERE rn = 1
        )
        SELECT
            w.idpozo, w.sigla, w.cuenca, w.provincia, w.area, w.yacimiento,
            w.formprod, w.formacion, w.clasificacion, w.subclasificacion,
            w.tipo_recurso, w.sub_tipo_recurso, w.profundidad, w.cota,
            w.coordenadax AS lon, w.coordenaday AS lat, w.has_production,
            o.empresa       AS operator_latest,
            o.idempresa     AS operator_code_latest,
            s.tipopozo      AS well_fluid_latest,
            s.tipoestado    AS well_state_latest,
            s.tipoextraccion AS lift_method_latest,
            p.first_prod_declared,
            ps.first_prod_month, ps.last_prod_month, ps.producing_months,
            ps.cum_oil_m3, ps.cum_gas_e3m3, ps.cum_water_m3,
            ps.cum_water_inj_m3, ps.total_effective_hours,
            f.frac_jobs, f.lateral_m, f.stages, f.proppant_t, f.water_m3,
            f.max_pressure_psi, f.max_hhp, f.frac_first, f.frac_last,
            f.completion_type,
            CASE
                WHEN f.idpozo IS NULL                THEN 'Unknown'
                WHEN f.lateral_m IS NULL             THEN 'Unknown'
                WHEN f.lateral_m >= {HORIZONTAL_M}   THEN 'Horizontal'
                ELSE 'Vertical'
            END AS trajectory,
            -- Completion intensity. Guarded with nullif so a zero lateral or a
            -- zero stage count yields NULL (undefined) instead of a division
            -- error or a misleading infinity.
            f.proppant_t * 1000 / nullif(f.lateral_m, 0)  AS proppant_kg_per_m,
            f.water_m3           / nullif(f.lateral_m, 0) AS water_m3_per_m,
            f.lateral_m          / nullif(f.stages, 0)    AS stage_spacing_m,
            -- Gas-oil ratio in m3/m3: prod_gas is 10^3 m3, hence the x1000.
            ps.cum_gas_e3m3 * 1000 / nullif(ps.cum_oil_m3, 0) AS gor_m3_m3
        FROM wells w
        LEFT JOIN latest_op o USING (idpozo)
        LEFT JOIN latest_state s USING (idpozo)
        LEFT JOIN padron p USING (idpozo)
        LEFT JOIN well_prod_summary ps USING (idpozo)
        LEFT JOIN well_frac f USING (idpozo)
    """)

    # ------------------------------------------------------------------ 4 --
    # Well-month facts with time-correct operator and fluid class.
    #
    # Two different temporal joins, because the two tables model time
    # differently:
    #
    #   well_operator_history stores explicit [valid_from, valid_to] intervals,
    #   so a range predicate is exact. valid_to is NULL for the open run, hence
    #   the coalesce to a far-future date.
    #
    #   well_events stores only the months where something *changed*, so the
    #   state in any other month is carried forward from the last change. That
    #   is precisely an ASOF JOIN: match the most recent row at or before the
    #   probe date. Doing it with a correlated subquery would work and would be
    #   orders of magnitude slower over 17.8 M rows.
    print("building prod_monthly (17.8 M rows, two temporal joins) …")
    con.execute("""
        CREATE OR REPLACE TABLE prod_monthly AS
        SELECT
            p.idpozo, p.fecha, p.anio,
            p.prod_pet, p.prod_gas, p.prod_agua,
            p.iny_agua, p.iny_gas,
            least(p.tef, 24 * date_diff('day', p.fecha,
                                        p.fecha + INTERVAL 1 MONTH)) AS tef,
            oh.empresa   AS operator_asof,
            ev.tipopozo  AS well_fluid_asof,
            ev.tipoestado AS well_state_asof
        FROM monthly_production p
        LEFT JOIN well_operator_history oh
               ON oh.idpozo = p.idpozo
              AND p.fecha BETWEEN oh.valid_from
                              AND coalesce(oh.valid_to, DATE '9999-12-31')
        ASOF LEFT JOIN well_events ev
               ON ev.idpozo = p.idpozo
              AND ev.event_date <= p.fecha
    """)

    # ------------------------------------------------------------- report ---
    print("\nresults")
    print("-" * 66)
    for label, sql in (
        ("wells with a fracture record", "SELECT count(*) FROM well_frac"),
        ("well_attrs rows", "SELECT count(*) FROM well_attrs"),
        ("prod_monthly rows", "SELECT count(*) FROM prod_monthly"),
        ("prod_monthly rows missing operator",
         "SELECT count(*) FROM prod_monthly WHERE operator_asof IS NULL"),
        ("prod_monthly rows missing fluid class",
         "SELECT count(*) FROM prod_monthly WHERE well_fluid_asof IS NULL"),
    ):
        print(f"  {label:<38}{con.execute(sql).fetchone()[0]:>14,}")

    print("\ntrajectory")
    print("-" * 66)
    for t, n, oil, lat in con.execute("""
        SELECT trajectory, count(*), sum(cum_oil_m3), avg(lateral_m)
        FROM well_attrs GROUP BY 1 ORDER BY 2 DESC
    """).fetchall():
        print(f"  {t:<14}{n:>8,} wells   cum oil {oil or 0:>16,.0f} m³   "
              f"mean lateral {lat or 0:>7,.0f} m")

    print("\nrow count is preserved by the temporal joins:")
    base = con.execute("SELECT count(*) FROM monthly_production").fetchone()[0]
    got = con.execute("SELECT count(*) FROM prod_monthly").fetchone()[0]
    # A range join that matched two overlapping operator runs would silently
    # duplicate well-months and inflate every total downstream. Checking the
    # count is the cheapest possible guard against that.
    print(f"  monthly_production {base:,} -> prod_monthly {got:,} "
          f"({'OK' if base == got else 'MISMATCH — overlapping operator runs!'})")

    con.close()
    return 0 if base == got else 1


if __name__ == "__main__":
    raise SystemExit(main())
