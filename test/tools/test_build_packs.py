"""tools/build_packs.py: the OFAC list becomes the pack file and the list entry that the pages read from public/packs/."""
import hashlib
import json
import pathlib
import re
import subprocess
import sys

import pytest

from test_ofac_pack import BECH, ENTRIES, LEGACY, entry, sdn_xml, valid_address

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "tools" / "build_packs.py"


def run(tmp_path, *args):
    return subprocess.run([sys.executable, "-I", str(SCRIPT), "--out", str(tmp_path / "packs"), *args], capture_output=True, text=True, timeout=60)


def build(tmp_path, entries=ENTRIES, date="10/21/2026", *extra):
    src = tmp_path / "SDN.XML"
    src.write_bytes(sdn_xml(entries, date).encode("utf-8"))
    return run(tmp_path, "--ofac", str(src), *extra)


def index_of(tmp_path):
    text = (tmp_path / "packs" / "index.js").read_text(encoding="utf-8")
    return json.loads(re.search(r"window\.HOPLINE_PACK_INDEX = (\[.*\]);", text, re.S).group(1))


def pack_of(tmp_path, pack_id="ofac-sdn"):
    text = (tmp_path / "packs" / (pack_id + ".js")).read_text(encoding="utf-8")
    return text, json.loads(re.search(r'\] = (\{.*\});\n$', text, re.S).group(1))


def test_the_pack_and_its_list_entry_are_written_with_where_the_data_came_from(tmp_path):
    r = build(tmp_path)
    assert r.returncode == 0 and "OFAC SDN list (Bitcoin): 2 wallets, as of 2026-10-21, written" in r.stdout, r.stderr
    (e,) = index_of(tmp_path)
    assert (e["id"], e["file"], e["entries"], e["asOf"], e["sanctions"], e["defaultOn"]) == ("ofac-sdn", "ofac-sdn.js", 2, "2026-10-21", True, True)
    assert e["licence"].startswith("Public domain") and "OFAC" in e["attribution"] and e["sourceUrl"] == "https://sanctionslist.ofac.treas.gov/Home/SdnList"
    text, pack = pack_of(tmp_path)
    assert e["version"] == hashlib.sha256(text.encode("utf-8")).hexdigest()[:10], "the version is the file's hash"
    assert pack["format"] == "hopline-labels" and pack["sanctions"] is True and pack["asOf"] == "2026-10-21" and {x["address"] for x in pack["labels"]} == {BECH, LEGACY}


def test_one_wallet_per_line_sorted_and_nothing_that_changes_without_the_list_changing(tmp_path):
    build(tmp_path)
    text, pack = pack_of(tmp_path)
    lines = [ln for ln in text.splitlines() if ln.startswith('{"address"')]
    assert len(lines) == 2 and [json.loads(ln.rstrip(","))["address"] for ln in lines] == sorted([BECH, LEGACY])
    assert "created" not in pack and "converted" not in pack["source"], "no time of conversion"
    assert all("list dated" not in x["note"] for x in pack["labels"]), "the date is stated once, on the pack"
    again = build(tmp_path)
    assert "unchanged" in again.stdout, "the same list gives the same files"


def test_a_new_list_changes_the_file_and_the_version_but_not_the_other_entries_of_the_list(tmp_path):
    build(tmp_path)
    packs = tmp_path / "packs"
    idx = (packs / "index.js").read_text(encoding="utf-8")
    other = {"id": "other", "name": "Other", "file": "other.js", "entries": 1, "source": "", "licence": "L", "attribution": "A", "asOf": "2026-01-01", "sourceUrl": "", "sanctions": False, "defaultOn": False, "version": "abc"}
    (packs / "index.js").write_text(idx.replace("\n];\n", ",\n" + json.dumps(other, separators=(",", ":")) + "\n];\n"), encoding="utf-8")
    before = index_of(tmp_path)[0]["version"]
    r = build(tmp_path, ENTRIES + [entry(500, "NEW GROUP", programs=["CYBER2"], ids=[("Digital Currency Address - XBT", "1BoatSLRHtKNngkdXEeobR76b53LETtpyT")])], "10/28/2026")
    assert r.returncode == 0 and "3 wallets, as of 2026-10-28, written" in r.stdout, r.stderr
    idx2 = index_of(tmp_path)
    assert [e["id"] for e in idx2] == ["ofac-sdn", "other"] and idx2[1] == other, "the entry of another pack stays as it was"
    assert idx2[0]["entries"] == 3 and idx2[0]["version"] != before


def test_a_list_that_shrinks_a_lot_is_refused_unless_forced(tmp_path):
    many = [entry(1000 + i, "GROUP %d" % i, ids=[("Digital Currency Address - XBT", valid_address(i))]) for i in range(25)]
    assert build(tmp_path, many).returncode == 0
    before = (tmp_path / "packs" / "ofac-sdn.js").read_text(encoding="utf-8")
    r = build(tmp_path, many[:2])
    assert r.returncode != 0 and "would shrink from 25 to 2" in r.stderr
    assert (tmp_path / "packs" / "ofac-sdn.js").read_text(encoding="utf-8") == before, "nothing was changed"
    assert build(tmp_path, many[:2], "10/21/2026", "--force").returncode == 0 and index_of(tmp_path)[0]["entries"] == 2


def test_a_short_list_may_lose_a_wallet_without_that_being_a_mistake(tmp_path):
    many = [entry(1000 + i, "GROUP %d" % i, ids=[("Digital Currency Address - XBT", valid_address(i))]) for i in range(5)]
    assert build(tmp_path, many).returncode == 0
    assert build(tmp_path, many[:3]).returncode == 0 and index_of(tmp_path)[0]["entries"] == 3, "a delisting"


def test_a_list_it_cannot_read_completely_is_not_written(tmp_path):
    sneaky = entry(500, "HIDDEN GROUP", ids=[("Digital Currency Address - XBT", LEGACY)]).replace("<sdnType>", "<remarks>Digital Currency Address - XBT " + BECH + "</remarks><sdnType>")
    r = build(tmp_path, [sneaky])
    assert r.returncode != 0 and "Not written" in r.stderr and not (tmp_path / "packs").exists()
    bad = tmp_path / "other.xml"; bad.write_text("<html></html>", encoding="utf-8")
    r2 = run(tmp_path, "--ofac", str(bad))
    assert r2.returncode != 0 and "not an OFAC SDN list" in r2.stderr and not (tmp_path / "packs").exists()
    r3 = run(tmp_path, "--ofac", str(tmp_path / "missing.zip"))
    assert r3.returncode != 0 and "Could not read the OFAC list" in r3.stderr


def test_a_list_file_that_is_not_one_this_tool_wrote_is_not_overwritten(tmp_path):
    (tmp_path / "packs").mkdir()
    (tmp_path / "packs" / "index.js").write_text("window.something = 1;\n", encoding="utf-8")
    r = build(tmp_path)
    assert r.returncode != 0 and "not a pack list this script wrote" in r.stderr
    assert (tmp_path / "packs" / "index.js").read_text(encoding="utf-8") == "window.something = 1;\n"


@pytest.mark.skipif(__import__("shutil").which("node") is None, reason="node is not available")
def test_the_page_side_code_accepts_what_this_tool_writes(tmp_path):
    build(tmp_path)
    js = ("global.window = global; const L = require(process.argv[1]), P = require(process.argv[2]); const d = process.argv[3];"
          "require(d + '/index.js'); require(d + '/ofac-sdn.js');"
          "const idx = P.cleanIndex(window.HOPLINE_PACK_INDEX), r = L.fromObject(window.HOPLINE_PACKS['ofac-sdn'], idx[0].name);"
          "console.log(JSON.stringify([idx.length, r.entries.length, r.sanctions, r.asOf, r.licence.startsWith('Public domain')]));")
    n = subprocess.run(["node", "-e", js, str(ROOT / "public" / "js" / "hopline-labels.js"), str(ROOT / "public" / "js" / "hopline-packs.js"), str(tmp_path / "packs")], capture_output=True, text=True, timeout=60)
    assert n.returncode == 0, n.stderr
    assert json.loads(n.stdout) == [1, 2, True, "2026-10-21", True]
