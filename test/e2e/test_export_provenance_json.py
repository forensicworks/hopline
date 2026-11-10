"""The JSON workspace file keeps what public lists say about a wallet (the list, its licence, who to credit and the date of its data) apart from the analyst's own label, tag and note, on both pages."""
import json

import pytest

from conftest import ADDRESS
from test_export_sources import PACK, setup
from test_wallet_export import save
from test_wallet_page import KNOWN_BUILTIN, goto, wpage  # noqa: F401  (the fixture is used by name)
from test_label_packs import BIG_ADDR, SMALL_ADDR


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def workspace_json(fpage, tmp_path):
    fpage.click("#exportMenu summary")
    with fpage.expect_download() as dl:
        fpage.click("[data-export=json]")
    p = tmp_path / "export.json"; dl.value.save_as(p)
    return json.loads(p.read_text(encoding="utf-8"))


def test_the_workspace_file_has_a_provenance_block_with_the_lists_and_what_each_says_about_a_wallet(fpage, tmp_path):
    setup(fpage)
    d = workspace_json(fpage, tmp_path)
    p = d["provenance"]
    assert p["generator"].startswith("Hopline workspace") and "ANALYST" in p["about"] and "provenance.wallets" in p["about"]
    lists = {l["list"]: l for l in p["lists"]}
    assert set(lists) == {"Built-in list", "Test ransomware list"}, "only the lists that name a wallet in the file"
    t = lists["Test ransomware list"]
    assert (t["licence"], t["attribution"], t["asOf"], t["sourceUrl"]) == ("CC BY 4.0", "A. Researcher", "2026-10-28", "https://example.org/list")
    claim = p["wallets"][SMALL_ADDR][0]
    assert (claim["list"], claim["label"], claim["category"], claim["licence"], claim["asOf"], claim["url"], claim["note"]) == (
        "Test ransomware list", "Ransomware: TestGroup", "RANSOM", "CC BY 4.0", "2026-10-28", "https://example.org/e/1", "3 payments")
    assert [c["list"] for c in p["wallets"][BIG_ADDR]] == ["Built-in list", "Test ransomware list"], "every list that names it, the built-in list first"


def test_the_analysts_own_words_stay_on_the_vertex_and_never_in_the_provenance(fpage, tmp_path):
    setup(fpage)
    d = workspace_json(fpage, tmp_path)
    node = next(n for n in d["nodes"] if n["id"] == "addr:" + SMALL_ADDR)
    assert (node["label"], node["note"], node["tag"]) == ("My suspect", "my hypothesis", "RANSOM")
    text = json.dumps(d["provenance"])
    assert "My suspect" not in text and "my hypothesis" not in text, "your own claim is not a list's"


def test_the_file_still_opens_in_the_workspace_and_the_block_is_not_kept_on_the_vertices(fpage, ctx, tmp_path):
    setup(fpage)
    d = workspace_json(fpage, tmp_path)
    other = ctx.new_page()
    other.goto(fpage.url.split("#")[0]); other.wait_for_function("window.__hopline && window.__hopline.renderer")
    other.set_input_files("#fileImport", files=[{"name": "w.json", "mimeType": "application/json", "buffer": json.dumps(d).encode()}])
    other.wait_for_function("() => window.__hopline.state.graph.nodes.size > 0", timeout=20000)
    got = other.evaluate("(a) => { const n = window.__hopline.state.graph.nodes.get('addr:' + a); return n ? { label: n.label, hasProvenance: 'provenance' in n } : null; }", SMALL_ADDR)
    assert got == {"label": "My suspect", "hasProvenance": False}, got


def test_the_wallet_pages_file_names_the_list_of_a_wallet_it_knows(wpage, tmp_path):
    goto(wpage)
    p = save(wpage, "json", tmp_path, "w.json")
    d = json.loads(p.read_text(encoding="utf-8"))["provenance"]
    assert d["generator"] == "Hopline wallet overview"
    assert [c["list"] for c in d["wallets"][KNOWN_BUILTIN]] == ["Built-in list"] and d["wallets"][KNOWN_BUILTIN][0]["label"] == "Robinhood Hot Wallet"
    assert ADDRESS not in d["wallets"], "the wallet itself is on no list"
    assert [l["list"] for l in d["lists"]] == ["Built-in list"]
