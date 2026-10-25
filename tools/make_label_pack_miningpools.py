#!/usr/bin/env python3
"""Turn the mining pools list that mempool.space uses into a Hopline label pack of the addresses the pools receive block rewards on.

github.com/mempool/mining-pools holds pools-v2.json: every pool with the coinbase tags it writes into the blocks it finds and, for some,
the addresses its block rewards are paid to. This script keeps the addresses (mainnet only, checksum checked), labels each
"Mining pool: <name>", gives the pool's own web address as the link, and writes a file that Hopline's "Label packs > Import labels"
reads. The coinbase tags are not used: they are text patterns for blocks, not addresses.

    python tools/make_label_pack_miningpools.py --download --out mining-pools.hopline-labels.json
    python tools/make_label_pack_miningpools.py --file pools-v2.json --out mining-pools.hopline-labels.json

--download reads the newest commit on the main branch (the commit id and its date go into the pack, so the data can be found again) and
checks that the repository's licence text is still the MIT licence this script was written against; if it has changed, nothing is made
until a person has read the new text and updated LICENSE_SHA256 below. GITHUB_TOKEN, when set, is sent to api.github.com only (GitHub
limits anonymous requests); the files themselves come from raw.githubusercontent.com without it. --file reads any copy of pools-v2.json;
the pack then says where its data came from but does not state a licence.

A listing here is a claim made by the people who keep the list (mostly pools themselves, through pull requests): Hopline shows it as
"known (pack name)". A pool's reward address is not always the wallet the pool pays its miners from.
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from btc_address import address_ok  # noqa: E402

REPO = "mempool/mining-pools"
SITE = "https://github.com/" + REPO
FILE = "pools-v2.json"
API_COMMIT = "https://api.github.com/repos/%s/commits/master" % REPO
RAW = "https://raw.githubusercontent.com/%s/%%s/%%s" % REPO
LICENSE_SHA256 = "76673785c54b3cebf0244040262e7a6ad6def39c20a0fb5a155a5d4a0042d399"     # the MIT licence text of the repository, as read on 2026-10-26
LICENCE = "MIT"
ATTRIBUTION = "mempool/mining-pools (used by mempool.space), MIT License, Copyright (c) 2019 btc.com and contributors"
NAME = "Mining pools (mempool.space)"
MAX_BYTES = 20_000_000                                                           # the real file is about 36 KB
MAX_LABEL = 120


class ListError(Exception):
    """The file is not something this script can read; the message says what to do."""


def clean(s, limit):
    return re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f\x7f-\x9f  ‪-‮⁦-⁩]", " ", s or "")).strip()[:limit]


def other_network(a):
    """A testnet or regtest address: the file holds a few, and they are left out without being counted as mistakes."""
    return isinstance(a, str) and (a.lower().startswith(("tb1", "bcrt1")) or a[:1] in ("m", "n", "2"))


def pools_of(data):
    if len(data) > MAX_BYTES:
        raise ListError("The file is larger than expected; refusing it.")
    try:
        d = json.loads(data.decode("utf-8-sig"))
    except (ValueError, UnicodeDecodeError):
        raise ListError("That is not JSON. The list is %s in %s." % (FILE, SITE))
    if not isinstance(d, list) or not d or not all(isinstance(p, dict) for p in d) or not any("addresses" in p for p in d):
        raise ListError("That is not the mining pools list (a list of pools, each with a name and addresses). Use %s from %s." % (FILE, SITE))
    return d


def convert(data, commit=None, today=None):
    """(pack, info) for the Bitcoin addresses in the list. `commit` is what fetch() returned alongside it ({sha, date, licence_text}); without it the pack
    does not state a licence. `info` counts what was read and what was left out."""
    today = today or datetime.date.today().isoformat()
    pools = pools_of(data)
    labels, seen, skipped, with_addresses = [], set(), {"invalid": 0, "duplicate": 0, "otherNetwork": 0, "noName": 0}, 0
    for p in pools:
        name = clean(p.get("name") if isinstance(p.get("name"), str) else "", 80)
        addrs = p.get("addresses") if isinstance(p.get("addresses"), list) else []
        if not name:
            skipped["noName"] += len(addrs)
            continue
        link = p.get("link") if isinstance(p.get("link"), str) else ""
        url = link.strip() if len(link.strip()) <= 300 and re.fullmatch(r"https?://[^\s<>\"']+", link.strip()) else ""
        before = len(labels)
        for a in addrs:
            if other_network(a):
                skipped["otherNetwork"] += 1
            elif not address_ok(a):
                skipped["invalid"] += 1
            elif a in seen:
                skipped["duplicate"] += 1
            else:
                seen.add(a)
                e = {"address": a, "label": clean("Mining pool: " + name, MAX_LABEL), "category": "MINING"}
                if url:
                    e["url"] = url
                labels.append(e)
        with_addresses += len(labels) > before
    pack = {"format": "hopline-labels", "version": 1, "name": NAME}
    if commit:
        pack["source"] = "%s, %s at commit %s (%s)" % (REPO, FILE, commit["sha"][:7], commit["date"])
        pack.update({"licence": LICENCE, "attribution": ATTRIBUTION, "sourceUrl": SITE, "asOf": commit["date"], "licenceText": commit["licence_text"]})
    else:
        pack["source"] = "mining pools list %s (a file you supplied), converted %s" % (FILE, today)
        pack.update({"attribution": "mempool/mining-pools (used by mempool.space)", "sourceUrl": SITE})
    pack["created"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    pack["labels"] = labels
    info = {"official": bool(commit), "pools": len(pools), "poolsWithAddresses": with_addresses, "read": len(labels), "skipped": skipped,
            "addresses": len(labels) + skipped["invalid"] + skipped["duplicate"] + skipped["otherNetwork"] + skipped["noName"]}
    return pack, info


# ---- the download -----------------------------------------------------------------------------------------------------------
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):                                         # a request that carries the token never follows a redirect to somewhere else
        return None


def http_get(url, token=False, timeout=60, limit=MAX_BYTES):
    req = urllib.request.Request(url, headers={"User-Agent": "hopline-build-packs", "Accept": "application/vnd.github+json, */*"})
    opener = urllib.request.build_opener(NoRedirect) if token else urllib.request.build_opener()
    if token and os.environ.get("GITHUB_TOKEN"):
        req.add_header("Authorization", "Bearer " + os.environ["GITHUB_TOKEN"])
    with opener.open(req, timeout=timeout) as r:
        data = r.read(limit + 1)
    if len(data) > limit:
        raise ListError("%s is larger than expected; refusing it." % url)
    return data


def fetch():
    """(data, commit): pools-v2.json at the newest commit of the main branch, and {sha, date, licence_text}. The licence text must be the one this script knows."""
    try:
        meta = json.loads(http_get(API_COMMIT, token=True, limit=2_000_000).decode("utf-8"))
        sha, date = str(meta["sha"]), str(meta["commit"]["committer"]["date"])[:10]
        if not re.fullmatch(r"[0-9a-f]{40}", sha) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            raise ValueError("unexpected reply")
        data, licence = http_get(RAW % (sha, FILE)), http_get(RAW % (sha, "LICENSE"), limit=100_000)
    except ListError:
        raise
    except (OSError, ValueError, KeyError, TypeError) as e:
        raise ListError("Could not download the mining pools list from %s (%s). Download %s yourself and use --file." % (SITE, e, FILE))
    if hashlib.sha256(licence).hexdigest() != LICENSE_SHA256:
        raise ListError("The licence text of %s is no longer the one this script was written against. Read it, and if the data may still be used, "
                        "update LICENSE_SHA256 in tools/make_label_pack_miningpools.py. Not used." % SITE)
    return data, {"sha": sha, "date": date, "licence_text": licence.decode("utf-8")}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split(chr(10) * 2)[0])
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--file", help="path to a copy of pools-v2.json")
    src.add_argument("--download", action="store_true", help="download the newest version from GitHub")
    ap.add_argument("--out", required=True, help="the label pack to write (.json)")
    a = ap.parse_args(argv)
    try:
        if a.download:
            data, commit = fetch()
        else:
            with open(a.file, "rb") as f:
                data, commit = f.read(MAX_BYTES + 1), None
        pack, info = convert(data, commit)
    except (ListError, OSError) as e:
        sys.exit(str(e))
    if not pack["labels"]:
        sys.exit("No Bitcoin addresses found: is this the mining pools list?")
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(pack, f, indent=1)
    s = info["skipped"]
    print("Wrote %d addresses of %d pools (left out: %d failed the checksum, %d testnet, %d repeated) to %s"
          % (info["read"], info["poolsWithAddresses"], s["invalid"], s["otherNetwork"], s["duplicate"], a.out))
    if not info["official"]:
        print("Note: a file you supplied, so the pack does not state a licence.", file=sys.stderr)


if __name__ == "__main__":
    main()
