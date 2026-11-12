#!/usr/bin/env python3
"""Builds the folder that is published on a web site (GitHub Pages or any static host): only the pages, never the tests or the tools.

    python tools/build_site.py --out site --stats-code MYCODE --version "$(git rev-parse --short HEAD)"

What the published copy differs in (everything else is the source, byte for byte):
  * public/config.js says "hosted": the Tor choice is not offered, and the session is kept in the browser only when the visitor ticks it;
  * with --stats-code (a GoatCounter site code) or --stats-endpoint (your own GoatCounter, https) visits are counted by page and feature
    name, as described in public/js/hopline-stats.js; without either, nothing is counted;
  * with --version, every script and style address in the three pages gets ?v=<version>, so after a deploy a browser cannot run new pages
    with old scripts (static hosts let browsers keep files for minutes);
  * with --code-version (the last change to the code: tools/code_version.py works it out) a version.json at the root of the site and the same id in
    public/config.js (HOPLINE_CONFIG.version), so a published copy can be told from an older one; --code-date is when that change was committed
    (HOPLINE_CONFIG.committed too). The pages show the version in their footer, and an open page that finds a later one in version.json offers a reload
    (public/js/hopline-version.js);
    It is not the ?v= of --version: that one is the deploy's own commit and moves with every deploy, the code version does not move with a pack refresh;
  * a _headers file (read by Cloudflare and Netlify, ignored elsewhere): no referrer is sent from the pages, content types are not guessed, and
    the pages cannot be shown inside another site's frame;
  * a 404.html, so an address that does not exist is a 404 (Cloudflare Pages otherwise answers it with the landing page and status 200); its
    "Back to Hopline" link is the only address that is not relative, so --base-path names where the site lives (/ or, on a GitHub project site, /hopline/);
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
CODE_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
ABOUT = "The last change to the code of this site. A daily refresh of the label packs does not change it."     # as in tools/code_version.py (a test keeps them equal)
HEADERS = """/*
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  Content-Security-Policy: frame-ancestors 'none'

/version.json
  Cache-Control: no-store
"""
NOT_FOUND = """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found - Hopline</title>
<style>body{font:16px Calibri,Arial,sans-serif;background:#18121a;color:#eee;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
main{text-align:center;padding:16px}a{color:#aee7f8}</style></head>
<body><main><h1>Not found</h1><p>There is no page at this address.</p><p><a href="@BASE@">Back to Hopline</a></p></main></body></html>
"""
BASE_PATH = re.compile(r"^/((?!\.+/)[A-Za-z0-9._-]+/)*$")
LOCAL_URL = re.compile(r'((?:src|href)=")((?:public/)?(?:config\.js|(?:js|css|data|lib|packs)/[^"?#]+\.(?:js|css)))(")')


def config_js(stats_endpoint, code_version=None, code_date=None):
    cfg = {"hosted": True}
    if stats_endpoint:
        cfg["stats"] = {"endpoint": stats_endpoint}
    if code_version:
        cfg["version"] = code_version
        if code_date:
            cfg["committed"] = code_date
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


def build(out, stats_code=None, stats_endpoint=None, version=None, base_path="/", code_version=None, code_date=None):
    given = base_path
    base_path = base_path if base_path.endswith("/") else base_path + "/"
    if not given or not BASE_PATH.match(base_path):
        raise SystemExit("--base-path must be a path such as / or /hopline/ (letters, digits, dots, hyphens and underscores).")
    if stats_code and stats_endpoint:
        raise SystemExit("Give --stats-code or --stats-endpoint, not both.")
    if stats_code and not CODE.match(stats_code):
        raise SystemExit("--stats-code must be a GoatCounter site code: lower-case letters, digits and hyphens.")
    if stats_endpoint and not ENDPOINT.match(stats_endpoint):
        raise SystemExit("--stats-endpoint must be an https address without a query or fragment, e.g. https://stats.example.org/count")
    if version and not VERSION.match(version):
        raise SystemExit("--version may only hold letters, digits, dots, hyphens and underscores (40 at most).")
    if code_version and not VERSION.match(code_version):
        raise SystemExit("--code-version may only hold letters, digits, dots, hyphens and underscores (40 at most).")
    if code_date and not (code_version and CODE_DATE.match(code_date)):
        raise SystemExit("--code-date goes with --code-version and looks like 2026-11-11T16:58:57Z (UTC).")
    endpoint = stats_endpoint or ("https://%s.goatcounter.com/count" % stats_code if stats_code else None)
    clear(out)
    for name in FILES:
        shutil.copy2(os.path.join(ROOT, name), os.path.join(out, name))
    shutil.copytree(os.path.join(ROOT, "public"), os.path.join(out, "public"), ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    with open(os.path.join(out, "public", "config.js"), "w", encoding="utf-8", newline="\n") as f:
        f.write(config_js(endpoint, code_version, code_date))
    if code_version:
        info = {"version": code_version}
        if code_date:
            info["committed"] = code_date
        info["about"] = ABOUT
        with open(os.path.join(out, "version.json"), "w", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(info, indent=2) + "\n")
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
        f.write(NOT_FOUND.replace("@BASE@", base_path))
    open(os.path.join(out, ".nojekyll"), "w").close()
    return {"out": os.path.realpath(out), "stats": endpoint, "version": version, "code_version": code_version}


def main(argv=None):
    ap = argparse.ArgumentParser(description="Build the published copy of Hopline.")
    ap.add_argument("--out", default="site", help="folder to write (default: site)")
    ap.add_argument("--stats-code", help="GoatCounter site code: count visits at https://CODE.goatcounter.com/count")
    ap.add_argument("--stats-endpoint", help="count visits at this https address instead (your own GoatCounter)")
    ap.add_argument("--version", help="added to script and style addresses as ?v=VERSION (for example the short commit id)")
    ap.add_argument("--code-version", help="the id of the last change to the code (tools/code_version.py): written to version.json at the root and to config.js")
    ap.add_argument("--code-date", help="when that change was committed, UTC, like 2026-11-11T16:58:57Z (goes with --code-version)")
    ap.add_argument("--base-path", default="/", help="where the site lives on its host, for the one link that cannot be relative: / (the default) or, for a GitHub project site, /hopline/")
    a = ap.parse_args(argv)
    r = build(a.out, a.stats_code, a.stats_endpoint, a.version, a.base_path, a.code_version, a.code_date)
    print("Built %s (counting: %s, version: %s, code version: %s)" % (r["out"], r["stats"] or "off", r["version"] or "none", r["code_version"] or "none"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
