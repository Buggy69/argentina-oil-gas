"""Stage 7 — stamp a build version onto every JS/CSS URL before publishing.

THE PROBLEM THIS SOLVES
-----------------------
GitHub Pages serves assets with `Cache-Control: max-age=600` and does not let
you change that. For ten minutes after a deploy, a returning visitor keeps
running the previous JavaScript.

Worse, a hard reload does not reliably fix it. Ctrl+Shift+R re-fetches the
document and its directly-referenced scripts, but a module pulled in later by a
DYNAMIC import — `import('./views/performance.js')` — is commonly served from
cache anyway. So the app shell updates while the views do not, and the site
appears to ignore a deploy entirely. That has now cost real debugging time twice
in this project, once mine and once the user's.

The only fix available on a host you cannot send headers from is to change the
URL when the content changes. This script rewrites every relative module
specifier and stylesheet link to carry `?v=<hash of the JS+CSS>`, so:

  * nothing changes when nothing changed (the hash is content-derived, so
    re-running is idempotent and does not churn the deploy), and
  * every URL changes the moment any script does, which no cache can survive.

WHY IT RUNS IN CI, NOT IN THE REPO
----------------------------------
It rewrites files in place, so running it locally would leave `?v=` noise in the
source. The deploy workflow runs it against its own checkout, immediately before
uploading the artifact — the published site is versioned, the repository stays
clean, and local development is unaffected (tools/serve.py sends no-store).

Run:  python tools/07_stamp_version.py [--check]
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import hashlib
import re

from tools.config import path

SITE = path("site")

# `from './x.js'`, `import './x.js'`, `import('./x.js')` — relative specifiers
# only. Bare or absolute URLs (there are none here, by design) are left alone.
_SPEC = re.compile(r"""(?P<pre>\b(?:from|import)\s*\(?\s*)(?P<q>['"])(?P<path>\.{1,2}/[^'"?]+\.js)(?:\?v=[0-9a-f]+)?(?P=q)""")
_HTML_SRC = re.compile(r"""(?P<pre>(?:src|href)=")(?P<path>(?:js|css)/[^"?]+\.(?:js|css))(?:\?v=[0-9a-f]+)?(?P<post>")""")


def js_files() -> list[Path]:
    return sorted(SITE.joinpath("js").rglob("*.js"))


def build_hash() -> str:
    """Content hash over every script and stylesheet that ships."""
    h = hashlib.sha256()
    for f in js_files() + sorted(SITE.joinpath("css").rglob("*.css")):
        # Strip any existing stamp so the hash describes the CODE, not the last
        # stamp — otherwise each run would produce a different hash for
        # identical source and the cache would be busted on every deploy.
        text = _SPEC.sub(lambda m: f"{m.group('pre')}{m.group('q')}{m.group('path')}{m.group('q')}",
                         f.read_text(encoding="utf-8"))
        h.update(text.encode("utf-8"))
    return h.hexdigest()[:10]


def main() -> int:
    check_only = "--check" in sys.argv
    version = build_hash()
    changed = 0

    for f in js_files():
        src = f.read_text(encoding="utf-8")
        out = _SPEC.sub(
            lambda m: f"{m.group('pre')}{m.group('q')}{m.group('path')}?v={version}{m.group('q')}",
            src)
        if out != src:
            changed += 1
            if not check_only:
                f.write_text(out, encoding="utf-8", newline="\n")

    index = SITE / "index.html"
    html = index.read_text(encoding="utf-8")
    out = _HTML_SRC.sub(
        lambda m: f"{m.group('pre')}{m.group('path')}?v={version}{m.group('post')}", html)
    if out != html:
        changed += 1
        if not check_only:
            index.write_text(out, encoding="utf-8", newline="\n")

    print(f"build version {version}: {'would stamp' if check_only else 'stamped'} "
          f"{changed} file(s)")
    if check_only and changed:
        print("  (run without --check to apply)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
