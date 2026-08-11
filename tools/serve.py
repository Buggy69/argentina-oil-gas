"""Local preview server for site/.

WHY NOT `python -m http.server`
------------------------------
Because it sends no `Cache-Control`, and a response with no explicit freshness
information lets the browser invent one (roughly 10% of the file's age). For an
ES module that was edited seconds ago that means the browser keeps executing the
*previous* version — even through a hard reload, because the module graph is
fetched separately from the document.

That is not a cosmetic annoyance. It silently invalidates testing: a bug gets
"fixed", the page still shows the old number, and the obvious conclusion is that
the fix was wrong. That happened here, on the unconventional-share tile.

So: no-store on everything. Slower, and exactly right for development.

It also implements HTTP Range, which `http.server` does not. Range is how the
deep-dive tier reads one well out of a 5 MB yearly file without downloading it,
so without this the single most interesting property of the data layer is
untestable until it is already in production.

Run:  python tools/serve.py [port]
"""

from __future__ import annotations

import os
import re
import sys
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "site"
_RANGE = re.compile(r"bytes=(\d*)-(\d*)")


class Handler(SimpleHTTPRequestHandler):
    # HTTP/1.1 for keep-alive. Reading one well fires roughly a hundred small
    # range requests across twenty yearly files; under HTTP/1.0 each one is a
    # fresh connection that is torn down immediately, and enough of them fail
    # that the read errors out. This is safe here only because every response
    # below sets an accurate Content-Length — HTTP/1.1 without one leaves the
    # client waiting for a body that never ends.
    protocol_version = "HTTP/1.1"

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def send_head(self):
        """Serve a byte range when one is requested, otherwise defer to the base."""
        header = self.headers.get("Range")
        if not header:
            return super().send_head()

        m = _RANGE.match(header.strip())
        if not m:
            return super().send_head()

        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()
        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return None

        size = os.fstat(f.fileno()).st_size
        start_s, end_s = m.group(1), m.group(2)
        if start_s == "":
            # "bytes=-500" means the LAST 500 bytes, not "from 0 to 500".
            # Parquet readers use exactly this to grab the footer, so getting it
            # wrong breaks metadata reads specifically.
            length = int(end_s or 0)
            start = max(0, size - length)
            end = size - 1
        else:
            start = int(start_s)
            end = int(end_s) if end_s else size - 1
        end = min(end, size - 1)

        if start > end or start >= size:
            f.close()
            self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return None

        self.send_response(HTTPStatus.PARTIAL_CONTENT)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()

        f.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            chunk = f.read(min(65536, remaining))
            if not chunk:
                break
            self.wfile.write(chunk)
            remaining -= len(chunk)
        f.close()
        return None


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    handler = partial(Handler, directory=str(ROOT))
    print(f"serving {ROOT} at http://127.0.0.1:{port}/  (no-store, Range enabled)")
    ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
