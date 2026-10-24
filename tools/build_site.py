#!/usr/bin/env python3
"""Builds the folder that is published on a web site (GitHub Pages or any static host): only the pages, never the tests or the tools.

    python tools/build_site.py --out site --stats-code MYCODE --version "$(git rev-parse --short HEAD)"

What the published copy differs in (everything else is the source, byte for byte):
  * public/config.js says "hosted": the Tor choice is not offered, and the session is kept in the browser only when the visitor ticks it;
  * with --stats-code (a GoatCounter site code) or --stats-endpoint (your own GoatCounter, https) visits are counted by page and feature
    name, as described in public/js/hopline-stats.js; without either, nothing is counted;
  * with --version, every script and style address in the three pages gets ?v=<version>, so after a deploy a browser cannot run new pages
    with old scripts (static hosts let browsers keep files for minutes);
  * a _headers file (read by Cloudflare and Netlify, ignored elsewhere): no referrer is sent from the pages, content types are not guessed, and
    the pages cannot be shown inside another site's frame;
  * a 404.html, so an address that does not exist is a 404 (Cloudflare Pages otherwise answers it with the landing page and status 200);
  * a .nojekyll file, so GitHub Pages serves the folder as it is.

The output folder is emptied first, except a .git folder (so it can be a checkout of the repository that serves the site). It will not empty
the repository itself or any folder that contains it. Standard library only. Python 3.8 or newer.
"""
import argparse
import json
import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILES = ["index.html", "LICENSE", "NOTICE"]
PAGES = ["index.html", os.path.join("public", "wallet.html"), os.path.join("public", "workspace.html")]
CODE = re.compile(r"^[a-z0-9][a-z0-9-]{1,30}$")
ENDPOINT = re.compile(r"^https://[A-Za-z0-9.-]+(:\d{1,5})?/[A-Za-z0-9._/-]*$")
VERSION = re.compile(r"^[0-9A-Za-z._-]{1,40}$")
HEADERS = """/*
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  Content-Security-Policy: frame-ancestors 'none'
"""
NOT_FOUND = """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found - Hopline</title>
<style>body{font:16px Calibri,Arial,sans-serif;background:#18121a;color:#eee;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
main{text-align:center;padding:16px}a{color:#aee7f8}</style></head>
<body><main><h1>Not found</h1><p>There is no page at this address.</p><p><a href="/">Back to Hopline</a></p></main></body></html>
"""
LOCAL_URL = re.compile(r'((?:src|href)=")((?:public/)?(?:config\.js|(?:js|css|data|lib)/[^"?#]+\.(?:js|css)))(")')


def config_js(stats_endpoint):
    cfg = {"hosted": True}
    if stats_endpoint:
        cfg["stats"] = {"endpoint": stats_endpoint}
    return ("/* Written by tools/build_site.py for the published copy: see the comment in the source file of the same name. */\n"
            "window.HOPLINE_CONFIG = Object.assign(window.HOPLINE_CONFIG || {}, %s);\n" % json.dumps(cfg))


def clear(out):
    """Empty `out` (keeping .git). Refuses the repository itself and anything above it."""
    out, root = os.path.realpath(out), os.path.realpath(ROOT)
    if out == root or root.startswith(out + os.sep):
        raise SystemExit("Refusing to empty %s: it is the repository or contains it." % out)
    os.makedirs(out, exist_ok=True)
    for name in os.listdir(out):
        if name == ".git":
            continue
        path = os.path.join(out, name)
        if os.path.isdir(path) and not os.path.islink(path):
            shutil.rmtree(path)
        else:
            os.remove(path)


def build(out, stats_code=None, stats_endpoint=None, version=None):
    if stats_code and stats_endpoint:
        raise SystemExit("Give --stats-code or --stats-endpoint, not both.")
    if stats_code and not CODE.match(stats_code):
        raise SystemExit("--stats-code must be a GoatCounter site code: lower-case letters, digits and hyphens.")
    if stats_endpoint and not ENDPOINT.match(stats_endpoint):
        raise SystemExit("--stats-endpoint must be an https address without a query or fragment, e.g. https://stats.example.org/count")
    if version and not VERSION.match(version):
        raise SystemExit("--version may only hold letters, digits, dots, hyphens and underscores (40 at most).")
    endpoint = stats_endpoint or ("https://%s.goatcounter.com/count" % stats_code if stats_code else None)
    clear(out)
    for name in FILES:
        shutil.copy2(os.path.join(ROOT, name), os.path.join(out, name))
    shutil.copytree(os.path.join(ROOT, "public"), os.path.join(out, "public"), ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    with open(os.path.join(out, "public", "config.js"), "w", encoding="utf-8", newline="\n") as f:
        f.write(config_js(endpoint))
    if version:
        for page in PAGES:
            path = os.path.join(out, page)
            with open(path, encoding="utf-8", newline="") as f:
                html = f.read()
            html = LOCAL_URL.sub(lambda m: m.group(1) + m.group(2) + "?v=" + version + m.group(3), html)
            with open(path, "w", encoding="utf-8", newline="") as f:
                f.write(html)
    with open(os.path.join(out, "_headers"), "w", encoding="utf-8", newline="\n") as f:
        f.write(HEADERS)
    with open(os.path.join(out, "404.html"), "w", encoding="utf-8", newline="\n") as f:
        f.write(NOT_FOUND)
    open(os.path.join(out, ".nojekyll"), "w").close()
    return {"out": os.path.realpath(out), "stats": endpoint, "version": version}


def main(argv=None):
    ap = argparse.ArgumentParser(description="Build the published copy of Hopline.")
    ap.add_argument("--out", default="site", help="folder to write (default: site)")
    ap.add_argument("--stats-code", help="GoatCounter site code: count visits at https://CODE.goatcounter.com/count")
    ap.add_argument("--stats-endpoint", help="count visits at this https address instead (your own GoatCounter)")
    ap.add_argument("--version", help="added to script and style addresses as ?v=VERSION (for example the short commit id)")
    a = ap.parse_args(argv)
    r = build(a.out, a.stats_code, a.stats_endpoint, a.version)
    print("Built %s (counting: %s, version: %s)" % (r["out"], r["stats"] or "off", r["version"] or "none"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
