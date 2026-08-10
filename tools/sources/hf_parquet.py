"""Driver: petrodb Parquet read straight from HuggingFace over HTTPS.

WHERE THIS RUNS
---------------
Not on Max's laptop. SLB's web filter blocks huggingface.co (category
"artificial-intelligence"), returning a warn-and-continue interstitial that a
browser can click through but a script cannot. This driver is for the GitHub
Actions runner, which is on GitHub's network and reaches the host normally.

Calling it from inside the corporate network fails loudly rather than
mysteriously: DuckDB receives HTML where it expected a Parquet magic number, so
ensure_available() probes first and explains what happened.

WHY THE MANIFEST MATTERS
------------------------
The partitions are static files behind a CDN with no directory listing, so a
glob cannot resolve. petrodb publishes `_files.json` for exactly this reason —
it is the file-discovery contract. We read it and hand DuckDB an explicit list.
"""

from __future__ import annotations

import json
import urllib.request
from typing import Any

from .base import _check_table
from .local_parquet import q

_TIMEOUT = 60


class HuggingFaceParquetSource:
    name = "hf_parquet"

    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/") + "/"
        self._manifest: list[str] | None = None

    # -- the seam ---------------------------------------------------------
    def scan_sql(self, table: str) -> str:
        _check_table(table)

        if table == "monthly_production":
            urls = [self.base_url + "monthly_production/" + p for p in self._files()]
            # DuckDB accepts a list literal of URLs; hive_partitioning still
            # recovers `anio` because the key is in each URL's path.
            array = "[" + ", ".join(q(u) for u in urls) + "]"
            return f"read_parquet({array}, hive_partitioning = true)"

        return f"read_parquet({q(self.base_url + table + '.parquet')})"

    def ensure_available(self) -> None:
        """Confirm we are getting Parquet, not a corporate block page.

        Every Parquet file starts with the four bytes b"PAR1". Checking them is
        a one-request test that distinguishes "the network is fine" from "a
        proxy replaced the body with HTML" — which otherwise shows up much
        later as an unintelligible parser error.
        """
        url = self.base_url + "wells.parquet"
        req = urllib.request.Request(url, headers={"Range": "bytes=0-3"})
        try:
            with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
                head = resp.read(4)
        except Exception as exc:  # noqa: BLE001 - re-raised with context below
            raise RuntimeError(f"{self.name}: cannot reach {url}: {exc}") from exc

        if head != b"PAR1":
            raise RuntimeError(
                f"{self.name}: {url} did not return Parquet (got {head!r}). "
                "On the SLB network huggingface.co is blocked by the web filter; "
                "use the local_parquet driver there, or run this in CI."
            )

    def fingerprint(self) -> dict[str, Any]:
        return {
            "driver": self.name,
            "base_url": self.base_url,
            "partitions": len(self._files()),
        }

    # -- internals --------------------------------------------------------
    def _files(self) -> list[str]:
        if self._manifest is None:
            url = self.base_url + "monthly_production/_files.json"
            with urllib.request.urlopen(url, timeout=_TIMEOUT) as resp:
                self._manifest = json.load(resp)
        return self._manifest
