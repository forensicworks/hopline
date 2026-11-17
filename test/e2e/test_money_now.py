"""Where the money is now: the Findings group that follows the money that reached the reference, coin by coin, and accounts for every satoshi.

A victim pays the reference wallet 60,000 sat. It passes 30,000 to a and 29,000 to b (1,000 sat fee); a passes 28,500 to c (1,500 sat fee). b rests. Nobody asked the server about c's coin.
"""
import pytest

from chains import IN, OUT, addr, tid, tx
from helpers import idle, open_query, selected, settle, show_findings, toast_text
from test_time_evidence import report_html  # noqa: F401


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def fix_fee(mock, n):
    """The fee of a transaction is what goes in less what comes out: the made-up ones say 150 whatever they hold."""
    r = mock.routes["/tx/" + tid(n)]
    r["fee"] = sum(v["prevout"]["value"] for v in r["vin"]) - sum(o["value"] for o in r["vout"])


def scene(page, mock, tx3_ins=None, outs3=None, unread=True, fix3=True, times=None):
    tx(mock, 1, [IN(90, 0, "victim", 70000)], [OUT("ref", 60000), OUT("victim", 9800)], spent={0: 2})
    tx(mock, 2, [IN(1, 0, "ref", 60000)], [OUT("a", 30000), OUT("b", 29000)], spent={0: 3})
    tx(mock, 3, tx3_ins or [IN(2, 0, "a", 30000)], outs3 or [OUT("c", 28500)])
    for n in (1, 2, 3) if fix3 else (1, 2):
        fix_fee(mock, n)
    for n, when in (times or {}).items():                                         # the block time of a transaction, to space them out
        mock.routes["/tx/" + tid(n)]["status"]["block_time"] = when
    if unread:
        mock.fail["/tx/" + tid(3) + "/outspends"] = 500                      # the spends of the last transaction cannot be read: its coin is "not checked"
    open_query(page, tid(1)); settle(page)
    for ex in ("tx:" + tid(1), "addr:" + addr("ref"), "addr:" + addr("a")):
        page.evaluate("(id) => window.__hopline.traceExpand(id, 'next')", ex); idle(page); settle(page)
    page.evaluate("(ids) => window.__hopline.setSel(ids)", ["addr:" + addr("ref")]); settle(page)
    page.click("#inspBody .relbtn[data-use-ref]"); settle(page)              # the reference: the wallet the victim paid
    show_findings(page); settle(page)


def findings(page):
    return page.inner_text("#anFindings")


def test_the_group_accounts_for_every_satoshi_and_says_what_it_does_not_know(tpage, mock):
    scene(tpage, mock)
    t = findings(tpage)
    assert "Where the money is now" in t or "WHERE THE MONEY IS NOW" in t
    assert "The money that reached" in t and "0.00060000 BTC in this graph" in t
    assert "Resting · 1 coin in 1 wallet" in t and "0.00029000 BTC" in t
    assert "Not checked · 1 coin in 1 wallet" in t and "0.00028500 BTC" in t
    assert "Fees on the way: 2,500 sat in 2 transactions." in t
    assert "Received 0.00060000 BTC = the places above + fees: everything that was received is accounted for." in t
    assert "Moved on" not in t and "Mixed with other money" not in t, "what is not there is not listed"


def test_checking_the_coin_nobody_asked_about_settles_it_and_asks_one_request_for_it(tpage, mock):
    scene(tpage, mock)
    assert tpage.inner_text("#btnMoneyCheck") == "Check 1 coin (1 request)"
    del mock.fail["/tx/" + tid(3) + "/outspends"]
    mock.requests.clear()
    tpage.click("#btnMoneyCheck")
    tpage.wait_for_function("() => /Resting now/.test(document.getElementById('toast').textContent)", timeout=15000); idle(tpage); settle(tpage)
    asked = [p for _, p in mock.requests if p.endswith("/outspends")]
    assert asked == ["/tx/%s/outspends" % tid(3)], asked
    t = findings(tpage)
    assert "Resting · 2 coins in 2 wallets" in t and "0.00057500 BTC" in t, t
    assert "Not checked" not in t and tpage.locator("#btnMoneyCheck").count() == 0
    assert "everything that was received is accounted for" in t
    assert "Resting now: 0.00057500 BTC (0.00029000 BTC before); not checked: 0.00000000 BTC" in toast_text(tpage)
    assert tpage.evaluate("(id) => window.__hopline.state.graph.nodes.get(id).spendsCheckedAt > 0", "tx:" + tid(3))
    assert tpage.inner_text("#btnMoneyRecheck") == "Check the resting coins again (2 requests)"


def test_a_coin_that_was_spent_by_a_transaction_that_is_not_loaded_is_moved_on(tpage, mock):
    scene(tpage, mock)
    del mock.fail["/tx/" + tid(3) + "/outspends"]
    mock.routes["/tx/" + tid(3) + "/outspends"] = [{"spent": True, "txid": tid(77), "vin": 0, "status": {"confirmed": True, "block_height": 700077, "block_time": 1650046200}}]
    tpage.click("#btnMoneyCheck")
    tpage.wait_for_function("() => /Resting now/.test(document.getElementById('toast').textContent)", timeout=15000); idle(tpage); settle(tpage)
    t = findings(tpage)
    assert "Moved on, not followed · 1 coin in 1 wallet" in t and "0.00028500 BTC" in t and "Not checked" not in t
    assert "Resting · 1 coin in 1 wallet" in t and "everything that was received is accounted for" in t
    assert "moved on: 0.00028500 BTC" in toast_text(tpage)


def test_money_spent_together_with_other_money_is_mixed_and_not_followed(tpage, mock):
    scene(tpage, mock, tx3_ins=[IN(2, 0, "a", 30000), IN(91, 0, "z", 20000)], outs3=[OUT("c", 48500)], unread=False)
    t = findings(tpage)
    assert "Mixed with other money: 1 transaction spent 0.00030000 BTC of these coins together with 0.00020000 BTC from others." in t, t
    assert "Resting · 1 coin in 1 wallet" in t and "Not checked" not in t, "c was not followed"
    assert "Fees on the way: 1,000 sat in 1 transaction." in t and "everything that was received is accounted for" in t


def test_pressing_a_row_selects_its_wallets(tpage, mock):
    scene(tpage, mock)
    tpage.locator("#anFindings .linkrow", has_text="Resting · 1 coin in 1 wallet").first.click(); settle(tpage)
    assert selected(tpage) == ["addr:" + addr("b")]


def test_the_report_has_the_table_and_says_whether_it_adds_up(tpage, mock, tmp_path):
    scene(tpage, mock)
    html = report_html(tpage, tmp_path, False)
    assert "<h2>Where the money is now</h2>" in html and "0.00060000 BTC in this report" in html
    assert "Resting (unspent)" in html and "Not checked" in html and "not known whether spent" in html
    assert "<th>Received</th><th></th><th class=\"num\">0.00060000 BTC</th><th>Everything received is accounted for.</th>" in html
    assert "2,500 sat" in html and addr("b") in html and addr("c") in html
    assert "A coin <i>not checked</i> is one nobody asked the server about" in html


def test_with_nothing_loaded_there_is_no_group(tpage, mock):
    show_findings(tpage)
    assert "money is now" not in findings(tpage).lower()


def test_a_transaction_whose_own_numbers_disagree_makes_the_group_say_it_does_not_add_up(tpage, mock):
    scene(tpage, mock, unread=False, fix3=False)                                      # its fee says 150 where the money in and out says 1,500
    t = findings(tpage)
    assert "Does not add up: received 0.00060000 BTC, accounted for 0.00058650 BTC (1,350 sat unaccounted). The data of a transaction disagrees with itself." in t, t
    assert "everything that was received is accounted for" not in t


def test_checking_the_resting_coins_again_shows_the_one_that_was_spent_since(tpage, mock):
    scene(tpage, mock)
    del mock.fail["/tx/" + tid(3) + "/outspends"]
    tpage.click("#btnMoneyCheck")
    tpage.wait_for_function("() => /Resting now/.test(document.getElementById('toast').textContent)", timeout=15000); idle(tpage); settle(tpage)
    assert "Resting · 2 coins in 2 wallets" in findings(tpage)
    mock.routes["/tx/" + tid(3) + "/outspends"] = [{"spent": True, "txid": tid(77), "vin": 0, "status": {"confirmed": True, "block_height": 700077, "block_time": 1650046200}}]
    tpage.click("#btnMoneyRecheck")
    tpage.wait_for_function("() => /0[.]00057500 BTC before/.test(document.getElementById('toast').textContent)", timeout=15000); idle(tpage); settle(tpage)
    t = findings(tpage)
    assert "Moved on, not followed · 1 coin in 1 wallet" in t and "Resting · 1 coin in 1 wallet" in t, t
    assert "everything that was received is accounted for" in t


def row_title(page, name):
    return page.locator("#anFindings .linkrow[title*='" + addr(name) + "']").first.get_attribute("title")


def test_asking_again_with_the_same_answer_shows_when_the_spends_were_read_this_time(tpage, mock):
    scene(tpage, mock)
    del mock.fail["/tx/" + tid(3) + "/outspends"]
    tpage.click("#btnMoneyCheck")
    tpage.wait_for_function("() => /Resting now/.test(document.getElementById('toast').textContent)", timeout=15000); idle(tpage); settle(tpage)
    first = row_title(tpage, "c")
    assert " · read 20" in first, first
    size = tpage.evaluate("() => window.__hopline.state.graph.nodes.size + '/' + window.__hopline.state.graph.edges.size")
    tpage.wait_for_timeout(1500)                                                        # the time is kept to the second
    tpage.click("#btnMoneyRecheck")
    tpage.wait_for_function("() => /Resting now/.test(document.getElementById('toast').textContent) && !window.__hopline.state.ext.busy && !window.__hopline.state.busy", timeout=15000); idle(tpage); settle(tpage)
    assert tpage.evaluate("() => window.__hopline.state.graph.nodes.size + '/' + window.__hopline.state.graph.edges.size") == size, "nothing was added: the answer is the same, only the time it was read has changed"
    second = row_title(tpage, "c")
    assert second != first and " · read 20" in second, (first, second)
