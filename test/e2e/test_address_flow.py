"""The details of an address, and its card on the graph, say what others paid it and what it paid them, apart from its own change coming back: a wallet that spends coins and gets the change
back to itself again and again has a "received" total far above what others ever sent it, and an incoming list that is shorter than that total suggests."""
import re

import pytest

from conftest import PRICES_NOW
from helpers import idle, open_query, settle, xy
from test_fiat_sources import money, use_fiat
from test_wallet_chart_more import mixed
from test_wallet_history import W, history

SATS_PER_BTC = 1e8


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def row(page, label):
    """The value shown beside a label in the details of the selected vertex."""
    return page.locator("#inspBody dt", has_text=re.compile("^%s$" % label)).locator("xpath=following-sibling::dd[1]").inner_text()


def rows(page):
    return page.eval_on_selector_all("#inspBody dt", "els => els.map(e => e.textContent)")


def test_the_details_give_both_numbers_when_the_wallet_paid_itself_change(fpage, mock):
    mixed(mock)                                                                          # in 100,000 + 50,000, spent 100,000 (30,150 gone, 69,850 back as change), in 5,000 and 40,000
    open_query(fpage, W)
    assert "0.00264850 BTC" in row(fpage, "Received here") and "0.00100000 BTC" in row(fpage, "Sent from here"), "the totals are what they were"
    assert row(fpage, "From others").startswith("0.00195000 BTC"), row(fpage, "From others")
    assert row(fpage, "To others").startswith("0.00030150 BTC"), row(fpage, "To others")
    hint = fpage.locator("#inspBody .flowhint").inner_text()
    assert "0.00069850 BTC" in hint and "1 transaction " in hint and "its own change" in hint, hint
    labels = rows(fpage)
    assert labels.index("Received here") < labels.index("Sent from here") < labels.index("From others") < labels.index("To others"), labels
    from_others, to_others, received, sent = 195000, 30150, 264850, 100000
    assert received - sent == from_others - to_others == 164850, "what is left is what is on chain"


def test_a_wallet_that_never_paid_itself_shows_the_two_totals_only(fpage, mock):
    history(mock, 5)                                                                     # five payments in, nothing spent
    open_query(fpage, W)
    assert "Received here" in rows(fpage)
    assert "From others" not in rows(fpage) and "To others" not in rows(fpage)
    assert fpage.locator("#inspBody .flowhint").count() == 0


def test_a_transaction_has_no_such_rows(fpage, mock):
    mixed(mock)
    open_query(fpage, W)
    tx = [i for i in fpage.evaluate("() => [...window.__hopline.state.graph.nodes.keys()]") if i.startswith("tx:")][0]
    fpage.evaluate("(id) => window.__hopline.setSel([id])", tx); settle(fpage)
    assert "From others" not in rows(fpage) and fpage.locator("#inspBody .flowhint").count() == 0


def test_the_card_on_the_graph_says_how_much_of_what_it_received_came_from_others(fpage, mock):
    mixed(mock)
    open_query(fpage, W)
    p = xy(fpage, "addr:" + W)
    fpage.mouse.move(p["x"], p["y"])
    fpage.wait_for_function("() => !document.getElementById('tooltip').hidden && /Received/.test(document.getElementById('tooltip').textContent)", timeout=4000)
    tip = fpage.inner_text("#tooltip")
    assert "Received 0.00264850 BTC" in tip.replace("\n", " "), tip
    assert "From others 0.00195000 BTC" in tip.replace("\n", " ") and "0.00069850 BTC, is its own change" in tip.replace("\n", " "), tip


def test_with_a_currency_the_new_rows_are_converted_at_each_transactions_time(fpage, mock):
    mixed(mock)
    open_query(fpage, W)
    use_fiat(fpage, "USD")
    fpage.check("input[name=fiatBasis][value=today]"); idle(fpage)
    fpage.wait_for_function("() => /From others/.test(document.getElementById('inspBody').textContent) && document.querySelectorAll('#inspBody dd .fiat').length >= 4", timeout=8000)
    price = PRICES_NOW["USD"]
    assert abs(money(row(fpage, "From others").split("BTC")[-1]) - 195000 / SATS_PER_BTC * price) < 0.02, row(fpage, "From others")
    assert abs(money(row(fpage, "To others").split("BTC")[-1]) - 30150 / SATS_PER_BTC * price) < 0.02, row(fpage, "To others")
