"""Selecting one small wallet in the Trace layout loads its whole history by itself, so its handles count what is there instead of asking "?"; a large wallet keeps its handle."""
import json

import pytest

from chains import IN, OUT, addr, tid, tx
from helpers import idle, open_query, settle


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def auto(page, balance=None, history=None):
    page.evaluate("(a) => { for (const [id, on] of a) { const c = document.getElementById(id); c.checked = on; c.dispatchEvent(new Event('change')); } }",
                  [[k, v] for k, v in (("autoBalance", balance), ("autoHistory", history)) if v is not None]); settle(page)


def set_pages(page, n):
    """The Address history pages box is inside a closed section: set it the way a change there would."""
    page.evaluate("(n) => { const c = document.getElementById('capPages'); c.value = String(n); c.dispatchEvent(new Event('change')); }", n); settle(page)


def select(page, who):
    page.evaluate("(id) => window.__hopline.setSel([id])", "addr:" + addr(who))


def stats(mock, who, txs, n_txs):
    a = addr(who)
    mock.routes["/address/" + a] = {"address": a, "chain_stats": {"tx_count": n_txs, "funded_txo_sum": 900, "spent_txo_sum": 900}, "mempool_stats": {"tx_count": 0, "funded_txo_sum": 0, "spent_txo_sum": 0}}
    mock.routes["/address/" + a + "/txs"] = [mock.routes["/tx/" + tid(n)] for n in txs]


def case(mock, wallet_txs=2):
    """src pays w in tx 1, w pays on in tx 2: w has two transactions (or `wallet_txs` on the server's count)."""
    tx(mock, 1, [IN(90, 0, "src", 1000)], [OUT("w", 900)], spent={0: 2})
    tx(mock, 2, [IN(1, 0, "w", 900)], [OUT("dest", 800)])
    stats(mock, "w", [2, 1], wallet_txs)


def paths(mock):
    return [p for _, p in mock.requests]


def history_loaded(page, who="w"):
    return page.evaluate("(id) => { const n = window.__hopline.state.graph.nodes.get(id); return !!n && n.txCount != null && !n.balanceOnly; }", "addr:" + addr(who))


def settled(page, mock, wait=900):
    page.wait_for_timeout(wait); idle(page); settle(page)


def shown(page):
    return set(page.evaluate("() => [...window.__hopline.renderer.data.visible.nodes]"))


def test_a_small_wallet_selected_in_the_trace_has_its_history_loaded_and_the_trace_shows_no_more_than_before(tpage, mock):
    case(mock)
    open_query(tpage, tid(1)); settle(tpage)
    auto(tpage, history=True)
    before, undo = shown(tpage), tpage.evaluate("() => window.__hopline.state.undoLoads.length")
    asked = len(mock.requests)
    select(tpage, "w")
    tpage.wait_for_function("(id) => { const n = window.__hopline.state.graph.nodes.get(id); return n && n.txCount != null && !n.balanceOnly; }", arg="addr:" + addr("w"), timeout=15000)
    settled(tpage, mock)
    ps = paths(mock)[asked:]
    assert "/address/" + addr("w") + "/txs" in ps and ps.count("/address/" + addr("w")) == 1, "the totals were asked for once: the history load reuses them (%s)" % ps
    assert tpage.evaluate("(id) => window.__hopline.state.graph.nodes.get(id).loaded", "tx:" + tid(2)), "the other transaction of the wallet is loaded now"
    assert shown(tpage) == before, "a trace shows what you reveal: nothing was added to it"
    assert tpage.evaluate("() => window.__hopline.state.undoLoads.length") == undo, "a load of this kind is not an entry in Undo load"
    assert not tpage.is_visible(".toast:has-text('History')") if tpage.locator(".toast").count() else True


def test_a_wallet_with_more_transactions_than_one_click_loads_keeps_its_handle_and_only_its_totals_are_read(tpage, mock):
    case(mock, wallet_txs=5000)
    open_query(tpage, tid(1)); settle(tpage)
    auto(tpage, history=True)
    asked = len(mock.requests)
    select(tpage, "w")
    tpage.wait_for_function("(id) => { const n = window.__hopline.state.graph.nodes.get(id); return n && n.txCount === 5000; }", arg="addr:" + addr("w"), timeout=15000)
    settled(tpage, mock)
    ps = paths(mock)[asked:]
    assert ps == ["/address/" + addr("w")], "its totals, and no history: %s" % ps
    assert not history_loaded(tpage)


def test_the_threshold_is_what_one_click_loads_and_the_label_says_so(tpage, mock):
    case(mock, wallet_txs=30)
    assert tpage.text_content("#autoHistN") == "50"
    set_pages(tpage, 1)
    assert tpage.text_content("#autoHistN") == "25"
    open_query(tpage, tid(1)); settle(tpage)
    auto(tpage, history=True)
    asked = len(mock.requests)
    select(tpage, "w")
    tpage.wait_for_function("(id) => { const n = window.__hopline.state.graph.nodes.get(id); return n && n.txCount === 30; }", arg="addr:" + addr("w"), timeout=15000)
    settled(tpage, mock)
    assert not any(p.endswith("/txs") for p in paths(mock)[asked:]), "30 transactions are more than one click loads (25)"
    set_pages(tpage, 2)
    assert tpage.text_content("#autoHistN") == "50"
    select(tpage, "dest"); settled(tpage, mock, 500); select(tpage, "w")
    tpage.wait_for_function("(id) => { const n = window.__hopline.state.graph.nodes.get(id); return n && n.txCount != null && !n.balanceOnly; }", arg="addr:" + addr("w"), timeout=15000)
    assert history_loaded(tpage), "with two pages 30 is small enough"


def test_it_does_nothing_in_the_other_layouts_for_a_box_of_wallets_or_when_switched_off(tpage, mock):
    case(mock)
    tx(mock, 3, [IN(91, 0, "w2", 500)], [OUT("dest3", 400)])
    stats(mock, "w2", [3], 1)
    open_query(tpage, tid(1)); open_query(tpage, tid(3)); settle(tpage)
    auto(tpage, history=False)
    asked = len(mock.requests)
    select(tpage, "w"); settled(tpage, mock)
    assert not any(p.endswith("/txs") for p in paths(mock)[asked:]), "switched off"
    auto(tpage, history=True)
    tpage.evaluate("(ids) => window.__hopline.setSel(ids)", ["addr:" + addr("w"), "addr:" + addr("w2")]); settled(tpage, mock)
    assert not any(p.endswith("/txs") for p in paths(mock)[asked:]), "a box of wallets is not one wallet"
    tpage.click("#sideTab"); tpage.click("#layoutSeg [data-layout=flow]"); settle(tpage)
    select(tpage, "w"); settled(tpage, mock)
    assert not any(p.endswith("/txs") for p in paths(mock)[asked:]), "only the Trace layout"


def test_a_wallet_is_asked_once(tpage, mock):
    case(mock)
    open_query(tpage, tid(1)); settle(tpage)
    auto(tpage, history=True)
    select(tpage, "w")
    tpage.wait_for_function("(id) => { const n = window.__hopline.state.graph.nodes.get(id); return n && n.txCount != null && !n.balanceOnly; }", arg="addr:" + addr("w"), timeout=15000)
    settled(tpage, mock)
    count = paths(mock).count("/address/" + addr("w") + "/txs")
    select(tpage, "dest"); settled(tpage, mock, 500); select(tpage, "w"); settled(tpage, mock)
    assert paths(mock).count("/address/" + addr("w") + "/txs") == count == 1


def test_it_is_on_for_a_new_visitor_and_the_choice_is_remembered(newpage, mock):
    assert newpage.is_checked("#autoHistory") and newpage.text_content("#autoHistN") == "50"
    auto(newpage, history=False)
    assert json.loads(newpage.evaluate("() => localStorage.getItem('hopline.prefs.v1')"))["autoHistory"] is False
    newpage.reload(); newpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert not newpage.is_checked("#autoHistory")
    assert newpage.evaluate("() => window.__hopline.state.autoHistory") is False
