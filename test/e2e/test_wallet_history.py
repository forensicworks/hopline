"""The wallet page: find things in what is loaded (search, dates, amounts), and load the whole history with a limit and a progress line."""
import calendar
import csv
import io

import pytest

from chains import IN, OUT, tid, tx
from conftest import ADDRESS
from helpers import wallet_export
from test_wallet_page import WALLET_URL, cards, goto, wpage  # noqa: F401  (the fixture is used by name)

W = ADDRESS
OTHER = "bc1qprdf80adfz7aekh5nejjfrp3jksc8r929svpxk"                  # Robinhood Hot Wallet on the built-in list


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def utc(y, m, d, h=12):
    return calendar.timegm((y, m, d, h, 0, 0))


def to(address, value):
    o = OUT("x", value); o["scriptpubkey_address"] = address
    return o


def history(mock, n=60):
    """n payments to the wallet, one a day from 1 March 2022, served 25 at a time (newest first); every 10th one comes from the known service."""
    ids = []
    for i in range(n):
        k = 100 + i
        payer = IN(k - 50, 0, "payer%d" % i, 20000 + i * 1000)
        if i % 10 == 0:
            payer["prevout"]["scriptpubkey_address"] = OTHER
        ids.append(tx(mock, k, [payer], [to(W, 10000 + i * 1000)]))
        mock.routes["/tx/" + tid(k)]["status"]["block_time"] = utc(2022, 3, 1) + i * 86400
        mock.routes["/tx/" + tid(k)]["status"]["block_height"] = 700000 + i
    txs = [mock.routes["/tx/" + t[3:]] for t in reversed(ids)]
    mock.routes["/address/" + W] = {"address": W, "chain_stats": {"funded_txo_count": n, "funded_txo_sum": 1, "spent_txo_count": 0, "spent_txo_sum": 0, "tx_count": n},
                                    "mempool_stats": {"funded_txo_count": 0, "funded_txo_sum": 0, "spent_txo_count": 0, "spent_txo_sum": 0, "tx_count": 0}}
    mock.routes["/address/" + W + "/txs"] = txs[:25]
    for a in range(25, n + 1, 25):                                                       # the last page may be full: then the next one is empty
        mock.routes["/address/" + W + "/txs/chain/" + txs[a - 1]["txid"]] = txs[a:a + 25]
    return txs


def count(page):
    return page.locator("#ledger .tx").count()


def counts_text(page):
    return page.inner_text("#fCount")


def type_in(page, a, b=None):
    """type_in(page, text) types into the search box; type_in(page, selector, text) into another field."""
    selector, text = ("#fText", a) if b is None else (a, b)
    page.fill(selector, text); page.wait_for_timeout(450)


# ---- search and limits ---------------------------------------------------------------------------------------------------------------------------

def test_the_search_finds_a_transaction_by_the_start_of_its_id_and_clear_brings_everything_back(wpage, mock):
    history(mock, 25)
    goto(wpage)
    assert count(wpage) == 25 and wpage.is_hidden("#fClear") and counts_text(wpage) == ""
    type_in(wpage, "#fText", tid(110)[:10])
    assert count(wpage) == 1 and wpage.locator("#ledger .tx").first.get_attribute("data-txid") == tid(110)
    assert "1 of 25 loaded match" in counts_text(wpage) and wpage.is_visible("#fClear")
    wpage.click("#fClear")
    assert count(wpage) == 25 and wpage.input_value("#fText") == "" and wpage.is_hidden("#fClear")


def test_the_search_looks_at_addresses_names_and_block_heights_and_every_word_must_match(wpage, mock):
    history(mock, 25)
    goto(wpage)
    type_in(wpage, "payer7")
    assert count(wpage) == 1
    type_in(wpage, "robinhood")
    assert count(wpage) == 3, "the three payments that came from the known service, found by its name"
    type_in(wpage, "robinhood built-in")
    assert count(wpage) == 0, "no row has both words"
    type_in(wpage, "700012")
    assert count(wpage) == 1 and wpage.locator("#ledger .tx").first.get_attribute("data-txid") == tid(112), "a block height"
    type_in(wpage, "none-of-these")
    assert count(wpage) == 0 and "None of the loaded transactions match" in wpage.inner_text("#ledger")


def test_a_date_range_is_in_utc_and_includes_both_ends(wpage, mock):
    history(mock, 25)
    goto(wpage)
    wpage.fill("#fFrom", "2022-03-05"); wpage.fill("#fTo", "2022-03-07"); wpage.dispatch_event("#fTo", "change"); wpage.wait_for_timeout(200)
    shown = wpage.eval_on_selector_all("#ledger .tx", "els => els.map(e => e.dataset.txid)")
    assert sorted(shown) == sorted(tid(100 + i) for i in (4, 5, 6)), shown
    wpage.fill("#fTo", ""); wpage.dispatch_event("#fTo", "change"); wpage.wait_for_timeout(200)
    assert count(wpage) == 25 - 4, "from 5 March on"


def test_an_amount_range_is_on_what_the_transaction_did_to_the_wallet(wpage, mock):
    history(mock, 25)
    goto(wpage)
    type_in(wpage, "#fMin", "0.00015")
    assert count(wpage) == 25 - 5, "payments of 10000 + i*1000 sat: those from 15000 up"
    type_in(wpage, "#fMax", "0.00020")
    assert count(wpage) == 6, "15000 to 20000 sat, both ends included"
    type_in(wpage, "#fMin", "0.001")
    assert count(wpage) == 0


def test_the_choices_combine_with_the_direction_buttons_and_the_counts_follow(wpage, mock):
    history(mock, 25)
    tx(mock, 300, [IN(1, 0, "x", 100000)], [to("bc1qshop0000000000000000000000000000000", 50000)])
    mock.routes["/tx/" + tid(300)]["vin"][0]["prevout"]["scriptpubkey_address"] = W
    mock.routes["/tx/" + tid(300)]["status"]["block_time"] = utc(2022, 3, 3)
    mock.routes["/address/" + W + "/txs"] = [mock.routes["/tx/" + tid(300)]] + mock.routes["/address/" + W + "/txs"]
    goto(wpage)
    wpage.fill("#fFrom", "2022-03-02"); wpage.fill("#fTo", "2022-03-04"); wpage.dispatch_event("#fTo", "change"); wpage.wait_for_timeout(200)
    assert count(wpage) == 4, "three payments in and the one out in those days"
    labels = wpage.eval_on_selector_all("#dirSeg button", "els => els.map(e => e.textContent)")
    assert labels == ["All 4", "↓ In 3", "↑ Out 1"], "the buttons count what the other choices leave"
    wpage.click("#dirSeg [data-dir=out]")
    assert count(wpage) == 1 and "1 of 26 loaded match" in counts_text(wpage)


def test_a_hostile_search_is_only_text(wpage, mock):
    history(mock, 25)
    goto(wpage)
    type_in(wpage, "<img src=x onerror=window.__pwned=1>")
    assert count(wpage) == 0 and wpage.evaluate("() => window.__pwned") is None


def test_a_long_list_is_drawn_a_hundred_at_a_time(wpage, mock):
    history(mock, 125)
    goto(wpage)
    wpage.evaluate("() => { document.getElementById('loadCap').value = 500; }")
    wpage.click("#loadAll"); wpage.wait_for_function("() => /whole history is here/.test(document.getElementById('message').textContent)", timeout=60000)
    assert wpage.inner_text("#loaded") == "125 of 125 loaded"
    assert count(wpage) == 100 and "Show 25 more (25 not shown)" in wpage.inner_text("#showMore")
    wpage.click("#showMore")
    assert count(wpage) == 125 and wpage.locator("#showMore").count() == 0
    type_in(wpage, "payer1")
    expect = len([i for i in range(125) if i % 10 and "payer1" in "payer%d" % i])
    assert count(wpage) == expect and expect < 100, "the search looks at everything loaded, not only what is drawn"


# ---- loading the whole history ------------------------------------------------------------------------------------------------------------------------

def test_load_all_fetches_a_page_at_a_time_to_the_end_and_says_how_far_it_is(wpage, mock):
    history(mock, 60)
    goto(wpage)
    assert wpage.inner_text("#loaded") == "25 of 60 loaded"
    wpage.click("#loadAll")
    wpage.wait_for_function("() => document.getElementById('loaded').textContent === '60 of 60 loaded'", timeout=30000)
    assert wpage.is_hidden("#allBar") and wpage.inner_text("#more") == "All loaded" and wpage.is_disabled("#loadAll")
    assert "the whole history is here" in wpage.inner_text("#message")
    paged = [p for h, p in mock.requests if "/txs/chain/" in p]
    assert len(paged) == 2, "two more pages of 25 and 10"


def test_the_progress_line_shows_while_it_loads_and_cancel_stops_it_after_the_page_in_flight(wpage, mock):
    history(mock, 200)
    mock.delay_ms = 250
    goto(wpage)
    wpage.click("#loadAll")
    wpage.wait_for_selector("#allBar:not([hidden])")
    wpage.wait_for_function("() => /Loading the whole history: \\d+ of 200 transactions · \\d+ request/.test(document.getElementById('allText').textContent)")
    assert wpage.is_disabled("#more") and wpage.is_disabled("#loadAll")
    wpage.click("#allCancel")
    wpage.wait_for_function("() => document.getElementById('allBar').hidden", timeout=30000)
    n = int(wpage.inner_text("#loaded").split(" of ")[0])
    assert 25 < n < 200 and n % 25 == 0, n
    assert "Stopped: %d of 200 transactions are loaded" % n in wpage.inner_text("#message")
    assert wpage.is_enabled("#loadAll") and wpage.is_enabled("#more"), "and loading can go on from there"


def test_the_limit_stops_it_and_says_so(wpage, mock):
    history(mock, 200)
    goto(wpage)
    wpage.fill("#loadCap", "75")
    wpage.click("#loadAll")
    wpage.wait_for_function("() => /Stopped at the limit of 75/.test(document.getElementById('message').textContent)", timeout=30000)
    assert wpage.inner_text("#loaded") == "75 of 200 loaded"
    assert 'Raise "up to"' in wpage.inner_text("#message")
    wpage.fill("#loadCap", "400"); wpage.click("#loadAll")
    wpage.wait_for_function("() => document.getElementById('loaded').textContent === '200 of 200 loaded'", timeout=30000)


def test_a_limit_outside_what_is_sensible_is_brought_inside_it(wpage, mock):
    history(mock, 60)
    goto(wpage)
    wpage.fill("#loadCap", "1"); wpage.click("#loadAll")
    wpage.wait_for_function("() => /Stopped at the limit of 25/.test(document.getElementById('message').textContent)", timeout=30000)
    assert wpage.inner_text("#loaded") == "25 of 60 loaded"


def test_a_failure_part_way_keeps_what_was_loaded_and_says_what_happened(wpage, mock):
    txs = history(mock, 100)
    mock.fail["/address/" + W + "/txs/chain/" + txs[49]["txid"]] = 500
    goto(wpage)
    wpage.click("#loadAll")
    wpage.wait_for_function("() => /Could not load the rest/.test(document.getElementById('message').textContent)", timeout=60000)
    assert wpage.inner_text("#loaded") == "50 of 100 loaded" and wpage.is_enabled("#loadAll")
    assert wpage.is_visible("#message.bad") or "bad" in (wpage.get_attribute("#message", "class") or "")


def test_export_with_the_whole_history_first_loads_the_rest_and_then_downloads_everything(wpage, mock, tmp_path):
    history(mock, 60)
    goto(wpage)
    wpage.click("#exportMenu summary"); wpage.check("#exportAll")
    with wpage.expect_download(timeout=60000) as dl:
        wallet_export(wpage, "csv")
    p = tmp_path / "all.csv"; dl.value.save_as(p)
    rows = list(csv.reader(io.StringIO(p.read_bytes().decode("utf-8-sig"))))
    assert len(rows) == 61, "a heading and every one of the 60"
    assert wpage.inner_text("#loaded") == "60 of 60 loaded"


def test_with_everything_loaded_the_buttons_are_off(wpage, mock):
    history(mock, 20)
    goto(wpage)
    wpage.click("#exportMenu summary")
    assert wpage.is_disabled("#loadAll") and wpage.is_disabled("#exportAll") and wpage.is_disabled("#loadCap")
    assert wpage.is_enabled("[data-export=csv]")
