#!/usr/bin/env python3
"""Which version of the code is published, and whether the site you are looking at is up to date.

    python tools/code_version.py                       the version: the short id of the last change to the code, and when it was committed (UTC)
    python tools/code_version.py --json                the same as the version.json file the build writes
    python tools/code_version.py --check https://hopline.pages.dev
                                                       read version.json from a published copy and say whether it is the latest on origin/master
    python tools/code_version.py --check URL --contains 0e2f471
                                                       and whether that commit (a change you made) is in what is published

The version is the last commit on the main line (first parent) that changed anything except the label packs (public/packs). The packs are
refreshed every day by a workflow that merges and publishes its own pull request, so the version must not move with them: after a
pack refresh the site is published again, but it is the same version. A pull request you merge is one commit on the main line (its merge
commit), so the version is the id GitHub shows for the merge. The addresses of the scripts in the pages (?v=...) are the deploy's own
commit and do change with the packs, on purpose: a browser has to fetch new packs.

The build needs the whole history (a shallow clone cannot tell), so the workflows check out with fetch-depth: 0.
Standard library only; git must be on the path. Python 3.8 or newer.
"""
import argparse
import datetime
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACK_PATHS = ["public/packs"]               # what the daily refresh changes (its `git add` in .github/workflows/refresh-packs.yml; a test keeps the two in step)
SHORT = 7                                    # as the workflows cut the deploy's commit id
ABOUT = "The last change to the code of this site. A daily refresh of the label packs does not change it."


def git(args, repo=ROOT, check=True):
    p = subprocess.run(["git"] + args, cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    if check and p.returncode != 0:
        raise SystemExit("git %s failed: %s" % (" ".join(args[:2]), p.stderr.strip() or p.stdout.strip()))
    return p


def utc(iso):
    """A commit date from git (+02:00 and so on) as UTC, to the second: 2026-11-11T16:58:57Z."""
    return datetime.datetime.fromisoformat(iso).astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def last_code_commit(ref="HEAD", repo=ROOT):
    """(full id, committed as UTC) of the last commit on the main line of `ref` that changed anything but the packs."""
    if git(["rev-parse", "--is-shallow-repository"], repo).stdout.strip() == "true":
        raise SystemExit("This is a shallow clone: the version needs the whole history (check out with fetch-depth: 0).")
    spec = ["."] + [":(exclude)%s" % p for p in PACK_PATHS]
    out = git(["log", "--first-parent", "-1", "--format=%H%x09%cI", ref, "--"] + spec, repo).stdout.strip()
    if not out:
        raise SystemExit("No commit of %s changed anything but the label packs." % ref)
    full, iso = out.split("\t")
    return full, utc(iso)


def version_info(ref="HEAD", repo=ROOT):
    full, when = last_code_commit(ref, repo)
    return {"version": full[:SHORT], "committed": when, "about": ABOUT}, full


def read_published(url):
    """version.json of a published copy (at its root), read past any cache."""
    target = url.rstrip("/") + "/version.json?t=%d" % int(time.time())
    req = urllib.request.Request(target, headers={"Cache-Control": "no-cache", "User-Agent": "hopline-code-version"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read().decode("utf-8"))
    except (urllib.error.URLError, ValueError, OSError) as e:
        raise SystemExit("Could not read %s: %s" % (target, e))
    if not isinstance(data, dict) or not isinstance(data.get("version"), str) or not data["version"]:
        raise SystemExit("%s has no version." % target)
    return data


def check(url, ref="origin/master", contains=None, repo=ROOT, out=print):
    """Compare a published copy with the latest code of `ref`. Returns 0 when it is the latest (and holds `contains`), else 1."""
    live = read_published(url)
    latest, full = version_info(ref, repo)
    out("Published (%s): %s, committed %s" % (url, live["version"], live.get("committed", "date not given")))
    out("Latest on %s: %s, committed %s" % (ref, latest["version"], latest["committed"]))
    code = 0
    if live["version"] == latest["version"]:
        out("Up to date.")
    else:
        code = 1
        known = git(["rev-parse", "--verify", "--quiet", live["version"] + "^{commit}"], repo, check=False)
        if known.returncode != 0:
            out("Not up to date: the published commit is not in this repository (fetch it first).")
        elif git(["merge-base", "--is-ancestor", live["version"], full], repo, check=False).returncode == 0:
            n = git(["rev-list", "--count", "--first-parent", "%s..%s" % (live["version"], full)], repo).stdout.strip()
            out("Behind by %s change%s on the main line. A deploy takes a few minutes; run this again, and look at the Actions tab if it stays." % (n, "" if n == "1" else "s"))
        else:
            out("Not up to date, and the published commit is not an ancestor of the latest: a different branch, or the history was rewritten.")
    if contains:
        known = git(["rev-parse", "--verify", "--quiet", contains + "^{commit}"], repo, check=False)
        if known.returncode != 0:
            out("%s is not a commit of this repository." % contains)
            code = 1
        elif git(["merge-base", "--is-ancestor", contains, live["version"]], repo, check=False).returncode == 0:
            out("%s is in the published version." % contains)
        else:
            out("%s is NOT in the published version yet." % contains)
            code = 1
    return code


def main(argv=None):
    ap = argparse.ArgumentParser(description="The published version of the code, and whether a published copy is up to date.")
    ap.add_argument("--json", action="store_true", help="print version.json (what the build writes)")
    ap.add_argument("--ref", default=None, help="the commit to look at (default: HEAD; with --check, origin/master)")
    ap.add_argument("--check", metavar="URL", help="read URL/version.json of a published copy and compare it with the latest code")
    ap.add_argument("--contains", metavar="COMMIT", help="with --check: also say whether this commit is in the published version")
    ap.add_argument("--no-fetch", action="store_true", help="with --check: do not fetch origin first")
    a = ap.parse_args(argv)
    if a.check:
        ref = a.ref or "origin/master"
        if ref.startswith("origin/") and not a.no_fetch:
            git(["fetch", "--quiet", "origin"], check=False)
        return check(a.check, ref, a.contains)
    info, _ = version_info(a.ref or "HEAD")
    print(json.dumps(info, indent=2) if a.json else "%s %s" % (info["version"], info["committed"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
