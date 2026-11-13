"""The start page, and the way from the workspace to the wallet overview."""
import re

import pytest

from conftest import ADDR_TXS, ADDRESS, NORMAL, ROOT
from helpers import idle, open_query
from test_wallet_sample import SAMPLE as SAMPLE_WALLET, serve_sample

INDEX_URL = (ROOT / "index.html").as_uri()
TXID = ADDR_TXS[0]["txid"]


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


@pytest.fixture
def ipage(ctx, errors):
    p = ctx.new_page()
    p.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    p.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" else None)
    p.goto(INDEX_URL)
    return p


def go(page, text):
    page.fill("#q", text); page.press("#q", "Enter")


def test_an_address_opens_as_a_wallet_overview(ipage):
    go(ipage, ADDRESS)
    ipage.wait_for_url("**/public/wallet.html?q=" + ADDRESS)
    ipage.wait_for_function("() => document.querySelectorAll('#ledger .tx').length > 0")


def test_a_transaction_id_opens_in_the_workspace(ipage):
    go(ipage, "  " + TXID.upper() + "  ")
    ipage.wait_for_url("**/public/workspace.html?q=" + TXID)
    ipage.wait_for_function("() => window.__hopline && window.__hopline.state.graph.nodes.size > 0")


def test_links_and_bitcoin_uris_are_understood(ipage):
    go(ipage, "https://mempool.space/address/" + ADDRESS)
    ipage.wait_for_url("**/public/wallet.html?q=" + ADDRESS)
    ipage.goto(INDEX_URL)
    go(ipage, "bitcoin:" + ADDRESS + "?amount=1")
    ipage.wait_for_url("**/public/wallet.html?q=" + ADDRESS)
    ipage.goto(INDEX_URL)
    go(ipage, "https://blockstream.info/tx/" + TXID)
    ipage.wait_for_url("**/public/workspace.html?q=" + TXID)


def test_an_empty_box_asks_for_something_and_goes_nowhere(ipage):
    go(ipage, "   ")
    assert "Enter a Bitcoin address" in ipage.inner_text("#err") and ipage.url == INDEX_URL


def test_the_two_cards_open_the_two_pages(ipage):
    hrefs = ipage.eval_on_selector_all(".card", "els => els.map(e => e.getAttribute('href'))")
    assert hrefs == ["public/workspace.html", "public/wallet.html"]
    ipage.click(".card:has-text('Wallet overview')")
    ipage.wait_for_url("**/public/wallet.html")
    ipage.wait_for_selector("#empty:not([hidden])")
    assert "Paste a Bitcoin address" in ipage.inner_text("#empty")


def test_the_brand_link_in_both_pages_comes_back_here(ctx, ipage):
    ipage.goto((ROOT / "public" / "wallet.html").as_uri())
    ipage.click(".brand"); ipage.wait_for_url(INDEX_URL)
    ipage.goto((ROOT / "public" / "workspace.html").as_uri())
    ipage.click(".brand"); ipage.wait_for_url(INDEX_URL)


def test_a_wallet_in_the_workspace_links_to_its_overview(fpage):
    open_query(fpage, ADDRESS)
    link = fpage.locator("#inspBody a:has-text('Wallet overview')")
    assert link.count() == 1
    assert link.get_attribute("href") == "wallet.html?q=" + ADDRESS and link.get_attribute("target") == "_blank" and "noopener" in link.get_attribute("rel")


# ---- what the page says, and where the box can send you ----------------------------------------------------------------------------------------------

BUTTONS = "els => els.map(e => e.id + ':' + e.classList.contains('primary') + ':' + e.getAttribute('aria-disabled'))"


def chip(page):
    return page.inner_text("#detect .found")


def test_nothing_is_said_about_an_empty_box_and_no_page_is_offered(ipage):
    assert ipage.inner_text("#detect") == "" and ipage.is_hidden("#goes") and ipage.is_hidden("#detect")


def test_an_address_is_recognised_and_both_pages_are_offered_with_the_old_one_first(ipage):
    ipage.fill("#q", ADDRESS)
    assert chip(ipage) == "Bitcoin address" and "Enter opens the wallet overview" in ipage.inner_text("#detect")
    assert ipage.eval_on_selector_all("#goes button", BUTTONS) == ["toWallet:true:null", "toWorkspace:false:null"]
    ipage.click("#toWorkspace")
    ipage.wait_for_url("**/public/workspace.html?q=" + ADDRESS)
    ipage.wait_for_function("() => window.__hopline && window.__hopline.state.graph.nodes.size > 0")


def test_the_overview_button_opens_the_overview(ipage):
    ipage.fill("#q", ADDRESS)
    ipage.click("#toWallet")
    ipage.wait_for_url("**/public/wallet.html?q=" + ADDRESS)
    ipage.wait_for_function("() => document.querySelectorAll('#ledger .tx').length > 0")


def test_a_transaction_has_no_overview_and_the_page_says_so(ipage):
    ipage.fill("#q", TXID)
    assert chip(ipage) == "Transaction ID"
    assert ipage.eval_on_selector_all("#goes button", BUTTONS) == ["toWorkspace:true:null", "toWallet:false:true"]
    assert "no overview of its own" in ipage.inner_text("#why")
    ipage.click("#toWallet", force=True)                       # the browser test tool treats aria-disabled as not clickable: press it anyway
    ipage.wait_for_timeout(300)
    assert ipage.url == INDEX_URL, "a button that cannot take the input goes nowhere"
    ipage.click("#toWorkspace")
    ipage.wait_for_url("**/public/workspace.html?q=" + TXID)


def test_several_entries_open_in_the_workspace_together_and_a_list_with_line_breaks_stays_a_list(ipage):
    # Firefox does not let a script make a paste event with clipboard data, so the event is a plain one that carries what the handler reads
    ipage.evaluate("""(text) => { const q = document.getElementById('q'); q.focus();
        const ev = new Event('paste', { bubbles: true, cancelable: true }); ev.clipboardData = { getData: () => text };
        q.dispatchEvent(ev); }""", ADDRESS + "\r\n" + TXID + "\n")
    assert ipage.input_value("#q") == ADDRESS + " " + TXID, "line breaks become spaces, they are not dropped (that would join the two)"
    assert chip(ipage) == "1 address and 1 transaction"
    assert "one address" in ipage.inner_text("#why")
    ipage.press("#q", "Enter")
    ipage.wait_for_url("**/public/workspace.html?q=*")
    ipage.wait_for_function("() => window.__hopline && window.__hopline.state.graph.nodes.size > 1")
    ids = ipage.evaluate("() => [...window.__hopline.state.graph.nodes.keys()]")
    assert "addr:" + ADDRESS in ids and "tx:" + TXID in ids


def test_a_typo_is_reported_before_any_page_opens(ipage, mock):
    typo = ADDRESS[:-1] + ("p" if ADDRESS.endswith("q") else "q")
    ipage.fill("#q", typo)
    ipage.wait_for_selector("#detect .found.warn")
    assert chip(ipage) == "Not recognised" and "checksum does not match" in ipage.inner_text("#detect") and ipage.is_hidden("#goes")
    ipage.press("#q", "Enter")
    ipage.wait_for_timeout(300)
    assert ipage.url == INDEX_URL and mock.requests == []


def test_an_address_that_is_still_being_typed_is_not_called_wrong(ipage):
    ipage.fill("#q", ADDRESS[:12])
    assert chip(ipage) == "Keep going" and ipage.get_attribute("#detect .found", "class").split() == ["found", "idle"]
    ipage.wait_for_timeout(700)
    assert chip(ipage) == "Keep going"
    ipage.press("#q", "Enter"); ipage.wait_for_timeout(200)
    assert ipage.url == INDEX_URL


def test_more_than_ten_are_refused_with_the_number_the_workspace_takes(ipage):
    ipage.fill("#q", " ".join(("%064x" % i) for i in range(11)))
    assert chip(ipage) == "11 entries" and "up to 10" in ipage.inner_text("#detect") and ipage.is_hidden("#goes")
    ipage.fill("#q", " ".join(("%064x" % i) for i in range(10)))
    assert chip(ipage) == "10 transactions" and ipage.is_visible("#goes")


def test_a_hopline_link_goes_to_the_workspace_with_its_own_part(ipage):
    ipage.fill("#q", "https://hopline.pages.dev/public/workspace.html#s1/AbC-_9")
    assert chip(ipage) == "Hopline link" and ipage.eval_on_selector_all("#goes button", "els => els.map(e => e.id)") == ["toWorkspace"]
    ipage.press("#q", "Enter")
    ipage.wait_for_url("**/public/workspace.html#s1/AbC-_9")


def test_typing_after_a_message_takes_it_away_and_an_empty_box_after_it_asks(ipage):
    ipage.fill("#q", ADDRESS); ipage.wait_for_selector("#goes:not([hidden])")
    ipage.fill("#q", "")
    assert ipage.is_hidden("#goes") and ipage.inner_text("#detect") == ""
    go(ipage, "")
    assert "Enter a Bitcoin address" in ipage.inner_text("#err") and ipage.url == INDEX_URL
    ipage.fill("#q", ADDRESS)
    assert ipage.inner_text("#err") == "", "the request for something goes away once there is something"


def test_the_examples_open_what_the_pages_call_their_samples(ipage):
    def js(name):
        return (ROOT / "public" / "js" / name).read_text(encoding="utf-8")
    wallet_sample = re.search(r"var SAMPLE = '([0-9a-z]+)'", js("wallet.js")).group(1)
    workspace_sample = re.search(r"var SAMPLE = '([0-9a-f]{64})'", js("workspace.js")).group(1)
    hrefs = ipage.eval_on_selector_all(".learn a[id]", "els => els.map(e => [e.id, e.getAttribute('href')])")
    assert [h[0] for h in hrefs] == ["openSaved", "samplePlain", "sampleWallet", "sampleConsol", "sampleBatch", "sampleCoinjoin", "samplePeel", "samplePeelLookalike", "sampleHandoff", "sampleSwap", "sampleListedWallet"], hrefs
    by = dict(hrefs)
    assert by["sampleWallet"] == "public/wallet.html?q=" + wallet_sample and by["openSaved"] == "public/workspace.html" and by["samplePlain"].startswith("public/workspace.html#s1/")
    assert wallet_sample == SAMPLE_WALLET and workspace_sample == NORMAL["txid"], "the fixture of the sample transaction is the one the workspace calls its sample (its own button when it is empty)"


def test_the_sample_wallet_link_opens_the_sample_wallet(ipage, mock):
    serve_sample(mock)
    ipage.click("#sampleWallet")
    ipage.wait_for_url("**/public/wallet.html?q=" + SAMPLE_WALLET)
    ipage.wait_for_function("() => document.querySelectorAll('#ledger .tx').length > 0")


def test_a_saved_workspace_is_opened_from_the_workspace_where_the_button_is_ready(ipage):
    ipage.click("#openSaved")
    ipage.wait_for_url("**/public/workspace.html")
    ipage.wait_for_selector("#emptyImport")
    assert ipage.is_visible("#emptyImport") and "Open a workspace file" in ipage.inner_text("#emptyImport")


def test_the_page_says_what_hopline_does_and_what_leaves_the_browser(ipage):
    assert ipage.inner_text(".lead").startswith("Paste a Bitcoin address or a transaction ID. See where the money went")
    assert [h.strip() for h in ipage.eval_on_selector_all(".proof h2", "els => els.map(e => e.textContent)")] == ["In your browser", "Names built in", "Findings with reasons"]
    assert ipage.eval_on_selector_all(".steps li h2", "els => els.map(e => e.textContent)") == ["Paste", "Trace", "Report"]
    leaves = ipage.inner_text(".leaves")
    assert "mempool.space" in leaves and "Blockstream.info" in leaves and "your own server" in leaves and "IP address" in leaves and "Apache-2.0" in leaves


def test_each_card_shows_its_page_and_says_what_it_is_best_for(ipage):
    for card, best in (("Workspace", "following a payment"), ("Wallet overview", "whole picture of one address")):
        loc = ipage.locator(".card:has(h2:text-is('%s'))" % card)
        img = loc.locator("img")
        assert img.get_attribute("alt"), "the picture is described"
        assert img.evaluate("e => e.complete && e.naturalWidth > 0"), "the picture loads"
        assert best in loc.locator(".best").inner_text()


def test_the_box_is_on_the_first_screen_of_a_small_laptop_and_nothing_is_wider_than_a_phone(ctx):
    for w, h in ((1366, 768), (400, 800)):
        p = ctx.new_page(); p.set_viewport_size({"width": w, "height": h}); p.goto(INDEX_URL)
        box = p.locator("#q").bounding_box()
        assert box["y"] + box["height"] < h, "%dx%d: the box is on the first screen" % (w, h)
        assert p.evaluate("() => document.documentElement.scrollWidth <= document.documentElement.clientWidth"), "%dx%d: no sideways scroll" % (w, h)
        p.fill("#q", ADDRESS)
        assert p.evaluate("() => document.documentElement.scrollWidth <= document.documentElement.clientWidth"), "%dx%d: nor with the buttons" % (w, h)
        p.close()


# every finding the page names is one the analysis really makes: the words that tell it in the code
LOOKS = {"Sanctioned wallets": "sanction", "Consolidations": "CONSOL", "Batch payments": "BATCH", "CoinJoin-like transactions": "COINJOIN", "Peel chains": "PEEL",
         "Round amounts": "ROUND", "Swap and bridge memos": "SWAP", "Routes between two wallets": "route"}


def test_the_page_names_what_the_analysis_looks_for_and_links_to_how_often_it_is_right(ipage):
    names = ipage.eval_on_selector_all(".looklist li", "els => els.map(e => e.textContent)")
    assert names == list(LOOKS), names
    code = " ".join(p.read_text(encoding="utf-8") for p in (ROOT / "public" / "js").glob("hopline-*.js")).lower()
    for name, word in LOOKS.items():
        assert word.lower() in code, "%s: nothing in the code is called %s" % (name, word)
    assert ipage.get_attribute(".looklist li.sanctions", "class") == "sanctions" and ipage.locator(".looklist li.sanctions").inner_text() == "Sanctioned wallets"
    link = ipage.locator(".looks a")
    assert link.get_attribute("href") == "https://github.com/forensicworks/hopline/wiki/Accuracy" and link.get_attribute("target") == "_blank" and link.get_attribute("rel") == "noopener noreferrer"
    assert "none of them proves who owns what" in ipage.inner_text(".looks")
