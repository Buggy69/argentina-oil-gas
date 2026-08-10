"""Build .docx versions of the written deliverables.

Markdown is the source of record; Word is a rendering of it. That direction
matters — editing the .docx and regenerating the .md would lose the diffable
history, so this script only ever goes one way.

`gfm+tex_math_dollars` is the input dialect: GitHub-flavoured Markdown (which is
what the tables in these documents are) plus `$…$` math, so any equation becomes
a real Word equation object rather than an image or literal dollar signs.

Run:  python tools/build_docx.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import shutil
import subprocess

from tools.config import path

DOCS = path("docs")
OUT = DOCS / "word"

SOURCES = [
    "verification_report.md",
    "how_it_works.md",
    "data_dictionary.md",
]


def main() -> int:
    pandoc = shutil.which("pandoc")
    if not pandoc:
        # conda puts it in the env's Library/bin on Windows, which is not always
        # on PATH for a non-activated interpreter.
        candidate = Path(sys.executable).parent / "Library" / "bin" / "pandoc.exe"
        if candidate.exists():
            pandoc = str(candidate)
    if not pandoc:
        print("pandoc not found. conda install -n geomech -c conda-forge pandoc",
              file=sys.stderr)
        return 1

    OUT.mkdir(parents=True, exist_ok=True)
    for name in SOURCES:
        src = DOCS / name
        if not src.exists():
            print(f"  skip {name} (not built yet)")
            continue
        dst = OUT / (src.stem + ".docx")
        subprocess.run(
            [pandoc, str(src), "-f", "gfm+tex_math_dollars", "-t", "docx",
             "--toc", "--toc-depth=2", "-o", str(dst)],
            check=True,
        )
        print(f"  {dst.name:<34}{dst.stat().st_size/1024:>8.1f} KB")
    print(f"\nwritten to {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
