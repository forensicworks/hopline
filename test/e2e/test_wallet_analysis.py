"""The wallet page: the balance over time, the biggest counterparties, "Trace from here" and the whole wallet (addresses spent together)."""
import json
import re
from urllib.parse import unquote

import pytest

from chains import IN, OUT, addr, real_addr, tid, tx
from conftest import ADDRESS
from test_copy import capture, copied
from test_wallet_history import OTHER, W, count, history, to, type_in, utc
from test_wallet_page import goto, wpage  # noqa: F401  (the fixture is used by name)


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def funded(mock, n):
    """The wallet's own totals agree with history(): it received every payment and spent nothing."""
    mock.routes["/address/" + W]["chain_stats"]["funded_txo_sum"] = sum(10000 + i * 1000 for i in range(n))


def points(page):
    return page.evaluate("() => window.__wallet.chart.pts.map((q) => [q.x, q.y, q.p.txid, q.p.balance, q.p.net])")


def over(page, k):
    page.locator("#chart").scroll_into_view_if_needed()                                    # clicking elsewhere may have scrolled it away
    box = page.locator("#chart").bounding_box(); p = points(page)[k]
    page.mouse.move(box["x"] + p[0], box["y"] + p[1])
    return box["x"] + p[0], box["y"] + p[1]


def in_view(page, txid):
    return page.evaluate("""(id) => { const c = Array.from(document.querySelectorAll('#ledger .tx')).find((e) => e.dataset.txid === id);
                                      if (!c) return false; const r = c.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight + 2; }""", txid)


# ---- the balance over time ----------------------------------------------------------------------------------------------------------------------

def test_the_chart_is_drawn_from_the_balance_after_each_transaction(wpage, mock):
    history(mock, 25); funded(mock, 25)
    goto(wpage)
    assert wpage.is_visible("#chartSec")
    p = points(wpage)
    assert len(p) == 25
    xs = [q[0] for q in p]; ys = [q[1] for q in p]
    assert xs == sorted(xs) and xs[0] < xs[-1], "oldest on the left"
    assert ys == sorted(ys, reverse=True) and ys[0] > ys[-1], "the balance only went up here, so the line only climbs"
    assert [q[3] for q in p][-1] == 550000 and p[0][3] == 10000
    painted = wpage.evaluate("() => { const c = document.getElementById('chart'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; }")
    assert painted > 800, "something was drawn"
    text = wpage.inner_text("#chartText")
    assert "25 confirmed transactions loaded" in text and "Highest 0.00550000 BTC" in text and "lowest 0.00000000 BTC" in text
    assert "Only part of the history" not in text, "all 25 of 25 are loaded"
    assert "Balance over time" in wpage.get_attribute("#chart", "aria-label") and "Highest" in wpage.get_attribute("#chart", "aria-label")


def test_hovering_a_point_names_the_transaction_and_what_was_left(wpage, mock):
    history(mock, 25); funded(mock, 25)
    goto(wpage)
    assert wpage.is_hidden("#chartTip")
    over(wpage, 4)
    wpage.wait_for_selector("#chartTip:not([hidden])")
    tip = wpage.inner_text("#chartTip")
    assert "Balance after: 0.00060000 BTC" in tip and "+0.00014000 BTC" in tip and tid(104)[:8] in tip and "block 700004" in tip and "UTC" in tip
    assert wpage.is_visible("#chartDot")
    wpage.mouse.move(5, 5)
    assert wpage.is_hidden("#chartTip") and wpage.is_hidden("#chartDot")


def test_clicking_a_point_scrolls_to_its_card_and_marks_it(wpage, mock):
    history(mock, 25); funded(mock, 25)
    goto(wpage)
    x, y = over(wpage, 4)
    wpage.mouse.click(x, y)
    wpage.wait_for_function("(id) => { const c = document.querySelector('#ledger .tx.flash'); return !!c && c.dataset.txid === id; }", arg=tid(104))
    assert in_view(wpage, tid(104))
    wpage.wait_for_function("() => !document.querySelector('#ledger .tx.flash')", timeout=6000)


def test_a_point_whose_card_is_not_drawn_or_is_filtered_out_is_brought_into_view(wpage, mock):
    history(mock, 125); funded(mock, 125)
    goto(wpage)
    wpage.evaluate("() => { document.getElementById('loadCap').value = 500; }")
    wpage.click("#loadAll"); wpage.wait_for_function("() => /whole history is here/.test(document.getElementById('message').textContent)", timeout=60000)
    assert count(wpage) == 100 and wpage.locator('#ledger .tx[data-txid="%s"]' % tid(100)).count() == 0, "the oldest is beyond the first hundred cards"
    x, y = over(wpage, 0)
    wpage.mouse.click(x, y)
    wpage.wait_for_selector('#ledger .tx.flash[data-txid="%s"]' % tid(100))
    assert count(wpage) == 125
    type_in(wpage, tid(113)[:10])
    assert count(wpage) == 1
    x, y = over(wpage, 60)
    wpage.mouse.click(x, y)
    wpage.wait_for_selector('#ledger .tx.flash[data-txid="%s"]' % tid(160))
    assert wpage.input_value("#fText") == "" and count(wpage) == 100, "the search that hid it is cleared (and the first hundred are drawn again)"


def test_with_only_part_of_the_history_loaded_the_chart_says_so(wpage, mock):
    history(mock, 125); funded(mock, 125)
    goto(wpage)
    assert len(points(wpage)) == 25
    assert "Only part of the history is loaded" in wpage.inner_text("#chartText")
    first = points(wpage)[0]
    assert first[3] == sum(10000 + i * 1000 for i in range(125)) - sum(10000 + i * 1000 for i in range(101, 125)), "worked back from today's balance"


def test_the_arrow_keys_walk_along_the_chart_and_enter_finds_the_transaction(wpage, mock):
    history(mock, 25); funded(mock, 25)
    goto(wpage)
    wpage.focus("#chart")
    wpage.keyboard.press("End"); assert tid(124)[:8] in wpage.inner_text("#chartTip")
    wpage.keyboard.press("ArrowLeft"); assert tid(123)[:8] in wpage.inner_text("#chartTip")
    wpage.keyboard.press("Home"); assert tid(100)[:8] in wpage.inner_text("#chartTip")
    wpage.keyboard.press("ArrowLeft"); assert tid(100)[:8] in wpage.inner_text("#chartTip"), "stops at the first"
    wpage.keyboard.press("Enter")
    wpage.wait_for_selector('#ledger .tx.flash[data-txid="%s"]' % tid(100))


def test_the_chart_follows_the_width_of_the_page(wpage, mock):
    history(mock, 25); funded(mock, 25)
    goto(wpage)
    wide = wpage.evaluate("() => window.__wallet.chart.w")
    assert wide > 900
    wpage.set_viewport_size({"width": 640, "height": 800})
    wpage.wait_for_function("() => window.__wallet.chart.w < 640", timeout=5000)
    assert wpage.evaluate("() => window.__wallet.chart.pts.every((q) => q.x <= window.__wallet.chart.w)")


def test_a_wallet_with_nothing_confirmed_has_no_chart(wpage, mock):
    tx(mock, 300, [IN(1, 0, "x", 5000)], [to(W, 4000)])
    mock.routes["/tx/" + tid(300)]["status"] = {"confirmed": False}
    mock.routes["/address/" + W] = {"address": W, "chain_stats": {"funded_txo_count": 0, "funded_txo_sum": 0, "spent_txo_count": 0, "spent_txo_sum": 0, "tx_count": 0},
                                    "mempool_stats": {"funded_txo_count": 1, "funded_txo_sum": 4000, "spent_txo_count": 0, "spent_txo_sum": 0, "tx_count": 1}}
    mock.routes["/address/" + W + "/txs"] = [mock.routes["/tx/" + tid(300)]]
    goto(wpage)
    assert count(wpage) == 1 and wpage.is_hidden("#chartSec")


def test_the_fixture_wallet_draws_a_chart_that_ends_at_nothing(wpage):
    goto(wpage)
    p = points(wpage)
    assert len(p) == 8 and p[-1][3] == 0, "the wallet ended empty"
    assert "8 confirmed transactions loaded" in wpage.inner_text("#chartText")


# ---- the biggest counterparties -------------------------------------------------------------------------------------------------------------------

def test_the_biggest_counterparties_come_first_with_their_names_and_how_much_they_moved(wpage, mock):
    history(mock, 25); funded(mock, 25)
    goto(wpage)
    rows = wpage.locator("#cp .cprow")
    assert rows.count() == 10 and wpage.is_visible("#cpSec")
    first = rows.first
    assert first.get_attribute("data-address") == OTHER
    text = first.inner_text()
    assert "Robinhood Hot Wallet" in text and "3 transactions" in text and "paid in 0.00090000 BTC" in text and "0.00090000 BTC" in first.locator(".vol").inner_text()
    assert first.locator(".rank").inner_text() == "1" and rows.nth(1).locator(".rank").inner_text() == "2"
    vols = [int(float(v.replace(" BTC", "")) * 1e8 + 0.5) for v in wpage.eval_on_selector_all("#cp .cprow .vol", "els => els.map(e => e.textContent)")]
    assert vols == sorted(vols, reverse=True), "biggest first"
    widths = wpage.eval_on_selector_all("#cp .cprow .bar i", "els => els.map(e => parseInt(e.style.width))")
    assert widths[0] == 100 and widths == sorted(widths, reverse=True) and min(widths) >= 2
    assert first.locator("a.mono").get_attribute("href") == "wallet.html?q=" + OTHER


def test_more_counterparties_are_ten_at_a_time(wpage, mock):
    history(mock, 25); funded(mock, 25)
    goto(wpage)
    assert wpage.inner_text("#cpMore") == "Show 10 more (13 not shown)"
    wpage.click("#cpMore")
    assert wpage.locator("#cp .cprow").count() == 20 and wpage.inner_text("#cpMore") == "Show 3 more (3 not shown)"
    wpage.click("#cpMore")
    assert wpage.locator("#cp .cprow").count() == 23 and wpage.is_hidden("#cpMore")


def test_the_transactions_button_shows_only_the_ones_with_that_wallet(wpage, mock):
    history(mock, 25); funded(mock, 25)
    goto(wpage)
    wpage.locator("#cp .cprow").first.locator("button").click()
    wpage.wait_for_function("() => document.querySelectorAll('#ledger .tx').length === 3")
    assert wpage.input_value("#fText") == OTHER and "3 of 25 loaded match" in wpage.inner_text("#fCount")


def test_a_wallet_on_a_sanctions_list_is_marked_and_a_hostile_name_stays_text(ctx, wpage, mock):
    bad = real_addr(21)
    tx(mock, 400, [IN(1, 0, "x", 90000)], [to(W, 80000)])
    mock.routes["/tx/" + tid(400)]["vin"][0]["prevout"]["scriptpubkey_address"] = bad
    mock.routes["/address/" + W + "/txs"] = [mock.routes["/tx/" + tid(400)]]
    mock.routes["/address/" + W] = {"address": W, "chain_stats": {"funded_txo_count": 1, "funded_txo_sum": 80000, "spent_txo_count": 0, "spent_txo_sum": 0, "tx_count": 1},      # a new dict: the fixture's own is shared by every test
                                    "mempool_stats": {"funded_txo_count": 0, "funded_txo_sum": 0, "spent_txo_count": 0, "spent_txo_sum": 0, "tx_count": 0}}
    pack = [{"id": "p1", "name": "Case list", "enabled": True, "sanctions": True, "entries": [[bad, "<img src=x onerror=window.__pwned=1>"]]}]
    ctx.add_init_script("localStorage.setItem('hopline.packs.v1', %s);" % json.dumps(json.dumps(pack)))
    goto(wpage)
    row = wpage.locator("#cp .cprow")
    assert row.count() == 1 and "sanctioned" in row.get_attribute("class") and "sanctions list" in row.inner_text()
    assert "<img src=x" in row.inner_text() and wpage.locator("#cp img").count() == 0 and wpage.evaluate("() => window.__pwned") is None


# ---- trace from here ----------------------------------------------------------------------------------------------------------------------------

def test_ticking_transactions_makes_a_link_that_starts_a_trace_with_the_wallet_and_those(wpage, mock):
    history(mock, 25); funded(mock, 25)
    goto(wpage)
    assert wpage.is_hidden("#pickBar") and wpage.locator("#ledger input[data-pick]").count() == 25
    wpage.check('#ledger .tx[data-txid="%s"] input[data-pick]' % tid(105))
    wpage.check('#ledger .tx[data-txid="%s"] input[data-pick]' % tid(103))
    assert wpage.is_visible("#pickBar") and "2 transactions ticked" in wpage.inner_text("#pickText")
    href = wpage.get_attribute("#pickGo", "href")
    assert href.startswith("workspace.html?q=") and unquote(href.split("q=", 1)[1]) == " ".join([W, tid(105), tid(103)]), "the wallet first, then in the order ticked"
    wpage.uncheck('#ledger .tx[data-txid="%s"] input[data-pick]' % tid(105))
    assert "1 transaction ticked" in wpage.inner_text("#pickText") and unquote(wpage.get_attribute("#pickGo", "href").split("q=", 1)[1]) == W + " " + tid(103)
    wpage.click("#pickClear")
    assert wpage.is_hidden("#pickBar") and wpage.locator("#ledger input[data-pick]:checked").count() == 0


def test_the_workspace_opens_in_a_trace_from_the_wallet_and_the_ticked_transactions(wpage, mock):
    history(mock, 25); funded(mock, 25)
    goto(wpage)
    wpage.check('#ledger .tx[data-txid="%s"] input[data-pick]' % tid(105))
    wpage.check('#ledger .tx[data-txid="%s"] input[data-pick]' % tid(103))
    wpage.click("#pickGo")
    wpage.wait_for_url("**/workspace.html?q=*")
    wpage.wait_for_function("() => window.__hopline && window.__hopline.state.trace.seeds.length >= 3", timeout=40000)
    seeds = wpage.evaluate("() => window.__hopline.state.trace.seeds")
    assert seeds == ["addr:" + W, "tx:" + tid(105), "tx:" + tid(103)] and wpage.evaluate("() => window.__hopline.state.layout") == "trace"


def test_the_ticks_stay_through_a_search_and_at_most_nine_fit(wpage, mock):
    history(mock, 25); funded(mock, 25)
    goto(wpage)
    for i in range(9):
        wpage.check('#ledger .tx[data-txid="%s"] input[data-pick]' % tid(110 + i))
    tenth = wpage.locator('#ledger .tx[data-txid="%s"] input[data-pick]' % tid(120))
    tenth.click()
    assert not tenth.is_checked() and "At most 9 transactions" in wpage.inner_text("#message")
    assert "9 transactions ticked" in wpage.inner_text("#pickText")
    type_in(wpage, tid(112)[:10])
    assert count(wpage) == 1 and wpage.locator("#ledger input[data-pick]").first.is_checked()
    wpage.click("#fClear")
    assert wpage.locator("#ledger input[data-pick]:checked").count() == 9
    q = unquote(wpage.get_attribute("#pickGo", "href").split("q=", 1)[1]).split(" ")
    assert len(q) == 10 and q[0] == W


def test_tick_shown_takes_the_first_ones_that_match_and_says_what_did_not_fit(wpage, mock):
    history(mock, 25); funded(mock, 25)
    goto(wpage)
    wpage.click("#pickShown")
    assert "Ticked 9 transactions; 16 more shown are not ticked" in wpage.inner_text("#message")
    assert unquote(wpage.get_attribute("#pickGo", "href").split("q=", 1)[1]).split(" ")[1] == tid(124), "the newest shown first"
    wpage.click("#pickShown")
    assert "At most 9 transactions can be ticked" in wpage.inner_text("#message")
    wpage.click("#pickClear")
    type_in(wpage, "robinhood")
    wpage.click("#pickShown")
    assert "Ticked 3 transactions." in wpage.inner_text("#message") and "3 transactions ticked" in wpage.inner_text("#pickText")
    wpage.click("#pickShown")
    assert "ticked already" in wpage.inner_text("#message")
    type_in(wpage, "no-such-thing")
    wpage.click("#pickShown")
    assert "Nothing is shown to tick" in wpage.inner_text("#message")


# ---- the whole wallet ----------------------------------------------------------------------------------------------------------------------------

X1, X2, X3 = addr("x1"), addr("x2"), addr("x3")


def spend(n, addrs, out, value=20000, time=None):
    return {"txid": tid(n), "fee": 150, "weight": 800, "status": {"confirmed": True, "block_height": 700000 + n, "block_time": (time or utc(2022, 4, 1)) + n},
            "vin": [{"txid": tid(n - 100 + i), "vout": 0, "is_coinbase": False, "prevout": {"scriptpubkey_address": a, "scriptpubkey_type": "v0_p2wpkh", "value": value}} for i, a in enumerate(addrs)],
            "vout": [{"scriptpubkey_address": out, "scriptpubkey_type": "v0_p2wpkh", "value": value * len(addrs) - 150}]}


def serve(mock, address, txs, balance=None):
    mock.routes["/address/" + address + "/txs"] = txs
    if balance is not None:
        mock.routes["/address/" + address] = {"address": address, "chain_stats": {"funded_txo_count": 1, "funded_txo_sum": balance, "spent_txo_count": 0, "spent_txo_sum": 0, "tx_count": len(txs)},
                                              "mempool_stats": {"funded_txo_count": 0, "funded_txo_sum": 0, "spent_txo_count": 0, "spent_txo_sum": 0, "tx_count": 0}}


def ring(mock):
    """W signed one transaction with X1 and X2; X2 signed another with X3, which W's own history does not show."""
    a = spend(200, [W, X1, X2], addr("shop"))
    receipt = spend(201, [addr("payer")], W, time=utc(2022, 3, 1))
    b = spend(202, [X2, X3], addr("shop2"))
    serve(mock, W, [a, receipt], balance=50000)
    serve(mock, X1, [a], balance=5000); serve(mock, X2, [b, a], balance=7000); serve(mock, X3, [b], balance=9000)
    return a, b


def members(page):
    return page.eval_on_selector_all("#clList .clrow", "els => els.map(e => e.dataset.address)")


def test_the_wallet_and_those_spent_with_it_are_listed_from_what_is_loaded(wpage, mock):
    ring(mock)
    goto(wpage)
    assert wpage.is_visible("#clusterSec")
    assert "This wallet and 2 others signed the same transactions (1 transaction joined them)" in wpage.inner_text("#clIntro")
    assert members(wpage) == [W, X1, X2] and "this wallet" in wpage.locator("#clList .clrow").first.inner_text()
    assert wpage.locator("#clList .clrow").nth(1).locator("a").get_attribute("href") == "wallet.html?q=" + X1
    assert "A guess, not proof" in wpage.inner_text("#clusterSec") and "CoinJoin" in wpage.inner_text("#clusterSec")


def test_look_further_loads_the_newest_transactions_of_the_others_and_the_group_grows(wpage, mock):
    ring(mock)
    goto(wpage)
    before = len(mock.requests)
    wpage.click("#clLook")
    wpage.wait_for_function("() => /Looked at 2 wallets/.test(document.getElementById('message').textContent)", timeout=30000)
    assert "the group grew from 3 to 4 wallets" in wpage.inner_text("#message")
    asked = [p for h, p in mock.requests[before:]]
    assert asked == ["/address/%s/txs" % X1, "/address/%s/txs" % X2], asked
    assert members(wpage) == [W, X1, X2, X3] and "2 transactions joined them" in wpage.inner_text("#clIntro") and "3 others" in wpage.inner_text("#clIntro")
    assert wpage.is_hidden("#clBar")
    wpage.click("#clLook")
    wpage.wait_for_function("() => /Looked at 1 wallet:/.test(document.getElementById('message').textContent)", timeout=30000)
    assert "did not grow (4 wallets)" in wpage.inner_text("#message")
    wpage.click("#clLook")
    assert "loaded already" in wpage.inner_text("#message")
    looked = wpage.eval_on_selector_all("#clList .clrow", "els => els.map(e => /newest transactions loaded/.test(e.textContent))")
    assert looked == [False, True, True, True]
    assert count(wpage) == 2, "the wallet's own list is not changed by looking at the others"


def test_read_balances_asks_for_each_wallet_and_adds_them_up(wpage, mock):
    ring(mock)
    goto(wpage)
    wpage.click("#clLook"); wpage.wait_for_function("() => /Looked at/.test(document.getElementById('message').textContent)", timeout=30000)
    assert wpage.is_hidden("#clTotal")
    wpage.click("#clBalances")
    wpage.wait_for_function("() => /Read 3 balances/.test(document.getElementById('message').textContent)", timeout=30000)
    rows = wpage.eval_on_selector_all("#clList .clrow .nums", "els => els.map(e => e.textContent)")
    assert rows == ["0.00050000 BTC", "0.00005000 BTC", "0.00007000 BTC", "0.00009000 BTC"]
    assert "Together the 4 wallets read hold 0.00071000 BTC" in wpage.inner_text("#clTotal") and "not read yet" not in wpage.inner_text("#clTotal")
    wpage.click("#clBalances")
    assert "read already" in wpage.inner_text("#message")


def test_cancel_stops_after_the_request_in_flight_and_keeps_what_came(wpage, mock):
    others = [addr("m%02d" % i) for i in range(15)]
    joint = spend(210, [W] + others, addr("shop"))
    serve(mock, W, [joint], balance=1000)
    for a in others:
        serve(mock, a, [joint])
    goto(wpage)
    mock.delay_ms = 200
    wpage.click("#clLook")
    wpage.wait_for_selector("#clBar:not([hidden])")
    assert re.search(r"Loading transactions: \d+ of 15", wpage.inner_text("#clText")) and wpage.is_disabled("#clLook") and wpage.is_disabled("#clBalances")
    wpage.click("#clCancel")
    wpage.wait_for_function("() => document.getElementById('clBar').hidden", timeout=30000)
    n = int(re.search(r"Stopped after (\d+) request", wpage.inner_text("#message")).group(1))
    assert 1 <= n < 15, n
    assert wpage.evaluate("() => window.__wallet.cluster.looked.size") == n and wpage.is_enabled("#clLook"), "what came is kept, and looking can go on"


def test_a_failure_part_way_is_said_and_what_was_loaded_is_kept(wpage, mock):
    ring(mock)
    goto(wpage)
    mock.fail["/address/%s/txs" % X2] = 500
    wpage.click("#clLook")
    wpage.wait_for_function("() => /Could not load the transactions of/.test(document.getElementById('message').textContent)", timeout=60000)
    assert "What was loaded so far is kept" in wpage.inner_text("#message") and "bad" in (wpage.get_attribute("#message", "class") or "")
    assert wpage.evaluate("() => Array.from(window.__wallet.cluster.looked)") == [X1] and wpage.is_enabled("#clLook")


def test_copy_and_open_in_workspace_use_the_members(wpage, mock):
    ring(mock)
    goto(wpage)
    capture(wpage)
    wpage.click("#clCopy")
    assert copied(wpage) == ["\n".join([W, X1, X2])] and "Copied 3 addresses" in wpage.inner_text("#message")
    href = wpage.get_attribute("#clOpen", "href")
    assert unquote(href.split("q=", 1)[1]) == " ".join([W, X1, X2]) and "Open in workspace" in wpage.inner_text("#clOpen")


def test_a_long_group_is_listed_twelve_at_a_time_and_the_workspace_gets_the_first_ten(wpage, mock):
    others = [addr("m%02d" % i) for i in range(15)]
    serve(mock, W, [spend(210, [W] + others, addr("shop"))], balance=1000)
    goto(wpage)
    assert len(members(wpage)) == 12 and wpage.inner_text("#clMore") == "Show 4 more (4 not shown)"
    wpage.click("#clMore")
    assert len(members(wpage)) == 16 and wpage.is_hidden("#clMore")
    assert "Open the first 10 in the workspace" in wpage.inner_text("#clOpen")
    assert len(unquote(wpage.get_attribute("#clOpen", "href").split("q=", 1)[1]).split(" ")) == 10


def test_a_coinjoin_looking_transaction_joins_nothing_and_is_counted(wpage, mock):
    ins = [W, addr("w1"), addr("w2"), addr("w3"), addr("w4")]
    mix = spend(220, ins, addr("e0"), value=1000000)
    mix["vout"] = [{"scriptpubkey_address": addr("e%d" % i), "scriptpubkey_type": "v0_p2wpkh", "value": 1000000} for i in range(5)] + [
        {"scriptpubkey_address": addr("chg1"), "scriptpubkey_type": "v0_p2wpkh", "value": 1234}, {"scriptpubkey_address": addr("chg2"), "scriptpubkey_type": "v0_p2wpkh", "value": 4321}]
    serve(mock, W, [mix], balance=1000)
    goto(wpage)
    assert "No other wallet was spent together with this one in the 1 loaded transactions" in wpage.inner_text("#clIntro")
    assert "1 transaction that looks like a CoinJoin was left out" in wpage.inner_text("#clIntro")
    assert members(wpage) == [W] and wpage.is_hidden("#clLook") and wpage.is_hidden("#clBalances") and wpage.is_hidden("#clCopy") and wpage.is_hidden("#clOpen")


def test_a_wallet_in_the_group_that_is_on_a_sanctions_list_is_called_out(ctx, wpage, mock):
    listed = real_addr(31)
    a = spend(230, [W, listed], addr("shop"))
    serve(mock, W, [a], balance=1000)
    pack = [{"id": "p1", "name": "Case list", "enabled": True, "sanctions": True, "entries": [[listed, "Listed person"]]}]
    ctx.add_init_script("localStorage.setItem('hopline.packs.v1', %s);" % json.dumps(json.dumps(pack)))
    goto(wpage)
    assert wpage.is_visible("#clSanction") and "One wallet in this group is on a sanctions list" in wpage.inner_text("#clSanction")
    row = wpage.locator('#clList .clrow[data-address="%s"]' % listed)
    assert "Listed person" in row.inner_text() and "sanctions list" in row.inner_text() and "sanctioned" in row.get_attribute("class")


def test_a_wallet_nothing_was_spent_with_is_a_group_of_one(wpage, mock):
    history(mock, 25); funded(mock, 25)
    goto(wpage)
    assert "No other wallet was spent together with this one in the 25 loaded transactions." in wpage.inner_text("#clIntro")
    assert members(wpage) == [W] and wpage.is_hidden("#clLook") and wpage.is_visible("#clusterSec")
