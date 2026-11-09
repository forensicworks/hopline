"""A wallet a list names a kind of service for gets the matching tag when it appears (an exchange gets EXCH), once, and your own choices win."""
import copy
import json

import pytest

from conftest import NORMAL
from helpers import idle, open_controls, open_query, settle, toast_text

# Fixed Float is in the built-in list as a swap service; the transaction's smaller output is moved to its address so it appears on the canvas by being loaded.
# The real transaction of the fixture also pays Robinhood's hot wallet, which the built-in list names as an exchange too.
FIXED_FLOAT = "bc1qns9f7yfx3ry9lj6yz7c9er0vwa0ye2eklpzqfw"
BIG = max(range(len(NORMAL["vout"])), key=lambda i: NORMAL["vout"][i]["value"])
SMALL = 1 - BIG
ROBINHOOD = NORMAL["vout"][BIG]["scriptpubkey_address"]
OTHER_ADDR = NORMAL["vout"][SMALL]["scriptpubkey_address"]
INPUT_ADDR = NORMAL["vin"][0]["prevout"]["scriptpubkey_address"]
FF = "addr:" + FIXED_FLOAT
RH = "addr:" + ROBINHOOD


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


@pytest.fixture
def to_fixed_float(mock):
    """The transaction as the API serves it, with one output paid to the Fixed Float address."""
    tx = copy.deepcopy(NORMAL)
    tx["vout"][SMALL]["scriptpubkey_address"] = FIXED_FLOAT
    mock.routes["/tx/" + NORMAL["txid"]] = tx
    return tx


def node(page, id_):
    return page.evaluate("(id) => { const n = window.__hopline.state.graph.nodes.get(id); return n ? { tag: n.tag || '', color: n.color || '', shape: n.shape || '' } : null; }", id_)


def drawn_texts(page):
    return page.evaluate("""() => { const r = window.__hopline.renderer, ctx = r.ctx, orig = ctx.fillText.bind(ctx), seen = [];
        ctx.fillText = (t, ...a) => { seen.push(String(t)); return orig(t, ...a); }; r.draw(); ctx.fillText = orig; return seen; }""")


def log_lines(page):
    return page.evaluate("() => window.__hopline.state.log.map(l => l.msg)")


def open_packs(page):
    open_controls(page)
    page.evaluate("() => { document.getElementById('packSection').open = true; }")


def load_pack(page, text, name="lists.csv"):
    open_packs(page)
    page.set_input_files("#packFile", files=[{"name": name, "mimeType": "text/csv", "buffer": text.encode("utf-8")}])
    page.wait_for_function("() => /Imported|Replaced|Import failed/.test(document.getElementById('toast').textContent)")
    settle(page)


def set_tag(page, id_, tag):
    page.evaluate("([id, tag]) => { const n = window.__hopline.state.graph.nodes.get(id); HoplineTags.apply(n, { tag }); window.__hopline.refresh(); }", [id_, tag])


def test_a_wallet_from_the_built_in_list_gets_the_tag_for_its_kind_when_it_appears(fpage, to_fixed_float):
    open_query(fpage, NORMAL["txid"])
    assert node(fpage, FF) == {"tag": "SWAP", "color": "#d98a3d", "shape": "hexagon"}, "a swap service gets SWAP"
    assert node(fpage, RH) == {"tag": "EXCH", "color": "#2ecc71", "shape": "hexagon"}, "an exchange (the real wallet this transaction pays) gets EXCH"
    assert node(fpage, "addr:" + INPUT_ADDR)["tag"] == "", "a wallet no list names is left alone"
    assert {"EXCH", "SWAP"} <= set(drawn_texts(fpage)), "the badges are drawn like any tag"
    assert any("Tagged 2 known wallets from the lists: EXCH 1, SWAP 1." in m for m in log_lines(fpage)), log_lines(fpage)
    fpage.evaluate("(id) => window.__hopline.setSel([id])", FF); settle(fpage)
    insp = fpage.inner_text("#inspBody")
    assert "known: Fixed Float Exchange" in insp
    assert fpage.input_value("#fTag") == "SWAP", "the tag is a real one: it shows in the tag box and can be changed there"


def test_only_a_category_that_names_a_kind_of_service_gives_a_tag(fpage):
    load_pack(fpage, "address,label,category\n%s,Some Mixer,Mixing service\n%s,Some Payment,RANSOM\n" % (INPUT_ADDR, OTHER_ADDR))
    open_query(fpage, NORMAL["txid"])
    assert node(fpage, "addr:" + INPUT_ADDR)["tag"] == "MIXER"
    assert node(fpage, "addr:" + OTHER_ADDR)["tag"] == "", "a ransomware entry has its own marking and is not a service"
    assert node(fpage, RH)["tag"] == "EXCH", "the built-in list and a pack work side by side"


def test_what_you_change_or_remove_stays_as_you_left_it(fpage, to_fixed_float):
    open_query(fpage, NORMAL["txid"])
    assert node(fpage, FF)["tag"] == "SWAP"
    set_tag(fpage, FF, "")
    assert node(fpage, FF) == {"tag": "", "color": "", "shape": ""}
    fpage.evaluate("() => { window.__hopline.afterGraphChange({}); window.__hopline.refresh({ relayout: true }); }"); idle(fpage)
    assert node(fpage, FF)["tag"] == "", "taking the tag off is not undone by the next redraw or by loading more"
    set_tag(fpage, FF, "THREAT")
    assert node(fpage, FF)["tag"] == "THREAT", "a tag of your own is never replaced"


def test_a_wallet_that_already_has_a_tag_of_its_own_is_left_alone(fpage, to_fixed_float):
    open_query(fpage, NORMAL["txid"])
    set_tag(fpage, FF, "WATCH")
    open_packs(fpage)
    fpage.click("#tagKnownNow")
    assert node(fpage, FF)["tag"] == "WATCH", "not even the button replaces it"


def test_the_switch_turns_it_off_and_the_button_tags_what_is_already_here(fpage, to_fixed_float):
    open_packs(fpage)
    fpage.uncheck("#autoTag")
    assert json.loads(fpage.evaluate("() => localStorage.getItem('hopline.prefs.v1')"))["autoTag"] is False
    open_query(fpage, NORMAL["txid"])
    assert node(fpage, FF)["tag"] == "" and node(fpage, RH)["tag"] == "", "switched off: nothing is tagged by itself"
    fpage.click("#tagKnownNow")
    assert node(fpage, FF)["tag"] == "SWAP" and node(fpage, RH)["tag"] == "EXCH", "the button works with the switch off too"
    assert "Tagged 2 known wallets from the lists: EXCH 1, SWAP 1." in toast_text(fpage)
    fpage.click("#tagKnownNow")
    assert "No wallet here without a tag" in toast_text(fpage), "nothing left to tag"


def test_the_switch_is_remembered(fpage):
    open_packs(fpage)
    fpage.uncheck("#autoTag")
    fpage.reload(); fpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    open_packs(fpage)
    assert not fpage.is_checked("#autoTag")


def test_a_file_you_open_is_shown_as_it_was_saved(fpage, to_fixed_float):
    open_packs(fpage)
    fpage.uncheck("#autoTag")
    open_query(fpage, NORMAL["txid"])
    assert node(fpage, FF)["tag"] == ""
    text = fpage.evaluate("() => HoplineIO.toJson(window.__hopline.state.graph)")
    fpage.click("#btnClear"); fpage.click("#btnClear"); settle(fpage)
    open_packs(fpage)
    fpage.check("#autoTag")
    fpage.set_input_files("#fileImport", files=[{"name": "saved.json", "mimeType": "application/json", "buffer": text.encode("utf-8")}])
    fpage.wait_for_function("() => /Imported/.test(document.getElementById('toast').textContent)")
    idle(fpage)
    assert node(fpage, FF)["tag"] == "", "a file's wallets are not tagged behind its author's back"
    fpage.click("#tagKnownNow")
    assert node(fpage, FF)["tag"] == "SWAP", "and the button does it when asked"


def test_an_automatic_tag_counts_in_the_legend_like_any_other(fpage, to_fixed_float):
    open_query(fpage, NORMAL["txid"])
    tags = fpage.evaluate("() => HoplineTags.summarise(Array.from(window.__hopline.state.graph.nodes.values())).map(t => [t.tag, t.count])")
    assert ["EXCH", 1] in tags and ["SWAP", 1] in tags, tags
