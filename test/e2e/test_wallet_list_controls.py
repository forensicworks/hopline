"""The wallet's Transactions list has the arrow list's choices: five orders, skip known services / only known, and unspent only."""
import pytest

from chains import IN, OUT, tid, tx
from conftest import ADDRESS
from helpers import open_query, settle

W = ADDRESS
KNOWN_BUILTIN = "bc1qprdf80adfz7aekh5nejjfrp3jksc8r929svpxk"                  # "Robinhood Hot Wallet" in the built-in list: a known service
NUMS = (200, 201, 202, 203, 204, 205)


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def paying(address, txn, vout, value):
    """An input that spends an output of transaction `txn` which belonged to `address`."""
    i = IN(txn, vout, "x", value); i["prevout"]["scriptpubkey_address"] = address
    return i


def to(address, value):
    o = OUT("x", value); o["scriptpubkey_address"] = address
    return o


def scene(mock, spend_info=True):
    """The wallet and six transactions (a bigger number is a later one):
       200 the service pays it 50000, still unspent        201 a friend pays it 45000, spent again in 203
       202 a second friend (you will label it) pays 20000, still unspent
       203 it spends the 45000 and pays a shop            204 it spends the 7000 from 205 and pays the service
       205 a third friend pays it 7000, spent again in 204"""
    tx(mock, 200, [paying(KNOWN_BUILTIN, 60, 0, 51000)], [to(W, 50000)])
    tx(mock, 201, [IN(61, 0, "friend", 46000)], [to(W, 45000)], spent={0: 203})
    tx(mock, 202, [IN(62, 0, "friend2", 21000)], [to(W, 20000)])
    tx(mock, 203, [paying(W, 201, 0, 45000)], [OUT("shop", 44000)])
    tx(mock, 204, [paying(W, 205, 0, 7000)], [to(KNOWN_BUILTIN, 6000)])
    tx(mock, 205, [IN(63, 0, "friend3", 8000)], [to(W, 7000)], spent={0: 204})
    ids = ["tx:" + tid(n) for n in reversed(NUMS)]
    mock.routes["/address/" + W] = {"address": W, "chain_stats": {"funded_txo_count": 4, "funded_txo_sum": 122000, "spent_txo_count": 2, "spent_txo_sum": 52000, "tx_count": len(ids)},
                                    "mempool_stats": {"funded_txo_count": 0, "funded_txo_sum": 0, "spent_txo_count": 0, "spent_txo_sum": 0, "tx_count": 0}}
    mock.routes["/address/" + W + "/txs"] = [mock.routes["/tx/" + i[3:]] for i in ids]
    if not spend_info:
        for n in NUMS:
            mock.routes["/tx/" + tid(n) + "/outspends"] = [{} for _ in mock.routes["/tx/" + tid(n)]["vout"]]


def opened(fpage, mock, spends_loaded=False, **kw):
    scene(mock, **kw)
    open_query(fpage, W)
    if spends_loaded:                                                               # opening a transaction loads what spent its outputs
        for n in (200, 201, 202, 205):
            fpage.evaluate("(id) => window.__hopline.navigate(id)", "tx:" + tid(n))
            fpage.wait_for_function("(id) => { const n = window.__hopline.state.graph.nodes.get(id); return n && n.loaded && n.outspendsLoaded; }", arg="tx:" + tid(n))
    fpage.evaluate("""() => { const g = window.__hopline.state.graph; g.nodes.forEach((v) => { if (v.type === 'addr' && /friend2/.test(v.address)) v.label = 'My friend'; });
        window.__hopline.state.groupRows = false; window.__hopline.refresh(); window.__hopline.setSel([]); }""")
    settle(fpage)
    fpage.evaluate("(id) => window.__hopline.setSel([id])", "addr:" + W); settle(fpage)


def order(page):
    """The transaction numbers, in the order the list shows them."""
    titles = page.eval_on_selector_all("#inspBody .walletsec .linkrow", "els => els.map(e => e.title)")
    by_id = {tid(n): n for n in NUMS}
    return [n for t in titles for txid, n in by_id.items() if txid in t]


def choose(page, aria, value):
    page.select_option("#inspBody .walletsec select[aria-label='%s']" % aria, value); settle(page)


def test_there_are_five_orders_and_each_one_orders_the_list(fpage, mock):
    opened(fpage, mock)
    assert fpage.eval_on_selector_all("#inspBody .walletsec select[aria-label='Order'] option", "os => os.map(o => o.value)") == ["new", "old", "big", "small", "known"]
    assert order(fpage) == [205, 204, 203, 202, 201, 200], "newest first is the default"
    choose(fpage, "Order", "old")
    assert order(fpage) == [200, 201, 202, 203, 204, 205]
    choose(fpage, "Order", "big")
    assert order(fpage) == [200, 201, 203, 202, 204, 205], "largest first; equal amounts by transaction id"
    choose(fpage, "Order", "small")
    assert order(fpage) == [204, 205, 202, 201, 203, 200]
    choose(fpage, "Order", "known")
    assert order(fpage) == [202, 200, 204, 201, 203, 205], "labelled by you, then known, then the rest, each largest first"


def test_skip_known_services_leaves_out_the_ones_on_the_built_in_list(fpage, mock):
    opened(fpage, mock)
    choose(fpage, "Which wallets", "skip")
    assert order(fpage) == [205, 203, 202, 201], "the service that paid the wallet and the service it paid are gone; a friend you labelled is not a service"
    assert "4 of 6 listed" in fpage.inner_text("#inspBody .walletfilters")


def test_only_known_or_labelled_keeps_the_services_and_what_you_labelled(fpage, mock):
    opened(fpage, mock)
    choose(fpage, "Which wallets", "only")
    assert order(fpage) == [204, 202, 200]
    choose(fpage, "Which wallets", "any")
    assert len(order(fpage)) == 6 and fpage.locator("#inspBody .walletfilters .hint").count() == 0, "no count when nothing is left out"


def test_unspent_only_keeps_the_payments_whose_coins_are_still_there(fpage, mock):
    opened(fpage, mock, spends_loaded=True)
    assert fpage.is_visible("#inspBody .walletsec .unspentopt")
    fpage.check("#inspBody .walletsec .unspentopt input"); settle(fpage)
    assert order(fpage) == [202, 200], "201 and 205 were spent again, and the others are payments out"
    assert "2 of 6 listed" in fpage.inner_text("#inspBody .walletfilters") and "no spend information" not in fpage.inner_text("#inspBody .walletfilters")
    fpage.uncheck("#inspBody .walletsec .unspentopt input"); settle(fpage)
    assert len(order(fpage)) == 6


def test_a_payment_whose_spending_is_not_known_is_left_out_and_the_list_says_so(fpage, mock):
    opened(fpage, mock)                                                             # only the history was loaded: 201 and 205 are known to be spent (203 and 204 are in it), 200 and 202 are not known either way
    fpage.check("#inspBody .walletsec .unspentopt input"); settle(fpage)
    assert order(fpage) == []
    assert "0 of 6 listed" in fpage.inner_text("#inspBody .walletfilters") and "2 payments with no spend information left out" in fpage.inner_text("#inspBody .walletfilters")


def test_the_choices_combine_and_work_with_the_in_out_buttons(fpage, mock):
    opened(fpage, mock, spends_loaded=True)
    choose(fpage, "Which wallets", "skip")
    fpage.check("#inspBody .walletsec .unspentopt input"); settle(fpage)
    assert order(fpage) == [202]
    fpage.click("#inspBody .walletsec [data-dir=out]"); settle(fpage)
    assert order(fpage) == [], "nothing that went out is also unspent"
    assert "None of these" in fpage.inner_text("#inspBody .walletsec")
    fpage.click("#inspBody .walletsec [data-dir=all]"); settle(fpage)
    assert order(fpage) == [202]


def test_the_ticks_only_count_what_is_listed(fpage, mock):
    opened(fpage, mock)
    fpage.check("#inspBody .walletsec .walletpick label input"); settle(fpage)                 # tick every listed transaction
    assert "6 ticked" in fpage.inner_text("#inspBody .walletsec .pickcount")
    choose(fpage, "Which wallets", "only")
    assert "3 ticked" in fpage.inner_text("#inspBody .walletsec .pickcount"), "a tick on a row the choice hides does not count"
    choose(fpage, "Which wallets", "any")
    assert "6 ticked" in fpage.inner_text("#inspBody .walletsec .pickcount"), "and it is back when the row is listed again"


def test_a_choice_survives_selecting_something_else_and_coming_back(fpage, mock):
    opened(fpage, mock)
    choose(fpage, "Order", "small"); choose(fpage, "Which wallets", "skip")
    fpage.evaluate("() => window.__hopline.setSel([])"); settle(fpage)
    fpage.evaluate("(id) => window.__hopline.setSel([id])", "addr:" + W); settle(fpage)
    assert fpage.input_value("#inspBody .walletsec select[aria-label='Order']") == "small"
    assert fpage.input_value("#inspBody .walletsec select[aria-label='Which wallets']") == "skip"
    assert order(fpage) == [205, 202, 201, 203], "smallest first, services skipped"


def test_when_nothing_about_spending_is_known_there_is_no_unspent_choice(fpage, mock):
    tx(mock, 200, [paying(KNOWN_BUILTIN, 60, 0, 51000)], [to(W, 50000)])
    tx(mock, 202, [IN(62, 0, "friend2", 21000)], [to(W, 20000)])
    ids = ["tx:" + tid(n) for n in (202, 200)]
    mock.routes["/address/" + W] = {"address": W, "chain_stats": {"funded_txo_count": 2, "funded_txo_sum": 70000, "spent_txo_count": 0, "spent_txo_sum": 0, "tx_count": 2},
                                    "mempool_stats": {"funded_txo_count": 0, "funded_txo_sum": 0, "spent_txo_count": 0, "spent_txo_sum": 0, "tx_count": 0}}
    mock.routes["/address/" + W + "/txs"] = [mock.routes["/tx/" + i[3:]] for i in ids]
    open_query(fpage, W)
    fpage.evaluate("() => { window.__hopline.state.groupRows = false; window.__hopline.setSel([]); }")
    fpage.evaluate("(id) => window.__hopline.setSel([id])", "addr:" + W); settle(fpage)
    assert len(order(fpage)) == 2
    assert fpage.locator("#inspBody .walletsec .unspentopt").count() == 0, "the history says nothing about what was spent"
    assert fpage.is_visible("#inspBody .walletsec select[aria-label='Which wallets']"), "the other choices are still there"
