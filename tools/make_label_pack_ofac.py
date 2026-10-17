#!/usr/bin/env python3
"""Turn the U.S. Treasury OFAC "SDN" sanctions list into an Orion label pack of Bitcoin addresses.

The list names people and organisations and, in the Remarks column, the digital-currency addresses attributed to them
("Digital Currency Address - XBT 1abc...;"). This script keeps the Bitcoin (XBT) ones, labels each "OFAC SDN: <name>" with
the sanctions programme as its category, and writes a file that Orion's "Label packs > Import labels" reads.

    python tools/make_label_pack_ofac.py --sdn sdn.csv --out ofac-sdn.orion-labels.json
    python tools/make_label_pack_ofac.py --download --out ofac-sdn.orion-labels.json

--download fetches the file from the address given by --url (default: the long-standing Treasury location, which may
have moved: if it fails, download sdn.csv from https://ofac.treasury.gov/ yourself and use --sdn). Nothing else is
fetched, and the result is a plain file you can read before importing it.

A sanctions listing is a claim by a government, not a finding of yours: Orion shows it as "known (pack name)".
"""
import argparse
import csv
import datetime
import io
import json
import re
import sys
import urllib.request

DEFAULT_URL = "https://www.treasury.gov/ofac/downloads/sdn.csv"
ADDRESS = re.compile(r"Digital Currency Address - (?:XBT|BTC)\s+([A-Za-z0-9]{14,90})")
SEARCH_PAGE = "https://sanctionssearch.ofac.treas.gov/"


def clean(s):
    s = re.sub(r"\s+", " ", (s or "").strip())
    return "" if s == "-0-" else s


def convert(text, today=None):
    """Return the label pack (a dict) for the Bitcoin addresses in the text of an sdn.csv."""
    today = today or datetime.date.today().isoformat()
    labels, seen = [], set()
    for row in csv.reader(io.StringIO(text.lstrip("﻿"))):
        if len(row) < 12:
            continue
        name, program, remarks = clean(row[1]), clean(row[3]), row[11]
        for address in ADDRESS.findall(remarks):
            if address in seen:
                continue
            seen.add(address)
            entry = {"address": address, "label": "OFAC SDN: " + name if name else "OFAC SDN", "url": SEARCH_PAGE}
            if program:
                entry["category"] = program[:40]
            labels.append(entry)
    return {"format": "orion-labels", "version": 1, "name": "OFAC SDN list (Bitcoin)",
            "source": "U.S. Treasury OFAC SDN list (sdn.csv), converted " + today, "created": datetime.datetime.now(datetime.timezone.utc).isoformat(), "labels": labels}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--sdn", help="path to a downloaded sdn.csv")
    src.add_argument("--download", action="store_true", help="download sdn.csv first")
    ap.add_argument("--url", default=DEFAULT_URL, help="where --download fetches from (default: %(default)s)")
    ap.add_argument("--out", required=True, help="the label pack to write (.json)")
    a = ap.parse_args(argv)
    if a.download:
        try:
            with urllib.request.urlopen(a.url, timeout=60) as r:
                text = r.read().decode("utf-8", "replace")
        except Exception as e:                                       # noqa: BLE001 - any failure is reported the same way
            sys.exit("Could not download %s (%s). Download sdn.csv yourself and use --sdn." % (a.url, e))
    else:
        with open(a.sdn, encoding="utf-8", errors="replace", newline="") as f:
            text = f.read()
    pack = convert(text)
    if not pack["labels"]:
        sys.exit("No Bitcoin addresses found: is this the SDN list (sdn.csv)?")
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(pack, f, indent=1)
    print("Wrote %d Bitcoin addresses to %s" % (len(pack["labels"]), a.out))


if __name__ == "__main__":
    main()
