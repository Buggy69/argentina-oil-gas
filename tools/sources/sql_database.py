"""Driver: a live SQL database. STUB — interface fixed, body not written.

This file exists now, empty of behaviour, on purpose. Max wants the dashboard
to eventually pull from a real database in near-real-time. Writing the
*interface* while the design is still fluid costs nothing and pins down the one
thing that is expensive to change later: the shape of the seam. When the time
comes, only this file and one line of config.toml change.

WHAT IMPLEMENTING IT WILL LOOK LIKE
-----------------------------------
DuckDB can attach several engines directly, which keeps `scan_sql` a one-liner
and leaves every downstream stage untouched:

    INSTALL postgres; LOAD postgres;
    ATTACH 'postgresql://host/db' AS pg (TYPE postgres, READ_ONLY);
    -- then scan_sql('wells') -> 'pg.public.wells'

MotherDuck is even closer to the current shape (`ATTACH 'md:petrodb'`), and a
plain object store needs no new driver at all — it is local_parquet with an
s3:// or r2:// root once httpfs is loaded.

THE DECISION THAT IS NOT MADE YET
---------------------------------
Whether the *browser* also talks to the database, or only this build pipeline
does. Today the browser queries Parquet through DuckDB-WASM with no server. A
live database reachable from a public web page needs either a public read-only
endpoint or a proxy, and that is a hosting and cost decision, not a code one.
The frontend is written behind a single runSQL() entry point so that either
answer stays a small change. See site/js/query.js.
"""

from __future__ import annotations

from typing import Any


class SqlDatabaseSource:
    name = "sql_database"

    def __init__(self, dsn: str = "", schema: str = "public") -> None:
        self.dsn = dsn
        self.schema = schema

    def scan_sql(self, table: str) -> str:
        raise NotImplementedError(
            "sql_database driver is a stub. See the module docstring for the "
            "intended implementation; set source.driver = 'local_parquet' for now."
        )

    def ensure_available(self) -> None:
        raise NotImplementedError("sql_database driver is a stub.")

    def fingerprint(self) -> dict[str, Any]:
        return {"driver": self.name, "dsn": "<not configured>"}
