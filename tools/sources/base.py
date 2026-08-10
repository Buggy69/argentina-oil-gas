"""The DataSource seam.

THE IDEA
--------
Every stage of this pipeline reads petrodb tables. If those stages call
`duckdb.read_parquet("C:/...")` directly, then moving the data — to an object
store, to a live SQL database — means editing every stage. So no stage is
allowed to name a location. Instead each stage asks a *driver* for a SQL
expression it can put after FROM, and the driver knows where the bytes are:

    src = get_source(cfg)
    con.execute(f"SELECT count(*) FROM {src.scan_sql('wells')}")

For local Parquet that expands to `read_parquet('C:/.../wells.parquet')`.
For data on HuggingFace it expands to `read_parquet('https://...')` and DuckDB
fetches it over HTTP. For a future Postgres it expands to `pg.public.wells`
after an ATTACH. The calling code is identical in all three cases.

WHY A SQL STRING AND NOT A DATAFRAME
------------------------------------
Returning a DataFrame would force every table into memory — 17.6 M rows of
monthly production is not something to hold in pandas when DuckDB can stream it
and push filters down into the Parquet reader. Returning a *SQL fragment* keeps
the work inside the engine, where predicate pushdown and row-group pruning
actually happen. The abstraction costs nothing at runtime.

SQL INJECTION
-------------
`scan_sql` builds a string that goes into a query, so it must never interpolate
untrusted input. Table names are validated against an allow-list (TABLES) and
paths come from config, not from user input. That check is in _check_table().
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

# The petrodb Argentina tables this project knows about. Anything not in this
# tuple is rejected before it can reach a SQL string.
TABLES: tuple[str, ...] = (
    "wells",
    "well_events",
    "well_operator_history",
    "monthly_production",
)


def _check_table(table: str) -> str:
    """Reject any table name that is not one of ours.

    This is the allow-list that makes f-string SQL safe here: the only values
    that can ever reach the query are the four literals above.
    """
    if table not in TABLES:
        raise ValueError(f"unknown table {table!r}; expected one of {TABLES}")
    return table


def sha256(path: Path, chunk: int = 1 << 20) -> str:
    """Hash a file in 1 MiB chunks.

    Chunked rather than `path.read_bytes()` because these files are up to 8 MB
    now and could be gigabytes later; streaming keeps memory flat regardless.
    """
    h = hashlib.sha256()
    with path.open("rb") as fh:
        while block := fh.read(chunk):
            h.update(block)
    return h.hexdigest()


@runtime_checkable
class DataSource(Protocol):
    """What every driver must provide.

    A Protocol rather than an abstract base class: drivers do not inherit from
    it, they simply match its shape (structural typing). That keeps the drivers
    independent of this module and makes a test double trivial to write —
    anything with these three members satisfies the type.
    """

    name: str

    def scan_sql(self, table: str) -> str:
        """A SQL expression valid immediately after FROM."""
        ...

    def ensure_available(self) -> None:
        """Do whatever is needed before scan_sql works (download, connect)."""
        ...

    def fingerprint(self) -> dict[str, Any]:
        """Provenance: what exactly was read, and how to prove it later.

        Goes into PROVENANCE.json so any published number can be traced back to
        a specific set of bytes.
        """
        ...


def get_source(cfg: dict[str, Any], driver: str | None = None) -> DataSource:
    """Instantiate the driver named in config.toml (or the override).

    Imports happen inside the function, not at module top level, so that a
    driver with an optional dependency (the future SQL one) cannot break the
    pipeline for everyone else simply by existing.
    """
    driver = driver or cfg["source"]["driver"]
    opts = cfg["source"].get(driver, {})

    if driver == "local_parquet":
        from .local_parquet import LocalParquetSource

        return LocalParquetSource(**opts)
    if driver == "hf_parquet":
        from .hf_parquet import HuggingFaceParquetSource

        return HuggingFaceParquetSource(**opts)
    if driver == "sql_database":
        from .sql_database import SqlDatabaseSource

        return SqlDatabaseSource(**opts)

    raise ValueError(f"unknown source driver {driver!r}")
