"""The nodes CSV and the GraphML file say which names come from a public list (with the list, its licence and the date of its data) and which are the analyst's own label, tag and note."""
import csv
import io
import json
import xml.etree.ElementTree as ET

import pytest

from conftest import NORMAL
from helpers import open_query, settle
from test_label_packs import BIG_ADDR, SMALL_ADDR, load_file

NS = "{http://graphml.graphdrawing.org/xmlns}"
PACK = {"format": "hopline-labels", "name": "Test ransomware list", "licence": "CC BY 4.0", "attribution": "A. Researcher", "asOf": "2026-10-28",
        "sourceUrl": "https://example.org/list", "labels": [{"address": SMALL_ADDR, "label": "Ransomware: TestGroup", "category": "RANSOM", "url": "https://example.org/e/1", "note": "3 payments"},
                                                                 {"address": BIG_ADDR, "label": "Listed here too", "category": "RANSOM"}]}


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def setup(fpage):
    open_query(fpage, NORMAL["txid"]); fpage.uncheck("#focusOn"); settle(fpage)
    load_file(fpage, "list.json", json.dumps(PACK), "application/json")
    fpage.evaluate("(a) => { const n = window.__hopline.state.graph.nodes.get('addr:' + a); n.label = 'My suspect'; n.note = 'my hypothesis'; n.tag = 'RANSOM'; }", SMALL_ADDR)


def download(fpage, kind, tmp_path):
    fpage.click("#exportMenu summary")
    with fpage.expect_download() as dl:
        fpage.click("[data-export=%s]" % kind)
    p = tmp_path / ("export." + ("graphml" if kind == "graphml" else "csv")); dl.value.save_as(p)
    return p.read_text(encoding="utf-8-sig")


def test_the_nodes_csv_keeps_the_list_apart_from_your_label_note_and_tag(fpage, tmp_path):
    setup(fpage)
    rows = list(csv.reader(io.StringIO(download(fpage, "csv-nodes", tmp_path))))
    c = rows[0].index
    r = [x for x in rows[1:] if x[0] == "addr:" + SMALL_ADDR][0]
    assert r[c("label")] == "My suspect" and r[c("note")] == "my hypothesis" and r[c("tag")] == "RANSOM", "yours, where they were"
    assert r[c("src_pack")] == "Test ransomware list" and r[c("src_label")] == "Ransomware: TestGroup" and r[c("src_category")] == "RANSOM"
    assert r[c("src_licence")] == "CC BY 4.0" and r[c("src_attribution")] == "A. Researcher" and r[c("src_as_of")] == "2026-10-28"
    assert r[c("src_url")] == "https://example.org/e/1" and r[c("src_note")] == "3 payments" and r[c("src_count")] == "1" and r[c("src_sanctions")] == ""
    assert "My suspect" not in r[c("src_all")] and "my hypothesis" not in r[c("src_all")], "your own words are never in the list's columns"
    both = [x for x in rows[1:] if x[0] == "addr:" + BIG_ADDR][0]
    assert both[c("src_pack")] == "Built-in list" and both[c("src_count")] == "2", "the built-in list comes first, as in the app"
    assert "Test ransomware list: Listed here too [RANSOM; data as of 2026-10-28; licence: CC BY 4.0]" in both[c("src_all")], both[c("src_all")]
    unnamed = [x for x in rows[1:] if x[1] == "tx"][0]
    assert unnamed[c("src_pack")] == "" and unnamed[c("src_count")] == "", "a transaction names no list"


def test_the_graphml_says_what_it_is_made_of_and_who_said_what(fpage, tmp_path):
    setup(fpage)
    root = ET.fromstring(download(fpage, "graphml", tmp_path))
    keys = {k.get("id"): k.get("attr.name") for k in root.iter(NS + "key")}
    graph = root.find(NS + "graph")
    g = {keys[d.get("key")]: d.text for d in graph.findall(NS + "data")}
    assert g["exported_utc"][:2] == "20" and g["generator"].startswith("Hopline workspace") and g["data_source"].startswith("http")
    assert "Built-in list" in g["sources_used"] and "Test ransomware list - " in g["sources_used"] and "licence: CC BY 4.0" in g["sources_used"] and "data as of 2026-10-28" in g["sources_used"] and "https://example.org/list" in g["sources_used"]
    assert "ANALYST" in g["field_groups"] and "src_* and ext_*" in g["field_groups"] and "HOPLINE INFERENCE" in g["field_groups"]
    node = [n for n in graph.findall(NS + "node") if n.get("id") == "addr:" + SMALL_ADDR][0]
    d = {keys[x.get("key")]: x.text for x in node.findall(NS + "data")}
    assert d["label"] == "My suspect" and d["note"] == "my hypothesis" and d["tag"] == "RANSOM"
    assert d["src_pack"] == "Test ransomware list" and d["src_label"] == "Ransomware: TestGroup" and d["src_as_of"] == "2026-10-28" and d["src_licence"] == "CC BY 4.0"
    assert d["src_count"] == "1" and "src_sanctions" not in d


def test_an_export_of_a_part_lists_only_the_sources_of_what_is_in_it(fpage, tmp_path):
    setup(fpage)
    fpage.check("#exportVisible") if fpage.is_visible("#exportVisible") else None
    root = ET.fromstring(download(fpage, "graphml", tmp_path))
    keys = {k.get("id"): k.get("attr.name") for k in root.iter(NS + "key")}
    g = {keys[d.get("key")]: d.text for d in root.find(NS + "graph").findall(NS + "data")}
    assert "sources_used" in g, "the list names a wallet that is in the file"
