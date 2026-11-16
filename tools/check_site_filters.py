"""Regression check: does every filter actually change the Overview's numbers?

WHY THIS EXISTS (2026-11-15)
----------------------------
A user reported that Province, Block, Field, Formation and Oil/gas well did
nothing to the Overview charts while "Wells in selection" moved. True: 10 of
the 12 filters were silently ignored, because the columns they need were only
decoded when the Explorer tab opened. Every check in the pipeline passed — the
data was right, the page was wrong. This script tests the PAGE.

WHAT IT DOES
------------
Drives headless Chrome over the DevTools protocol, exactly as a user would:
for each filter in the bar it ticks the first value, reads the "Cumulative oil"
tile, and compares it with the same sum computed independently by DuckDB from
the published cube files. It also confirms that a combination no cube can serve
(Field + Formation) is *announced* on the page rather than ignored.

Run (local preview must be up, or pass the live URL):
    python tools/check_site_filters.py http://127.0.0.1:8765/
    python tools/check_site_filters.py https://buggy69.github.io/argentina-oil-gas/

Needs: Chrome, and `websocket-client` + `requests` (both in the geomech env).
Exit code 1 if any filter's tile disagrees with DuckDB.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import duckdb
import requests
import websocket

SITE = Path(__file__).resolve().parent.parent / "site"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = 9339
BLOCK_ONLY = {"area", "yacimiento", "name_marker", "trajectory_class"}


class Page:
    """Minimal DevTools-protocol client: send a command, wait for its reply."""

    def __init__(self, url: str) -> None:
        self.profile = Path(tempfile.mkdtemp(prefix="petrodb-check-"))
        self.proc = subprocess.Popen([CHROME, "--headless=new", f"--remote-debugging-port={PORT}",
                                      f"--user-data-dir={self.profile}", "--no-first-run",
                                      "--window-size=1400,1000", "about:blank"])
        for _ in range(100):
            try:
                tabs = requests.get(f"http://127.0.0.1:{PORT}/json", timeout=2).json()
                break
            except Exception:  # noqa: BLE001 - Chrome still starting
                time.sleep(0.2)
        page = next(t for t in tabs if t["type"] == "page")
        self.ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=120)
        self.n, self.url, self.warnings = 0, url, []
        self.cmd("Runtime.enable")
        self.cmd("Page.enable")

    def cmd(self, method: str, **params):
        self.n += 1
        self.ws.send(json.dumps({"id": self.n, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("method") == "Runtime.consoleAPICalled" and msg["params"]["type"] in ("warning", "error"):
                self.warnings.append(" ".join(str(a.get("value", "")) for a in msg["params"]["args"]))
            if msg.get("method") == "Runtime.exceptionThrown":
                self.warnings.append("EXCEPTION " + str(msg["params"]["exceptionDetails"])[:300])
            if msg.get("id") == self.n:
                return msg.get("result", msg)

    def js(self, expr: str):
        return self.cmd("Runtime.evaluate", expression=expr, returnByValue=True,
                        awaitPromise=True)["result"].get("value")

    def overview(self) -> None:
        """Load the Overview and wait until it is really interactive.

        A fixed sleep is not enough: on a cold load of the live site the filter
        bar was not built after 8 s, the facet list came back empty, and the
        first version of this script "passed" having tested nothing. Wait for
        the facets AND for the tiles to have been redrawn from the cube (the
        Tier-A fast path paints tiles before the cube exists)."""
        self.cmd("Page.navigate", url=self.url + "#/overview")
        for _ in range(120):
            time.sleep(0.5)
            if self.js("document.querySelectorAll('#filterbar details.facet').length >= 12"
                       " && !document.querySelector('#ov-ops .note')"):
                break
        else:
            raise RuntimeError("Overview did not become interactive within 60 s")
        time.sleep(1)
        self.warnings.clear()

    def tick_first(self, dim: str) -> str:
        """Open a facet, tick its first value, close it; return the value ticked."""
        return self.js(f"""(async () => {{
          const d = document.querySelector('#filterbar details.facet[data-dim="{dim}"]');
          d.open = true; await new Promise(r => setTimeout(r, 300));
          const cb = d.querySelector('.facet-list input[type=checkbox]');
          const v = cb.value || cb.dataset.value; cb.click(); d.open = false; return v; }})()""")

    def state(self) -> dict:
        return self.js("""(() => ({
          oil: document.querySelectorAll('#ov-tiles .tile .value')[1]?.textContent,
          notes: [...document.querySelectorAll('.unapplied')]
                   .filter(e => !e.hidden && e.textContent).map(e => e.textContent) }))()""")

    def close(self) -> None:
        self.ws.close()
        self.proc.kill()
        time.sleep(0.5)
        shutil.rmtree(self.profile, ignore_errors=True)


def tile_value(text: str) -> float:
    """'278.32 M' -> 278.32e6 (the tile prints 2 decimals of k / M / B)."""
    m = re.match(r"([\d.,]+)\s*([kMB]?)", text or "")
    return float(m.group(1).replace(",", "")) * {"": 1, "k": 1e3, "M": 1e6, "B": 1e9}[m.group(2)]


def expected_oil(dim: str, value: str, dims: dict) -> float:
    """Independent truth: sum oil in the cube that carries this dimension."""
    table, key = ("agg_block", f"block_{dim}") if dim in BLOCK_ONLY else ("agg_monthly", dim)
    code = dims[key].index(value)
    path = (SITE / "data" / f"{table}.parquet").as_posix()
    return duckdb.sql(f"SELECT sum(oil_m3) FROM '{path}' WHERE {dim} = {code}").fetchone()[0]


def main() -> int:
    url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/"
    dims = json.loads((SITE / "data" / "dims.json").read_text(encoding="utf-8"))
    page = Page(url)
    failures = 0
    try:
        page.overview()
        facets = [d for d in page.js("[...document.querySelectorAll('#filterbar details.facet')]"
                                     ".map(d => d.dataset.dim)") if d != "__time"]
        if len(facets) < 12:            # an empty loop must never read as a pass
            print(f"FAIL only {len(facets)} filters found on the page")
            failures += 1
        for dim in facets:
            page.overview()
            value = page.tick_first(dim)
            time.sleep(5)
            shown = page.state()["oil"]
            exp = expected_oil(dim, value, dims)
            ok = abs(tile_value(shown) - exp) <= max(0.006 * exp, 1e4)
            ignored = [w for w in page.warnings if "ignored" in w or "EXCEPTION" in w]
            ok = ok and not ignored
            failures += not ok
            print(f"{'OK  ' if ok else 'FAIL'} {dim:17s} {value[:30]:30s} tile {shown:>10s}"
                  f"  DuckDB {exp / 1e6:10.3f} M {ignored[:1] if ignored else ''}", flush=True)

        # A combination no single cube carries must be announced, not ignored.
        page.overview()
        page.tick_first("yacimiento"); time.sleep(4)
        page.tick_first("formation"); time.sleep(5)
        announced = any("Formation" in n for n in page.state()["notes"])
        failures += not announced
        print(f"{'OK  ' if announced else 'FAIL'} Field + Formation is announced on the page")
    finally:
        page.close()

    print(f"\n{failures} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
