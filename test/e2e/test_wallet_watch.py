"""Watch this wallet: a box on the wallet page that reads the wallet again every few minutes while the page is open, keeps what is on screen as it is, puts what it found behind a Show button, and raises a
browser alert for it (never for the first check, never twice for the same transaction). The interval is a few hundred milliseconds here (window.HOPLINE_WATCH_MS) and Notification is a stand-in that records
what it was asked to show."""
import json

import pytest

from chains import IN, real_addr, tid
from test_wallet_own_labels import node, session
from test_wallet_page import WALLET_URL, goto, wpage  # noqa: F401  (the fixture is used by name)

W = real_addr(71)
A_DAY_AGO = "Date.now() - 25 * 3600 * 1000"

FAKE_ALERTS = """
window.HOPLINE_WATCH_MS = 400;
window.__notes = []; window.__asked = 0; window.__perm = %s;
window.Notification = class {
  constructor(t, o) { window.__notes.push({ title: t, body: o && o.body, tag: o && o.tag }); }
  close() {}
  static get permission() { return window.__perm; }
  static requestPermission() { window.__asked++; if (window.__perm === 'default') window.__perm = 'granted'; return Promise.resolve(window.__perm); }
};
"""
NO_ALERTS = "window.HOPLINE_WATCH_MS = 400; try { delete window.Notification; } catch (e) {}"


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


PAYER = real_addr(72)


def paytx(n, value, confirmed=True):
    vin = IN(5, 0, "payer", value + 150)
    vin["prevout"]["scriptpubkey_address"] = PAYER
    return {"txid": tid(n), "fee": 150, "weight": 800,
            "status": {"confirmed": True, "block_height": 700000 + n, "block_time": 1650000000 + n * 600} if confirmed else {"confirmed": False},
            "vin": [vin], "vout": [{"scriptpubkey_address": W, "scriptpubkey_type": "v0_p2wpkh", "value": value}]}


def serve(mock, txs):
    """The wallet as the server sees it: the transactions (newest first, unconfirmed ones before the rest) and the totals that go with them."""
    chain = [t for t in txs if t["status"]["confirmed"]]
    pend = [t for t in txs if not t["status"]["confirmed"]]
    got = lambda lst: sum(o["value"] for t in lst for o in t["vout"] if o["scriptpubkey_address"] == W)
    mock.routes["/address/" + W] = {"address": W, "chain_stats": {"funded_txo_count": len(chain), "funded_txo_sum": got(chain), "spent_txo_count": 0, "spent_txo_sum": 0, "tx_count": len(chain)},
                                    "mempool_stats": {"funded_txo_count": len(pend), "funded_txo_sum": got(pend), "spent_txo_count": 0, "spent_txo_sum": 0, "tx_count": len(pend)}}
    mock.routes["/address/" + W + "/txs"] = pend + chain[:25]                          # the server answers with a page of 25 confirmed transactions


BASE = [paytx(302, 20_000), paytx(301, 50_000)]


def opened(wpage, ctx, mock, perm="'default'", script=None):
    ctx.add_init_script(script or FAKE_ALERTS % perm)
    serve(mock, BASE)
    goto(wpage, W)


def requests_for(mock, suffix=""):
    return [p for _, p in mock.requests if p == "/address/" + W + suffix]


def tick(page):
    page.check("#watchOn")
    page.wait_for_function("() => window.__wallet.watch.lastAt > 0", timeout=8000)


def notes(page):
    return page.evaluate("() => window.__notes")


def wait_banner(page, text):
    page.wait_for_function("(t) => { const b = document.getElementById('watchBanner'); return !b.hidden && b.textContent.indexOf(t) >= 0; }", arg=text, timeout=8000)


def cards(page):
    return page.locator("#ledger .tx")


def test_the_box_is_off_and_nothing_asks_the_server_until_it_is_ticked(wpage, ctx, mock):
    opened(wpage, ctx, mock)
    assert wpage.is_visible("#watchBar") and not wpage.is_checked("#watchOn") and wpage.is_checked("#watchAmounts") and wpage.input_value("#watchEvery") == "2"
    assert wpage.is_hidden("#watchNote") and wpage.is_hidden("#watchBanner") and wpage.inner_text("#watchStatus") == ""
    before = len(mock.requests)
    wpage.wait_for_timeout(1200)
    assert len(mock.requests) == before, "no timer is running"
    assert wpage.evaluate("() => window.__asked") == 0, "and the browser was not asked for anything"


def test_ticking_asks_the_browser_once_starts_at_once_and_says_what_it_tells_the_server(wpage, ctx, mock):
    opened(wpage, ctx, mock)
    tick(wpage)
    assert wpage.evaluate("() => window.__asked") == 1 and wpage.evaluate("() => window.__perm") == "granted"
    status = wpage.inner_text("#watchStatus")
    assert status.startswith("Watching") and "last checked" in status and "UTC" in status, status
    note = wpage.inner_text("#watchNote")
    assert "mempool.space" in note and "Tor" in note and "24 hours" in note and "your address" in note, note
    assert notes(wpage) == [] and wpage.is_hidden("#watchBanner"), "nothing changed: nothing said"
    assert len(requests_for(mock)) >= 2, "the page load and the first check, one request for the totals each"


def test_a_check_that_finds_no_change_is_one_small_request_and_the_list_is_not_read(wpage, ctx, mock):
    opened(wpage, ctx, mock)
    tick(wpage)
    n_txs = len(requests_for(mock, "/txs"))
    wpage.wait_for_function("() => window.__wallet.state.client.total.network > 0 && window.__wallet.watch.lastAt > 0")
    first = wpage.evaluate("() => window.__wallet.watch.lastAt")
    wpage.wait_for_function("(t) => window.__wallet.watch.lastAt > t", arg=first, timeout=8000)
    wpage.wait_for_function("(t) => window.__wallet.watch.lastAt > t", arg=wpage.evaluate("() => window.__wallet.watch.lastAt"), timeout=8000)
    assert len(requests_for(mock, "/txs")) == n_txs, "unchanged totals: the transactions were not asked for again"
    assert len(requests_for(mock)) >= 4, "while the totals were asked for at every check"


def test_a_new_transaction_waits_behind_a_button_and_raises_one_alert(wpage, ctx, mock):
    opened(wpage, ctx, mock)
    tick(wpage)
    serve(mock, [paytx(303, 30_000, confirmed=False)] + BASE)                        # a payment of 0.0003 BTC reaches the mempool
    wait_banner(wpage, "1 new transaction")
    assert cards(wpage).count() == 2, "what is on screen did not change by itself"
    assert wpage.evaluate("() => document.title").startswith("(1) Hopline Wallet")
    wpage.wait_for_timeout(1500)                                                      # more checks find the same thing
    got = notes(wpage)
    assert len(got) == 1, got
    assert got[0]["title"].startswith("Hopline · bc1q") and got[0]["body"] == "1 new transaction: +0.00030000 BTC received (unconfirmed)" and got[0]["tag"] == "hopline-watch-" + W
    wpage.click("#watchShow")
    assert cards(wpage).count() == 3 and wpage.is_hidden("#watchBanner")
    first = cards(wpage).first
    assert first.get_attribute("data-txid") == tid(303) and "NEW" in first.inner_text() and "Unconfirmed" in first.inner_text()
    assert cards(wpage).nth(1).locator(".newchip").count() == 0
    assert "3 of 3 loaded" in wpage.inner_text("#loaded")
    assert wpage.evaluate("() => document.title").startswith("Hopline Wallet"), "the count is gone from the title"
    wpage.wait_for_timeout(1000)
    assert len(notes(wpage)) == 1 and wpage.is_hidden("#watchBanner"), "joined in: nothing more to say"


def test_a_second_arrival_before_show_is_announced_alone_and_the_banner_counts_both(wpage, ctx, mock):
    opened(wpage, ctx, mock)
    tick(wpage)
    serve(mock, [paytx(303, 30_000, confirmed=False)] + BASE)
    wait_banner(wpage, "1 new transaction")
    wpage.wait_for_function("() => window.__notes.length === 1")
    serve(mock, [paytx(304, 40_000, confirmed=False), paytx(303, 30_000, confirmed=False)] + BASE)      # another one, and the first is still waiting behind the button
    wait_banner(wpage, "2 new transactions")
    wpage.wait_for_function("() => window.__notes.length === 2", timeout=8000)
    assert notes(wpage)[1]["body"] == "1 new transaction: +0.00040000 BTC received (unconfirmed)", "only the one that was not announced yet: %s" % notes(wpage)
    assert wpage.evaluate("() => document.title").startswith("(2) Hopline Wallet")
    wpage.click("#watchShow")
    assert cards(wpage).count() == 4 and [cards(wpage).nth(i).get_attribute("data-txid") for i in range(2)] == [tid(304), tid(303)]
    assert wpage.locator("#ledger .newchip").count() == 2


def test_a_transaction_that_gets_confirmed_is_said_once_and_shows_its_block(wpage, ctx, mock):
    opened(wpage, ctx, mock)
    tick(wpage)
    serve(mock, [paytx(303, 30_000, confirmed=False)] + BASE)
    wait_banner(wpage, "1 new transaction"); wpage.click("#watchShow")
    serve(mock, [paytx(303, 30_000)] + BASE)                                           # a block holds it
    wait_banner(wpage, "1 transaction confirmed")
    assert len(notes(wpage)) == 2 and notes(wpage)[1]["body"] == "1 transaction confirmed", notes(wpage)
    assert "Unconfirmed" in cards(wpage).first.inner_text(), "still as it was until Show"
    wpage.click("#watchShow")
    text = cards(wpage).first.inner_text()
    assert "Unconfirmed" not in text and "block 700303" in text and cards(wpage).count() == 3
    wpage.wait_for_timeout(1000)
    assert len(notes(wpage)) == 2


def test_the_first_check_after_ticking_shows_the_banner_but_raises_no_alert(wpage, ctx, mock):
    opened(wpage, ctx, mock)
    serve(mock, [paytx(303, 30_000, confirmed=False)] + BASE)                        # it happened while the page was open: the screen is out of date
    wpage.check("#watchOn")
    wait_banner(wpage, "1 new transaction")
    wpage.wait_for_timeout(1500)
    assert notes(wpage) == [], "the person is looking at the page; later checks do not repeat it"


def test_the_amount_can_be_left_out_of_the_alert(wpage, ctx, mock):
    opened(wpage, ctx, mock)
    wpage.uncheck("#watchAmounts")
    tick(wpage)
    serve(mock, [paytx(303, 30_000, confirmed=False)] + BASE)
    wait_banner(wpage, "1 new transaction")
    wpage.wait_for_function("() => window.__notes.length > 0")
    assert notes(wpage)[0]["body"] == "1 new transaction (unconfirmed)", notes(wpage)


def test_a_wallet_with_a_name_names_itself_and_the_other_side_in_the_alert(wpage, ctx, mock):
    session(ctx, [node(W, label="DarkSide payment wallet"), node(PAYER, label="Exchange X")])
    ctx.add_init_script(FAKE_ALERTS % "'default'")
    serve(mock, BASE)
    goto(wpage, W)
    tick(wpage)
    serve(mock, [paytx(303, 30_000, confirmed=False)] + BASE)
    wpage.wait_for_function("() => window.__notes.length > 0", timeout=8000)
    got = notes(wpage)[0]
    assert got["title"] == "Hopline · DarkSide payment wallet", got
    assert got["body"] == "1 new transaction: +0.00030000 BTC received (unconfirmed) · with Exchange X", got


def test_when_the_browser_blocks_alerts_the_page_still_shows_what_happened_and_says_so(wpage, ctx, mock):
    opened(wpage, ctx, mock, perm="'denied'")
    tick(wpage)
    assert "blocked" in wpage.inner_text("#watchNote")
    serve(mock, [paytx(303, 30_000, confirmed=False)] + BASE)
    wait_banner(wpage, "1 new transaction")
    assert notes(wpage) == [] and wpage.evaluate("() => window.__asked") == 0, "a blocked site is not asked again"


def test_in_a_browser_without_alerts_the_page_says_so_and_still_works(wpage, ctx, mock):
    opened(wpage, ctx, mock, script=NO_ALERTS)
    tick(wpage)
    assert "cannot show alerts" in wpage.inner_text("#watchNote")
    serve(mock, [paytx(303, 30_000, confirmed=False)] + BASE)
    wait_banner(wpage, "1 new transaction")


def test_unticking_stops_it_and_a_reload_starts_with_it_off(wpage, ctx, mock):
    opened(wpage, ctx, mock)
    tick(wpage)
    wpage.uncheck("#watchOn")
    assert wpage.is_hidden("#watchNote") and wpage.inner_text("#watchStatus") == ""
    before = len(requests_for(mock))
    wpage.wait_for_timeout(1500)
    assert len(requests_for(mock)) == before, "no further check"
    wpage.check("#watchOn"); wpage.wait_for_timeout(300)
    goto(wpage, W)
    assert not wpage.is_checked("#watchOn") and wpage.inner_text("#watchStatus") == ""


def test_a_failing_check_says_so_keeps_going_and_recovers(wpage, ctx, mock):
    opened(wpage, ctx, mock)
    tick(wpage)
    mock.fail["/address/" + W] = 404
    wpage.wait_for_function("() => /Last check failed/.test(document.getElementById('watchStatus').textContent)", timeout=8000)
    assert "bad" in wpage.get_attribute("#watchStatus", "class") and wpage.is_checked("#watchOn"), "still watching"
    del mock.fail["/address/" + W]
    wpage.wait_for_function("() => /^Watching/.test(document.getElementById('watchStatus').textContent)", timeout=15000)


def test_a_wake_from_sleep_says_which_time_the_check_covers(wpage, ctx, mock):
    opened(wpage, ctx, mock)
    tick(wpage)
    wpage.evaluate("() => { const w = window.__wallet.watch; w.lastAt = Date.now() - 3600000; w.nextAt = Date.now() - 1800000; }")
    wpage.wait_for_function("() => /the tab was asleep from/.test(document.getElementById('watchStatus').textContent)", timeout=8000)


def test_it_stops_by_itself_after_a_day(wpage, ctx, mock):
    opened(wpage, ctx, mock)
    tick(wpage)
    wpage.evaluate("() => { window.__wallet.watch.startedAt = %s; }" % A_DAY_AGO)
    wpage.wait_for_function("() => !document.getElementById('watchOn').checked", timeout=8000)
    assert "Stopped after 24 hours" in wpage.inner_text("#watchStatus")
    before = len(requests_for(mock))
    wpage.wait_for_timeout(1200)
    assert len(requests_for(mock)) == before


def test_the_choices_are_kept_for_the_next_visit(wpage, ctx, mock):
    opened(wpage, ctx, mock)
    wpage.select_option("#watchEvery", "10"); wpage.uncheck("#watchAmounts")
    assert json.loads(wpage.evaluate("() => localStorage.getItem('hopline.walletwatch.v1')")) == {"every": 10, "amounts": False}
    goto(wpage, W)
    assert wpage.input_value("#watchEvery") == "10" and not wpage.is_checked("#watchAmounts") and not wpage.is_checked("#watchOn")


def test_more_than_a_page_of_news_is_read_again_instead_of_joined(wpage, ctx, mock):
    opened(wpage, ctx, mock)
    tick(wpage)
    many = [paytx(400 + i, 1_000 + i) for i in range(25)][::-1]                      # a full page of confirmed transactions the page has never seen
    serve(mock, many + BASE)
    wait_banner(wpage, "more than 25")
    wpage.click("#watchShow")
    wpage.wait_for_function("() => document.querySelectorAll('#ledger .tx').length === 25", timeout=8000)
    assert cards(wpage).first.get_attribute("data-txid") == tid(424), "the wallet was read again: its newest page is shown"
    assert wpage.is_hidden("#watchBanner")


def test_a_check_always_asks_the_server_not_the_answer_kept_from_before(wpage, ctx, mock):
    opened(wpage, ctx, mock)
    tick(wpage)
    first = wpage.evaluate("() => window.__wallet.state.client.count.cached")
    serve(mock, [paytx(303, 30_000, confirmed=False)] + BASE)                        # the page's client keeps answers for minutes: a check must not be served from them
    wait_banner(wpage, "1 new transaction")
    assert wpage.evaluate("() => window.__wallet.state.client.count.cached") == first, "no answer came from the kept ones"
