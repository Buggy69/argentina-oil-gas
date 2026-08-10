"""Configuration loading — the single place that knows where the repo root is.

Why this exists as its own module: every other script needs paths, and the
tempting shortcut is `Path(__file__).parent / ".." / "data"` scattered in ten
files. That breaks the moment a script is run from a different directory or on
a different OS. Resolving the root once, here, means every path in the project
is absolute and correct no matter how a script is invoked — including from a
GitHub Actions runner where the drive letter does not exist.
"""

from __future__ import annotations

import tomllib  # standard library since Python 3.11 — no dependency needed
from pathlib import Path
from typing import Any

# __file__ is  <root>/tools/config.py , so two .parent hops reach the repo root.
# .resolve() turns it absolute and collapses any ".." segments.
ROOT = Path(__file__).resolve().parent.parent

_CONFIG_PATH = ROOT / "config.toml"


def load() -> dict[str, Any]:
    """Read config.toml and return it as a plain nested dict.

    tomllib requires a binary file handle ("rb"), not text — TOML is defined as
    UTF-8 and the parser does its own decoding. Passing "r" raises TypeError.
    """
    with _CONFIG_PATH.open("rb") as fh:
        return tomllib.load(fh)


def path(*parts: str) -> Path:
    """Resolve a repo-relative path to an absolute one.

    Usage:  path(cfg["paths"]["raw"], "petrodb")  ->  <root>/data/raw/petrodb

    An already-absolute input (like the OneDrive staging path) is returned
    unchanged, because Path("/abs") / "x" keeps the absolute root but
    ROOT / "/abs" would *replace* ROOT — a classic pathlib trap worth knowing:
    joining an absolute path discards everything to its left.
    """
    p = Path(*parts)
    return p if p.is_absolute() else (ROOT / p)


CFG = load()
