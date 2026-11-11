"""A coin that came to a wallet whose spending the graph holds in full, and that nothing in the graph spends, is unspent: the arrow is dashed and the details say so, without the outspends of the
transaction that paid it ever being read (reported on a transaction of more than 1 BTC: loaded from the wallet's side, or with the wallet's history loaded afterwards, the arrow stayed solid)."""
import pytest

from chains import IN, OUT, real_addr, tid, tx
from helpers import open_query, settle
from test_unspent_dash import arrow_gaps

KEEP, OTHER, SPENT = real_addr(61), real_addr(62), real_addr(63)
BIG = 108_590_000


def stats(address, received, sent, n_tx):
    return {"address": address, "chain_stats": {"funded_txo_count": 1, "funded_txo_sum": received, "spent_txo_count": 1 if sent else 0, "spent_txo_sum": sent, "tx_count": n_tx},
            "mempool_stats": {"funded_txo_count": 0, "funded_txo_sum": 0, "spent_txo_count": 0, "spent_txo_sum": 0, "tx_count": 0}}


def pay(who, value):
    return {"scriptpubkey_address": who, "scriptpubkey_type": "v0_p2wpkh", "value": value}


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def scene(mock):
    """Transaction 80 pays KEEP (a thick arrow, never spent) and OTHER (a thin one, a wallet nothing is known of). The server is not asked who spends its outputs: that answer is not served."""
    tx(mock, 80, [IN(5, 0, "payer", BIG + 20_000)], [pay(KEEP, BIG), pay(OTHER, 5_000)])
    del mock.routes["/tx/" + tid(80) + "/outspends"]
    mock.routes["/address/" + KEEP] = stats(KEEP, BIG, 0, 1)
    mock.routes["/address/" + KEEP + "/txs"] = [mock.routes["/tx/" + tid(80)]]


def edge_state(page, to_addr):
    return page.evaluate("""(t) => { const e = [...window.__hopline.state.graph.edges.values()].find((x) => x.kind === 'out' && x.target === t);
                                     return e ? { spent: e.spent === undefined ? 'unknown' : e.spent, inferred: !!e.spentInferred } : null; }""", "addr:" + to_addr)


def test_a_wallet_opened_first_shows_its_unspent_coin_dashed(page, mock):
    scene(mock)
    open_query(page, KEEP); settle(page)
    assert edge_state(page, KEEP) == {"spent": False, "inferred": True}
    got = arrow_gaps(page, "tx:" + tid(80), "addr:" + KEEP)
    assert got["width"] >= 7 and got["gaps"] >= 2, "a thick arrow with dashes you can see: %s" % got
    assert edge_state(page, OTHER) == {"spent": "unknown", "inferred": False}, "nothing is known of the other wallet, so its arrow is not claimed to be unspent"
    assert not any(p.endswith("/outspends") for _, p in mock.requests), "and this came without asking the server who spends the outputs"


def test_the_details_of_the_transaction_say_unspent_for_it(page, mock):
    scene(mock)
    open_query(page, KEEP); settle(page)
    page.evaluate("(id) => window.__hopline.setSel([id])", "tx:" + tid(80)); settle(page)
    text = page.inner_text("#inspBody").lower()
    assert "→ unspent" in text and "→ spender unknown" in text, "one coin is known to be unspent, the other is not known: %s" % text[-400:]


def test_a_transaction_opened_first_turns_dashed_when_the_wallets_balance_is_read(fpage, mock):
    scene(mock)
    fpage.evaluate("() => { window.__hopline.state.autoBalance = true; }")
    open_query(fpage, tid(80)); settle(fpage)
    assert edge_state(fpage, KEEP)["spent"] == "unknown", "at first nothing says whether it is spent"
    assert arrow_gaps(fpage, "tx:" + tid(80), "addr:" + KEEP)["gaps"] == 0, "solid"
    fpage.evaluate("(id) => window.__hopline.setSel([id])", "addr:" + KEEP); fpage.wait_for_timeout(500); settle(fpage)
    assert edge_state(fpage, KEEP) == {"spent": False, "inferred": True}
    got = arrow_gaps(fpage, "tx:" + tid(80), "addr:" + KEEP)
    assert got["gaps"] >= 2, "and now it is dashed: %s" % got


def test_a_transaction_opened_first_turns_dashed_when_the_wallets_history_is_loaded(fpage, mock):
    scene(mock)
    fpage.evaluate("() => { window.__hopline.state.autoBalance = false; window.__hopline.state.autoHistory = false; }")
    open_query(fpage, tid(80)); settle(fpage)
    fpage.evaluate("(id) => window.__hopline.setSel([id])", "addr:" + KEEP); settle(fpage)
    assert edge_state(fpage, KEEP)["spent"] == "unknown", "no balance and no history read: not known"
    fpage.click("#inspBody button:has-text(\"Load history\")"); fpage.wait_for_timeout(500); settle(fpage)
    assert edge_state(fpage, KEEP) == {"spent": False, "inferred": True}
    assert arrow_gaps(fpage, "tx:" + tid(80), "addr:" + KEEP)["gaps"] >= 2


def test_a_wallet_that_spent_the_coin_is_not_claimed_unspent(fpage, mock):
    scene(mock)
    tx(mock, 81, [IN(80, 0, "keep", BIG)], [pay(SPENT, BIG - 150)])
    mock.routes["/tx/" + tid(81)]["vin"][0]["prevout"]["scriptpubkey_address"] = KEEP
    mock.routes["/address/" + KEEP] = stats(KEEP, BIG, BIG, 2)
    mock.routes["/address/" + KEEP + "/txs"] = [mock.routes["/tx/" + tid(81)], mock.routes["/tx/" + tid(80)]]
    fpage.evaluate("() => { window.__hopline.state.autoBalance = false; window.__hopline.state.autoHistory = false; }")
    open_query(fpage, tid(80)); settle(fpage)
    fpage.evaluate("(id) => window.__hopline.setSel([id])", "addr:" + KEEP); settle(fpage)
    fpage.click("#inspBody button:has-text(\"Load history\")"); fpage.wait_for_timeout(500); settle(fpage)
    got = edge_state(fpage, KEEP)
    assert got["spent"] is True and got["inferred"] is False, "the transaction that spent it is in the graph: that is the answer, not a guess: %s" % got
