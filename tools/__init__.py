"""Build pipeline for the PetroDB Argentina dashboard.

This is a package (not a loose folder of scripts) so that `tools.sources` can
use relative imports like `from ..config import path`.

A wrinkle worth understanding, because it bites everyone once: the stage
scripts are named `01_ingest_petrodb.py` and friends. The numeric prefix makes
the pipeline order obvious in a directory listing, but it also means those
files can never be imported — a Python module name cannot begin with a digit.
They are entry points only, run as:

    python tools/01_ingest_petrodb.py

And when Python runs a script that way it puts the *script's own directory*
(`tools/`) on sys.path — not the repository root. So `import tools.config`
would fail. Each stage script therefore opens with a three-line bootstrap that
puts the repo root on sys.path before importing anything of ours. That is the
price of the numeric prefixes, and it is paid explicitly and visibly rather
than through a hidden .pth file or an editable install.
"""
