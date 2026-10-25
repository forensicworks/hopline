#!/usr/bin/env python3
"""Turn the UK Sanctions List into a Hopline label pack of the Bitcoin addresses it names.

The UK list (https://www.gov.uk/government/publications/the-uk-sanctions-list, published by the Foreign, Commonwealth & Development
Office) has no field for a crypto wallet. When the UK names one it writes it into the free text of the entry ("Other information" or
"UK statement of reasons"), for example "Digital Currency Address: XBT 3Lpoy5..." or "Digital address: bc1q72...". So this script reads
those two text fields of every designation, finds what looks like a Bitcoin address, keeps it only if its checksum is right, and labels it
"UK Sanctions: <name of the designation>". Most of the crypto addresses on the list are Ethereum or Tron ones; they are not Bitcoin
addresses and are not touched. An address that the text says belongs to another coin (BCH, ETH...) is left out.

    python tools/make_label_pack_uksanctions.py --download --out uk-sanctions.hopline-labels.json
    python tools/make_label_pack_uksanctions.py --file UK-Sanctions-List.xml --out uk-sanctions.hopline-labels.json

The data is under the Open Government Licence v3.0 (Crown copyright); the pack says so and carries the attribution the licence asks for.
A listing is the UK government's claim that the address is owned or controlled by a designated person or entity, or associated with it:
Hopline shows it as "known (pack name)" and as a sanctions listing, not as a finding of yours.
"""
import argparse
import datetime
import io
import json
import os
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from btc_address import address_ok  # noqa: E402

PAGE = "https://www.gov.uk/government/publications/the-uk-sanctions-list"
URL = "https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml"
LICENCE = "Open Government Licence v3.0"
ATTRIBUTION = ("UK Sanctions List, Foreign, Commonwealth & Development Office. Contains public sector information licensed under the "
               "Open Government Licence v3.0 (https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/)")
NAME = "UK Sanctions List (Bitcoin)"
MAX_BYTES = 300_000_000                                                          # the real file is about 22 MB
MIN_DESIGNATIONS = 1000                                                          # the real list has over 6,000: far fewer means it is not the list, or its layout changed
TEXT_FIELDS = ("OtherInformation", "UKStatementofReasons")
MAX_LABEL, MAX_NOTE = 120, 500                                                   # as the label pack importer caps them

BASE58 = re.compile(r"(?<![A-Za-z0-9])[13][1-9A-HJ-NP-Za-km-z]{25,34}(?![A-Za-z0-9])")
BECH32 = re.compile(r"(?<![A-Za-z0-9])(?:bc1|BC1)[0-9a-zA-Z]{8,87}(?![A-Za-z0-9])")
TICKER = re.compile(r"(?<![A-Za-z0-9])([A-Za-z]{2,6})[\s:;,)\-]*$")                              # the word just before an address: "XBT", "USDT", "BCH"...
BITCOIN_TICKERS = ("XBT", "BTC", "USDT")                                         # USDT on the Omni layer is paid to an ordinary Bitcoin address
OTHER_COINS = ("BCH", "BSV", "ETH", "ETC", "BNB", "USDC", "TRX", "LTC", "DOGE", "XMR", "ZEC", "DASH", "XRP", "SOL", "DAI", "BUSD", "TUSD", "TON")


class ListError(Exception):
    """The file is not something this script can read; the message says what to do."""


def clean(s, limit):
    return re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f\x7f-\x9f  ‪-‮⁦-⁩]", " ", s or "")).strip()[:limit]


def local(tag):
    return tag.rpartition("}")[2]


def iso_date(uk):
    """The list writes dates as DD/MM/YYYY; the pack states the date of its data as YYYY-MM-DD ('' when it is not a real date)."""
    m = re.fullmatch(r"(\d{2})/(\d{2})/(\d{4})", uk or "")
    try:
        return datetime.date(int(m.group(3)), int(m.group(2)), int(m.group(1))).isoformat() if m else ""
    except ValueError:
        return ""


def primary_name(d):
    """'SURNAME, Given names' for a person, the name for an entity: the list puts the surname or the whole name in Name6 and the given names in Name1 to Name5."""
    for n in d.iter():
        if local(n.tag) == "Name" and (n.findtext("NameType") or "").strip() == "Primary Name":
            given = " ".join(clean(n.findtext("Name%d" % i), 80) for i in range(1, 6) if clean(n.findtext("Name%d" % i), 80))
            last = clean(n.findtext("Name6"), 120)
            return last + ", " + given if last and given else last or given
    return ""


def read(data):
    """(date the list was generated, designations): each designation is { id, name, regime, texts }."""
    if len(data) > MAX_BYTES:
        raise ListError("The file is larger than expected; refusing it.")
    head = data[:4000].lstrip()
    if b"<!DOCTYPE" in data[:20000] or b"<!ENTITY" in data[:20000]:
        raise ListError("The file declares a DOCTYPE or entities, which the real list does not; refusing to read it.")
    if not head.startswith((b"<?xml", b"<Designations")):
        raise ListError("That is not the UK Sanctions List XML. Download UK-Sanctions-List.xml from %s." % PAGE)
    date, out = "", []
    try:
        for _, el in ET.iterparse(io.BytesIO(data), events=("end",)):
            t = local(el.tag)
            if t == "DateGenerated":
                date = clean(el.text, 20)
            elif t == "Designation":
                out.append({"id": clean(el.findtext("UniqueID"), 30), "name": primary_name(el), "regime": clean(el.findtext("RegimeName"), 200),
                            "texts": [el.findtext(f) or "" for f in TEXT_FIELDS]})
                el.clear()
    except ET.ParseError as e:
        raise ListError("The file is not valid XML (%s): it may be cut short, or it is not the UK Sanctions List." % e)
    if len(out) < MIN_DESIGNATIONS:
        raise ListError("The file holds only %d designations; the real list has thousands. Is this the UK Sanctions List (UK-Sanctions-List.xml)?" % len(out))
    return date, out


def addresses_in(text):
    """[(address, ticker)] for what looks like a Bitcoin address in a text: in the order written, with the coin the text names just before it ('' when it names none)."""
    found = []
    for pattern in (BASE58, BECH32):
        for m in pattern.finditer(text):
            before = TICKER.search(text[max(0, m.start() - 30):m.start()])
            found.append((m.start(), m.group(0).lower() if m.group(0)[:3] in ("bc1", "BC1") else m.group(0), before.group(1).upper() if before else ""))        # bech32 is not case sensitive, base58 is
    return [(a, t) for _, a, t in sorted(found)]


def convert(data, today=None):
    """(pack, info) for the Bitcoin addresses written in the text of the designations. `info` counts what was read and what was left out."""
    today = today or datetime.date.today().isoformat()
    date, designations = read(data)
    labels, seen, skipped = [], set(), {"invalid": 0, "duplicate": 0, "otherCoin": 0}
    for d in designations:
        for text in d["texts"]:
            for address, ticker in addresses_in(text):
                if ticker in OTHER_COINS:
                    skipped["otherCoin"] += 1
                elif not address_ok(address):
                    skipped["invalid"] += 1
                elif address in seen:
                    skipped["duplicate"] += 1
                else:
                    seen.add(address)
                    note = "UK Sanctions List entry %s%s; the address is written in the entry's text%s" % (
                        d["id"], " (%s)" % d["regime"] if d["regime"] else "", " (marked %s)" % ticker if ticker in BITCOIN_TICKERS else "")
                    labels.append({"address": address, "label": clean("UK Sanctions: " + (d["name"] or d["id"]), MAX_LABEL), "category": clean(re.sub(r"\d+$", "", d["id"]), 40) or "UK",
                                   "note": clean(note, MAX_NOTE)})
    pack = {"format": "hopline-labels", "version": 1, "name": NAME, "sanctions": True,
            "source": "UK Sanctions List (UK-Sanctions-List.xml%s), converted %s" % (", generated " + date if date else "", today),
            "licence": LICENCE, "attribution": ATTRIBUTION, "sourceUrl": PAGE}
    if iso_date(date):
        pack["asOf"] = iso_date(date)
    pack["created"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    pack["labels"] = labels
    info = {"date": date, "designations": len(designations), "read": len(labels), "skipped": skipped}
    return pack, info


def download(url=URL):
    req = urllib.request.Request(url, headers={"User-Agent": "hopline-build-packs"})
    with urllib.request.urlopen(req, timeout=180) as r:
        data = r.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ListError("The download is larger than expected; refusing it.")
    return data


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split(chr(10) * 2)[0])
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--file", help="path to UK-Sanctions-List.xml")
    src.add_argument("--download", action="store_true", help="download the list from the Foreign, Commonwealth & Development Office")
    ap.add_argument("--out", required=True, help="the label pack to write (.json)")
    a = ap.parse_args(argv)
    try:
        if a.download:
            try:
                data = download()
            except ListError:
                raise
            except Exception as e:                                           # noqa: BLE001 - any failure is reported the same way
                raise ListError("Could not download %s (%s). Download UK-Sanctions-List.xml yourself from %s and use --file." % (URL, e, PAGE))
        else:
            with open(a.file, "rb") as f:
                data = f.read(MAX_BYTES + 1)
        pack, info = convert(data)
    except (ListError, OSError) as e:
        sys.exit(str(e))
    if not pack["labels"]:
        sys.exit("No Bitcoin addresses found in the text of the %d designations." % info["designations"])
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(pack, f, indent=1)
    s = info["skipped"]
    print("Wrote %d Bitcoin addresses (from %d designations on the list generated %s; left out: %d failed the checksum, %d named as another coin, %d repeated) to %s"
          % (info["read"], info["designations"], info["date"] or "?", s["invalid"], s["otherCoin"], s["duplicate"], a.out))


if __name__ == "__main__":
    main()
