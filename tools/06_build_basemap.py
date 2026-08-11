"""Stage 6 — build the bundled basemap for the well map.

WHY BUILD ONE RATHER THAN USE MAP TILES
---------------------------------------
Every normal web map pulls raster tiles from a tile server. That would be one
more third-party host, and this site deliberately has none: no CDN, no fonts, no
analytics, no tiles. A page that talks only to its own origin cannot be broken
by anyone's corporate web filter, ad blocker or privacy extension — which is a
promise worth more here than a prettier background.

So the geography is compiled in: Argentina's provinces plus the neighbouring
countries for context, simplified to what is legible at this zoom and shipped as
a small GeoJSON.

Source is **Natural Earth**, which is public domain — explicitly no permission
needed and no attribution required, though it is credited on the map anyway
because that is the decent thing to do.

SIMPLIFICATION
--------------
The 1:50m provinces file is 2.3 MB, most of which is coastline detail finer than
one screen pixel at a country-wide view. Douglas–Peucker at ~0.02° (roughly
2 km) removes what cannot be seen. `preserve_topology=True` matters: without it,
simplification can pull a polygon inside-out or detach a shared border, and
provinces would stop tiling.

Run:  python tools/06_build_basemap.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import json
import urllib.request
from datetime import datetime, timezone

from shapely.geometry import mapping, shape
from shapely.ops import unary_union

from tools.config import path

NE = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/"
      "geojson/")

# The 10m file, not 50m — and that is not a quality preference, it is the only
# option. Natural Earth's 1:50m admin-1 layer is a *reduced* set: 294 features
# covering nine large federal countries (Russia, USA, India, Brazil …).
# Argentina is not in it, so filtering 50m for Argentine provinces silently
# returns nothing. The 10m layer is 40 MB, downloaded once at build time and
# thrown away; only the simplified result ships.
ADMIN1 = NE + "ne_10m_admin_1_states_provinces.geojson"
ADMIN0 = NE + "ne_50m_admin_0_countries.geojson"

# Countries drawn faintly behind Argentina, so the outline reads as a continent
# rather than as a shape floating in space.
NEIGHBOURS = {"Chile", "Bolivia", "Paraguay", "Brazil", "Uruguay",
              "Falkland Islands"}

# Degrees. ~0.02° is about 2 km at these latitudes — below one screen pixel when
# the whole country is in view.
TOLERANCE = 0.02

# Everything outside this is irrelevant to a map of Argentina and only inflates
# the file (Brazil alone is larger than the area of interest).
CLIP = (-76.0, -57.0, -52.0, -20.0)   # lon_min, lat_min, lon_max, lat_max


def fetch_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "petrodb-basemap/1.0"})
    with urllib.request.urlopen(req, timeout=300) as resp:
        return json.load(resp)


def clip_and_simplify(geom):
    """Trim to the area of interest, then drop invisible detail."""
    from shapely.geometry import box

    g = geom.intersection(box(*CLIP))
    if g.is_empty:
        return None
    g = g.simplify(TOLERANCE, preserve_topology=True)
    return None if g.is_empty else g


def main() -> int:
    out_dir = path("site", "data", "geo")
    out_dir.mkdir(parents=True, exist_ok=True)

    print("downloading Natural Earth (admin-1 is ~40 MB; build-time only) …")
    admin1 = fetch_json(ADMIN1)
    admin0 = fetch_json(ADMIN0)

    # Guard against the silent-empty failure that started this: if the source
    # layer has no Argentine features at all, say so loudly instead of writing
    # a basemap with no provinces in it.
    if not any(f["properties"].get("admin") == "Argentina"
               for f in admin1["features"]):
        print("ERROR: no Argentine features in the admin-1 source — wrong "
              "Natural Earth resolution?", file=sys.stderr)
        return 1

    features = []

    # --- Argentina's provinces --------------------------------------------
    n_prov = 0
    for f in admin1["features"]:
        p = f["properties"]
        if p.get("admin") != "Argentina":
            continue
        g = clip_and_simplify(shape(f["geometry"]))
        if g is None:
            continue
        name = p.get("name") or p.get("name_en") or "?"
        features.append({
            "type": "Feature",
            "properties": {"name": name, "layer": "province"},
            "geometry": mapping(g),
        })
        n_prov += 1

    # --- neighbouring countries, as one faint backdrop each ----------------
    n_nb = 0
    for f in admin0["features"]:
        p = f["properties"]
        name = p.get("NAME") or p.get("name")
        if name not in NEIGHBOURS:
            continue
        g = clip_and_simplify(shape(f["geometry"]))
        if g is None:
            continue
        features.append({
            "type": "Feature",
            "properties": {"name": name, "layer": "neighbour"},
            "geometry": mapping(g),
        })
        n_nb += 1

    # --- national outline --------------------------------------------------
    # The union of the provinces, drawn on top as a single heavier stroke so the
    # country border reads differently from the internal divisions.
    ar = unary_union([shape(f["geometry"]) for f in features
                      if f["properties"]["layer"] == "province"])
    features.append({
        "type": "Feature",
        "properties": {"name": "Argentina", "layer": "outline"},
        "geometry": mapping(ar.simplify(TOLERANCE, preserve_topology=True)),
    })

    fc = {
        "type": "FeatureCollection",
        "metadata": {
            "source": "Natural Earth 1:50m (naturalearthdata.com)",
            "licence": "Public domain — no permission needed, credited by choice",
            "built": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "simplify_tolerance_deg": TOLERANCE,
        },
        "features": features,
    }

    dest = out_dir / "basemap.json"
    dest.write_text(json.dumps(fc, separators=(",", ":")), encoding="utf-8")
    kb = dest.stat().st_size / 1024
    print(f"  {n_prov} provinces, {n_nb} neighbouring countries, 1 national outline")
    print(f"  {dest.relative_to(path('.'))}  {kb:.0f} KB")
    if kb > 600:
        print("  NOTE: larger than expected; raise TOLERANCE if this grows.",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
