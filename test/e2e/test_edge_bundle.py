"""Coins between the same two vertices (14 inputs of one transaction from one wallet) are drawn as one arrow with their number and total; the details list each coin."""
import json

import pytest

from chains import IN, OUT, addr, tid, tx
from helpers import idle, open_query, settle, xy
from test_edge_labels import edge_labels


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


FUND = "addr:" + addr("fund")
TX = "tx:" + tid(80)


def three_coins(mock):
    """One wallet funds three inputs of one transaction (30,000, 50,000 and 70,000 sat): three edges between the same two vertices."""
    tx(mock, 80, [IN(70, 0, "fund", 30000), IN(71, 1, "fund", 50000), IN(72, 0, "fund", 70000)], [OUT("sink", 149000)])


def texts(page):
    return sorted(l["text"] for l in edge_labels(page))


def test_three_coins_from_one_wallet_are_one_arrow_with_their_number_and_total(fpage, mock):
    three_coins(mock)
    open_query(fpage, tid(80)); fpage.uncheck("#focusOn"); settle(fpage)
    on = texts(fpage)
    assert "3 inputs · 0.0015 BTC" in on, on
    fpage.uncheck("#bundleEdges"); settle(fpage)
    off = texts(fpage)
    assert len(off) == len(on) + 2, "three labels become one: %s / %s" % (on, off)
    fpage.check("#bundleEdges"); settle(fpage)
    assert fpage.is_checked("#bundleEdges") and texts(fpage) == on
    assert sum(1 for k in fpage.evaluate("() => [...window.__hopline.state.graph.edges.keys()]") if k.startswith("in:" + tid(80))) == 3, "the data still has one edge per coin"


def test_switching_it_off_draws_each_coin_and_the_choice_is_remembered(fpage, mock):
    three_coins(mock)
    open_query(fpage, tid(80)); fpage.uncheck("#focusOn"); settle(fpage)
    fpage.uncheck("#bundleEdges"); settle(fpage)
    assert not any(x.startswith("3 inputs") for x in texts(fpage))
    assert json.loads(fpage.evaluate("() => localStorage.getItem('hopline.prefs.v1')"))["bundleEdges"] is False
    fpage.reload(); fpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert fpage.evaluate("() => window.__hopline.state.bundleEdges") is False and not fpage.is_checked("#bundleEdges")


def test_one_coin_alone_is_drawn_as_before(fpage, mock):
    tx(mock, 81, [IN(73, 0, "solo", 40000)], [OUT("sink2", 39000)])
    open_query(fpage, tid(81)); fpage.uncheck("#focusOn"); settle(fpage)
    t = texts(fpage)
    assert "0.0004 BTC" in t and not any("input" in x for x in t), t


def test_two_outputs_to_the_same_address_are_one_arrow_too(fpage, mock):
    tx(mock, 82, [IN(74, 0, "payer", 100000)], [OUT("shop", 30000), OUT("shop", 60000), OUT("chg", 9000)])
    open_query(fpage, tid(82)); fpage.uncheck("#focusOn"); settle(fpage)
    t = texts(fpage)
    assert "2 outputs · 0.0009 BTC" in t, t


def test_clicking_the_arrow_lists_every_coin_and_a_row_selects_that_coin(fpage, mock):
    three_coins(mock)
    open_query(fpage, tid(80)); fpage.uncheck("#focusOn"); settle(fpage)
    fpage.evaluate("() => window.__hopline.setSel([])"); settle(fpage)
    a, b = xy(fpage, FUND), xy(fpage, TX)
    fpage.mouse.click((a["x"] + b["x"]) / 2, (a["y"] + b["y"]) / 2); settle(fpage)
    sel = fpage.evaluate("() => window.__hopline.state.selectedEdge")
    assert sel and sel.startswith("in:" + tid(80)), sel
    body = fpage.inner_text("#inspBody")
    assert "Inputs on this arrow" in body and "3 · 0.00150000 BTC in all" in body
    rows = fpage.eval_on_selector_all("#inspBody .linkrow", "els => els.map(e => e.textContent)")
    assert len(rows) == 3 and "0.00070000 BTC" in rows[0] and "0.00050000 BTC" in rows[1] and "0.00030000 BTC" in rows[2], rows
    assert "from " + tid(72)[:6] in rows[0], "each says which earlier transaction it came from"
    fpage.click("#inspBody .linkrow >> nth=2"); settle(fpage)
    assert fpage.evaluate("() => window.__hopline.state.selectedEdge") == "in:%s:0" % tid(80) and "0.00030000 BTC" in fpage.inner_text("#inspBody")
    assert fpage.locator("#inspBody .linkrow.on").count() == 1


def test_hovering_the_arrow_says_how_many_coins_and_their_total(fpage, mock):
    three_coins(mock)
    open_query(fpage, tid(80)); fpage.uncheck("#focusOn"); settle(fpage)
    fpage.evaluate("() => window.__hopline.setSel([])"); settle(fpage)
    a, b = xy(fpage, FUND), xy(fpage, TX)
    fpage.mouse.move((a["x"] + b["x"]) / 2, (a["y"] + b["y"]) / 2); fpage.wait_for_selector("#tooltip:not([hidden])")
    tip = fpage.inner_text("#tooltip")
    assert "Inputs" in tip and "3 coins" in tip and "0.0015 BTC in all" in tip.replace("0.00150000", "0.0015"), tip


def test_with_the_option_off_a_click_shows_just_that_coin(fpage, mock):
    three_coins(mock)
    open_query(fpage, tid(80)); fpage.uncheck("#focusOn"); settle(fpage)
    fpage.uncheck("#bundleEdges"); settle(fpage)
    fpage.evaluate("(id) => window.__hopline.renderer.cb.onSelectEdge(id)", "in:%s:1" % tid(80)); settle(fpage)
    body = fpage.inner_text("#inspBody")
    assert "0.00050000 BTC" in body and "on this arrow" not in body and fpage.locator("#inspBody .linkrow.on").count() == 0


def test_a_trace_draws_the_one_arrow_too(tpage, mock):
    three_coins(mock)
    open_query(tpage, tid(80)); settle(tpage)
    tpage.evaluate("(id) => window.__hopline.traceExpand(id, 'prev')", TX); idle(tpage); settle(tpage)
    assert FUND in tpage.evaluate("() => [...window.__hopline.renderer.data.visible.nodes]")
    assert "3 inputs · 0.0015 BTC" in texts(tpage), texts(tpage)
