"""CI only — download petrodb from HuggingFace into data/raw/petrodb, politely.

WHY THIS EXISTS (2026-11-13)
----------------------------
The refresh used to read petrodb straight off huggingface.co through DuckDB
(the hf_parquet driver). DuckDB reads remote Parquet with many small HTTP
Range requests — footer, then each row group of each column — so one rebuild
fired hundreds of GETs at HF. On 12 and 13 Nov 2026 HF answered with
"HTTP 429 Too Many Requests" and the Enrich stage died.

Downloading each file whole is ~23 GETs instead of hundreds. Retrying with a
back-off that honours HF's Retry-After header covers a transient 429. The
workflow also caches the result (actions/cache), so most runs make no HF
request at all — petrodb has been frozen since Aug 2026 (data ends 2025-12).

After this script the pipeline runs on the local_parquet driver, exactly as on
Max's laptop, so CI and laptop read the same layout.

Run:  python tools/fetch_petrodb_hf.py        (skips files already present)
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tools.config import CFG, path

BASE = CFG["source"]["hf_parquet"]["base_url"].rstrip("/") + "/"
ROOT = path(CFG["source"]["local_parquet"]["root"])
TOP_LEVEL = ["wells.parquet", "well_events.parquet", "well_operator_history.parquet"]

ATTEMPTS = 6
TIMEOUT = 120


def get(url: str) -> bytes:
    """GET a whole file; on 429/5xx wait (Retry-After if given) and retry."""
    delay = 20.0
    for attempt in range(1, ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(url, timeout=TIMEOUT) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            if exc.code != 429 and exc.code < 500:
                raise
            retry_after = exc.headers.get("Retry-After", "")
            wait = float(retry_after) if retry_after.isdigit() else delay
            why = f"HTTP {exc.code}"
        except (urllib.error.URLError, TimeoutError) as exc:
            wait, why = delay, type(exc).__name__
        if attempt == ATTEMPTS:
            raise RuntimeError(f"{url}: gave up after {ATTEMPTS} attempts ({why})")
        print(f"  {why}, retry {attempt}/{ATTEMPTS - 1} in {wait:.0f} s", flush=True)
        time.sleep(wait)
        delay = min(delay * 2, 300)
    raise AssertionError("unreachable")


def main() -> int:
    partitions = json.loads(get(BASE + "monthly_production/_files.json"))
    rels = TOP_LEVEL + ["monthly_production/" + p for p in partitions]

    fetched = 0
    for rel in rels:
        dest = ROOT / rel
        if dest.exists() and dest.stat().st_size > 0:
            continue
        body = get(BASE + rel)
        # A proxy or error page would not start with Parquet's magic bytes.
        if body[:4] != b"PAR1" or body[-4:] != b"PAR1":
            raise RuntimeError(f"{rel}: response is not a Parquet file")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(body)
        fetched += 1
        print(f"  {rel:55s} {len(body) / 1e6:7.2f} MB", flush=True)
        time.sleep(1)  # be gentle; nothing here is time-critical

    print(f"petrodb: {len(rels)} files in {ROOT} ({fetched} downloaded, "
          f"{len(rels) - fetched} already present)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
