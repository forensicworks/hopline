#!/usr/bin/env python3
"""Turn the Ransomwhere dataset into a Hopline label pack of Bitcoin ransomware payment addresses.

Ransomwhere (https://ransomwhe.re) is a crowdsourced list of the addresses ransomware actors asked victims to pay. Every report is
checked by hand against the ransom demand before it is added. Its data is released on Zenodo (CC BY 4.0, by Jack Cable), one file,
ransomwhere.json: a list of addresses, each with the ransomware family and the payments seen on it. This script keeps the Bitcoin
addresses that pass the address checksum, labels each "Ransomware: <family>", gives the payments as the note (how many, when, and
how much in all), and writes a file that Hopline's "Label packs > Import labels" reads.

    python tools/make_label_pack_ransomwhere.py --download --out ransomwhere.hopline-labels.json
    python tools/make_label_pack_ransomwhere.py --file ransomwhere.json --out ransomwhere.hopline-labels.json

--download fetches the release this script was written against (version 1.1.0, 27 October 2024) and checks its MD5 against the one
Zenodo publishes, so a changed file is refused. A newer release is adopted on purpose: read its record and licence, then change
RELEASE below. --file reads any export (a list, or {"result": [...]} as the live API gives); the pack then says the data is
Ransomwhere's but does not claim the licence of the Zenodo release unless the file is that release.

A listing here is a report by people who were asked to pay, checked by one project: Hopline shows it as "known (pack name)". It is a
claim, not a finding of yours, and an address on it is not proof that a payment was made to a particular actor.
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

RELEASE = {"version": "1.1.0", "published": "2024-10-27", "doi": "10.5281/zenodo.13999026", "record": "https://zenodo.org/records/13999026",
           "url": "https://zenodo.org/records/13999026/files/ransomwhere.json?download=1", "md5": "8a7bff74ab0dea4186232bc131c5d40f"}
LICENCE = "CC BY 4.0"
ATTRIBUTION = "Ransomwhere (ransomwhe.re), Jack Cable and contributors; Zenodo, doi:" + RELEASE["doi"]
NAME = "Ransomwhere ransomware payments"
MAX_BYTES = 100_000_000                                                          # the real file is about 5.6 MB
MAX_LABEL, MAX_NOTE = 120, 500                                                   # as the label pack importer caps them


class ListError(Exception):
    """The file is not something this script can read; the message says what to do."""


from btc_address import address_ok  # noqa: E402,F401  (the checks live in btc_address.py; the tests reach them through this module)


# ---- the pack ---------------------------------------------------------------------------------------------------------------
def clean(s, limit):
    return re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f\x7f-\x9f  ‪-‮⁦-⁩]", " ", s or "")).strip()[:limit]


def day(t):
    return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%Y-%m-%d")


def btc(sats):
    return ("%.8f" % (sats / 1e8)).rstrip("0").rstrip(".")


def payments_note(txs):
    """'3 payments, 2020-04-25 to 2020-05-03, 1.2345 BTC in all'; the dataset's own record of what the address received."""
    pays = [(t["time"], t["amount"]) for t in txs if isinstance(t, dict) and isinstance(t.get("time"), int) and isinstance(t.get("amount"), int) and t["amount"] >= 0 and 0 < t["time"] < 4102444800]
    if not pays:
        return "No payment recorded in the dataset"
    first, last = day(min(t for t, _ in pays)), day(max(t for t, _ in pays))
    return "%d payment%s, %s, %s BTC in all" % (len(pays), "" if len(pays) == 1 else "s", first if first == last else first + " to " + last, btc(sum(a for _, a in pays)))


def rows_of(data):
    if len(data) > MAX_BYTES:
        raise ListError("The file is larger than expected; refusing it.")
    try:
        d = json.loads(data.decode("utf-8-sig"))
    except (ValueError, UnicodeDecodeError):
        raise ListError("That is not JSON. Ransomwhere's export is ransomwhere.json from %s." % RELEASE["record"])
    rows = d.get("result") if isinstance(d, dict) else d
    if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows[:50]) or not any("address" in r and "family" in r for r in rows[:50]):
        raise ListError("That is not a Ransomwhere export (a list of addresses with a family and transactions). Use ransomwhere.json from %s." % RELEASE["record"])
    return rows


def convert(data, today=None):
    """(pack, info) for the Bitcoin addresses in a Ransomwhere export. `info` counts what was read and what was left out."""
    today = today or datetime.date.today().isoformat()
    rows = rows_of(data)
    official = hashlib.md5(data).hexdigest() == RELEASE["md5"]
    seen, labels, skipped, newest = set(), [], {"invalid": 0, "otherChain": 0, "duplicate": 0}, 0
    for r in rows:
        if r.get("blockchain") != "bitcoin":
            skipped["otherChain"] += 1
            continue
        a = r.get("address")
        if not address_ok(a):
            skipped["invalid"] += 1
            continue
        if a in seen:
            skipped["duplicate"] += 1
            continue
        seen.add(a)
        family = clean(r.get("family") if isinstance(r.get("family"), str) else "", 80)
        label = "Ransomware (family not known)" if family.lower() in ("", "unlabeled", "unlabelled", "unknown") else "Ransomware: " + family
        labels.append({"address": a, "label": clean(label, MAX_LABEL), "category": "RANSOM", "note": clean(payments_note(r.get("transactions") or []), MAX_NOTE)})
        for k in ("updatedAt", "createdAt"):
            v = r.get(k)
            if isinstance(v, str) and re.match(r"\d{4}-\d{2}-\d{2}T", v):
                newest = max(newest, int(v[:4] + v[5:7] + v[8:10]))
    stamp = str(newest)
    as_of = "%s-%s-%s" % (stamp[:4], stamp[4:6], stamp[6:]) if newest else ""
    source = ("Ransomwhere dataset version %s, published %s on Zenodo (ransomwhere.json)" % (RELEASE["version"], RELEASE["published"])) if official \
        else "Ransomwhere export (a file you supplied), converted " + today
    pack = {"format": "hopline-labels", "version": 1, "name": NAME, "source": source}
    if official:
        pack.update({"licence": LICENCE, "attribution": ATTRIBUTION, "sourceUrl": RELEASE["record"]})
    else:
        pack.update({"attribution": "Ransomwhere (ransomwhe.re)", "sourceUrl": "https://ransomwhe.re"})
    if as_of:
        pack["asOf"] = as_of
    pack["created"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    pack["labels"] = labels
    info = {"official": official, "rows": len(rows), "read": len(labels), "skipped": skipped, "asOf": as_of}
    return pack, info


def download(url=None):
    url = url or RELEASE["url"]
    with urllib.request.urlopen(url, timeout=120) as r:
        data = r.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ListError("The download is larger than expected; refusing it.")
    if url == RELEASE["url"] and hashlib.md5(data).hexdigest() != RELEASE["md5"]:
        raise ListError("The file at %s is not the release this script was written against (its MD5 differs from the one Zenodo published). Not used." % url)
    return data


def newer_release(timeout=30):
    """A sentence for a person when Zenodo has a release newer than the pinned one, '' otherwise. It never raises: a check that cannot run says nothing.
    It does not change the pack: a newer release is adopted by reading its record and licence and then changing RELEASE."""
    try:
        with urllib.request.urlopen(RELEASE["record"].replace("/records/", "/api/records/") + "/versions/latest", timeout=timeout) as r:
            d = json.loads(r.read(2_000_000).decode("utf-8"))
        rid = str(d.get("id", ""))
        if not re.fullmatch(r"\d{1,12}", rid) or rid == RELEASE["record"].rsplit("/", 1)[1]:
            return ""
        meta = d.get("metadata") if isinstance(d.get("metadata"), dict) else {}
        lic = meta.get("license")
        return ("Ransomwhere has a newer release on Zenodo: version %s, published %s, licence %s, https://zenodo.org/records/%s. The pack is unchanged until its record and "
                "licence have been read and RELEASE in tools/make_label_pack_ransomwhere.py is changed to adopt it."
                % (clean(str(meta.get("version", "?")), 30), clean(str(meta.get("publication_date", "?")), 30), clean(str(lic.get("id", "?") if isinstance(lic, dict) else "?"), 40), rid))
    except Exception:                                                                   # noqa: BLE001 - offline, a changed reply, anything: say nothing
        return ""


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--file", help="path to ransomwhere.json (or the live API's export)")
    src.add_argument("--download", action="store_true", help="download the pinned release from Zenodo")
    ap.add_argument("--out", required=True, help="the label pack to write (.json)")
    a = ap.parse_args(argv)
    try:
        if a.download:
            try:
                data = download()
            except ListError:
                raise
            except Exception as e:                                           # noqa: BLE001 - any failure is reported the same way
                raise ListError("Could not download %s (%s). Download ransomwhere.json yourself from %s and use --file." % (RELEASE["url"], e, RELEASE["record"]))
        else:
            with open(a.file, "rb") as f:
                data = f.read(MAX_BYTES + 1)
        pack, info = convert(data)
    except (ListError, OSError) as e:
        sys.exit(str(e))
    if not pack["labels"]:
        sys.exit("No Bitcoin addresses found: is this the Ransomwhere export?")
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(pack, f, indent=1)
    s = info["skipped"]
    print("Wrote %d Bitcoin addresses (of %d rows; left out: %d failed the checksum, %d on other chains, %d repeated) to %s"
          % (info["read"], info["rows"], s["invalid"], s["otherChain"], s["duplicate"], a.out))
    if not info["official"]:
        print("Note: this file is not the Zenodo release %s, so the pack does not state its licence." % RELEASE["version"], file=sys.stderr)


if __name__ == "__main__":
    main()
