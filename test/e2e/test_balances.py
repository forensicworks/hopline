"""The balance of each address, in the details panel (and the exports and the report)."""
import csv
import io
import json
import re

import pytest

from conftest import ADDRESS, NORMAL
from helpers import idle, open_query, settle, toast_text

BIG = max(range(len(NORMAL["vout"])), key=lambda i: NORMAL["vout"][i]["value"])
BIG_ADDR = NORMAL["vout"][BIG]["scriptpubkey_address"]
SMALL_ADDR = NORMAL["vout"][1 - BIG]["scriptpubkey_address"]
INPUT_ADDR = NORMAL["vin"][0]["prevout"]["scriptpubkey_address"]


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def stats(mock, addr, funded, spent, mem_in=0, mem_out=0, n=3):
    mock.routes["/address/" + addr] = {"address": addr, "chain_stats": {"funded_txo_count": n, "funded_txo_sum": funded, "spent_txo_count": n, "spent_txo_sum": spent, "tx_count": n},
                                       "mempool_stats": {"funded_txo_count": 0, "funded_txo_sum": mem_in, "spent_txo_count": 0, "spent_txo_sum": mem_out, "tx_count": 0}}


def select(page, *addrs):
    page.evaluate("(ids) => window.__hopline.setSel(ids)", ["addr:" + a for a in addrs]); settle(page)


def insp(page):
    return page.inner_text("#inspBody")


def test_loading_an_addresss_history_shows_its_balance_with_when_and_from_where(fpage, mock):
    stats(mock, ADDRESS, 1555415, 1000000)
    open_query(fpage, ADDRESS)
    t = insp(fpage)
    assert "BALANCE" in t.upper() and "0.00555415 BTC" in t
    assert "received 0.01555415 BTC, sent 0.01000000 BTC" in t
    assert re.search(r"Balance as of\s+\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC from mempool\.space", t, re.I)
    assert "not loaded yet" not in t and fpage.locator("#inspBody button:has-text('Load balance')").count() == 0


def test_a_wallet_whose_balance_is_unknown_says_so_and_one_click_reads_it_without_the_history(fpage, mock):
    open_query(fpage, NORMAL["txid"])
    stats(mock, SMALL_ADDR, 200000, 150000)
    select(fpage, SMALL_ADDR)
    assert "not loaded yet" in insp(fpage)
    n = len(mock.requests)
    fpage.click("#inspBody button:has-text('Load balance')"); idle(fpage); settle(fpage)
    got = [p for _, p in mock.requests[n:]]
    assert got == ["/address/" + SMALL_ADDR], "one request, and no history"
    assert "0.00050000 BTC" in insp(fpage) and "not loaded yet" not in insp(fpage)
    assert fpage.evaluate("(a) => window.__hopline.state.graph.nodes.get('addr:' + a).txCount", SMALL_ADDR) == 3


def test_unconfirmed_money_is_shown_apart_from_the_balance(fpage, mock):
    open_query(fpage, NORMAL["txid"])
    stats(mock, SMALL_ADDR, 200000, 150000, mem_in=30000, mem_out=0)
    select(fpage, SMALL_ADDR)
    fpage.click("#inspBody button:has-text('Load balance')"); idle(fpage); settle(fpage)
    t = insp(fpage)
    assert "0.00050000 BTC" in t and "+0.00030000 BTC (not in the balance above)" in t
    stats(mock, SMALL_ADDR, 200000, 150000, mem_in=0, mem_out=20000)
    fpage.evaluate("() => window.__hopline.state.client.cache.clear()")
    fpage.evaluate("(a) => window.__hopline.state.explorer.loadBalances([a], 10).then(() => window.__hopline.refresh())", SMALL_ADDR); idle(fpage)
    fpage.evaluate("() => window.__hopline.setSel(['addr:' + %s])" % json.dumps(SMALL_ADDR)); settle(fpage)
    assert "-0.00020000 BTC (not in the balance above)" in insp(fpage)


def test_a_failed_read_says_so_and_leaves_the_button(fpage, mock):
    open_query(fpage, NORMAL["txid"])
    select(fpage, INPUT_ADDR)                                                       # no route for it: the server answers 404 (the fixture's own address is SMALL_ADDR, which has one)
    fpage.click("#inspBody button:has-text('Load balance')"); idle(fpage); settle(fpage)
    assert "failed" in toast_text(fpage).lower() or "404" in toast_text(fpage)
    assert "not loaded yet: press Load balance to read it" in insp(fpage) and fpage.locator("#inspBody button:has-text('Load balance')").count() == 1, "it says what to press"


def test_several_selected_wallets_get_a_list_of_balances_largest_first_and_a_total(fpage, mock):
    open_query(fpage, NORMAL["txid"])
    fpage.uncheck("#focusOn"); settle(fpage)
    stats(mock, BIG_ADDR, 900000, 400000)         # 500000
    stats(mock, SMALL_ADDR, 200000, 150000)       # 50000
    select(fpage, BIG_ADDR, SMALL_ADDR, INPUT_ADDR)
    t = insp(fpage)
    assert "BALANCES (3 WALLETS)" in t.upper() and "3 wallets: balances not loaded yet. Press Load 3 balances to read them." in t
    fpage.click("#inspBody button:has-text('Load 3 balances')"); idle(fpage); settle(fpage)
    fpage.wait_for_function("() => document.getElementById('toast').textContent.length > 0")
    t = insp(fpage)
    rows = fpage.locator("#inspBody .balrow .amt").all_inner_texts()
    assert rows[:2] == ["0.00500000 BTC", "0.00050000 BTC"], rows
    assert "Total of 2" in t and "0.00550000 BTC" in t
    assert "1 wallet not loaded yet: press Load 1 balance to read it." in t and fpage.locator("#inspBody button:has-text('Load 1 balance')").count() == 1, "the one the server did not know stays marked"


def test_the_balance_is_valued_at_todays_price_when_a_currency_is_chosen(fpage, mock):
    open_query(fpage, NORMAL["txid"])
    stats(mock, SMALL_ADDR, 100000000, 0)                                           # exactly 1 BTC
    select(fpage, SMALL_ADDR)
    fpage.click("#inspBody button:has-text('Load balance')"); idle(fpage); settle(fpage)
    fpage.select_option("#fiatCur", "USD")
    fpage.wait_for_function("() => /history to|today|Could not|need/i.test(document.getElementById('fiatStatus').textContent)"); settle(fpage)
    fx = fpage.locator("#inspBody dd:has-text('1.00000000 BTC') .fiat").first
    assert "$82,052.00" in fx.inner_text(), "1 BTC at the fixture's price today"
    assert "per BTC today" in (fx.get_attribute("title") or "")


def test_balances_are_in_the_exports_the_session_and_the_report(fpage, mock, tmp_path):
    open_query(fpage, NORMAL["txid"])
    fpage.uncheck("#focusOn"); settle(fpage)
    stats(mock, SMALL_ADDR, 200000, 150000)
    select(fpage, SMALL_ADDR)
    fpage.click("#inspBody button:has-text('Load balance')"); idle(fpage); settle(fpage)

    def export(kind, name):
        fpage.evaluate("() => { document.getElementById('exportMenu').open = true; }")
        with fpage.expect_download() as dl:
            fpage.click("[data-export=%s]" % kind)
        p = tmp_path / name; dl.value.save_as(p); return p

    rows = list(csv.reader(io.StringIO(export("csv-nodes", "n.csv").read_text(encoding="utf-8-sig"), newline="")))
    h = rows[0]; by = {r[0]: r for r in rows[1:]}
    assert by["addr:" + SMALL_ADDR][h.index("balance_sat")] == "50000" and by["addr:" + SMALL_ADDR][h.index("balance_pending_sat")] == "0"
    assert re.match(r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC", by["addr:" + SMALL_ADDR][h.index("balance_as_of_utc")])
    assert by["addr:" + BIG_ADDR][h.index("balance_sat")] == "", "empty where it was never read"
    html = export("report", "r.html").read_text(encoding="utf-8")
    assert "<th>Balance</th>" in html and "0.00050000 BTC" in html and "not read" in html and "as of 20" in html
    fpage.wait_for_timeout(1100)
    fpage.reload(); fpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    fpage.click("#restoreYes"); fpage.wait_for_function("() => window.__hopline.state.graph.nodes.size > 0"); settle(fpage)
    select(fpage, SMALL_ADDR)
    assert "0.00050000 BTC" in insp(fpage) and "not loaded yet" not in insp(fpage), "kept with the session"


def test_hostile_balance_values_in_an_imported_file_are_dropped(fpage, mock):
    open_query(fpage, NORMAL["txid"])
    stats(mock, SMALL_ADDR, 200000, 150000)
    select(fpage, SMALL_ADDR)
    fpage.click("#inspBody button:has-text('Load balance')"); idle(fpage); settle(fpage)
    doc = json.loads(fpage.evaluate("() => HoplineIO.toJson(window.__hopline.state.graph)"))
    node = next(n for n in doc["nodes"] if n["id"] == "addr:" + SMALL_ADDR)
    node.update({"fundedSum": -5, "spentSum": 1.5, "mempoolFundedSum": 10 ** 20, "statsAt": "now", "statsSource": "javascript:alert(1)"})
    fpage.click("#btnClear"); fpage.click("#btnClear"); settle(fpage)
    fpage.evaluate("(text) => { const f = new File([text], 'w.json'); const dt = new DataTransfer(); dt.items.add(f); const i = document.getElementById('fileImport'); i.files = dt.files; i.dispatchEvent(new Event('change')); }", json.dumps(doc))
    fpage.wait_for_function("() => window.__hopline.state.graph.nodes.size > 0"); settle(fpage)
    n = fpage.evaluate("(a) => window.__hopline.state.graph.nodes.get('addr:' + a)", SMALL_ADDR)
    assert all(k not in n for k in ("fundedSum", "spentSum", "mempoolFundedSum", "statsAt", "statsSource"))
    select(fpage, SMALL_ADDR)
    assert "not loaded yet" in insp(fpage)
