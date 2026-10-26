#!/usr/bin/env python3
"""Write the label packs the site ships, and the list of them, into public/packs/.

    python tools/build_packs.py --refresh                              every source, downloaded again (what the weekly workflow runs)
    python tools/build_packs.py --refresh --only ofac-sdn             just the sources named
    python tools/build_packs.py --download --download-ransomwhere --download-miningpools     the three, by hand
    python tools/build_packs.py --ofac SDN_XML.ZIP --ransomwhere ransomwhere.json

Each pack becomes packs/<id>.js (one wallet per line, so a refresh shows in a diff as the wallets that were added or removed)
and gets a line in packs/index.js, the list the pages read (public/js/hopline-packs.js). Only the packs named on the command line
(or by --refresh, all of them) are rewritten; the others stay as they are. Nothing is evaluated: the sources are read by their own
converters. --summary FILE writes what changed as markdown (the weekly workflow uses it as the pull request text).

Five packs, each from its own converter (see sources.md for where each comes from and under what licence): the OFAC sanctions list
(make_label_pack_ofac.py) and the UK Sanctions List (make_label_pack_uksanctions.py), which ship switched on, and the Ransomwhere
ransomware payment addresses (make_label_pack_ransomwhere.py), the mining pools mempool.space knows (make_label_pack_miningpools.py)
and a chosen part of the GraphSense tag packs (make_label_pack_graphsense.py), which ship switched off. The two GitHub-hosted lists are
taken from the newest commit once the repository's licence text is the one the tool knows; the MIT licence asks for its text to travel
with copies of the data, so their pack files start with it. Ransomwhere is taken only from the release the converter is pinned to (its
MD5 is checked), because the pack states that release's licence; --refresh also says when Zenodo has a newer release, which is for a
person to read and adopt. A pack of 20 or more wallets that shrinks to under 80% of its earlier size is refused (--force overrides): a
source that changes its layout shows up as a short list, and a short sanctions list is worse than an old one.

To add a source: write tools/make_label_pack_<name>.py (read the file, check every address, return the pack), a build_<name>() below
that returns (id, pack, switched on as shipped), and one entry in SOURCES. --refresh and the weekly workflow then include it. A source
whose licence or terms are not settled does not go in.
"""
import argparse
import hashlib
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import make_label_pack_graphsense as gs  # noqa: E402
import make_label_pack_miningpools as mp  # noqa: E402
import make_label_pack_ofac as ofac  # noqa: E402
import make_label_pack_ransomwhere as rw  # noqa: E402
import make_label_pack_uksanctions as uk  # noqa: E402

OUT = os.path.join(os.path.dirname(HERE), "public", "packs")
MIN_KEEP = 0.8
MIN_LIST = 20                                                                    # the shrink check applies to packs of at least this many wallets
SHOWN = 40                                                                       # wallets listed per kind of change in a summary
INDEX_RE = re.compile(r"window\.HOPLINE_PACK_INDEX = (\[.*\]);", re.S)


class BuildError(Exception):
    """A pack that cannot be written; the message says why."""


def pack_text(pack_id, pack):
    """The text of packs/<id>.js. Every wallet is on its own line; nothing that changes from run to run (a conversion time) is in it."""
    labels = [dict(e, note=re.sub(r"; list dated [\d/]+$", "", e["note"])) if e.get("note") else e for e in sorted(pack["labels"], key=lambda e: e["address"])]   # sorted, and without the list's date, so a refresh changes only the wallets that changed
    head = {k: v for k, v in pack.items() if k not in ("labels", "created", "licenceText")}
    head["source"] = re.sub(r", converted \d{4}-\d{2}-\d{2}$", "", head.get("source", ""))
    top = json.dumps(head, separators=(",", ":"), ensure_ascii=True)
    lines = [json.dumps(e, separators=(",", ":"), ensure_ascii=True) for e in labels]
    notice, comment, nl = pack.get("licenceText"), "", chr(10)
    if notice:                                                               # a licence that asks for its text to travel with copies of the data: it is the top of the file
        comment = "/*" + nl + " * The data below is under this licence (" + pack.get("sourceUrl", "") + "):" + nl + " *" + nl \
                  + nl.join((" * " + ln).rstrip() for ln in notice.replace("*/", "* /").strip().splitlines()) + nl + " */" + nl
    return ('/* Hopline label pack "%s": written by tools/build_packs.py, do not edit by hand. */\n' % pack["name"].replace("*/", "") + comment
            + '(window.HOPLINE_PACKS = window.HOPLINE_PACKS || {})["%s"] = ' % pack_id
            + top[:-1] + ',"labels":[\n' + ",\n".join(lines) + "\n]};\n")


def index_entry(pack_id, pack, text, default_on):
    entry = {"id": pack_id, "name": pack["name"], "file": pack_id + ".js", "entries": len(pack["labels"]),
             "source": re.sub(r", converted \d{4}-\d{2}-\d{2}$", "", pack.get("source", "")),
             "licence": pack.get("licence", ""), "attribution": pack.get("attribution", ""), "asOf": pack.get("asOf", ""),
             "sourceUrl": pack.get("sourceUrl", ""), "sanctions": pack.get("sanctions") is True, "defaultOn": default_on,
             "version": hashlib.sha256(text.encode("utf-8")).hexdigest()[:10]}
    return entry


def read_index(path):
    """The entries of an existing packs/index.js ([] when there is none)."""
    try:
        with open(path, encoding="utf-8") as f:
            m = INDEX_RE.search(f.read())
    except FileNotFoundError:
        return []
    if not m:
        raise BuildError("%s is not a pack list this script wrote; delete it or fix it by hand." % path)
    return json.loads(m.group(1))


def index_text(entries):
    return ("/* The label packs this site ships: written by tools/build_packs.py, do not edit by hand. */\n"
            "window.HOPLINE_PACK_INDEX = [\n" + ",\n".join(json.dumps(e, separators=(",", ":"), ensure_ascii=True) for e in entries) + "\n];\n")


def read_labels(out_dir, pack_id):
    """{address: entry} of a pack file written earlier ({} when there is none): the wallet lines are plain JSON, one each."""
    try:
        with open(os.path.join(out_dir, pack_id + ".js"), encoding="utf-8") as f:
            lines = [ln.rstrip().rstrip(",") for ln in f if ln.startswith('{"address"')]
    except FileNotFoundError:
        return {}
    return {e["address"]: e for e in (json.loads(ln) for ln in lines)}


def diff_labels(old, new_labels):
    """What a rebuild changed: wallets added, wallets removed, and wallets whose name or category changed (as (old, new))."""
    new = {e["address"]: e for e in new_labels}
    return {"added": [new[a] for a in sorted(set(new) - set(old))], "removed": [old[a] for a in sorted(set(old) - set(new))],
            "changed": [(old[a], new[a]) for a in sorted(set(old) & set(new)) if (old[a].get("label"), old[a].get("category")) != (new[a].get("label"), new[a].get("category"))]}


def write_if_changed(path, text):
    try:
        with open(path, encoding="utf-8", newline="") as f:
            if f.read() == text:
                return False
    except FileNotFoundError:
        pass
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return True


def add_pack(out_dir, pack_id, pack, default_on, force=False):
    """Write one pack and update the list. Returns (entry, changed, what changed)."""
    os.makedirs(out_dir, exist_ok=True)
    index_path = os.path.join(out_dir, "index.js")
    entries = read_index(index_path)
    old = next((e for e in entries if e.get("id") == pack_id), None)
    if old and not force and old.get("entries", 0) >= MIN_LIST and len(pack["labels"]) < MIN_KEEP * old["entries"]:       # a short list loses a wallet when one is delisted: only a long one is checked
        raise BuildError("%s would shrink from %d to %d wallets, which is more than expected: check the source, or use --force."
                         % (pack["name"], old["entries"], len(pack["labels"])))
    diff = diff_labels(read_labels(out_dir, pack_id), pack["labels"])
    text = pack_text(pack_id, pack)
    entry = index_entry(pack_id, pack, text, default_on)
    changed = write_if_changed(os.path.join(out_dir, entry["file"]), text)
    entries = [entry if e.get("id") == pack_id else e for e in entries] if old else entries + [entry]
    changed = write_if_changed(index_path, index_text(entries)) or changed
    return entry, changed, diff


# ---- the sources ------------------------------------------------------------------------------------------------------------
def build_ofac(args):
    try:
        if args.download:
            data = ofac.download(ofac.DEFAULT_URL)
        else:
            with open(args.ofac, "rb") as f:
                data = f.read(ofac.MAX_BYTES + 1)
        pack, info = ofac.convert(data)
    except OSError as e:
        raise BuildError("Could not read the OFAC list (%s)." % e)
    except ofac.ListError as e:
        raise BuildError(str(e))
    if info["warning"]:
        raise BuildError(info["warning"] + " Not written.")
    if not pack["labels"]:
        raise BuildError("No Bitcoin addresses found: is this the SDN list?")
    return "ofac-sdn", pack, True


def build_ransomwhere(args):
    try:
        if args.download_ransomwhere:
            data = rw.download()
        else:
            with open(args.ransomwhere, "rb") as f:
                data = f.read(rw.MAX_BYTES + 1)
        pack, info = rw.convert(data)
    except OSError as e:
        raise BuildError("Could not read the Ransomwhere data (%s)." % e)
    except rw.ListError as e:
        raise BuildError(str(e))
    if not info["official"]:
        raise BuildError("That file is not the Ransomwhere release %s on Zenodo (%s), whose licence the pack states. To adopt a newer release, read its "
                         "record and licence, then change RELEASE in tools/make_label_pack_ransomwhere.py. Not written." % (rw.RELEASE["version"], rw.RELEASE["record"]))
    bad = sum(info["skipped"].values())
    if not pack["labels"] or bad > 0.01 * info["rows"]:
        raise BuildError("%d of the %d Ransomwhere rows could not be used, which is more than expected. Not written." % (bad, info["rows"]))
    return "ransomwhere", pack, False


def build_miningpools(args):
    try:
        data, commit = mp.fetch()
        pack, info = mp.convert(data, commit)
    except mp.ListError as e:
        raise BuildError(str(e))
    bad = info["skipped"]["invalid"] + info["skipped"]["noName"]
    if not pack["labels"] or bad > 0.02 * max(info["addresses"], 1):
        raise BuildError("%d of the %d addresses in the mining pools list could not be used, which is more than expected. Not written." % (bad, info["addresses"]))
    return "mining-pools", pack, False


def build_graphsense(args):
    try:
        files, commit = gs.fetch()
        pack, info = gs.convert(files, commit)
    except gs.ListError as e:
        raise BuildError(str(e))
    if not pack["labels"] or len(info["packs"]) < len(gs.PACKS):
        raise BuildError("Only %d of the %d chosen GraphSense packs were read, giving %d addresses: a pack may have been renamed or moved. Not written."
                         % (len(info["packs"]), len(gs.PACKS), len(pack["labels"])))
    return "graphsense", pack, False


def build_uksanctions(args):
    try:
        if args is None or args.download_uk:
            data = uk.download()
        else:
            with open(args.uk, "rb") as f:
                data = f.read(uk.MAX_BYTES + 1)
        pack, info = uk.convert(data)
    except OSError as e:
        raise BuildError("Could not read the UK Sanctions List (%s)." % e)
    except uk.ListError as e:
        raise BuildError(str(e))
    if not pack["labels"]:
        raise BuildError("No Bitcoin address found in the text of the %d designations on the UK Sanctions List: its layout may have changed. Not written." % info["designations"])
    return "uk-sanctions", pack, True


# Every source that --refresh (and so the weekly workflow) rebuilds: its id, how to build it from the live source, and an optional check
# that returns a sentence for a person when the source has something that needs a decision (it never changes the pack itself).
SOURCES = [
    {"id": "ofac-sdn", "build": lambda: build_ofac(argparse.Namespace(ofac=None, download=True)), "check": None},
    {"id": "ransomwhere", "build": lambda: build_ransomwhere(argparse.Namespace(ransomwhere=None, download_ransomwhere=True)), "check": rw.newer_release},
    {"id": "mining-pools", "build": lambda: build_miningpools(None), "check": None},
    {"id": "uk-sanctions", "build": lambda: build_uksanctions(None), "check": None},
    {"id": "graphsense", "build": lambda: build_graphsense(None), "check": None},
]


def refresh(out_dir, only=(), force=False):
    """Rebuild every source (or those in `only`), each on its own: one that fails keeps its old files and is reported, the others are still written.
    Returns (results, failures, notices); a result is { entry, changed, diff }, a failure (id, message), a notice (id, sentence)."""
    results, failures, notices = [], [], []
    for src in SOURCES:
        if only and src["id"] not in only:
            continue
        try:
            pack_id, pack, default_on = src["build"]()
            entry, changed, diff = add_pack(out_dir, pack_id, pack, default_on, force)
            results.append({"entry": entry, "changed": changed, "diff": diff})
        except BuildError as e:
            failures.append((src["id"], str(e)))
        note = src["check"]() if src["check"] else ""
        if note:
            notices.append((src["id"], note))
    return results, failures, notices


# ---- what changed, as text --------------------------------------------------------------------------------------------------
def code(text, limit=100):
    """Text from a source as a markdown code span: it cannot be a link, an image or a mention of somebody, whatever the source wrote."""
    return "`" + re.sub(r"[`\r\n\t]+", " ", str(text or ""))[:limit].strip() + "`"


def counts(diff):
    bits = ["+%d added" % len(diff["added"]) if diff["added"] else "", "-%d removed" % len(diff["removed"]) if diff["removed"] else "", "%d renamed" % len(diff["changed"]) if diff["changed"] else ""]
    return ", ".join(b for b in bits if b)


def summary_text(results, failures, notices):
    out = ["## Label packs", ""]
    if results:
        out += ["| Pack | Wallets | As of | Changed |", "|---|---|---|---|"]
        for r in results:
            e = r["entry"]
            out.append("| %s | %s | %s | %s |" % (code(e["name"]), "{:,}".format(e["entries"]), e["asOf"] or "unknown", counts(r["diff"]) or ("data changed" if r["changed"] else "nothing")))
        out.append("")
    for r in results:
        for title, items in (("added", r["diff"]["added"]), ("removed", r["diff"]["removed"]), ("renamed", r["diff"]["changed"])):
            if not items:
                continue
            out += ["### %s: %s (%d)" % (r["entry"]["id"], title, len(items)), ""]
            for it in items[:SHOWN]:
                new = it[1] if title == "renamed" else it
                out.append("- %s %s%s" % (code(new["address"]), code(new.get("label")), (" (was " + code(it[0].get("label")) + ")") if title == "renamed" else ""))
            if len(items) > SHOWN:
                out.append("- and %d more" % (len(items) - SHOWN))
            out.append("")
    if failures:
        out += ["### Could not refresh", ""] + ["- **%s**: %s (its files were left as they were)" % (i, code(m, 400)) for i, m in failures] + [""]
    if notices:
        out += ["### Needs a decision", ""] + ["- **%s**: %s" % (i, m) for i, m in notices] + [""]
    return chr(10).join(out)


def result_line(r):
    e = r["entry"]
    d = counts(r["diff"])
    return "%s: %d wallets, as of %s, %s%s" % (e["name"], e["entries"], e["asOf"] or "an unknown date", "written" if r["changed"] else "unchanged", " (%s)" % d if d else "")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split(chr(10) * 2)[0])
    ap.add_argument("--refresh", action="store_true", help="download every source again and rebuild its pack; one that fails is reported and left as it was")
    ap.add_argument("--only", help="with --refresh: only these pack ids, comma separated (%s)" % ", ".join(s["id"] for s in SOURCES))
    ap.add_argument("--ofac", help="path to a downloaded SDN list (SDN_XML.ZIP, SDN.XML or one of the larger layouts)")
    ap.add_argument("--download", action="store_true", help="download SDN_XML.ZIP from OFAC first")
    ap.add_argument("--ransomwhere", help="path to ransomwhere.json of the pinned Zenodo release")
    ap.add_argument("--download-ransomwhere", action="store_true", help="download the pinned Ransomwhere release from Zenodo (its MD5 is checked)")
    ap.add_argument("--download-miningpools", action="store_true", help="download the mining pools list from GitHub (its licence text must be the one this tool knows)")
    ap.add_argument("--download-graphsense", action="store_true", help="download the chosen GraphSense tag packs from GitHub (the licence text must be the one this tool knows)")
    ap.add_argument("--uk", help="path to UK-Sanctions-List.xml")
    ap.add_argument("--download-uk", action="store_true", help="download the UK Sanctions List from the Foreign, Commonwealth & Development Office")
    ap.add_argument("--out", default=OUT, help="the folder to write (default: %(default)s)")
    ap.add_argument("--summary", help="also write what changed to this file, as markdown")
    ap.add_argument("--force", action="store_true", help="write a pack even if it is much smaller than the one it replaces")
    a = ap.parse_args(argv)
    if bool(a.ofac) + a.download > 1 or bool(a.ransomwhere) + a.download_ransomwhere > 1:
        ap.error("give one source for each pack: a file or --download, not both")
    only = [x.strip() for x in (a.only or "").split(",") if x.strip()]
    if only and not a.refresh:
        ap.error("--only goes with --refresh")
    if any(x not in [s["id"] for s in SOURCES] for x in only):
        ap.error("no such pack in --only; the ids are: %s" % ", ".join(s["id"] for s in SOURCES))
    if bool(a.uk) + a.download_uk > 1:
        ap.error("give one source for each pack: a file or --download-uk, not both")
    if a.refresh and (a.ofac or a.download or a.ransomwhere or a.download_ransomwhere or a.download_miningpools or a.uk or a.download_uk or a.download_graphsense):
        ap.error("--refresh downloads every source itself: do not combine it with a source of your own")
    jobs = ([build_ofac] if a.ofac or a.download else []) + ([build_ransomwhere] if a.ransomwhere or a.download_ransomwhere else []) + ([build_miningpools] if a.download_miningpools else []) + ([build_uksanctions] if a.uk or a.download_uk else []) + ([build_graphsense] if a.download_graphsense else [])
    if not jobs and not a.refresh:
        ap.error("name at least one source: --refresh, --ofac FILE, --download, --ransomwhere FILE, --download-ransomwhere, --download-miningpools, --uk FILE, --download-uk or --download-graphsense")
    failures, notices = [], []
    try:
        if a.refresh:
            results, failures, notices = refresh(a.out, only, a.force)
        else:
            made = [job(a) for job in jobs]                                  # every source is read before anything is written
            results = [dict(zip(("entry", "changed", "diff"), add_pack(a.out, pack_id, pack, default_on, a.force))) for pack_id, pack, default_on in made]
    except BuildError as e:
        sys.exit(str(e))
    for r in results:
        print(result_line(r))
    for pack_id, message in failures:
        print("%s: NOT refreshed: %s" % (pack_id, message), file=sys.stderr)
    for pack_id, message in notices:
        print("%s: %s" % (pack_id, message))
    if a.summary:
        with open(a.summary, "w", encoding="utf-8", newline="\n") as f:
            f.write(summary_text(results, failures, notices) + chr(10))
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
