"""Stage 0 — fetch the official Argentine open-data files.

WHY THERE IS A SECOND SOURCE AT ALL
-----------------------------------
petrodb is a repackaging of `datos.energia.gob.ar`. Reading the publisher
directly buys three things petrodb cannot give us:

* **Ground truth.** Two tiny CSVs (~30 KB) carry the official monthly oil and
  gas totals by basin and resource subtype. Summing petrodb and comparing
  against them is a real audit — the kind where a discrepancy means something,
  because the two numbers come from different processing chains.
* **First production date.** The padrón gives the month each well first
  produced. Without it there is no "months on production" axis, and therefore
  no decline curve and no type curve.
* **Trajectory.** Vertical vs horizontal exists nowhere in petrodb. The
  fracture table has `longitud_rama_horizontal_m`, so trajectory becomes a
  measurement rather than a guess — and brings stage count, proppant tonnage,
  fluid volume and treating pressure along with it.

Resource UUIDs are pinned below. CKAN resource IDs are stable across
re-publications while *filenames* are not, so the ID is what we trust; the
current URL is resolved through the API at run time.

Run:  python tools/00_download_portal.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import json
import urllib.error
import urllib.request
from datetime import datetime, timezone

from tools.config import CFG, path
from tools.sources import sha256

CKAN = CFG["source"]["http_portal"]["ckan_base"]

# dataset id -> the package each resource belongs to. Two different packages
# are in play: production (capítulo IV) and fracture (adjunto IV).
PKG_PRODUCTION = "c846e79c-026c-4040-897f-1ad3543b407c"
PKG_FRACTURE = "71fa2e84-0316-4a1b-af68-7f35e41f58d7"

# local name -> (package id, resource id, what it is for)
RESOURCES: dict[str, tuple[str, str, str]] = {
    "serie_historica_petroleo.csv": (
        PKG_PRODUCTION, "af8c50bb-fde0-43b7-98eb-7cd14daf586c",
        "Official monthly oil totals by basin and resource subtype — ground truth",
    ),
    "serie_historica_gas.csv": (
        PKG_PRODUCTION, "a3244ddd-38bc-4800-a700-360b649d2f3a",
        "Official monthly gas totals by basin and resource subtype — ground truth",
    ),
    "padron_primera_produccion.csv": (
        PKG_PRODUCTION, "5578dd48-d0dd-487e-8ddc-bd3ebb1afef0",
        "First production month per idpozo — the months-on-production axis",
    ),
    "capitulo_iv_pozos.csv": (
        PKG_PRODUCTION, "cb5c0f04-7835-45cd-b982-3e25ca7d7751",
        "Well registry with geojson + WKB geometry — independent check on coordinates",
    ),
    "fractura_adjunto_iv.csv": (
        PKG_FRACTURE, "2280ad92-6ed3-403e-a095-50139863ab0d",
        "Per-fracture-job completion data — trajectory, stages, proppant, fluid",
    ),
}

_TIMEOUT = 300
_UA = {"User-Agent": "petrodb-dashboard/1.0 (open data pipeline)"}


def ckan_resource(package_id: str, resource_id: str) -> dict:
    """Ask CKAN for a resource's current URL and metadata.

    Resolving through the API rather than hard-coding the download URL means a
    filename change upstream (they happen — accents get re-encoded) does not
    break the pipeline. The UUID is the stable identifier.
    """
    url = f"{CKAN}/api/3/action/package_show?id={package_id}"
    req = urllib.request.Request(url, headers=_UA)
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
        payload = json.load(resp)
    for res in payload["result"]["resources"]:
        if res["id"] == resource_id:
            return res
    raise KeyError(f"resource {resource_id} not found in package {package_id}")


def download(url: str, dest: Path) -> int:
    """Stream a URL to disk.

    Streamed in chunks rather than `resp.read()` because these files reach tens
    of megabytes and the portal serves some of them slowly; holding the whole
    body in memory buys nothing.

    The portal answers https:// but redirects to http:// for the file bodies.
    urllib refuses that downgrade silently by simply not following it, so if the
    https attempt yields nothing usable we retry the http URL explicitly. It is
    public open data over the publisher's own host — the content hash we record
    is what makes the result trustworthy, not the transport.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    attempts = [url]
    if url.startswith("https://"):
        attempts.append("http://" + url[len("https://"):])
    elif url.startswith("http://"):
        attempts.insert(0, "https://" + url[len("http://"):])

    last: Exception | None = None
    for attempt in attempts:
        try:
            req = urllib.request.Request(attempt, headers=_UA)
            with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp, \
                 dest.open("wb") as fh:
                total = 0
                while chunk := resp.read(1 << 20):
                    fh.write(chunk)
                    total += len(chunk)
            if total > 0:
                return total
            last = OSError("empty response")
        except (urllib.error.URLError, OSError) as exc:
            last = exc
    raise OSError(f"could not download {url}: {last}")


def main() -> int:
    out = path(CFG["paths"]["raw"], "portal")
    manifest: dict[str, object] = {
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "ckan_base": CKAN,
        "resources": {},
    }

    print(f"target: {out}\n")
    for name, (pkg, rid, purpose) in RESOURCES.items():
        meta = ckan_resource(pkg, rid)
        size = download(meta["url"], out / name)
        digest = sha256(out / name)
        print(f"  {name:<34}{size/1_048_576:>8.2f} MB  {digest[:12]}…")
        print(f"     {purpose}")
        manifest["resources"][name] = {
            "package_id": pkg,
            "resource_id": rid,
            "url": meta["url"],
            "last_modified": meta.get("last_modified") or meta.get("created"),
            "licence": "CC BY 4.0",
            "bytes": size,
            "sha256": digest,
            "purpose": purpose,
        }

    (out / "_portal_manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    print(f"\nmanifest written: {out / '_portal_manifest.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
