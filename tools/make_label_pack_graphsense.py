#!/usr/bin/env python3
"""Turn a chosen part of the GraphSense public TagPacks into a Hopline label pack of Bitcoin addresses.

github.com/graphsense/graphsense-tagpacks is a collection of "TagPacks": YAML files that attribute addresses, each with a link to the
public source of the claim. The repository is MIT licensed (Copyright Iknaio Cryptoasset Analytics GmbH and AIT Austrian Institute of
Technology). It holds about 500,000 Bitcoin tags, most of them bulk lists copied from other projects, scraped sites and social media,
whose own terms the MIT licence of the repository cannot grant. So this script takes only the packs named in PACKS below, and within
each only the tags whose source link is on the page of the kind named there: a government or court document, or the page of the
exchange or service that the address belongs to. Everything else in the repository is left alone, with the reason; adding a pack
means reading where its tags come from and adding one line.

    python tools/make_label_pack_graphsense.py --download --out graphsense.hopline-labels.json
    python tools/make_label_pack_graphsense.py --dir <a folder holding the pack files> --out graphsense.hopline-labels.json

--download reads the newest commit of the main branch (its id and date go into the pack), takes the packs of PACKS from that commit and
checks that the repository's licence text is still the MIT text this script knows; if it has changed, nothing is made until a person has
read it and updated LICENSE_SHA256. GITHUB_TOKEN, when set, goes to api.github.com only. --dir uses the pack files you give, and the
pack then does not state a licence.

A tag is the claim of whoever wrote the page it links to (an exchange's own list of its wallets, a court filing) as copied by the
GraphSense team: Hopline shows it as "known (pack name)", with the link, and the date the pack was last changed.
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from btc_address import address_ok  # noqa: E402
from make_label_pack_miningpools import ListError, clean, http_get  # noqa: E402,F401  (the same GitHub download and the same text cleaning)

REPO = "graphsense/graphsense-tagpacks"
SITE = "https://github.com/" + REPO
API_COMMIT = "https://api.github.com/repos/%s/commits/master" % REPO
RAW = "https://raw.githubusercontent.com/%s/%%s/%%s" % REPO
LICENSE_SHA256 = "2c9bb5e1d50203d505b997babbb23eebda868f1280dc5ef5854263ba0dd7c4ed"     # the MIT licence text of the repository, as read on 2026-10-26
LICENCE = "MIT"
ATTRIBUTION = ("GraphSense TagPacks (github.com/graphsense/graphsense-tagpacks), MIT License, Copyright (c) 2022 Iknaio Cryptoasset Analytics GmbH, "
               "Copyright (c) 2018-2022 AIT Austrian Institute of Technology; each tag links to its source")
NAME = "GraphSense tag packs (selected)"
MAX_BYTES = 5_000_000                                                            # the chosen packs are a few KB each
MAX_LABEL, MAX_NOTE = 120, 500                                                   # as the label pack importer caps them

# The packs taken, and the pages their tags may link to (a tag whose source is anywhere else is left out). Each is a page of a government,
# or of the entity that owns the address.
PACKS = {
    "aft-alqaeda-forfeit_vc": ("https://www.justice.gov/",),                     # a U.S. Department of Justice forfeiture complaint
    "lazarus2": ("https://www.fbi.gov/",),                                       # an FBI press release naming funds stolen by DPRK
    "exchange-wallets-binance": ("https://www.binance.com/",),                   # an exchange's own list of its reserve wallets
    "exchange-wallets-huobi": ("https://www.huobi.com/",),
    "exchange-wallets-kucoin": ("https://www.kucoin.com/",),
    "exchange-wallets-bybit": ("https://blog.bybit.com/", "https://www.bybithelp.com/"),
    "exchange-wallets-deribit": ("https://insights.deribit.com/",),
    "exchange-wallets-bitfinexcom": ("https://github.com/bitfinexcom/",),
    "demo": ("https://archive.org/",),                                           # the Internet Archive's own donation page
    "protonmail": ("https://protonmail.com/",),                                  # Proton's own donation page
}


# ---- the TagPack format (YAML), read strictly ---------------------------------------------------------------------------------
def scalar(v, where):
    v = v.strip()
    if v[:1] in ("|", ">", "[", "{", "&", "*", "!", "%", "@", "`"):
        raise ListError("%s: a YAML construct this reader does not handle (%s)." % (where, v[:20]))
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
        inner = v[1:-1]
        return inner.replace("''", "'") if v[0] == "'" else inner.replace('\\"', '"').replace("\\\\", "\\")
    if " #" in v:
        v = v.split(" #", 1)[0].rstrip()
    return v


def parse_pack(text, name):
    """({header fields}, [tags]) of a TagPack: top-level 'key: value' lines, then 'tags:' with a list of 'key: value' entries. Anything else is refused."""
    header, tags, cur, in_tags = {}, [], None, False
    for n, raw in enumerate(text.replace("\r\n", "\n").split("\n"), 1):
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        where = "%s line %d" % (name, n)
        if not in_tags:
            if re.fullmatch(r"tags:\s*", raw):
                in_tags = True
                continue
            m = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*)", raw)
            if not m:
                raise ListError("%s: not a 'key: value' line." % where)
            header[m.group(1)] = scalar(m.group(2), where)
            continue
        m = re.fullmatch(r"- ([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*)", raw)
        if m:
            cur = {m.group(1): scalar(m.group(2), where)}
            tags.append(cur)
            continue
        m = re.fullmatch(r"  ([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*)", raw)
        if m and cur is not None:
            cur[m.group(1)] = scalar(m.group(2), where)
            continue
        raise ListError("%s: not a tag entry." % where)
    if not in_tags:
        raise ListError("%s: no 'tags:' list; this is not a TagPack." % name)
    return header, tags


def web_link(url):
    url = (url or "").strip()
    return url if len(url) <= 300 and re.fullmatch(r"https?://[^\s<>\"']+", url) else ""


def convert(files, commit=None, today=None):
    """(pack, info) from {pack name: file text} (only the names in PACKS are read). `commit` is what fetch() returned alongside; without it the pack does not state a licence."""
    today = today or datetime.date.today().isoformat()
    labels, seen, newest = [], set(), ""
    skipped = {"otherCurrency": 0, "otherSource": 0, "invalid": 0, "duplicate": 0}
    read = []
    for name in PACKS:
        if name not in files:
            continue
        header, tags = parse_pack(files[name], name)
        read.append(name)
        for t in tags:
            def eff(k):
                return t.get(k, header.get(k, ""))
            if eff("currency") not in ("BTC", "XBT"):
                skipped["otherCurrency"] += 1
                continue
            source = web_link(eff("source"))
            if not source or not source.startswith(PACKS[name]):
                skipped["otherSource"] += 1
                continue
            a = t.get("address", "")
            if not address_ok(a):
                skipped["invalid"] += 1
                continue
            if a in seen:
                skipped["duplicate"] += 1
                continue
            seen.add(a)
            last = eff("lastmod") if re.fullmatch(r"\d{4}-\d{2}-\d{2}", eff("lastmod")) else ""
            newest = max(newest, last)
            note = "GraphSense tagpack %s (%s%s%s)" % (name, eff("confidence") or "no confidence given", ", " + last if last else "", "; abuse type: " + eff("abuse") if eff("abuse") else "")
            labels.append({"address": a, "label": clean(eff("label") or eff("title") or name, MAX_LABEL), "category": clean((eff("category") or eff("abuse") or "").upper(), 40),
                           "url": source, "note": clean(note, MAX_NOTE)})
    for e in labels:
        if not e["category"]:
            del e["category"]
    pack = {"format": "hopline-labels", "version": 1, "name": NAME}
    if commit:
        pack["source"] = "%s, %d chosen packs at commit %s (%s)" % (REPO, len(read), commit["sha"][:7], commit["date"])
        pack.update({"licence": LICENCE, "attribution": ATTRIBUTION, "sourceUrl": SITE, "licenceText": commit["licence_text"]})
    else:
        pack["source"] = "GraphSense tag packs (files you supplied), converted " + today
        pack.update({"attribution": "GraphSense TagPacks (github.com/graphsense/graphsense-tagpacks)", "sourceUrl": SITE})
    if newest:
        pack["asOf"] = newest                                                    # the newest change to a tag in it, not the day it was copied
    pack["created"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    pack["labels"] = labels
    info = {"official": bool(commit), "packs": read, "read": len(labels), "skipped": skipped, "asOf": newest,
            "tags": len(labels) + sum(skipped.values())}
    return pack, info


# ---- the download -----------------------------------------------------------------------------------------------------------
def fetch():
    """({pack name: text}, commit): the packs of PACKS at the newest commit of the main branch, and {sha, date, licence_text}. The licence text must be the one this script knows."""
    try:
        meta = json.loads(http_get(API_COMMIT, token=True, limit=2_000_000).decode("utf-8"))
        sha, date = str(meta["sha"]), str(meta["commit"]["committer"]["date"])[:10]
        if not re.fullmatch(r"[0-9a-f]{40}", sha) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            raise ValueError("unexpected reply")
        licence = http_get(RAW % (sha, "LICENSE"), limit=100_000)
        files = {name: http_get(RAW % (sha, "packs/%s.yaml" % name), limit=MAX_BYTES).decode("utf-8") for name in PACKS}
    except ListError:
        raise
    except (OSError, ValueError, KeyError, TypeError) as e:
        raise ListError("Could not download the GraphSense tag packs from %s (%s). Download the pack files yourself and use --dir." % (SITE, e))
    if hashlib.sha256(licence).hexdigest() != LICENSE_SHA256:
        raise ListError("The licence text of %s is no longer the one this script was written against. Read it, and if the data may still be used, "
                        "update LICENSE_SHA256 in tools/make_label_pack_graphsense.py. Not used." % SITE)
    return files, {"sha": sha, "date": date, "licence_text": licence.decode("utf-8")}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split(chr(10) * 2)[0])
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--dir", help="a folder holding the TagPack files (<name>.yaml)")
    src.add_argument("--download", action="store_true", help="download the chosen packs from GitHub")
    ap.add_argument("--out", required=True, help="the label pack to write (.json)")
    a = ap.parse_args(argv)
    try:
        if a.download:
            files, commit = fetch()
        else:
            files, commit = {}, None
            for name in PACKS:
                path = os.path.join(a.dir, name + ".yaml")
                if os.path.exists(path):
                    with open(path, "rb") as f:
                        files[name] = f.read(MAX_BYTES + 1).decode("utf-8")
        pack, info = convert(files, commit)
    except (ListError, OSError, UnicodeDecodeError) as e:
        sys.exit(str(e))
    if not pack["labels"]:
        sys.exit("No Bitcoin addresses found in the chosen packs.")
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(pack, f, indent=1)
    s = info["skipped"]
    print("Wrote %d Bitcoin addresses from %d packs (left out: %d from another source page, %d not Bitcoin, %d failed the checksum, %d repeated) to %s"
          % (info["read"], len(info["packs"]), s["otherSource"], s["otherCurrency"], s["invalid"], s["duplicate"], a.out))
    if not info["official"]:
        print("Note: files you supplied, so the pack does not state a licence.", file=sys.stderr)


if __name__ == "__main__":
    main()
