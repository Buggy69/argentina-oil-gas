"""Stage 1 — move the staged petrodb downloads into the canonical raw store.

THE PROBLEM THIS SOLVES
-----------------------
petrodb publishes `monthly_production` as one Parquet file per year, and every
one of them is named `data.parquet` — the year lives in the *directory*
(`anio=2019/data.parquet`), which a browser download throws away. So Max's
download folder contains 21 files called `data.parquet`, `data0.parquet`,
`data (1).parquet` … `data (19).parquet`, and the download order tells us
nothing reliable about which year is which.

Renaming them by hand would be twenty guesses. Instead this script asks each
file what it contains: `SELECT min(fecha), max(fecha)` costs almost nothing
because Parquet stores per-column min/max in its footer, so DuckDB answers from
metadata without decoding a single row. The file names itself, and a misfiled
partition becomes impossible rather than merely unlikely.

Run:  python tools/01_ingest_petrodb.py
"""

from __future__ import annotations

# --- bootstrap -------------------------------------------------------------
# Running `python tools/01_ingest_petrodb.py` puts `tools/` on sys.path, not the
# repository root, so `import tools.config` would fail. Three lines fix it
# explicitly. (The file cannot be imported as a module instead: a Python module
# name may not begin with a digit.)
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
# ---------------------------------------------------------------------------

import json
import shutil
from collections import defaultdict

import duckdb

from tools.config import CFG, path
from tools.sources import TABLES, sha256
from tools.warehouse import connect, register_views

SIMPLE_TABLES = ("wells", "well_events", "well_operator_history")


def human(n: int) -> str:
    return f"{n / 1_048_576:.2f} MB"


def copy_verified(src: Path, dst: Path) -> str:
    """Copy a file and prove the copy is byte-identical.

    copy2 preserves timestamps, which keeps the "downloaded on" date meaningful
    after the move. The hash comparison is not paranoia: OneDrive is a syncing
    filesystem, and a file that is still a cloud placeholder rather than real
    local bytes copies as a stub without raising anything.
    """
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    digest, back = sha256(src), sha256(dst)
    if digest != back:
        raise OSError(f"copy of {src.name} does not match source (sha256 differs)")
    return digest


def main() -> int:
    staging = Path(CFG["paths"]["staging"])
    raw = path(CFG["source"]["local_parquet"]["root"])

    if not staging.exists():
        print(f"staging folder not found: {staging}", file=sys.stderr)
        return 1

    print(f"staging : {staging}")
    print(f"target  : {raw}\n")

    manifest: dict[str, object] = {"staging": str(staging), "files": {}}

    # -- 1. the three single-file tables ------------------------------------
    for table in SIMPLE_TABLES:
        src = staging / f"{table}.parquet"
        if not src.exists():
            print(f"MISSING  {src.name}", file=sys.stderr)
            return 1
        digest = copy_verified(src, raw / f"{table}.parquet")
        size = src.stat().st_size
        print(f"  {table:<24} {human(size):>10}  {digest[:12]}…")
        manifest["files"][f"{table}.parquet"] = {"bytes": size, "sha256": digest}

    # -- 2. identify every monthly_production partition ---------------------
    # `data.parquet`, `data0.parquet`, `data (7).parquet` — glob catches all.
    candidates = sorted(staging.glob("data*.parquet"))
    print(f"\nidentifying {len(candidates)} monthly_production partitions "
          f"by their own date range…\n")

    con = duckdb.connect()  # throwaway in-memory connection, just for metadata
    found: dict[int, list[dict]] = defaultdict(list)

    for f in candidates:
        # One query, answered from the Parquet footer's column statistics.
        # min/max/count are all footer-resident, so this does not scan data.
        rows, lo, hi = con.execute(
            "SELECT count(*), min(fecha), max(fecha) FROM read_parquet(?)", [str(f)]
        ).fetchone()

        years = {lo.year, hi.year}
        if len(years) != 1:
            # A partition that spans two calendar years would break the
            # anio=YYYY layout, so refuse rather than pick one.
            print(f"  ! {f.name}: spans {sorted(years)} — not a year partition",
                  file=sys.stderr)
            return 1

        year = lo.year
        found[year].append(
            {"file": f, "rows": rows, "lo": lo, "hi": hi,
             "bytes": f.stat().st_size, "sha256": sha256(f)}
        )

    # -- 3. resolve duplicates ---------------------------------------------
    duplicates: list[str] = []
    for year, entries in sorted(found.items()):
        if len(entries) == 1:
            continue
        hashes = {e["sha256"] for e in entries}
        names = ", ".join(e["file"].name for e in entries)
        if len(hashes) == 1:
            # Same bytes downloaded twice — harmless, keep one, say so.
            duplicates.append(f"{year}: {names} are byte-identical; kept one")
            found[year] = entries[:1]
        else:
            # Different content for the same year is a real problem: one of
            # them is stale. Keep the larger and shout about it rather than
            # silently choosing.
            entries.sort(key=lambda e: e["rows"], reverse=True)
            duplicates.append(
                f"{year}: {names} DIFFER "
                f"({', '.join(str(e['rows']) for e in entries)} rows) — kept the largest"
            )
            found[year] = entries[:1]

    # -- 4. coverage table --------------------------------------------------
    years = sorted(found)
    print(f"  {'year':<6}{'rows':>12}  {'first':<12}{'last':<12}{'size':>10}  source")
    print("  " + "-" * 74)
    total_rows = 0
    for year in years:
        e = found[year][0]
        total_rows += e["rows"]
        print(f"  {year:<6}{e['rows']:>12,}  {e['lo']!s:<12}{e['hi']!s:<12}"
              f"{human(e['bytes']):>10}  {e['file'].name}")
    print("  " + "-" * 74)
    print(f"  {'total':<6}{total_rows:>12,}   {len(years)} partitions "
          f"{years[0]}–{years[-1]}")

    gaps = [y for y in range(years[0], years[-1] + 1) if y not in found]
    if gaps:
        print(f"\n  MISSING YEARS: {gaps}", file=sys.stderr)
    if duplicates:
        print("\n  duplicates resolved:")
        for line in duplicates:
            print(f"    - {line}")

    # -- 5. write them into the hive layout ---------------------------------
    dest_root = raw / "monthly_production"
    if dest_root.exists():
        shutil.rmtree(dest_root)  # a clean slate; stale years must not survive
    for year in years:
        e = found[year][0]
        digest = copy_verified(e["file"], dest_root / f"anio={year}" / "data.parquet")
        manifest["files"][f"monthly_production/anio={year}/data.parquet"] = {
            "bytes": e["bytes"], "sha256": digest,
            "rows": e["rows"], "staged_as": e["file"].name,
        }

    manifest["monthly_production_rows"] = total_rows
    manifest["years"] = years
    manifest["gaps"] = gaps
    manifest["duplicates"] = duplicates
    (raw / "_ingest_manifest.json").write_text(
        json.dumps(manifest, indent=2, default=str), encoding="utf-8"
    )

    # -- 6. register the warehouse views ------------------------------------
    con2 = connect()
    register_views(con2)
    print("\nwarehouse views registered:")
    for table in TABLES:
        n = con2.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
        print(f"  {table:<24}{n:>12,}")

    # Prove the hive partition key really became a column — if this returns
    # NULL the glob matched files but hive_partitioning did not fire, and every
    # year-filtered query downstream would silently return nothing.
    probe = con2.execute(
        "SELECT anio, count(*) FROM monthly_production GROUP BY anio "
        "ORDER BY anio LIMIT 3"
    ).fetchall()
    print(f"  hive key `anio` resolves: {probe}")
    con2.close()

    return 1 if gaps else 0


if __name__ == "__main__":
    raise SystemExit(main())
