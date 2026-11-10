"""The wallet overview's summary: Total received and Total sent count the change a wallet pays back to itself both ways. From others and To others leave it out, and appear only when there is some."""
import pytest

from conftest import PRICES_NOW
from test_fiat_sources import price_at
from test_wallet_chart_more import OTHER, mixed, spend
from test_wallet_fiat import dollars, prefs, wait_prices
from test_wallet_history import W
from test_wallet_page import goto, wpage  # noqa: F401  (the fixture is used by name)


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def totals(mock, funded, spent, count, pending=0):
    mock.routes["/address/" + W] = {"address": W, "chain_stats": {"funded_txo_count": count, "funded_txo_sum": funded, "spent_txo_count": 1, "spent_txo_sum": spent, "tx_count": count},
                                    "mempool_stats": {"funded_txo_count": 0, "funded_txo_sum": 0, "spent_txo_count": 0, "spent_txo_sum": 0, "tx_count": pending}}


def five(mock):
    """The wallet of mixed(): 100,000 + 50,000 in; then it spends 100,000, gives 30,000 away and pays 69,850 back to itself (150 of fee); then 5,000 + 40,000 in.
    Received 264,850 in all, sent 100,000: from others 195,000 (264,850 less its own 69,850), to others 30,150 (30,000 and the fee)."""
    txs = mixed(mock)
    totals(mock, 264850, 100000, 5)
    return txs


def churn(mock, n=30):
    """n days of March 2022, the first at the oldest: an even day the wallet gets 100,000, an odd day it spends 100,000 and pays 30,000 away and 69,850 back to itself. Served 25 at a time, newest first."""
    txs = []
    for i in range(n):
        if i % 2 == 0:
            txs.append(spend(100 + i, i + 1, [("bc1qpayerxxxxxxxxxxxxxx", 100150)], [(W, 100000)]))
        else:
            txs.append(spend(100 + i, i + 1, [(W, 100000)], [(OTHER, 30000), (W, 69850)]))
    txs.reverse()
    mock.routes["/address/" + W + "/txs"] = txs[:25]
    for a in range(25, n + 1, 25):
        mock.routes["/address/" + W + "/txs/chain/" + txs[a - 1]["txid"]] = txs[a:a + 25]
    evens, odds = (n + 1) // 2, n // 2
    totals(mock, evens * 100000 + odds * 69850, odds * 100000, n)
    return txs


def others(txs):
    """The test's own sum over transactions: (what others paid the wallet, what it paid them) in sats, and the same in dollars at each transaction's price. The own change of a transaction is the smaller of what the wallet put in and got back."""
    fr = to = fr_usd = to_usd = 0
    for t in txs:
        recv = sum(o["value"] for o in t["vout"] if o.get("scriptpubkey_address") == W)
        sent = sum(v["prevout"]["value"] for v in t["vin"] if (v.get("prevout") or {}).get("scriptpubkey_address") == W)
        own = min(recv, sent)
        p = price_at(t["status"]["block_time"]) / 1e8
        fr += recv - own; to += sent - own; fr_usd += (recv - own) * p; to_usd += (sent - own) * p
    return fr, to, fr_usd, to_usd


# ---- what is shown ---------------------------------------------------------------------------------------------------------------------------------

def test_a_wallet_that_paid_itself_change_shows_what_others_paid_it_and_what_it_paid_them(wpage, mock):
    five(mock)
    goto(wpage)
    assert wpage.inner_text("#sReceived") == "0.00264850 BTC" and wpage.inner_text("#sSent") == "0.00100000 BTC", "the totals are the address's own, unchanged"
    assert wpage.inner_text("#sFrom") == "0.00195000 BTC" and wpage.inner_text("#sTo") == "0.00030150 BTC"
    assert wpage.is_visible("#sFromRow") and wpage.is_visible("#sToRow")
    assert "paid back to itself" in wpage.get_attribute("#sFromRow", "title") and "fees included" in wpage.get_attribute("#sToRow", "title")


def test_the_difference_of_the_two_is_the_difference_of_the_totals(wpage, mock):
    five(mock)
    goto(wpage)
    sats = lambda sel: round(float(wpage.inner_text(sel).split()[0]) * 1e8)          # noqa: E731
    assert sats("#sReceived") - sats("#sSent") == sats("#sFrom") - sats("#sTo") == 164850, "and that is the balance, with the change in neither"


def test_a_line_under_the_figures_says_how_much_was_change_and_how_many_transactions_it_was_in(wpage, mock):
    five(mock)
    goto(wpage)
    hint = wpage.inner_text("#sFlowHint")
    assert wpage.is_visible("#sFlowHint")
    assert "0.00069850 BTC of what this wallet received and of what it sent is its own change" in hint and "in 1 transaction" in hint, hint
    assert "fees included" in hint and "loaded so far" not in hint, "all of it is loaded: nothing to say about that"
    assert "loaded" not in wpage.inner_text("#sFrom") and "loaded" not in wpage.inner_text("#sTo")


def test_a_wallet_with_no_change_of_its_own_shows_only_the_totals(wpage):
    goto(wpage)                                                                        # the sample wallet only received and was emptied by other wallets' coins: nothing came back to it
    assert wpage.inner_text("#sReceived") == "0.01555415 BTC"
    for sel in ("#sFromRow", "#sToRow", "#sFlowHint"):
        assert wpage.is_hidden(sel), sel


def test_an_unconfirmed_transaction_is_not_counted_as_the_totals_do_not_count_it(wpage, mock):
    txs = five(mock)
    pend = spend(300, 2, [(W, 69850)], [(OTHER, 40000), (W, 29700)])
    pend["status"] = {"confirmed": False}
    mock.routes["/address/" + W + "/txs"] = [pend] + txs
    totals(mock, 264850, 100000, 5, pending=1)
    goto(wpage)
    assert wpage.inner_text("#sFrom") == "0.00195000 BTC" and wpage.inner_text("#sTo") == "0.00030150 BTC"
    assert "1 transaction" in wpage.inner_text("#sPending")


# ---- until the whole history is here ---------------------------------------------------------------------------------------------------------------

def test_while_only_part_of_the_history_is_loaded_the_figures_say_which_transactions_they_come_from(wpage, mock):
    txs = churn(mock)
    goto(wpage)
    assert wpage.locator("#ledger .tx").count() == 25
    fr, to, _, _ = others(txs[:25])
    assert wpage.inner_text("#sFrom").startswith("%.8f BTC" % (fr / 1e8)) and wpage.inner_text("#sTo").startswith("%.8f BTC" % (to / 1e8)), (wpage.inner_text("#sFrom"), wpage.inner_text("#sTo"))
    assert "in the 25 loaded transactions" in wpage.inner_text("#sFrom") and "in the 25 loaded transactions" in wpage.inner_text("#sTo")
    assert "worked out from the 25 confirmed transactions loaded so far" in wpage.inner_text("#sFlowHint")
    assert wpage.inner_text("#sReceived").startswith("0.02547750 BTC"), "the totals are for the whole history all the same"


def test_loading_the_rest_makes_them_the_whole_history_and_takes_the_note_away(wpage, mock):
    txs = churn(mock)
    goto(wpage)
    wpage.click("#loadAll")
    wpage.wait_for_function("() => document.querySelectorAll('#ledger .tx').length === 30", timeout=60000)
    fr, to, _, _ = others(txs)
    assert (fr, to) == (1500000, 452250)
    assert wpage.inner_text("#sFrom") == "0.01500000 BTC" and wpage.inner_text("#sTo") == "0.00452250 BTC"
    assert "loaded" not in wpage.inner_text("#sFrom") and "loaded so far" not in wpage.inner_text("#sFlowHint")
    assert wpage.inner_text("#sReceived") == "0.02547750 BTC"


# ---- in a currency ---------------------------------------------------------------------------------------------------------------------------------

def test_at_todays_price_each_figure_is_converted_whole_and_says_so(ctx, wpage, mock):
    prefs(ctx, {"currency": "USD", "basis": "today", "show": "both", "ref": None})
    five(mock)
    goto(wpage); wait_prices(wpage)
    for sel, sats in (("#sFrom", 195000), ("#sTo", 30150)):
        text = wpage.inner_text(sel)
        assert ("%.8f BTC" % (sats / 1e8)) in text and "at today's price" in text, text
        assert abs(dollars(text)[0] - sats / 1e8 * PRICES_NOW["USD"]) < 0.02, text


def test_at_each_transactions_own_price_the_figures_add_up_transaction_by_transaction(ctx, wpage, mock):
    prefs(ctx, {"currency": "USD", "basis": "each", "show": "fiat", "ref": None})
    txs = five(mock)
    goto(wpage); wait_prices(wpage)
    _, _, fr_usd, to_usd = others(txs)
    got_f, got_t = wpage.inner_text("#sFrom"), wpage.inner_text("#sTo")
    assert "BTC" not in got_f and "BTC" not in got_t and "today" not in got_f, (got_f, got_t)
    assert abs(dollars(got_f)[0] - fr_usd) < 0.25 and abs(dollars(got_t)[0] - to_usd) < 0.25, (got_f, fr_usd, got_t, to_usd)
    assert "its own transaction" in wpage.get_attribute("#sFrom", "title")
    wpage.select_option("#fiatShow", "btc")
    assert "$" not in wpage.inner_text("#sFrom") and wpage.inner_text("#sFrom") == "0.00195000 BTC"


def test_before_the_whole_history_is_loaded_the_totals_use_todays_price_but_these_use_the_prices_of_the_transactions_they_are_made_of(ctx, wpage, mock):
    prefs(ctx, {"currency": "USD", "basis": "each", "show": "both", "ref": None})
    txs = churn(mock)
    goto(wpage); wait_prices(wpage)
    _, _, fr_usd, to_usd = others(txs[:25])
    assert "at today's price" in wpage.inner_text("#sReceived"), "the whole history is not here: the total stands on today's price"
    got_f, got_t = wpage.inner_text("#sFrom"), wpage.inner_text("#sTo")
    assert "at today" not in got_f and "at today" not in got_t, "these are made of the loaded transactions, each at its own time"
    assert abs(dollars(got_f)[0] - fr_usd) < 0.5 and abs(dollars(got_t)[0] - to_usd) < 0.5, (got_f, fr_usd, got_t, to_usd)
    assert "in the 25 loaded transactions" in got_f
