#!/usr/bin/env python3
"""Review the built-in wallet list (public/data/known-addresses.js) for what a computer can check, and say what it cannot.

    python tools/review_known_addresses.py

Checked: every address passes its checksum and format; labels that differ only in case, spacing or punctuation; an "alt" name that is the same
name written another way (an alt that names another owner is a real conflict and is listed, not changed); addresses that are also in a
shipped label pack, with both names. NOT checked: whether an address really belongs to the name it carries, which needs a source for each
entry. A name is a claim, not proof (see sources.md).
"""
import collections
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import btc_address as ba  # noqa: E402

PACKS = ("ofac-sdn", "uk-sanctions", "graphsense", "ransomwhere", "mining-pools")
SUFFIXES = (" Hot Wallet", " Cold Wallet", " Wallet")


def load_known():
    text = (ROOT / "public" / "data" / "known-addresses.js").read_text(encoding="utf-8")
    return json.loads(text[text.index("= {") + 2: text.rindex("}") + 1])


def load_pack(name):
    text = (ROOT / "public" / "packs" / (name + ".js")).read_text(encoding="utf-8")
    return json.loads(text[text.index('"] = ') + 5: text.rindex("}") + 1])


def entity(name):
    """The name without the kind of wallet, in lower case without punctuation: BitFlyer, Bitflyer and bitflyer are one entity."""
    for s in SUFFIXES:
        if name.endswith(s):
            name = name[: -len(s)]
    return "".join(ch for ch in name.lower() if ch.isalnum())


def review(known, packs):
    """What the checks find, as a dict of lists (each empty when there is nothing to say)."""
    labels = collections.Counter(v["label"] for v in known.values())
    spellings = collections.defaultdict(set)
    for k in labels:
        spellings[entity(k)].add(k)
    found = {
        "bad_addresses": [a for a in known if not ba.address_ok(a)],
        "case_variants": sorted(sorted(v) for k, v in spellings.items() if len({x.lower() for x in v}) < len(v)),
        "same_name_alts": [(a, v["label"], x) for a, v in known.items() for x in v.get("alt", []) if entity(x) == entity(v["label"])],
        "conflicts": [(a, v["label"], v["alt"]) for a, v in known.items() if v.get("alt") and any(entity(x) != entity(v["label"]) for x in v["alt"])],
        "pack_overlaps": [],
    }
    for name, pack in packs.items():
        theirs = {x["address"]: x["label"] for x in pack["labels"]}
        for a in known:
            if a in theirs:
                same = entity(known[a]["label"]) in "".join(ch for ch in theirs[a].lower() if ch.isalnum()) or entity(theirs[a]) in entity(known[a]["label"])
                found["pack_overlaps"].append((name, a, known[a]["label"], theirs[a], same))
    return found


def main():
    known = load_known()
    packs = {}
    for name in PACKS:
        try:
            packs[name] = load_pack(name)
        except (OSError, ValueError) as e:
            print("could not read the pack %s: %s" % (name, e))
    f = review(known, packs)
    print("%d entries, %d distinct labels" % (len(known), len({v["label"] for v in known.values()})))
    print("addresses that fail their checksum or format: %d" % len(f["bad_addresses"]))
    print("labels that differ only in case or spelling: %d %s" % (len(f["case_variants"]), f["case_variants"]))
    print("alternative names that are the same name written another way: %d" % len(f["same_name_alts"]))
    print("addresses with a name of ANOTHER owner as an alternative (to decide by a person): %d" % len(f["conflicts"]))
    for a, label, alt in f["conflicts"]:
        print("    %s  %s  also: %s" % (a, label, ", ".join(alt)))
    print("addresses also in a shipped pack: %d" % len(f["pack_overlaps"]))
    for name, a, mine, theirs, same in f["pack_overlaps"]:
        print("    %-9s %s  built-in: %s | %s: %s" % ("same" if same else "DIFFERENT", a, mine, name, theirs))
    return 0


if __name__ == "__main__":
    sys.exit(main())
