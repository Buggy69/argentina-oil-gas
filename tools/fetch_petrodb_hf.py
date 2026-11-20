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

import hashlib
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


def remote_hashes() -> dict[str, str] | None:
    """sha256 of every file under argentina/ as HuggingFace reports it, or None.

    WHY (2026-11-20): the workflow restores data/raw/petrodb from a cache with a
    static key, and main() skips files already present. A NEW year partition
    would still be fetched (it appears in _files.json), but a REVISED existing
    file — wells.parquet, or a corrected 2025 partition — would never replace
    the cached copy, leaving a silently half-updated dataset. HF's tree API
    lists each file with its LFS sha256, so a changed file can be detected
    without downloading it.

    Never fatal: if the listing fails or has an unexpected shape, the refresh
    carries on exactly as before and says so. (Not testable from the SLB
    network, which blocks huggingface.co — see CLAUDE.md lesson 19.)
    """
    # base_url = https://huggingface.co/datasets/<org>/<repo>/resolve/<rev>/<dir>/
    try:
        tail = BASE.split("/datasets/", 1)[1]
        org, repo, _, rev, *sub = tail.strip("/").split("/")
        api = (f"https://huggingface.co/api/datasets/{org}/{repo}/tree/{rev}/"
               f"{'/'.join(sub)}?recursive=true")
        entries = json.loads(get(api))
        prefix = "/".join(sub) + "/"
        out = {}
        for e in entries:
            if e.get("type") != "file" or "lfs" not in e:
                continue
            out[e["path"][len(prefix):] if e["path"].startswith(prefix) else e["path"]] =                 e["lfs"]["oid"]
        return out or None
    except Exception as exc:  # noqa: BLE001 - advisory check, must not break the refresh
        print(f"  (change detection skipped: {type(exc).__name__}: {exc})", flush=True)
        return None


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    partitions = json.loads(get(BASE + "monthly_production/_files.json"))
    rels = TOP_LEVEL + ["monthly_production/" + p for p in partitions]

    # A cached file whose sha256 differs from HF's is stale: delete it so the
    # loop below fetches it again.
    remote = remote_hashes()
    changed = []
    if remote is not None:
        for rel in rels:
            dest = ROOT / rel
            want = remote.get(rel)
            if want and dest.exists() and sha256_file(dest) != want:
                changed.append(rel)
                dest.unlink()
        print(f"petrodb change check: {len(changed)} of {len(rels)} cached files "
              f"differ from HuggingFace" + (": " + ", ".join(changed) if changed else ""))

    fetched = 0
    for rel in rels:
        dest = ROOT / rel
        if dest.exists() and dest.stat().st_size > 0:
            continue
        body = get(BASE + rel)
        # A proxy or error page would not start with Parquet's magic bytes.
        if body[:4] != b"PAR1" or body[-4:] != b"PAR1":
            raise RuntimeError(f"{rel}: response is not a Parquet file")
        if remote and remote.get(rel) and hashlib.sha256(body).hexdigest() != remote[rel]:
            raise RuntimeError(f"{rel}: downloaded bytes do not match HF's sha256")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(body)
        fetched += 1
        print(f"  {rel:55s} {len(body) / 1e6:7.2f} MB", flush=True)
        time.sleep(1)  # be gentle; nothing here is time-critical

    print(f"petrodb: {len(rels)} files in {ROOT} ({fetched} downloaded, "
          f"{len(rels) - fetched} already present)")
    if changed:
        # The cache key is static, so actions/cache will NOT save these new
        # bytes: every later run re-downloads them (correct, just slower).
        # Bump the key suffix in refresh.yml to make the new data the cache.
        print("::warning::petrodb changed upstream - bump the cache key "
              "(petrodb-hf-vN) in .github/workflows/refresh.yml")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
