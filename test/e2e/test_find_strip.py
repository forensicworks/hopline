"""What was found, in one strip over the graph: chips with counts that select what they count, and the count on the Analysis heading."""
import json

import pytest

from chains import coinjoin, consolidation, peel_chain, reuse_change, addr, tid
from conftest import NORMAL
from helpers import idle, open_query, settle
from test_analysis import auto
from test_every_name import load_json, sanctions_pack
from test_label_packs import SMALL_ADDR


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def chips(page):
    return page.evaluate("() => [...document.querySelectorAll('#findStrip .findchip')].map((b) => [b.dataset.key, b.textContent])")


def labels(page):
    return {k: t for k, t in chips(page)}


def selected(page):
    return set(page.evaluate("() => [...window.__hopline.state.selected]"))


def test_nothing_is_shown_until_something_is_found(fpage):
    assert fpage.is_hidden("#findStrip") and fpage.inner_text("#anCount") == ""
    open_query(fpage, NORMAL["txid"])
    l = labels(fpage)
    assert l["known"] == "Known wallets1" and l["change"] == "Change guesses1" and "sanctions" not in l, "the transaction pays a known wallet, and the other output is guessed to be change"
    assert fpage.inner_text("#anCount") == "(1)", "a known wallet is not a finding, so only the change guess is counted"


def test_a_consolidation_is_counted_and_a_click_selects_it(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30))
    assert fpage.is_visible("#findStrip")
    l = labels(fpage)
    assert l["consolidation"] == "CONSOL1" and l["clusters"] == "Clusters1", l
    fpage.click("#findStrip [data-key=consolidation]"); settle(fpage)
    assert selected(fpage) == {"tx:" + tid(30)}
    fpage.click("#findStrip [data-key=clusters]"); settle(fpage)
    assert selected(fpage) == {"addr:" + addr("k%d" % i) for i in range(6)}, "the six addresses that were spent together"
    assert fpage.inner_text("#anCount") == "(2)", "the heading carries the number of findings"


def test_a_peel_chain_counts_as_one_and_selects_its_transactions(fpage, mock):
    peel_chain(mock, 6)
    open_query(fpage, tid(10))
    auto(fpage, hops=5, follow="largest")
    assert labels(fpage)["peel"] == "PEEL1"
    assert "1 possible peel chain (6 transactions)" in fpage.get_attribute("#findStrip [data-key=peel]", "title")
    fpage.click("#findStrip [data-key=peel]"); settle(fpage)
    assert selected(fpage) == {"tx:" + tid(10 + i) for i in range(6)}


def test_a_coinjoin_like_transaction_and_a_change_guess_have_their_chips(fpage, mock):
    coinjoin(mock); reuse_change(mock)
    open_query(fpage, tid(50)); open_query(fpage, tid(40))
    fpage.uncheck("#focusOn"); settle(fpage)
    l = labels(fpage)
    assert l["coinjoin"] == "COINJOIN?1" and l["change"] == "Change guesses1", l
    fpage.click("#findStrip [data-key=change]"); settle(fpage)
    assert selected(fpage) == {"addr:" + addr("me")}, "the output that is guessed to be change"
    assert "not findings" in fpage.get_attribute("#findStrip [data-key=change]", "title"), "and the chip says it is a guess"


def test_the_switches_under_analysis_decide_what_is_drawn_not_what_was_found(fpage, mock):
    consolidation(mock); reuse_change(mock)
    open_query(fpage, tid(30)); open_query(fpage, tid(40))
    fpage.uncheck("#focusOn"); settle(fpage)
    before = labels(fpage)
    assert {"consolidation", "clusters", "change"} <= set(before)
    fpage.uncheck("#anChange"); fpage.uncheck("#anClusters"); fpage.uncheck("#anFlags")
    assert labels(fpage) == before, "the marks are off, the findings are still counted"


def test_a_wallet_on_a_sanctions_list_comes_first_in_red_and_a_click_selects_it(fpage):
    open_query(fpage, NORMAL["txid"])
    load_json(fpage, "list.json", sanctions_pack(SMALL_ADDR))
    keys = [k for k, _ in chips(fpage)]
    assert keys[0] == "sanctions", keys
    assert "bad" in fpage.get_attribute("#findStrip [data-key=sanctions]", "class") and labels(fpage)["sanctions"] == "Sanctions1"
    fpage.click("#findStrip [data-key=sanctions]"); settle(fpage)
    assert selected(fpage) == {"addr:" + SMALL_ADDR}
    assert fpage.inner_text("#anCount") == "(1)"


def test_known_wallets_are_counted_apart_from_the_findings(fpage):
    open_query(fpage, NORMAL["txid"])
    assert labels(fpage)["known"] == "Known wallets1"
    fpage.click("#findStrip [data-key=known]"); settle(fpage)
    assert len(selected(fpage)) == 1


def test_the_strip_follows_what_is_loaded_and_goes_away_when_it_is_cleared(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30))
    assert fpage.is_visible("#findStrip")
    fpage.click("#btnClear"); fpage.click("#btnClear"); settle(fpage)
    assert fpage.is_hidden("#findStrip") and fpage.inner_text("#anCount") == ""


def test_the_findings_chip_opens_the_findings_panel_on_the_right(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30))
    fpage.evaluate("() => window.__hopline.setSel([])"); settle(fpage)
    fpage.click("#inspCollapse"); settle(fpage)
    assert fpage.is_hidden("#inspector")
    fpage.click("#findStrip [data-key=details]"); settle(fpage)
    assert fpage.is_visible("#inspector") and fpage.is_visible("#findPane") and fpage.is_visible("#detList")


def test_the_strip_stays_in_full_screen_and_its_findings_chip_opens_the_panel(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30)); settle(fpage)
    fpage.evaluate("() => { document.documentElement.requestFullscreen = () => Promise.reject(new Error('not allowed here')); }")
    fpage.click("#fullBtn"); settle(fpage)
    assert fpage.is_visible("#findStrip") and fpage.is_visible("#findStrip [data-key=consolidation]")
    fpage.click("#findStrip [data-key=details]"); settle(fpage)
    assert fpage.is_visible("#findPane") and fpage.is_visible("#detList")


def test_the_strip_sits_clear_of_the_counts_and_inside_the_graph(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30)); settle(fpage)
    s = fpage.locator("#findStrip").bounding_box(); h = fpage.locator("#hud").bounding_box(); c = fpage.locator("#cv").bounding_box()
    assert s["y"] + s["height"] <= h["y"] + 1, "above the counts"
    assert s["x"] >= c["x"] and s["x"] + s["width"] <= c["x"] + c["width"]
