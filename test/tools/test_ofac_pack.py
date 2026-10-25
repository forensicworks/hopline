"""tools/make_label_pack_ofac.py: the OFAC list (SDN.XML) becomes a label pack that Hopline's importer accepts."""
import io
import json
import pathlib
import re
import subprocess
import sys
import zipfile
from xml.sax.saxutils import escape

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "tools" / "make_label_pack_ofac.py"
BECH = "bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h"      # real addresses with valid checksums
LEGACY = "325gSHHe7UGvzEc9kGx43VqPboXUVwa26i"
ETH = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"
NS = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/XML"


def valid_address(i):
    """The i-th of as many valid mainnet addresses (base58, version 0) as a test needs."""
    import hashlib
    raw = bytes([0]) + hashlib.sha256(b"hopline test address %d" % i).digest()[:20]
    raw += hashlib.sha256(hashlib.sha256(raw).digest()).digest()[:4]
    n, out = int.from_bytes(raw, "big"), ""
    while n:
        n, r = divmod(n, 58)
        out = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"[r] + out
    return "1" + out


def entry(uid, last, first=None, programs=(), ids=()):
    """One <sdnEntry> as the real file writes it. `ids` is a list of (idType, idNumber)."""
    x = "<sdnEntry><uid>%s</uid>" % uid
    if first:
        x += "<firstName>%s</firstName>" % escape(first)
    x += "<lastName>%s</lastName><sdnType>Entity</sdnType>" % escape(last)
    if programs:
        x += "<programList>" + "".join("<program>%s</program>" % p for p in programs) + "</programList>"
    if ids:
        x += "<idList>" + "".join("<id><uid>9%s</uid><idType>%s</idType><idNumber>%s</idNumber></id>" % (n, t, escape(v)) for n, (t, v) in enumerate(ids)) + "</idList>"
    return x + "</sdnEntry>"


def sdn_xml(entries, date="10/21/2026"):
    return ('<?xml version="1.0" standalone="yes"?><sdnList xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="%s">'
            '<publshInformation><Publish_Date>%s</Publish_Date><Record_Count>%d</Record_Count></publshInformation>%s</sdnList>' % (NS, date, len(entries), "".join(entries)))


ENTRIES = [
    entry(100, "EXAMPLE GROUP & SONS", programs=["CYBER2"], ids=[("Digital Currency Address - XBT", BECH), ("Digital Currency Address - XBT", LEGACY),
                                                                 ("Digital Currency Address - ETH", ETH), ("Email Address", "x@example.org")]),
    entry(200, "ETH ONLY LTD", programs=["SDGT"], ids=[("Digital Currency Address - ETH", ETH)]),
    entry(300, "NO ADDRESS INC", programs=["IRAN"]),
    entry(400, "SMITH", first="Jane", programs=["DPRK3", "CYBER2"], ids=[("Digital Currency Address - XBT", BECH)]),
]


def run(*args):
    return subprocess.run([sys.executable, "-I", str(SCRIPT), *args], capture_output=True, text=True, timeout=60)


def pack_from(tmp_path, data, name="SDN.XML"):
    src, out = tmp_path / name, tmp_path / "pack.json"
    src.write_bytes(data if isinstance(data, bytes) else data.encode("utf-8"))
    r = run("--sdn", str(src), "--out", str(out))
    return r, out


def test_bitcoin_addresses_become_labels_and_everything_else_is_left_out(tmp_path):
    r, out = pack_from(tmp_path, sdn_xml(ENTRIES))
    assert r.returncode == 0 and "Wrote 2 Bitcoin addresses (from 2 of the 4 entries on the list dated 10/21/2026)" in r.stdout, r.stderr
    pack = json.loads(out.read_text(encoding="utf-8"))
    assert pack["format"] == "hopline-labels" and pack["name"] == "OFAC SDN list (Bitcoin)"
    assert "SDN.XML, dated 10/21/2026" in pack["source"]
    by = {e["address"]: e for e in pack["labels"]}
    assert set(by) == {BECH, LEGACY}, "the Ethereum address, the email, the entries without a Bitcoin address are left out"
    assert by[LEGACY]["label"] == "OFAC SDN: EXAMPLE GROUP & SONS" and by[LEGACY]["category"] == "CYBER2"
    assert by[LEGACY]["url"] == "https://sanctionssearch.ofac.treas.gov/Details.aspx?id=100" and by[LEGACY]["note"] == "OFAC SDN entry 100; list dated 10/21/2026"


def test_an_address_listed_under_two_entries_keeps_both_names_programmes_and_ids(tmp_path):
    r, out = pack_from(tmp_path, sdn_xml(ENTRIES))
    e = {x["address"]: x for x in json.loads(out.read_text(encoding="utf-8"))["labels"]}[BECH]
    assert e["label"] == "OFAC SDN: EXAMPLE GROUP & SONS / SMITH, Jane", "an individual is written 'LAST, First'"
    assert e["category"] == "CYBER2, DPRK3" and e["note"].startswith("OFAC SDN entry 100, 400;") and e["url"].endswith("id=100")


def test_the_zipped_list_gives_the_same_result(tmp_path):
    xml = sdn_xml(ENTRIES).encode("utf-8")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("SDN.XML", xml)
    r, zipped = pack_from(tmp_path, buf.getvalue(), "SDN_XML.ZIP")
    assert r.returncode == 0, r.stderr
    other = tmp_path / "plain"; other.mkdir()
    r2, plain = pack_from(other, xml)
    a, b = json.loads(zipped.read_text(encoding="utf-8")), json.loads(plain.read_text(encoding="utf-8"))
    assert a["labels"] == b["labels"]


def test_several_programmes_become_a_short_readable_category():
    sys.path.insert(0, str(ROOT / "tools"))
    import make_label_pack_ofac as m
    assert m.category([]) == "" and m.category(["CYBER2"]) == "CYBER2"
    assert m.category(["DPRK3", "CYBER2"]) == "DPRK3, CYBER2"
    long = m.category(["ILLICIT-DRUGS-EO14059", "SDNTK", "SDNT", "CYBER2"])
    assert long == "ILLICIT-DRUGS-EO14059, SDNTK, SDNT" and len(long) <= 40, "cut at a programme, never in the middle of one"
    assert m.category(["A" * 60]) == "A" * 40


def test_an_address_mentioned_where_the_list_is_not_read_is_reported_but_the_pack_is_still_written(tmp_path):
    sneaky = entry(500, "HIDDEN GROUP", ids=[("Digital Currency Address - XBT", LEGACY)]).replace("<sdnType>", "<remarks>Digital Currency Address - XBT " + BECH + "</remarks><sdnType>")
    r, out = pack_from(tmp_path, sdn_xml([sneaky]))
    assert r.returncode == 0 and out.exists(), r.stderr
    assert "mentions 2 Bitcoin address entries but only 1 could be read" in r.stderr


def test_the_browser_converter_gives_exactly_the_same_pack(tmp_path):
    """public/js/hopline-ofac.js (what the workspace uses) and this tool must never drift apart."""
    r, out = pack_from(tmp_path, sdn_xml(ENTRIES))
    assert r.returncode == 0, r.stderr
    js = ("const O = require(process.argv[1]); const xml = require('fs').readFileSync(process.argv[2], 'utf8');"
          "const r = O.convertXml(xml, { today: '2000-01-01' }); const p = r.pack;"
          "console.log(JSON.stringify({ name: p.name, labels: p.labels, about: [p.licence, p.attribution, p.asOf, p.sourceUrl, p.sanctions] }));")
    n = subprocess.run(["node", "-e", js, str(ROOT / "public" / "js" / "hopline-ofac.js"), str(tmp_path / "SDN.XML")], capture_output=True, text=True, timeout=60)
    if n.returncode != 0 and "not found" in (n.stderr or "").lower():
        pytest.skip("node is not available")
    assert n.returncode == 0, n.stderr
    browser, tool = json.loads(n.stdout), json.loads(out.read_text(encoding="utf-8"))
    assert browser["name"] == tool["name"] and browser["labels"] == tool["labels"]
    assert browser["about"] == [tool["licence"], tool["attribution"], tool["asOf"], tool["sourceUrl"], tool["sanctions"]], "and says the same about where it came from"
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", tool["asOf"]) and tool["licence"].startswith("Public domain")


def test_hoplines_own_importer_accepts_the_result(tmp_path):
    r, out = pack_from(tmp_path, sdn_xml(ENTRIES)); assert r.returncode == 0
    js = "const L = require(process.argv[1]); const p = L.parse(require('fs').readFileSync(process.argv[2], 'utf8'), 'x'); console.log(JSON.stringify([p.name, p.entries.length, p.skipped, p.entries.map(e => e.url)]));"
    r = subprocess.run(["node", "-e", js, str(ROOT / "public" / "js" / "hopline-labels.js"), str(out)], capture_output=True, text=True, timeout=60)
    if r.returncode != 0 and "not found" in (r.stderr or "").lower():
        pytest.skip("node is not available")
    assert r.returncode == 0, r.stderr
    name, n, skipped, urls = json.loads(r.stdout)
    assert name == "OFAC SDN list (Bitcoin)" and n == 2 and sum(skipped.values()) == 0
    assert all(u.startswith("https://sanctionssearch.ofac.treas.gov/Details.aspx?id=") for u in urls), "links to the entry are kept"


def test_the_csv_is_refused_because_it_loses_addresses(tmp_path):
    r, out = pack_from(tmp_path, '"36","AEROCARIBBEAN AIRLINES",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- \n', "SDN.CSV")
    assert r.returncode != 0 and "SDN.CSV cannot be used" in r.stderr and "SDN_XML.ZIP" in r.stderr
    assert not out.exists()


def test_an_xml_file_that_is_not_an_sdn_list_is_refused_with_advice(tmp_path):
    r, out = pack_from(tmp_path, '<?xml version="1.0"?><Whatever xmlns="http://example.org"><DistinctParties/></Whatever>', "other.xml")
    assert r.returncode != 0 and "not an OFAC SDN list" in r.stderr and "top element is <Whatever>" in r.stderr and "SDN_XML.ZIP" in r.stderr
    assert not out.exists()


def test_a_file_with_entity_declarations_is_refused(tmp_path):
    bomb = '<?xml version="1.0"?><!DOCTYPE sdnList [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]><sdnList><sdnEntry><uid>1</uid><lastName>&b;</lastName></sdnEntry></sdnList>'
    r, out = pack_from(tmp_path, bomb)
    assert r.returncode != 0 and "DOCTYPE" in r.stderr and not out.exists()


def test_a_cut_off_or_broken_file_is_reported_and_nothing_is_written(tmp_path):
    r, out = pack_from(tmp_path, sdn_xml(ENTRIES)[:-400])
    assert r.returncode != 0 and "cut short" in r.stderr and not out.exists(), "it does not end where the list ends"
    r, out = pack_from(tmp_path, sdn_xml(ENTRIES).replace("<uid>200</uid>", "<uid>200</wrong>"))
    assert r.returncode != 0 and "not valid XML" in r.stderr and not out.exists(), "ends properly but is broken inside"
    r, out = pack_from(tmp_path, b"PK\x03\x04 not really a zip")
    assert r.returncode != 0 and "not a readable zip" in r.stderr and not out.exists()


def test_a_list_without_bitcoin_addresses_is_refused(tmp_path):
    r, out = pack_from(tmp_path, sdn_xml([ENTRIES[1], ENTRIES[2]]))
    assert r.returncode != 0 and "No Bitcoin addresses found" in r.stderr and not out.exists()


def test_a_failed_download_says_what_to_do_and_writes_nothing(tmp_path):
    r = run("--download", "--url", "http://127.0.0.1:9/SDN_XML.ZIP", "--out", str(tmp_path / "x.json"))
    assert r.returncode != 0 and "Download SDN.XML or SDN_XML.ZIP yourself" in r.stderr and "sanctionslist.ofac.treas.gov" in r.stderr
    assert not (tmp_path / "x.json").exists()


# ---- the enhanced and advanced layouts: the same list, read from the shared fixtures in test/fixtures/ofac -----------------

FX = ROOT / "test" / "fixtures" / "ofac"
LAYOUTS = ("legacy", "enhanced", "advanced")
PAYER = "1opFYNKYG21CfzMYgCZBDoeBpQ9vhVUC9"


def fixture_pack(tmp_path, name, text=None):
    src = tmp_path / ("sdn_" + name + ".xml")
    src.write_text(text if text is not None else (FX / ("sdn_" + name + ".xml")).read_text(encoding="utf-8"), encoding="utf-8")
    out = tmp_path / (name + ".json")
    r = run("--sdn", str(src), "--out", str(out))
    return r, out


@pytest.mark.parametrize("layout", LAYOUTS)
def test_each_layout_gives_the_same_pack(tmp_path, layout):
    r, out = fixture_pack(tmp_path, layout)
    assert r.returncode == 0 and "Wrote 3 Bitcoin addresses (from 3 of the 5 entries on the list dated 10/21/2026)" in r.stdout and not r.stderr, r.stderr
    got = json.loads(out.read_text(encoding="utf-8"))
    ref_dir = tmp_path / "ref"; ref_dir.mkdir()
    _, ref = fixture_pack(ref_dir, "legacy")
    assert got["labels"] == json.loads(ref.read_text(encoding="utf-8"))["labels"], "identical to the legacy layout's pack"
    by = {e["address"]: e for e in got["labels"]}
    assert by[BECH]["label"] == "OFAC SDN: EXAMPLE GROUP & SONS / SMITH, Jane" and by[BECH]["category"] == "CYBER2, DPRK3" and by[BECH]["note"] == "OFAC SDN entry 100, 400; list dated 10/21/2026"
    assert by[PAYER]["label"] == "OFAC SDN: DOE, John Michael" and "NOT THE NAME" not in json.dumps(got) and "ALIAS" not in json.dumps(got)
    assert {"legacy": "SDN.XML", "enhanced": "SDN_ENHANCED.XML", "advanced": "SDN_ADVANCED.XML"}[layout] + ", dated 10/21/2026" in got["source"]


@pytest.mark.parametrize("layout", LAYOUTS)
def test_the_browser_converter_gives_the_same_pack_for_each_layout(tmp_path, layout):
    """public/js/hopline-ofac.js (what the workspace uses) and this tool must never drift apart."""
    r, out = fixture_pack(tmp_path, layout)
    assert r.returncode == 0, r.stderr
    js = ("const O = require(process.argv[1]); const xml = require('fs').readFileSync(process.argv[2], 'utf8');"
          "const r = O.convertXml(xml, { today: '2000-01-01' }); const p = r.pack;"
          "console.log(JSON.stringify({ name: p.name, labels: p.labels, about: [p.licence, p.attribution, p.asOf, p.sourceUrl, p.sanctions] }));")
    n = subprocess.run(["node", "-e", js, str(ROOT / "public" / "js" / "hopline-ofac.js"), str(tmp_path / ("sdn_" + layout + ".xml"))], capture_output=True, text=True, timeout=60)
    if n.returncode != 0 and "not found" in (n.stderr or "").lower():
        pytest.skip("node is not available")
    assert n.returncode == 0, n.stderr
    browser, tool = json.loads(n.stdout), json.loads(out.read_text(encoding="utf-8"))
    assert browser["name"] == tool["name"] and browser["labels"] == tool["labels"]
    assert browser["about"] == [tool["licence"], tool["attribution"], tool["asOf"], tool["sourceUrl"], tool["sanctions"]], "and says the same about where it came from"
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", tool["asOf"]) and tool["licence"].startswith("Public domain")


@pytest.mark.parametrize("layout,tag", [("enhanced", "value"), ("advanced", "VersionDetail")])
def test_an_address_the_reading_missed_is_reported_in_every_layout(tmp_path, layout, tag):
    text = (FX / ("sdn_" + layout + ".xml")).read_text(encoding="utf-8")
    opening = "<value>" if tag == "value" else '<VersionDetail DetailTypeID="1432">'
    assert text.count(opening + PAYER) == 1
    r, out = fixture_pack(tmp_path, layout, text.replace(opening + PAYER, opening))
    assert r.returncode == 0 and out.exists()
    assert "mentions 4 Bitcoin address entries but only 3 could be read" in r.stderr


@pytest.mark.parametrize("layout", ("enhanced", "advanced"))
def test_a_cut_off_or_hostile_file_is_refused_in_every_layout(tmp_path, layout):
    text = (FX / ("sdn_" + layout + ".xml")).read_text(encoding="utf-8")
    r, out = fixture_pack(tmp_path, layout, text[:-200])
    assert r.returncode != 0 and "cut short" in r.stderr and not out.exists()
    r, out = fixture_pack(tmp_path, layout, text.replace("?>", '?><!DOCTYPE x [<!ENTITY a "b">]>', 1))
    assert r.returncode != 0 and "DOCTYPE" in r.stderr and not out.exists()


def test_the_zipped_enhanced_and_advanced_lists_work_too(tmp_path):
    for layout in ("enhanced", "advanced"):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("SDN_" + layout.upper() + ".XML", (FX / ("sdn_" + layout + ".xml")).read_bytes())
        r, out = pack_from(tmp_path, buf.getvalue(), "SDN_" + layout.upper() + ".ZIP")
        assert r.returncode == 0 and "Wrote 3 Bitcoin addresses" in r.stdout, r.stderr
