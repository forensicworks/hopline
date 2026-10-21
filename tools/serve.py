#!/usr/bin/env python3
"""A small static server for trying the pages locally, instead of `python -m http.server`.

    python tools/serve.py                 (then open http://127.0.0.1:8000/index.html)

Why not the standard one: it lets the browser keep copies of files for a while, so after the code changes the browser can run a
mix of new and old scripts and a page shows nothing or misbehaves until you reload with Ctrl+F5. This server tells the browser to
keep nothing, and it names the file types itself (on Windows the standard server asks the registry, which is sometimes wrong).

It listens on 127.0.0.1 only (this computer), serves the repository folder, and never writes anything.
Standard library only. Python 3.8 or newer.
"""
import argparse
import functools
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".ico": "image/x-icon",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = dict(http.server.SimpleHTTPRequestHandler.extensions_map, **TYPES)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def make_server(directory=ROOT, port=8000, bind="127.0.0.1"):
    """The server, not yet running (port 0 picks a free one: server.server_address[1])."""
    handler = functools.partial(Handler, directory=directory)
    return http.server.ThreadingHTTPServer((bind, port), handler)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--port", type=int, default=8000, help="port to listen on (default 8000)")
    ap.add_argument("--directory", default=ROOT, help="folder to serve (default: the repository)")
    args = ap.parse_args(argv)
    try:
        server = make_server(args.directory, args.port)
    except OSError as e:
        print("Could not listen on 127.0.0.1:%d (%s). Try another port: python tools/serve.py --port 8001" % (args.port, e), file=sys.stderr)
        return 1
    print("Serving %s on http://127.0.0.1:%d/  (Ctrl+C to stop)" % (args.directory, server.server_address[1]))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
