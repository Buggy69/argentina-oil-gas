"""The DuckDB warehouse every stage reads.

DESIGN CHOICE: VIEWS, NOT COPIES
--------------------------------
The four petrodb tables are registered as *views* over the Parquet files rather
than copied into the database. Three reasons, in order of importance:

1. There is exactly one copy of the truth. A materialised table can drift from
   the files it came from; a view cannot.
2. Re-running a stage costs nothing. Nobody waits for a 17.6 M-row reload to
   test a one-line change.
3. Filters still reach the storage layer. DuckDB pushes predicates and column
   projections through a view into the Parquet reader, so
   `WHERE anio = 2023` skips nineteen files without opening them and
   `SELECT prod_pet` never decodes the other ten columns. Copying into a table
   would not make this faster — it would just spend disk to arrive at the same
   scan.

Derived tables (Stage 3's enrichment) *are* materialised, because they are the
product of real computation and are read many times afterwards.
"""

from __future__ import annotations

import duckdb

from .config import CFG, path
from .sources import TABLES, DataSource, get_source


def connect(read_only: bool = False) -> duckdb.DuckDBPyConnection:
    """Open (creating if needed) the warehouse file."""
    wh = path(CFG["paths"]["warehouse"])
    wh.parent.mkdir(parents=True, exist_ok=True)
    return duckdb.connect(str(wh), read_only=read_only)


def register_views(
    con: duckdb.DuckDBPyConnection, src: DataSource | None = None
) -> DataSource:
    """Point the warehouse's views at whatever the active driver serves.

    Re-running this after switching `source.driver` in config.toml re-aims every
    view at the new location. Nothing downstream notices, which is the entire
    purpose of the driver layer.
    """
    src = src or get_source(CFG)
    src.ensure_available()
    for table in TABLES:
        con.execute(
            f"CREATE OR REPLACE VIEW {table} AS SELECT * FROM {src.scan_sql(table)}"
        )
    return src


def open_warehouse(read_only: bool = False) -> tuple[duckdb.DuckDBPyConnection, DataSource]:
    """Convenience for stages: a connection with views already registered.

    Note `read_only=True` cannot be combined with registering views (that is a
    write), so read-only callers must rely on views a previous stage created.
    """
    con = connect(read_only=read_only)
    if read_only:
        return con, get_source(CFG)
    return con, register_views(con)
