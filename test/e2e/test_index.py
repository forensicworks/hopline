"""The start page, and the way from the workspace to the wallet overview."""
import pytest

from conftest import ADDR_TXS, ADDRESS, ROOT
from helpers import open_query

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
    assert "Enter a Bitcoin address" in ipage.inner_text("#message")


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
