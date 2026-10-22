"""The wallet overview page: one address as a ledger (inputs left, outputs right), a summary, the labelled wallets it dealt with."""
import importlib.util
import json
import threading

import pytest

from chains import IN, OUT, real_addr, tid, tx
from conftest import ADDR_TXS, ADDRESS, ROOT, fx
from test_copy import capture, copied

WALLET_URL = (ROOT / "public" / "wallet.html").as_uri()
MEMPOOL = "https://mempool.space"
BLOCKSTREAM = "https://blockstream.info"
KNOWN_BUILTIN = "bc1qprdf80adfz7aekh5nejjfrp3jksc8r929svpxk"        # "Robinhood Hot Wallet" in the built-in list; an output of the first fixture transaction
PAYER = "1opFYNKYG21CfzMYgCZBDoeBpQ9vhVUC9"                          # an input of that transaction: only labelled when a pack says so


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


@pytest.fixture
def wpage(ctx, errors):
    p = ctx.new_page()
    p.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    p.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" else None)
    return p


def goto(page, q=ADDRESS, wait=True):
    page.goto(WALLET_URL + "?q=" + q)
    if wait:
        page.wait_for_function("() => document.querySelectorAll('#ledger .tx').length > 0 || /Could not load|checksum|Enter a|look like|does not know/.test(document.getElementById('message').textContent)")


def cards(page):
    return page.locator("#ledger .tx")


def text_of(page, sel):
    return page.inner_text(sel)


def test_the_summary_is_the_addresses_own_totals_and_what_is_loaded(wpage):
    goto(wpage)
    assert wpage.inner_text("#addr") == ADDRESS
    assert "0.00000000 BTC" in text_of(wpage, "#sBalance")
    assert "0.01555415 BTC" in text_of(wpage, "#sReceived") and "0.01555415 BTC" in text_of(wpage, "#sSent")
    assert "8 on chain" in text_of(wpage, "#sCount") and "8 loaded (all)" in text_of(wpage, "#sCount")
    assert text_of(wpage, "#sPending") == "none"
    assert "2021-03-22" in text_of(wpage, "#sFirst") and "2022-08-10" in text_of(wpage, "#sLast")
    assert wpage.title().startswith("Hopline Wallet")


def test_every_transaction_is_a_card_with_inputs_on_the_left_and_outputs_on_the_right(wpage):
    goto(wpage)
    assert cards(wpage).count() == len(ADDR_TXS) == 8
    first = cards(wpage).first
    assert first.get_attribute("data-txid") == ADDR_TXS[0]["txid"], "newest first"
    assert "out" in first.get_attribute("class")
    assert "−0.00044358 BTC sent" in first.locator(".net").inner_text()
    assert first.locator(".col").nth(0).locator("h4").inner_text().lower().startswith("inputs (3)")
    assert first.locator(".col").nth(1).locator("h4").inner_text().lower().startswith("outputs (1)")
    assert first.locator(".col").nth(0).locator(".line").count() == 3 and first.locator(".col").nth(1).locator(".line").count() == 1
    assert first.locator(".amt.in").count() == 3 and first.locator(".amt.out").count() == 1, "red amounts on the input side, green on the output side"
    assert first.locator(".line.self").count() >= 1 and "this wallet" in first.inner_text()


def test_each_card_says_when_where_how_much_and_what_was_left(wpage):
    goto(wpage)
    meta = cards(wpage).first.locator(".meta").inner_text()
    assert "balance after 0.00000000 BTC" in meta and "block " in meta and "fee " in meta
    second = cards(wpage).nth(1)
    assert "balance after 0.00044358 BTC" in second.locator(".meta").inner_text(), "worked backwards from today's balance"
    assert "+0.00023564 BTC received" in second.locator(".net").inner_text()
    assert "2022-" in cards(wpage).first.locator(".time").inner_text() and "UTC" in cards(wpage).first.locator(".time").inner_text()


def test_addresses_link_to_their_own_overview_and_the_transaction_opens_in_the_workspace(wpage):
    goto(wpage)
    other = wpage.locator("#ledger .tx a.mono").first
    href = other.get_attribute("href")
    assert href.startswith("wallet.html?q=") and "q=" + ADDRESS not in href
    tx = cards(wpage).first
    assert tx.locator("a:has-text('Open in workspace')").get_attribute("href") == "workspace.html?q=" + ADDR_TXS[0]["txid"]
    assert tx.locator("a:has-text('Explorer')").get_attribute("href") == "https://mempool.space/tx/" + ADDR_TXS[0]["txid"]
    assert wpage.get_attribute("#toWorkspace", "href") == "workspace.html?q=" + ADDRESS and wpage.is_visible("#toWorkspace")


def test_the_in_and_out_filter_shows_only_those_and_counts_them(wpage):
    goto(wpage)
    segs = wpage.locator("#dirSeg button")
    assert segs.all_inner_texts() == ["All 8", "↓ In 5", "↑ Out 3"]
    wpage.click("#dirSeg [data-dir=in]")
    assert cards(wpage).count() == 5 and all("in" in c for c in wpage.eval_on_selector_all("#ledger .tx", "els => els.map(e => e.className)"))
    wpage.click("#dirSeg [data-dir=out]")
    assert cards(wpage).count() == 3
    wpage.click("#dirSeg [data-dir=all]")
    assert cards(wpage).count() == 8


def test_labelled_wallets_are_listed_as_associations_and_marked_on_the_cards(wpage):
    goto(wpage)
    assert wpage.is_visible("#assocSec")
    row = wpage.locator("#assoc .assocrow").filter(has_text="Robinhood Hot Wallet")
    assert row.count() == 1 and KNOWN_BUILTIN in row.inner_text()
    assert row.locator("a").get_attribute("href") == "wallet.html?q=" + KNOWN_BUILTIN
    assert "3 transactions" in row.inner_text() and "paid in 0.04164313 BTC" in row.inner_text() and "received 0.06227455 BTC" in row.inner_text()
    assert wpage.locator("#ledger .tx .lbl:has-text('Robinhood Hot Wallet')").count() >= 1


def test_label_lists_saved_by_the_workspace_are_used_and_a_hostile_name_stays_text(ctx, wpage):
    packs = [["p1", "Case list", True, [[PAYER, "Suspect <img src=x onerror=window.__pwned=1>", "THREAT", "https://example.org/x", "note"]]]]
    stored = json.dumps([{"id": p[0], "name": p[1], "enabled": p[2], "entries": p[3]} for p in packs])
    ctx.add_init_script("localStorage.setItem('hopline.packs.v1', %s);" % json.dumps(stored))
    goto(wpage)
    assert wpage.locator("#assoc .assocrow").filter(has_text="Suspect").count() == 1
    assert "<img src=x" in wpage.inner_text("#assoc") and wpage.locator("#assoc img, #ledger img").count() == 0
    assert wpage.evaluate("() => window.__pwned") is None
    assert "Case list" in wpage.inner_text("#assoc") and "THREAT" in wpage.inner_text("#assoc")


def test_a_switched_off_pack_adds_nothing(ctx, wpage):
    stored = json.dumps([{"id": "p1", "name": "Off", "enabled": False, "entries": [[PAYER, "Hidden name"]]}])
    ctx.add_init_script("localStorage.setItem('hopline.packs.v1', %s);" % json.dumps(stored))
    goto(wpage)
    assert "Hidden name" not in wpage.inner_text("body")


def test_hovering_the_address_shows_a_qr_code_and_it_goes_away(wpage):
    goto(wpage)
    assert wpage.is_hidden("#qrfloat")
    wpage.hover("#addr")
    assert wpage.is_visible("#qrfloat") and wpage.locator("#qrfloat canvas, #qrfloat img").count() >= 1
    wpage.mouse.move(5, 300)
    assert wpage.is_hidden("#qrfloat")
    wpage.focus("#addr")
    assert wpage.is_visible("#qrfloat"), "the keyboard gets it too"


def test_copy_buttons_copy_the_address_and_the_transaction_id(wpage):
    goto(wpage)
    capture(wpage)
    wpage.click("#copyAddr")
    assert copied(wpage) == [ADDRESS] and "Copied the address" in wpage.inner_text("#message")
    cards(wpage).first.locator(".copybtn").click()
    assert copied(wpage)[-1] == ADDR_TXS[0]["txid"]


def test_the_csv_has_a_line_per_loaded_transaction(wpage, tmp_path):
    goto(wpage)
    with wpage.expect_download() as dl:
        wpage.click("#csv")
    p = tmp_path / "w.csv"; dl.value.save_as(p)
    lines = p.read_bytes().decode("utf-8-sig").strip().split("\r\n")
    assert len(lines) == 9 and lines[0].startswith("txid,time_utc,time_unix,status,height,direction,")
    assert lines[1].startswith(ADDR_TXS[0]["txid"] + ",") and ",out,0,44358,-44358," in lines[1]


def test_a_long_history_loads_a_page_at_a_time(wpage, mock):
    n = []
    for i in range(30):                                                   # 30 payments to the wallet, newest first
        k = 200 - i
        o = OUT("x", 10000 + k); o["scriptpubkey_address"] = ADDRESS
        n.append(tx(mock, k, [IN(k - 100, 0, "payer%d" % i, 20000)], [o]))
    txs = [mock.routes["/tx/" + t[3:]] for t in n]
    mock.routes["/address/" + ADDRESS + "/txs"] = txs[:25]
    mock.routes["/address/" + ADDRESS + "/txs/chain/" + txs[24]["txid"]] = txs[25:]
    mock.routes["/address/" + ADDRESS] = {"address": ADDRESS, "chain_stats": {"funded_txo_count": 30, "funded_txo_sum": 300000, "spent_txo_count": 0, "spent_txo_sum": 0, "tx_count": 30},
                                          "mempool_stats": {"funded_txo_count": 0, "funded_txo_sum": 0, "spent_txo_count": 0, "spent_txo_sum": 0, "tx_count": 0}}
    goto(wpage)
    assert cards(wpage).count() == 25 and "25 of 30 loaded" in wpage.inner_text("#loaded")
    assert wpage.inner_text("#more") == "Load 25 more" and wpage.is_enabled("#more")
    wpage.click("#more")
    wpage.wait_for_function("() => document.querySelectorAll('#ledger .tx').length === 30")
    assert wpage.inner_text("#more") == "All loaded" and wpage.is_disabled("#more") and "30 of 30 loaded" in wpage.inner_text("#loaded")
    assert any(p.endswith("/txs/chain/" + txs[24]["txid"]) for h, p in mock.requests), "the next page continues after the last transaction of the first"
    ids = wpage.eval_on_selector_all("#ledger .tx", "els => els.map(e => e.dataset.txid)")
    assert len(set(ids)) == 30
    assert "balance after" in cards(wpage).nth(29).locator(".meta").inner_text()


def test_an_unconfirmed_transaction_is_marked_and_counted_as_pending(wpage, mock):
    o = OUT("x", 7000); o["scriptpubkey_address"] = ADDRESS
    t = tx(mock, 77, [IN(9, 0, "payer", 9000)], [o])
    mock.routes["/tx/" + t[3:]]["status"] = {"confirmed": False}
    mock.routes["/address/" + ADDRESS + "/txs"] = [mock.routes["/tx/" + t[3:]]] + ADDR_TXS
    st = dict(fx("address_stats.json")); st["mempool_stats"] = {"funded_txo_count": 1, "funded_txo_sum": 7000, "spent_txo_count": 0, "spent_txo_sum": 0, "tx_count": 1}
    mock.routes["/address/" + ADDRESS] = st
    goto(wpage)
    assert cards(wpage).count() == 9
    first = cards(wpage).first
    assert first.locator(".time").inner_text() == "Unconfirmed" and "balance after" not in first.locator(".meta").inner_text()
    assert "1 transaction" in text_of(wpage, "#sPending") and "+0.00007000 BTC when confirmed" in text_of(wpage, "#sPending")
    assert "balance after 0.00000000 BTC" in cards(wpage).nth(1).locator(".meta").inner_text(), "the confirmed ones do not count it"


def test_op_return_coinbase_and_outputs_without_an_address_are_described(wpage, mock):
    o = OUT("x", 5000); o["scriptpubkey_address"] = ADDRESS
    t = tx(mock, 80, [], [o, {"scriptpubkey_type": "op_return", "scriptpubkey": "6a0b68656c6c6f20776f726c64", "value": 0}, {"scriptpubkey_type": "nonstandard", "scriptpubkey": "51", "value": 300}])
    mock.routes["/tx/" + t[3:]]["vin"] = [{"txid": "00" * 32, "vout": 4294967295, "is_coinbase": True, "prevout": None}]
    mock.routes["/address/" + ADDRESS + "/txs"] = [mock.routes["/tx/" + t[3:]]]
    goto(wpage)
    body = cards(wpage).first.inner_text()
    assert "Newly minted coins (coinbase)" in body and "OP_RETURN “hello world”" in body and "Output without an address" in body


def test_an_address_with_no_history_says_so(wpage, mock):
    mock.routes["/address/" + ADDRESS + "/txs"] = []
    mock.routes["/address/" + ADDRESS] = {"address": ADDRESS, "chain_stats": {"funded_txo_count": 0, "funded_txo_sum": 0, "spent_txo_count": 0, "spent_txo_sum": 0, "tx_count": 0},
                                          "mempool_stats": {"funded_txo_count": 0, "funded_txo_sum": 0, "spent_txo_count": 0, "spent_txo_sum": 0, "tx_count": 0}}
    wpage.goto(WALLET_URL + "?q=" + ADDRESS)
    wpage.wait_for_function("() => document.getElementById('ledgerSec') && !document.getElementById('ledgerSec').hidden")
    assert "No transactions yet" in text_of(wpage, "#ledger") and wpage.is_disabled("#csv") and wpage.is_hidden("#assocSec")


# ---------------------------------------------------------------- asking: the search box, the server, mistakes
def test_a_wrong_address_is_explained_before_anything_is_sent(wpage, mock):
    wpage.goto(WALLET_URL + "?q=bc1qdg78fm9gjwwywsh3545qp4us4rpyrclm9v8udX")
    wpage.wait_for_function("() => document.getElementById('message').textContent.length > 0")
    assert "checksum" in wpage.inner_text("#message") and wpage.is_hidden("#ledgerSec")
    assert [p for h, p in mock.requests] == [], "no request was made"


def test_a_transaction_id_goes_to_the_workspace(wpage):
    txid = ADDR_TXS[0]["txid"]
    wpage.goto(WALLET_URL + "?q=" + txid)
    wpage.wait_for_url("**/workspace.html?q=" + txid)


def test_the_search_box_opens_an_address_here_and_a_transaction_in_the_workspace(wpage):
    goto(wpage)
    wpage.fill("#q", KNOWN_BUILTIN); wpage.press("#q", "Enter")
    wpage.wait_for_url("**/wallet.html?q=" + KNOWN_BUILTIN)
    wpage.fill("#q", ADDR_TXS[1]["txid"]); wpage.press("#q", "Enter")
    wpage.wait_for_url("**/workspace.html?q=" + ADDR_TXS[1]["txid"])


def test_a_mistyped_search_says_what_is_wrong_and_stays_put(wpage):
    goto(wpage)
    wpage.fill("#q", "hello"); wpage.press("#q", "Enter")
    assert "does not look like" in wpage.inner_text("#message") and "wallet.html" in wpage.url


def test_without_a_question_it_asks_for_an_address(wpage):
    wpage.goto(WALLET_URL)
    wpage.wait_for_function("() => document.getElementById('message').textContent.length > 0")
    assert "Enter a Bitcoin address" in wpage.inner_text("#message") and wpage.is_hidden("#head")


def test_when_mempool_space_throttles_blockstream_answers_and_the_page_says_where_it_got_the_data(wpage, mock):
    mock.fail_host[MEMPOOL] = 429
    goto(wpage)
    assert cards(wpage).count() == 8
    assert {h for h, p in mock.requests if p.startswith("/address/")} >= {BLOCKSTREAM}
    assert "backup blockstream.info" in wpage.inner_text("#source") and "mempool.space" in wpage.inner_text("#source")
    assert "did not answer well, so blockstream.info was used" in wpage.inner_text("#message")


def test_the_server_choice_saved_by_the_workspace_is_followed(ctx, wpage, mock):
    ctx.add_init_script("localStorage.setItem('hopline.prefs.v1', JSON.stringify({ source: 'blockstream', fallback: false }));")
    goto(wpage)
    assert {h for h, p in mock.requests if p.startswith("/address/")} == {BLOCKSTREAM}, "only the server that was chosen, no backup"
    assert "blockstream.info" in wpage.inner_text("#source") and "backup" not in wpage.inner_text("#source")
    assert wpage.locator("#ledger .tx a:has-text('Explorer')").first.get_attribute("href").startswith("https://mempool.space/tx/")


def test_a_failing_server_gives_a_message_and_try_again_works(wpage, mock):
    mock.fail_host[MEMPOOL] = 500
    mock.fail_host[BLOCKSTREAM] = 500
    wpage.goto(WALLET_URL + "?q=" + ADDRESS)
    wpage.wait_for_function("() => /Could not load/.test(document.getElementById('message').textContent)", timeout=60000)
    assert wpage.locator("#message button:has-text('Try again')").count() == 1 and wpage.is_hidden("#ledgerSec")
    mock.fail_host.clear()
    wpage.click("#message button")
    wpage.wait_for_function("() => document.querySelectorAll('#ledger .tx').length === 8")


def test_it_fits_a_phone_without_sideways_scrolling(ctx, wpage):
    wpage.set_viewport_size({"width": 390, "height": 800})
    goto(wpage)
    assert wpage.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth + 1")
    assert wpage.locator("#ledger .tx").first.locator(".cols").evaluate("e => getComputedStyle(e).gridTemplateColumns.split(' ').length") == 1, "inputs above outputs"


def test_the_page_never_runs_markup_from_the_data(wpage, mock):
    evil = json.loads(json.dumps(ADDR_TXS))
    evil[0]["vout"][0]["scriptpubkey_address"] = ADDRESS
    mock.routes["/address/" + ADDRESS + "/txs"] = evil
    goto(wpage)
    assert wpage.locator("#ledger script, #ledger img, #assoc script").count() == 0


# ---------------------------------------------------------------- a page that cannot start or draw says so instead of staying blank
# These go through a local web server: the browser does not let a test replace a script of a page opened from a file.
@pytest.fixture(scope="module")
def site():
    spec = importlib.util.spec_from_file_location("serve", ROOT / "tools" / "serve.py")
    serve = importlib.util.module_from_spec(spec); spec.loader.exec_module(serve)
    srv = serve.make_server(str(ROOT), 0)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % srv.server_address[1]
    srv.shutdown(); srv.server_close()


def old_copy(page, name):
    """What a browser that kept an old copy of a script would run: the script, without what the newer page expects from it."""
    glob = {"hopline-labels.js": "HoplineLabels", "hopline-api.js": "HoplineApi"}[name]
    page.route("**/js/" + name, lambda r: r.fulfill(status=200, content_type="text/javascript", body="window." + glob + " = {};"))


def test_the_pages_work_over_http_too_with_the_real_file_types(site, wpage):
    wpage.goto(site + "/public/wallet.html?q=" + ADDRESS)
    wpage.wait_for_function("() => document.querySelectorAll('#ledger .tx').length === 8")


def test_an_old_copy_of_a_script_gives_a_message_about_reloading_not_a_blank_page(site, wpage, errors):
    old_copy(wpage, "hopline-labels.js")
    wpage.goto(site + "/public/wallet.html?q=" + ADDRESS)
    wpage.wait_for_selector("#bootError")
    t = wpage.inner_text("#bootError")
    assert "could not start" in t and "Ctrl+F5" in t and "parseStored is not a function" in t, "it says what was missing"
    assert wpage.is_hidden("#head") and wpage.is_hidden("#ledgerSec")
    errors.clear()                                                             # the error was the point of this test


def test_the_workspace_says_the_same_when_one_of_its_scripts_is_an_old_copy(site, wpage, errors):
    old_copy(wpage, "hopline-api.js")
    wpage.goto(site + "/public/workspace.html")
    wpage.wait_for_selector("#bootError")
    assert "could not start" in wpage.inner_text("#bootError") and "Ctrl+F5" in wpage.inner_text("#bootError")
    errors.clear()


def test_the_banner_stays_away_once_the_page_has_started(wpage, errors):
    goto(wpage)
    assert wpage.locator("#bootError").count() == 0
    wpage.evaluate("() => setTimeout(() => { throw new Error('later'); }, 0)")
    wpage.wait_for_timeout(200)
    assert wpage.locator("#bootError").count() == 0, "an error after start-up is not a start-up error"
    errors.clear()


def test_a_failure_while_drawing_is_shown_with_a_way_to_try_again(site, wpage, errors):
    src = (ROOT / "public" / "js" / "hopline-wallet.js").read_text(encoding="utf-8")
    wpage.route("**/js/hopline-wallet.js", lambda r: r.fulfill(status=200, content_type="text/javascript", body=src + ";HoplineWallet.ledger = function () { throw new Error('boom'); };"))
    wpage.goto(site + "/public/wallet.html?q=" + ADDRESS)
    wpage.wait_for_function("() => /could not be shown/.test(document.getElementById('message').textContent)")
    assert "The data arrived but could not be shown: boom" in wpage.inner_text("#message")
    assert wpage.locator("#message button:has-text('Try again')").count() == 1
    errors.clear()


def test_a_server_that_does_not_answer_gets_a_note_after_a_while(ctx, wpage):
    ctx.add_init_script("window.HOPLINE_WAIT_MS = 300;")
    wpage.route("https://mempool.space/**", lambda route: None)               # never answers
    wpage.route("https://blockstream.info/**", lambda route: None)
    wpage.goto(WALLET_URL + "?q=" + ADDRESS)
    wpage.wait_for_function("() => /Still waiting for mempool.space/.test(document.getElementById('message').textContent)")
    assert "&source=blockstream" in wpage.inner_text("#message") and wpage.locator("#message button:has-text('Try again')").count() == 1
