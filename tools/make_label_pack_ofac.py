#!/usr/bin/env python3
"""Turn the U.S. Treasury OFAC "SDN" sanctions list into a Hopline label pack of Bitcoin addresses.

OFAC publishes the list as XML. Every sanctioned person or organisation has an entry, and among its details are the
digital-currency addresses attributed to it ("Digital Currency Address - XBT"). This script keeps the Bitcoin (XBT) ones,
labels each "OFAC SDN: <name>", gives the sanctions programmes as the category and a link to OFAC's page for the entry, and
writes a file that Hopline's "Label packs > Import labels" reads. (The workspace itself reads the same files directly; this
tool makes the identical pack from the command line.)

    python tools/make_label_pack_ofac.py --download --out ofac-sdn.hopline-labels.json
    python tools/make_label_pack_ofac.py --sdn SDN_XML.ZIP --out ofac-sdn.hopline-labels.json

--sdn takes any of the three XML versions, zipped or not (they hold the same addresses): SDN.XML / SDN_XML.ZIP (the legacy
layout, 30 MB unzipped: the lightest), SDN_ENHANCED.XML / SDN_ENHANCED.ZIP and SDN_ADVANCED.XML / SDN_ADVANCED.ZIP. --download
fetches SDN_XML.ZIP (about 2.5 MB) from OFAC's Sanctions List Service. By hand: open
https://sanctionslist.ofac.treas.gov/Home/SdnList (Data Center - SDN List), download a file and give it to --sdn.
Do NOT use SDN.CSV: it cuts every entry's remarks at 1000 characters, so it loses addresses (in October 2026 it held about
half of the Bitcoin addresses, plus two cut-off fragments). Nothing else is fetched, and the result is a plain file you can
read before importing it. The list changes whenever OFAC acts: make a new pack when you need the current one (importing a
pack with the same name replaces the old one).

A sanctions listing is a claim by a government, not a finding of yours: Hopline shows it as "known (pack name)".
"""
import argparse
import datetime
import io
import json
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from collections import OrderedDict

DEFAULT_URL = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN_XML.ZIP"
PAGE = "https://sanctionslist.ofac.treas.gov/Home/SdnList"
ENTRY_PAGE = "https://sanctionssearch.ofac.treas.gov/Details.aspx?id="          # OFAC's page for one entry, by its uid
ID_TYPES = ("Digital Currency Address - XBT", "Digital Currency Address - BTC")   # OFAC writes XBT
MAX_BYTES = 400_000_000                                                          # the biggest real file is about 130 MB


class ListError(Exception):
    """The file is not something this script can read; the message says what to do."""


def clean(s):
    return re.sub(r"\s+", " ", (s or "").strip())


def local(tag):
    return tag.rpartition("}")[2]


def kids(elem, name):
    return [c for c in elem if local(c.tag) == name] if elem is not None else []


def kid(elem, name):
    k = kids(elem, name)
    return k[0] if k else None


def kid_text(elem, name):
    c = kid(elem, name)
    return clean(c.text) if c is not None else ""


def first_where(items, test):
    for i in items:
        if test(i):
            return i
    return items[0] if items else None


def category(programs, limit=40):
    """The programmes as one short text ("DPRK3, CYBER2"), shortened at a programme boundary when it would not fit."""
    out = ""
    for p in programs:
        nxt = p if not out else out + ", " + p
        if len(nxt) > limit:
            return out or p[:limit]
        out = nxt
    return out


def xml_bytes(data):
    """The XML bytes from what was given: the XML itself or the zip that holds it. Anything else is refused with advice."""
    if data[:2] == b"PK":
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                names = [i for i in z.infolist() if i.filename.upper().endswith(".XML")]
                if len(names) != 1:
                    raise ListError("The zip has %d XML files; expected one." % len(names))
                if names[0].file_size > MAX_BYTES:
                    raise ListError("The XML inside the zip is larger than expected (%d bytes); refusing it." % names[0].file_size)
                return z.read(names[0])                                           # read into memory; nothing is extracted to disk
        except zipfile.BadZipFile:
            raise ListError("That is not a readable zip file.")
    if data.lstrip()[:1] == b"<":
        return data
    raise ListError("That is not an XML list. SDN.CSV cannot be used: it cuts long remarks and loses addresses. "
                    "Download SDN_XML.ZIP, SDN_ENHANCED.ZIP or SDN_ADVANCED.ZIP from %s." % PAGE)


def events(data):
    """(element, depth) at the end of every element. Sections directly under the top element are released once read, so the
    memory used stays small on the 130 MB files."""
    depth = 0
    try:
        for ev, el in ET.iterparse(io.BytesIO(data), events=("start", "end")):
            if ev == "start":
                depth += 1
                continue
            yield el, depth
            if depth == 2:
                el.clear()
            depth -= 1
    except ET.ParseError as e:
        raise ListError("The file is not valid XML (%s): it may be cut short, or it is not the SDN list." % e)


def count(data, what):
    return data.count(what.encode("ascii"))


# ---- the three layouts: each gives (date, entries, expected, records); a record is (uid, who, programs, address) ------------

def read_legacy(data):
    date, entries, records = "", 0, []
    for el, _ in events(data):
        n = local(el.tag)
        if n == "Publish_Date":
            date = clean(el.text)
        elif n == "sdnEntry":
            entries += 1
            uid, last, first = kid_text(el, "uid"), kid_text(el, "lastName"), kid_text(el, "firstName")
            who = last + ", " + first if last and first else last or first
            programs = [clean(p.text) for p in kids(kid(el, "programList"), "program") if clean(p.text)]
            for i in kids(kid(el, "idList"), "id"):
                if kid_text(i, "idType") in ID_TYPES and kid_text(i, "idNumber"):
                    records.append((uid, who, programs, kid_text(i, "idNumber")))
            el.clear()
    expected = sum(count(data, t) for t in ID_TYPES)                              # every mention, wherever it is
    return date, entries, expected, records


def read_enhanced(data):
    date, records = "", []
    for el, _ in events(data):
        n = local(el.tag)
        if n == "dataAsOf":
            m = re.match(r"(\d{4})-(\d{2})-(\d{2})", clean(el.text))
            date = "%s/%s/%s" % (m.group(2), m.group(3), m.group(1)) if m else ""
        elif n == "entity":
            feats = [f for f in kids(kid(el, "features"), "feature") if clean((kid(f, "type").text if kid(f, "type") is not None else "")) in ID_TYPES and kid_text(f, "value")]
            if feats:
                nm = first_where(kids(kid(el, "names"), "name"), lambda x: kid_text(x, "isPrimary") == "true")
                tr = first_where(kids(kid(nm, "translations"), "translation"), lambda x: kid_text(x, "isPrimary") == "true")
                who = kid_text(tr, "formattedFullName")
                if not who:
                    last, first = kid_text(tr, "formattedLastName"), kid_text(tr, "formattedFirstName")
                    who = last + ", " + first if last and first else last or first
                programs = [clean(p.text) for p in kids(kid(el, "sanctionsPrograms"), "sanctionsProgram") if clean(p.text)]
                for f in feats:
                    records.append((el.get("id") or "", who, programs, kid_text(f, "value")))
            el.clear()
    mentions = sum(count(data, t) for t in ID_TYPES)
    definitions = sum(len(re.findall(rb"<type>\s*" + re.escape(t.encode("ascii")) + rb"\s*</type>", data)) for t in ID_TYPES)
    return date, count(data, "<entity "), mentions - definitions, records          # all mentions except the definition of the type


def read_advanced(data):
    date, records, ft_ids, name_types, needed = "", [], set(), {}, {}
    for el, _ in events(data):
        n = local(el.tag)
        if n == "FeatureType":
            if clean(el.text) in ID_TYPES:
                ft_ids.add(el.get("ID"))
        elif n == "NamePartType":
            name_types[el.get("ID")] = clean(el.text)
        elif n == "DateOfIssue":
            date = "%02d/%02d/%s" % (int(kid_text(el, "Month") or 0), int(kid_text(el, "Day") or 0), kid_text(el, "Year"))
        elif n == "Profile":
            feats = [f for f in kids(el, "Feature") if f.get("FeatureTypeID") in ft_ids]
            if feats:
                ident = first_where(kids(el, "Identity"), lambda i: i.get("Primary") == "true")
                groups = {}
                for g in kids(kid(ident, "NamePartGroups"), "MasterNamePartGroup"):
                    ng = kid(g, "NamePartGroup")
                    if ng is not None:
                        groups[ng.get("ID")] = ng.get("NamePartTypeID")
                alias = first_where(kids(ident, "Alias"), lambda a: a.get("Primary") == "true")
                dn = first_where(kids(alias, "DocumentedName"), lambda d: d.get("DocNameStatusID") == "1")
                last_parts, rest = [], []
                for part in kids(dn, "DocumentedNamePart"):
                    v = kid(part, "NamePartValue")
                    t = clean(v.text) if v is not None else ""
                    kind = name_types.get(groups.get(v.get("NamePartGroupID"))) if v is not None else ""
                    if not t:
                        continue
                    if kind == "Last Name":
                        last_parts.append(t.upper())
                    else:
                        rest.append(t.upper() if kind == "Entity Name" else t)   # OFAC writes surnames and organisation names in capitals in the other two layouts
                who = " ".join(last_parts) + (", " + " ".join(rest) if rest else "") if last_parts else " ".join(rest)
                for f in feats:
                    addr = clean(kid(kid(f, "FeatureVersion"), "VersionDetail").text) if kid(kid(f, "FeatureVersion"), "VersionDetail") is not None else ""
                    if addr:
                        records.append([el.get("ID") or "", who, [], addr])
                        needed[el.get("ID") or ""] = []
            el.clear()
        elif n == "SanctionsEntry":
            pid = el.get("ProfileID")
            if pid in needed:                                                       # the "Program" measures (type 1) name the programmes
                for m in kids(el, "SanctionsMeasure"):
                    name = kid_text(m, "Comment")
                    if m.get("SanctionsTypeID") == "1" and name and name not in needed[pid]:
                        needed[pid].append(name)
            el.clear()
    for r in records:
        r[2] = needed.get(r[0], [])
    expected = sum(count(data, 'FeatureTypeID="%s"' % i) for i in ft_ids)
    return date, count(data, "<DistinctParty "), expected, [tuple(r) for r in records]


LAYOUTS = {"sdnList": (read_legacy, b"</sdnList>", "SDN.XML"),
           "sanctionsData": (read_enhanced, b"</sanctionsData>", "SDN_ENHANCED.XML"),
           "Sanctions": (read_advanced, b"</Sanctions>", "SDN_ADVANCED.XML")}


def convert(data, today=None):
    """(pack, info) for the Bitcoin addresses in an SDN XML file (any of the three layouts, or the zip that holds it). `pack` is the
    label pack as a dict; `info` says what was read: layout, the list's publish date, entries on the list, entries with a Bitcoin
    address, address entries read, address entries expected, and a warning when those two differ."""
    today = today or datetime.date.today().isoformat()
    data = xml_bytes(data)
    if b"<!DOCTYPE" in data or b"<!ENTITY" in data:
        raise ListError("The file declares a DOCTYPE or entities, which the real list does not; refusing to read it.")
    head = re.sub(rb"<\?.*?\?>|<!--.*?-->", b"", data[:6000], flags=re.S)
    top = re.search(rb"<([A-Za-z_][\w.:-]*)[\s>/]", head)
    name = local(top.group(1).decode("ascii")) if top else ""
    if name not in LAYOUTS:
        raise ListError("This is not an OFAC SDN list (the top element is <%s>). Download SDN_XML.ZIP, SDN_ENHANCED.ZIP or SDN_ADVANCED.ZIP from %s."
                        % (top.group(1).decode("ascii", "replace") if top else "?", PAGE))
    reader, end, file = LAYOUTS[name]
    if data.rstrip()[-len(end):] != end:
        raise ListError("The file is cut short: it does not end where the list ends.")
    date, entries, expected, records = reader(data)
    found = OrderedDict()
    for uid, who, programs, address in records:
        rec = found.setdefault(address, {"uids": [], "names": [], "programs": []})
        if re.fullmatch(r"\d{1,12}", uid) and uid not in rec["uids"]:
            rec["uids"].append(uid)
        if who and who not in rec["names"]:
            rec["names"].append(who)
        for p in programs:
            if p not in rec["programs"]:
                rec["programs"].append(p)
    labels = []
    for address, rec in found.items():
        names = rec["names"]
        label = "OFAC SDN: " + " / ".join(names[:3]) + (" (+%d more)" % (len(names) - 3) if len(names) > 3 else "") if names else "OFAC SDN"
        entry = {"address": address, "label": label, "url": ENTRY_PAGE + rec["uids"][0] if rec["uids"] else PAGE}
        if category(rec["programs"]):
            entry["category"] = category(rec["programs"])
        entry["note"] = ("OFAC SDN entry " + ", ".join(rec["uids"]) if rec["uids"] else "OFAC SDN") + ("; list dated " + date if date else "")
        labels.append(entry)
    pack = {"format": "hopline-labels", "version": 1, "name": "OFAC SDN list (Bitcoin)", "sanctions": True,
            "source": "U.S. Treasury OFAC SDN list (" + file + (", dated " + date if date else "") + "), converted " + today,
            "created": datetime.datetime.now(datetime.timezone.utc).isoformat(), "labels": labels}
    info = {"layout": name, "date": date, "entries": entries, "with_address": len({r[0] for r in records}), "read": len(records), "expected": expected, "warning": ""}
    if len(records) != expected:
        info["warning"] = ("The file mentions %d Bitcoin address entries but only %d could be read: the list may have a layout this script does not know, "
                           "so the pack may be incomplete." % (expected, len(records)))
    return pack, info


def download(url):
    with urllib.request.urlopen(url, timeout=120) as r:
        data = r.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ListError("The download is larger than expected; refusing it.")
    return data


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--sdn", help="path to a downloaded SDN list: SDN.XML, SDN_XML.ZIP, SDN_ENHANCED.(XML|ZIP) or SDN_ADVANCED.(XML|ZIP)")
    src.add_argument("--download", action="store_true", help="download SDN_XML.ZIP first")
    ap.add_argument("--url", default=DEFAULT_URL, help="where --download fetches from (default: %(default)s)")
    ap.add_argument("--out", required=True, help="the label pack to write (.json)")
    a = ap.parse_args(argv)
    try:
        if a.download:
            try:
                data = download(a.url)
            except ListError:
                raise
            except Exception as e:                                           # noqa: BLE001 - any failure is reported the same way
                raise ListError("Could not download %s (%s). Download SDN.XML or SDN_XML.ZIP yourself from %s and use --sdn." % (a.url, e, PAGE))
        else:
            with open(a.sdn, "rb") as f:
                data = f.read(MAX_BYTES + 1)
        pack, info = convert(data)
    except (ListError, OSError) as e:
        sys.exit(str(e))
    if not pack["labels"]:
        sys.exit("No Bitcoin addresses found: is this the SDN list?")
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(pack, f, indent=1)
    print("Wrote %d Bitcoin addresses (from %d of the %d entries on the list dated %s) to %s" % (len(pack["labels"]), info["with_address"], info["entries"], info["date"] or "?", a.out))
    if info["warning"]:
        print("Warning: " + info["warning"], file=sys.stderr)


if __name__ == "__main__":
    main()
