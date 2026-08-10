# ---
# jupyter:
#   jupytext:
#     text_representation:
#       extension: .py
#       format_name: percent
#   kernelspec:
#     display_name: Python (geomech)
#     language: python
#     name: geomech
# ---

# %% [markdown]
# # Argentina production data — reproducing the dashboard's headline numbers
#
# This notebook is the **source of record in `.py` form** (jupytext percent
# format). Build the `.ipynb` from it, never the other way round — a `.py` is
# diffable, a notebook is not.
#
# Its real job is to be a **regression test**. Every number the dashboard shows
# is asserted here against the warehouse. Run it after any pipeline change: if
# an assertion fails, something moved that should not have.
#
# ```powershell
# $PY = "C:\Users\mhaas\AppData\Local\anaconda3\envs\geomech\python.exe"
# & $PY -m jupytext --to ipynb --execute notebooks\petrodb_ar_exploration.py
# ```

# %%
import sys
from pathlib import Path

# The notebook lives one level below the repo root, and Jupyter's working
# directory is wherever it was launched — so resolve the root explicitly rather
# than relying on relative paths.
ROOT = Path.cwd()
if not (ROOT / "tools").exists():
    ROOT = ROOT.parent
sys.path.insert(0, str(ROOT))

import matplotlib

# Agg: render to a buffer, never to a window. Without this a headless run blocks
# forever trying to open a GUI backend.
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from tools.warehouse import open_warehouse

con, src = open_warehouse()
print("source driver:", src.name)

# %% [markdown]
# ## 1. Shape of the corpus
#
# These are the numbers printed on the dashboard's Overview tiles.

# %%
shape = con.execute("""
    SELECT (SELECT count(*) FROM wells)              AS wells,
           (SELECT count(*) FROM monthly_production) AS well_months,
           (SELECT min(fecha) FROM monthly_production) AS first_month,
           (SELECT max(fecha) FROM monthly_production) AS last_month
""").fetchone()
print(f"wells        {shape[0]:>12,}")
print(f"well-months  {shape[1]:>12,}")
print(f"period       {shape[2]} .. {shape[3]}")

assert shape[0] == 85_417, "well count moved"
assert shape[1] == 17_775_911, "well-month count moved"

# %% [markdown]
# ## 2. The unit derivation, re-run
#
# The official series publishes the monthly total, the daily average, and the
# daily average in thousands of barrels. Those three are redundant, which makes
# them a closed test: dividing the total by the days in the month must reproduce
# the published daily figure, and their ratio must give the barrel factor.
#
# No external constant is trusted here — the number falls out of the
# publisher's own arithmetic.

# %%
oil_csv = (ROOT / "data/raw/portal/serie_historica_petroleo.csv").as_posix()
row = con.execute(f"""
    SELECT indice_tiempo, total, total_diario, kbbl_diario
    FROM read_csv_auto('{oil_csv}') ORDER BY indice_tiempo LIMIT 1
""").fetchone()
ym, total, daily, kbbl = row
days = 31  # 2006-01
derived_daily = total / days
factor = kbbl * 1000 / derived_daily

print(f"{ym}: total {total:,.4f} m3 over {days} days")
print(f"   total/days      = {derived_daily:,.4f}   published: {daily:,.4f}")
print(f"   implied bbl/m3  = {factor:.5f}")

assert abs(derived_daily - daily) < 1e-3, "the daily column is not total/days"
assert abs(factor - 6.28981) < 1e-4, "barrel factor moved"

# %% [markdown]
# ## 3. Reconciliation against the publisher
#
# The strongest check in the project: this pipeline's per-well sums against a
# monthly series the publisher computes by a different route. Agreement here is
# evidence; disagreement localises a problem to a basin and a month.

# %%
BASINS = {"AUSTRAL": "austral", "GOLFO SAN JORGE": "gsj", "NEUQUINA": "neuquina",
          "NOROESTE": "noroeste", "CUYANA": "cuyana"}

print(f"{'basin':<18}{'petrodb (m3)':>18}{'official (m3)':>18}{'delta':>10}")
print("-" * 64)
worst = 0.0
for basin, suffix in BASINS.items():
    mine, theirs = con.execute(f"""
        WITH mine AS (
            SELECT strftime(p.fecha, '%Y-%m') AS ym, sum(p.prod_pet) AS v
            FROM monthly_production p JOIN wells w USING (idpozo)
            WHERE w.cuenca = ? GROUP BY 1
        ), theirs AS (
            SELECT indice_tiempo AS ym, cuenca_{suffix} AS v
            FROM read_csv_auto('{oil_csv}')
        )
        SELECT sum(mine.v), sum(theirs.v) FROM mine JOIN theirs USING (ym)
    """, [basin]).fetchone()
    d = (mine - theirs) / theirs * 100
    worst = max(worst, abs(d))
    print(f"{basin:<18}{mine:>18,.0f}{theirs:>18,.0f}{d:>9.3f}%")

print(f"\nworst basin deviation: {worst:.3f}%")
assert worst < 1.0, "reconciliation against the official series has drifted"

# %% [markdown]
# ## 4. Trajectory, and the honest size of the unknown
#
# Trajectory is not in the production data at all. It comes from the fracture
# table's reported lateral length, so it exists only where a fracture was
# reported — which is most unconventional wells and almost no conventional ones.
# The `Unknown` bucket is published rather than imputed away.

# %%
traj = con.execute("""
    SELECT trajectory, count(*) AS wells,
           round(avg(lateral_m)) AS mean_lateral_m,
           round(median(cum_oil_m3)) AS median_cum_oil_m3
    FROM well_attrs GROUP BY 1 ORDER BY 2 DESC
""").fetchall()
for t, n, lat, med in traj:
    print(f"{t:<12}{n:>8,} wells   mean lateral {str(lat):>7} m   "
          f"median cum oil {med:>9,.0f} m3")

unknown = next(n for t, n, _, _ in traj if t == "Unknown")
print(f"\nUnknown is {unknown / 85_417 * 100:.1f}% of wells — stated on the site, "
      f"never imputed.")

# %% [markdown]
# ## 5. Horizontal wells did not merely get more common — they changed the curve
#
# Median monthly oil against months since each well's own first production.
# This is the shape the Well performance view draws.

# %%
tc = con.execute("""
    SELECT trajectory, month_on_prod, oil_p50
    FROM typecurve
    WHERE subtype = 'SHALE' AND month_on_prod <= 48
      AND trajectory IN ('Horizontal', 'Vertical')
    ORDER BY trajectory, month_on_prod
""").df()

fig, ax = plt.subplots(figsize=(7, 4), dpi=110)
for name, grp in tc.groupby("trajectory"):
    ax.plot(grp.month_on_prod, grp.oil_p50, lw=2, label=name)
ax.set_xlabel("months on production")
ax.set_ylabel("median oil per well  [m³/month]")
ax.set_title("Shale wells — median decline by trajectory")
ax.legend(frameon=False)
ax.spines[["top", "right"]].set_visible(False)
ax.grid(axis="y", lw=0.5, alpha=0.35)
fig.tight_layout()
fig.savefig(ROOT / "docs" / "typecurve_shale.png")
print("saved docs/typecurve_shale.png")

peak = tc[tc.trajectory == "Horizontal"].oil_p50.max()
print(f"horizontal shale peak median: {peak:,.0f} m3/month")
assert peak > 1000, "horizontal shale type curve looks wrong"

# %% [markdown]
# ## 6. Concentration — why a mean is the wrong summary here
#
# A small number of wells carry the basin. Any statistic that reports only a
# mean is describing a distribution it does not have.

# %%
conc = con.execute("""
    WITH w AS (
        SELECT cum_oil_m3 AS v FROM well_attrs
        WHERE cum_oil_m3 > 0 AND cuenca = 'NEUQUINA'
    ), ranked AS (
        SELECT v, row_number() OVER (ORDER BY v DESC) AS rn, count(*) OVER () AS n
        FROM w
    )
    SELECT
        (SELECT sum(v) FROM ranked WHERE rn <= n * 0.05) / (SELECT sum(v) FROM ranked) * 100,
        (SELECT avg(v) FROM ranked),
        (SELECT median(v) FROM ranked),
        (SELECT n FROM ranked LIMIT 1)
""").fetchone()
print(f"Neuquina, {conc[3]:,} producing wells")
print(f"  top 5% of wells hold : {conc[0]:.1f}% of cumulative oil")
print(f"  mean                 : {conc[1]:,.0f} m3")
print(f"  median               : {conc[2]:,.0f} m3")
print(f"  mean / median        : {conc[1] / conc[2]:.1f}x")

# %%
con.close()
print("all assertions passed")
