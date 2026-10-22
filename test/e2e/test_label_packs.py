"""Label packs: other people's lists of wallets and names, imported from CSV or JSON, kept apart from your own labels."""
import csv
import io
import json

import pytest

from conftest import NORMAL, OUTSPENDS
from helpers import idle, open_query, settle, toast_text

BIG = max(range(len(NORMAL["vout"])), key=lambda i: NORMAL["vout"][i]["value"])
BIG_ADDR = NORMAL["vout"][BIG]["scriptpubkey_address"]
SMALL_ADDR = NORMAL["vout"][1 - BIG]["scriptpubkey_address"]
INPUT_ADDR = NORMAL["vin"][0]["prevout"]["scriptpubkey_address"]
ETH = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def drawn_texts(page):
    return page.evaluate("""() => { const r = window.__hopline.renderer, ctx = r.ctx, orig = ctx.fillText.bind(ctx), seen = [];
        ctx.fillText = (t, ...a) => { seen.push(String(t)); return orig(t, ...a); }; r.draw(); ctx.fillText = orig; return seen; }""")


def open_packs(page):
    page.evaluate("() => { document.getElementById('packSection').open = true; }")


def load(page, name, text):
    open_packs(page)
    page.set_input_files("#packFile", files=[{"name": name, "mimeType": "text/csv", "buffer": text.encode("utf-8")}])
    page.wait_for_function("() => /Imported|Replaced|Import failed/.test(document.getElementById('toast').textContent)")
    settle(page)


def known(page, address):
    return page.evaluate("(a) => window.__hopline.renderer.data.known[a] || null", address)


def test_importing_a_pack_labels_the_wallets_it_names_and_says_where_the_name_came_from(fpage):
    open_query(fpage, NORMAL["txid"])
    load(fpage, "exchange-list.csv", "address,label,category,url,note\n%s,Pack Exchange,EXCH,https://example.org/ref,Hot wallet seen in case 7\n" % SMALL_ADDR)
    t = toast_text(fpage)
    assert "Imported 1 labelled wallets, 1 of them already in the workspace" in t, t
    k = known(fpage, SMALL_ADDR)
    assert k["label"] == "Pack Exchange" and k["pack"] == "exchange-list" and k["category"] == "EXCH"
    assert "Pack Exchange" in drawn_texts(fpage), "drawn on the canvas like any known wallet"
    fpage.evaluate("(id) => window.__hopline.setSel([id])", "addr:" + SMALL_ADDR); settle(fpage)
    insp = fpage.inner_text("#inspBody")
    assert "known: Pack Exchange (exchange-list)" in insp and "EXCH" in insp and "Hot wallet seen in case 7" in insp and "source" in insp.lower()
    assert fpage.get_attribute("#inspBody a:has-text('source')", "href") == "https://example.org/ref"
    assert "exchange-list" in fpage.inner_text("#packList") and "1 wallets" in fpage.inner_text("#packList")


def test_a_pack_can_be_switched_off_and_removed_and_it_is_remembered(fpage):
    open_query(fpage, NORMAL["txid"])
    load(fpage, "p1.csv", "%s,First pack\n" % SMALL_ADDR)
    assert known(fpage, SMALL_ADDR)["label"] == "First pack"
    fpage.uncheck("#packList input[type=checkbox]"); settle(fpage)
    assert known(fpage, SMALL_ADDR) is None and "First pack" not in drawn_texts(fpage)
    fpage.reload(); fpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    open_packs(fpage)
    assert "p1" in fpage.inner_text("#packList") and not fpage.is_checked("#packList input[type=checkbox]"), "still there, still off"
    fpage.check("#packList input[type=checkbox]")
    assert known(fpage, SMALL_ADDR)["label"] == "First pack"
    fpage.click("#packList button[aria-label='Remove p1']")
    assert known(fpage, SMALL_ADDR) is None and "No packs imported" in fpage.inner_text("#packHint")
    fpage.reload(); fpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert fpage.evaluate("() => window.__hopline.state.packs.length") == 0


def test_two_packs_naming_one_wallet_both_show_and_importing_the_same_name_replaces(fpage):
    open_query(fpage, NORMAL["txid"])
    load(fpage, "a.csv", "%s,Name from A\n" % SMALL_ADDR)
    load(fpage, "b.csv", "%s,Name from B\n" % SMALL_ADDR)
    k = known(fpage, SMALL_ADDR)
    assert k["label"] == "Name from A" and k["alt"] == ["Name from B (b)"], "the first pack wins and the other is listed as an alternative"
    fpage.evaluate("(id) => window.__hopline.setSel([id])", "addr:" + SMALL_ADDR); settle(fpage)
    assert "also listed as: Name from B (b)" in fpage.inner_text("#inspBody")
    load(fpage, "a.csv", "%s,Newer name from A\n" % SMALL_ADDR)
    assert "Replaced the pack" in toast_text(fpage) and fpage.evaluate("() => window.__hopline.state.packs.length") == 2
    assert known(fpage, SMALL_ADDR)["label"] != "Name from A"


def test_rows_that_cannot_be_used_are_counted_and_left_out(fpage):
    open_query(fpage, NORMAL["txid"])
    bad = SMALL_ADDR[:-1] + ("a" if SMALL_ADDR[-1] != "a" else "b")
    load(fpage, "mixed.csv", "address,label\n%s,Good\n%s,Typo in the address\n%s,An Ethereum address\n%s,Good again\n" % (INPUT_ADDR, bad, ETH, INPUT_ADDR))
    t = toast_text(fpage)
    assert "Imported 1 labelled wallets" in t and "1 failed the address checksum" in t and "1 were not Bitcoin addresses" in t and "1 repeated" in t, t
    assert known(fpage, bad) is None and known(fpage, INPUT_ADDR)["label"] == "Good"


def test_a_file_with_nothing_usable_is_refused_and_changes_nothing(fpage):
    open_query(fpage, NORMAL["txid"])
    load(fpage, "eth.csv", "address,label\n%s,Ethereum\n" % ETH)
    assert "Import failed" in toast_text(fpage) and "not Bitcoin addresses" in toast_text(fpage)
    assert fpage.evaluate("() => window.__hopline.state.packs.length") == 0


def test_hostile_text_in_a_pack_is_only_ever_text(fpage):
    open_query(fpage, NORMAL["txid"])
    evil = '<img src=x onerror=window.__pwned=1> ' + "x" * 200
    pack = {"format": "hopline-labels", "name": "<b>bold</b> pack", "labels": [{"address": SMALL_ADDR, "label": evil, "category": "<script>1</script>", "url": "javascript:window.__pwned=1", "note": "<i>n</i>"}]}
    load(fpage, "evil.json", json.dumps(pack))
    fpage.evaluate("(id) => window.__hopline.setSel([id])", "addr:" + SMALL_ADDR); settle(fpage)
    assert fpage.evaluate("() => window.__pwned") is None
    assert fpage.locator("#inspBody img, #inspBody script, #packList b, #inspBody i").count() == 0, "nothing was turned into markup"
    assert fpage.locator("#inspBody a:has-text('source')").count() == 0, "a javascript: link is dropped"
    assert "<b>bold</b> pack" in fpage.inner_text("#packList"), "shown literally"
    assert len(known(fpage, SMALL_ADDR)["label"]) == 120


def test_a_wallet_a_pack_labels_stops_auto_expand_like_any_known_wallet(fpage):
    open_query(fpage, NORMAL["txid"])
    load(fpage, "stop.csv", "%s,Pack Exchange\n" % INPUT_ADDR)
    open_packs(fpage)
    fpage.evaluate("(id) => window.__hopline.autoExpand(id, { dir: 'prev', hops: 2, follow: 'all' })", "tx:" + NORMAL["txid"]); idle(fpage); settle(fpage)
    assert "reached a labelled wallet (Pack Exchange)" in toast_text(fpage)


def test_importing_a_pack_refreshes_the_analysis_that_depends_on_known_wallets(fpage):
    open_query(fpage, NORMAL["txid"])
    before = fpage.evaluate("() => [...window.__hopline.analysis().changeEdges.keys()]")
    assert before, "the built-in list knows one output, so the other is the likely change"
    load(fpage, "both.csv", "%s,Also known\n" % SMALL_ADDR)
    after = fpage.evaluate("() => [...window.__hopline.analysis().changeEdges.keys()]")
    assert after == [], "both outputs are now known wallets: nothing singles one out any more"


def test_your_own_labels_export_as_a_pack_that_imports_back(fpage, tmp_path):
    open_query(fpage, NORMAL["txid"])
    fpage.evaluate("""(a) => { const g = window.__hopline.state.graph; g.annotate('addr:' + a, '=SUM(1+1) Suspect', 'seen on 2022-04-05'); g.nodes.get('addr:' + a).tag = 'THREAT'; window.__hopline.refresh(); }""", SMALL_ADDR)
    open_packs(fpage)

    def export(button, name):
        with fpage.expect_download() as dl:
            fpage.click(button)
        p = tmp_path / name; dl.value.save_as(p); return p

    rows = list(csv.reader(io.StringIO(export("#packExportCsv", "l.csv").read_text(encoding="utf-8-sig"), newline="")))
    assert rows[0] == ["address", "label", "category", "url", "note"]
    assert rows[1][0] == SMALL_ADDR and rows[1][1] == "'=SUM(1+1) Suspect" and rows[1][2] == "THREAT" and rows[1][4] == "seen on 2022-04-05", "a formula in a label is defused for spreadsheets"
    doc = json.loads(export("#packExportJson", "l.json").read_text(encoding="utf-8"))
    assert doc["format"] == "hopline-labels" and doc["labels"][0]["address"] == SMALL_ADDR and doc["labels"][0]["label"] == "=SUM(1+1) Suspect"
    load(fpage, "colleague.json", json.dumps(doc))
    assert known(fpage, SMALL_ADDR)["label"] == "=SUM(1+1) Suspect" and known(fpage, SMALL_ADDR)["pack"].startswith("Hopline labels")


def test_exporting_with_nothing_labelled_says_so(fpage):
    open_query(fpage, NORMAL["txid"])
    open_packs(fpage)
    fpage.click("#packExportCsv")
    assert "Nothing to export" in toast_text(fpage)
