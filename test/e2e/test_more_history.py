"""More of a wallet's history can be loaded from the list behind an arrow and from the wallet's Transactions list."""
import pytest

from chains import IN, OUT, tx
from conftest import ADDRESS
from helpers import idle, open_query, settle
from test_trace import click_handle, shown

W = ADDRESS
W_ID = "addr:" + W


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def history(mock, n=30):
    """n payments to the wallet, newest first, served 25 at a time."""
    ids = []
    for i in range(n):
        k = 200 - i
        o = OUT("x", 10000 + k); o["scriptpubkey_address"] = W
        ids.append(tx(mock, k, [IN(k - 100, 0, "payer%d" % i, 20000)], [o]))
    txs = [mock.routes["/tx/" + t[3:]] for t in ids]
    mock.routes["/address/" + W + "/txs"] = txs[:25]
    if n >= 25:                                                                          # the second page: what is left, which may be nothing
        mock.routes["/address/" + W + "/txs/chain/" + txs[24]["txid"]] = txs[25:]
    mock.routes["/address/" + W] = {"address": W, "chain_stats": {"funded_txo_count": n, "funded_txo_sum": 300000, "spent_txo_count": 0, "spent_txo_sum": 0, "tx_count": n},
                                    "mempool_stats": {"funded_txo_count": 0, "funded_txo_sum": 0, "spent_txo_count": 0, "spent_txo_sum": 0, "tx_count": 0}}
    return ids


def one_page_only(page):
    page.evaluate("() => { window.__hopline.state.capPages = 1; }")                      # 25 transactions per request, so there is more to load


def tx_count_listed(page):
    return page.evaluate("() => { const n = window.__hopline.state.graph.nodes.get('%s'); let k = 0; window.__hopline.state.graph.edgesOf(n.id).forEach(() => k++); return k; }" % W_ID)


def loaded_txs(page):
    return page.evaluate("() => { let k = 0; window.__hopline.state.graph.nodes.forEach((n) => { if (n.type === 'tx' && n.loaded) k++; }); return k; }")


def test_the_list_behind_an_arrow_can_load_more_of_the_wallets_history(tpage, mock):
    history(mock)
    one_page_only(tpage)
    open_query(tpage, W); settle(tpage)
    assert loaded_txs(tpage) == 25
    n = tpage.evaluate("(id) => { const x = window.__hopline.state.graph.nodes.get(id); return [!!x.histNext, !!x.histDone]; }", W_ID)
    assert n == [True, False], "25 of 30: there is more"
    click_handle(tpage, W_ID, "left"); settle(tpage)                                       # what paid the wallet: 25 known, more than a click shows, so the list opens
    assert tpage.is_visible("#ctxMenu.choosing")
    assert "25 hidden" in tpage.inner_text("#ctxMenu").lower()
    btn = tpage.locator("#ctxMenu .choosermore button")
    assert btn.count() == 1 and "30 on chain, not all loaded" in tpage.inner_text("#ctxMenu .choosermore")
    btn.click(); idle(tpage); settle(tpage)
    assert loaded_txs(tpage) == 30
    assert tpage.is_visible("#ctxMenu.choosing") and "30 hidden" in tpage.inner_text("#ctxMenu").lower(), "the list opens again, with what was fetched in it"
    assert tpage.locator("#ctxMenu .choosermore").count() == 0, "and has nothing more to offer"


def test_a_wallet_whose_history_is_complete_has_no_such_button(tpage, mock):
    history(mock, n=12)
    open_query(tpage, W); settle(tpage)
    click_handle(tpage, W_ID, "left"); settle(tpage)
    assert tpage.is_visible("#ctxMenu.choosing") and tpage.locator("#ctxMenu .choosermore").count() == 0


def test_the_wallets_transactions_list_can_load_more_too(fpage, mock):
    history(mock)
    one_page_only(fpage)
    open_query(fpage, W); settle(fpage)
    fpage.evaluate("() => { window.__hopline.state.groupRows = false; }")
    fpage.evaluate("(id) => window.__hopline.setSel([id])", W_ID); settle(fpage)
    assert "transactions (25)" in fpage.inner_text("#inspBody").lower()
    row = fpage.locator("#inspBody .walletsec .moreHistory")
    assert row.count() == 1 and "30 on chain, 25 transactions listed" in row.inner_text()
    row.locator("button").click(); idle(fpage); settle(fpage)
    fpage.evaluate("(id) => window.__hopline.setSel([id])", W_ID); settle(fpage)
    assert "transactions (30)" in fpage.inner_text("#inspBody").lower()
    assert fpage.locator("#inspBody .walletsec .moreHistory").count() == 0


def test_the_tip_over_an_arrow_says_that_more_history_is_not_loaded(tpage, mock):
    history(mock)
    one_page_only(tpage)
    open_query(tpage, W); settle(tpage)
    tip = tpage.evaluate("(id) => window.__hopline.renderer.data.handleMore(id, 'left')", W_ID)
    assert "25 transactions" in tip and "More of its history is not loaded" in tip and "Shift-click the arrow" in tip
    tpage.evaluate("() => window.__hopline.state.graph.nodes.get('%s').histNext = null; window.__hopline.state.graph.nodes.get('%s').histDone = true;" % (W_ID, W_ID))
    tip = tpage.evaluate("(id) => window.__hopline.renderer.data.handleMore(id, 'left')", W_ID)
    assert "More of its history" not in tip


def test_a_single_click_still_shows_what_is_known_and_the_next_click_loads_more(tpage, mock):
    history(mock)
    one_page_only(tpage)
    tpage.evaluate("() => { window.__hopline.state.stepMode = 'all'; }")                   # no list: show whatever is known
    open_query(tpage, W); settle(tpage)
    before = len(shown(tpage))
    click_handle(tpage, W_ID, "left"); idle(tpage); settle(tpage)
    assert len(shown(tpage)) > before and loaded_txs(tpage) == 25
    click_handle(tpage, W_ID, "left"); idle(tpage); settle(tpage)
    assert loaded_txs(tpage) == 30, "nothing known is left hidden, so this click fetches the rest"
