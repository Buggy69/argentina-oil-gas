"""Stage 5a — vendor the browser libraries into the repository.

WHY VENDOR AT ALL
-----------------
The published page must make **zero requests to any host other than its own**.
Two reasons, and the second is the one that actually forced it:

1. A page with no third-party requests cannot be broken by a corporate web
   filter. That is not hypothetical here — the SLB filter blocks huggingface.co
   outright, and nobody can promise the same will never happen to a CDN.
2. It is the difference between "works for anyone" and "works for anyone whose
   network happens to allow the CDN we picked".

The cost is that upgrades are deliberate: a version bump is a commit, with the
hash recorded below, rather than something that changes under the site
overnight. For a dashboard meant to be citable, that is a feature.

WHY hyparquet AND NOT DuckDB-WASM
---------------------------------
DuckDB-WASM would give a real SQL engine in the browser, but its WebAssembly
binary is 34–39 MB uncompressed (~10 MB over the wire). That is a poor trade
for a page whose brief is "runs smoothly on a smartphone", when the data it
would query is a 296 k-row pre-aggregated cube.

hyparquet reads the same Parquet files in 58 KB of JavaScript, including
byte-range reads against a remote file — which is exactly what the Tier C
drill-down needs. Aggregating 296 k rows in plain JS is a few milliseconds.
The whole vendored payload is ~1.3 MB, of which ECharts is 1.1 MB.

hyparquet-compressors is required because the tiers are written with ZSTD;
without it hyparquet can only read uncompressed and Snappy pages.

Run:  python tools/05_vendor_assets.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import json
import re
import urllib.request
from datetime import datetime, timezone

from tools.config import path
from tools.sources import sha256

VENDOR = path("site", "vendor")

# name on disk -> (url, why it is here)
ASSETS: dict[str, tuple[str, str]] = {
    "hyparquet.mjs": (
        "https://cdn.jsdelivr.net/npm/hyparquet@1.28.1/+esm",
        "Parquet reader — the whole query engine, including HTTP range reads",
    ),
    "hyparquet-compressors.mjs": (
        "https://cdn.jsdelivr.net/npm/hyparquet-compressors@1.1.1/+esm",
        "ZSTD/Brotli page decompressors; the tiers are written with ZSTD",
    ),
    "echarts.min.js": (
        "https://cdn.jsdelivr.net/npm/echarts@6.1.0/dist/echarts.min.js",
        "Charting — canvas rendering, which is what keeps 85 k map points smooth",
    ),
}


CDN = "https://cdn.jsdelivr.net"

# jsDelivr's "+esm" bundles resolve their own dependencies to ABSOLUTE paths on
# the CDN, e.g. `from"/npm/fzstd@0.1.1/+esm"`. Copied verbatim onto our own
# host those become requests to `https://oursite/npm/fzstd@0.1.1/+esm`, which
# 404 — and the failure surfaces as the useless "Failed to fetch dynamically
# imported module", naming the *importer* rather than the missing dependency.
#
# So vendoring cannot be a plain download: every transitive `/npm/...`
# specifier has to be fetched too and rewritten to a local relative path. This
# is the real cost of the no-third-party-hosts rule, and it is worth paying
# once here rather than discovering it in production on someone else's network.
_NPM_IMPORT = re.compile(r'(?P<q>["\'])(?P<path>/npm/[^"\']+)(?P=q)')


def _local_name(npm_path: str) -> str:
    """/npm/fzstd@0.1.1/+esm  ->  npm_fzstd@0.1.1.mjs"""
    stem = npm_path[len("/npm/"):].removesuffix("/+esm").replace("/", "_")
    return f"npm_{stem}.mjs"


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "petrodb-dashboard/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read()


def vendor_module(url: str, dest: Path, seen: set[str], manifest: dict,
                  why: str = "transitive dependency") -> None:
    """Download a module and, recursively, everything it imports from the CDN."""
    if url in seen:
        return
    seen.add(url)
    body = fetch(url)
    text = body.decode("utf-8")

    for m in _NPM_IMPORT.finditer(text):
        dep_path = m.group("path")
        dep_name = _local_name(dep_path)
        vendor_module(CDN + dep_path, VENDOR / dep_name, seen, manifest)
        # "./name.mjs" — relative to this file, so it resolves the same way no
        # matter what path the site is served from (a project page lives under
        # /repo-name/, which absolute paths would get wrong too).
        text = text.replace(m.group(0), f'"./{dep_name}"')

    dest.write_bytes(text.encode("utf-8"))
    digest = sha256(dest)
    print(f"  {dest.name:<32}{len(text)/1024:>8.1f} KB  {digest[:12]}…")
    print(f"     {why}")
    manifest["assets"][dest.name] = {"url": url, "bytes": len(text),
                                     "sha256": digest, "purpose": why}


def main() -> int:
    VENDOR.mkdir(parents=True, exist_ok=True)
    manifest = {
        "vendored_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "note": ("Pinned and committed on purpose. Nothing here is fetched at "
                 "runtime; the published site makes no third-party requests. "
                 "Transitive /npm/ imports inside jsDelivr +esm bundles are "
                 "downloaded and rewritten to local relative paths."),
        "assets": {},
    }
    seen: set[str] = set()

    for name, (url, why) in ASSETS.items():
        dest = VENDOR / name
        if name.endswith(".mjs"):
            vendor_module(url, dest, seen, manifest, why)
        else:
            # echarts is a classic UMD script: no imports to resolve.
            body = fetch(url)
            dest.write_bytes(body)
            digest = sha256(dest)
            print(f"  {name:<32}{len(body)/1024:>8.1f} KB  {digest[:12]}…")
            print(f"     {why}")
            manifest["assets"][name] = {"url": url, "bytes": len(body),
                                        "sha256": digest, "purpose": why}

    total = sum(a["bytes"] for a in manifest["assets"].values())
    print(f"\n  total vendored payload: {total/1024:.0f} KB")
    (VENDOR / "_vendor_manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
