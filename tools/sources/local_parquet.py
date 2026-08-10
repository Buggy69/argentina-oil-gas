"""Driver: petrodb Parquet files sitting on the local filesystem.

This is the driver used for day-to-day work, reading the canonical raw store
that Stage 1 populates from Max's browser downloads.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..config import path as resolve_path
from .base import TABLES, _check_table, sha256


def q(p: Path | str) -> str:
    """Quote a path or URL as a SQL string literal, in a form DuckDB likes.

    Two things happen here, both load-bearing:

    1. Backslashes become forward slashes. DuckDB accepts ``C:/Users/...`` on
       Windows, but its *glob* matcher treats ``\\`` inconsistently — a pattern
       like ``anio=*\\*.parquet`` can silently match nothing, which looks
       exactly like an empty dataset rather than an error. Path.as_posix()
       sidesteps the whole class of problem. URLs are already posix-shaped and
       pass through untouched.

    2. Single quotes are doubled. SQL escapes a quote by repeating it, not with
       a backslash. Rare in paths, but "Max's data" is a perfectly ordinary
       folder name and would otherwise terminate the string literal early.
    """
    text = p.as_posix() if isinstance(p, Path) else str(p)
    return "'" + text.replace("'", "''") + "'"


class LocalParquetSource:
    """Reads the four tables from a directory laid out as::

        <root>/wells.parquet
        <root>/well_events.parquet
        <root>/well_operator_history.parquet
        <root>/monthly_production/anio=YYYY/data.parquet
    """

    name = "local_parquet"

    def __init__(self, root: str) -> None:
        self.root = resolve_path(root)

    # -- the seam ---------------------------------------------------------
    def scan_sql(self, table: str) -> str:
        _check_table(table)

        if table == "monthly_production":
            # A glob plus hive_partitioning=true recovers `anio` from the
            # directory name, so the year is queryable as a real column without
            # being stored in any file. Filtering on it lets DuckDB skip whole
            # files before opening them — the cheapest filter there is.
            glob = self.root / "monthly_production" / "anio=*" / "*.parquet"
            return f"read_parquet({q(glob)}, hive_partitioning = true)"

        return f"read_parquet({q(self.root / (table + '.parquet'))})"

    def ensure_available(self) -> None:
        """Fail early and specifically rather than deep inside a query.

        A missing file surfaced here names the table and the expected path; the
        same failure surfaced from DuckDB three stages later is a glob that
        matched nothing and an empty result that looks like real data.
        """
        missing = [t for t in TABLES if not self._files(t)]
        if missing:
            raise FileNotFoundError(
                f"{self.name}: no files for {missing} under {self.root}. "
                "Run tools/01_ingest_petrodb.py first."
            )

    def fingerprint(self) -> dict[str, Any]:
        files: dict[str, dict[str, Any]] = {}
        for table in TABLES:
            for f in self._files(table):
                files[f.relative_to(self.root).as_posix()] = {
                    "bytes": f.stat().st_size,
                    "sha256": sha256(f),
                }
        return {"driver": self.name, "root": str(self.root), "files": files}

    # -- internals --------------------------------------------------------
    def _files(self, table: str) -> list[Path]:
        if table == "monthly_production":
            return sorted((self.root / "monthly_production").glob("anio=*/*.parquet"))
        p = self.root / f"{table}.parquet"
        return [p] if p.exists() else []
