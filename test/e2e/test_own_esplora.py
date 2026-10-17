"""Your own Esplora server as the data source: where the fiat prices come from is a separate choice."""
import pytest

from conftest import NORMAL
from helpers import idle, open_query, settle

OWN = "http://localhost:8080"


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def use_own(page, prices=None):
    page.select_option("#source", "custom")
    page.fill("#customBase", OWN + "/api"); page.dispatch_event("#customBase", "change")
    if prices:
        page.select_option("#customPrices", prices)


def hosts(mock, prefix):
    return {h for h, p in mock.requests if p.startswith(prefix)}


def fiat_loaded(page):
    page.select_option("#fiatCur", "USD")
    page.wait_for_function("() => /history to|today|Could not|need/i.test(document.getElementById('fiatStatus').textContent)")
    settle(page)


def test_the_price_choice_appears_only_for_your_own_server(fpage):
    assert fpage.is_hidden("#customPricesRow")
    fpage.select_option("#source", "custom")
    assert fpage.is_visible("#customPricesRow") and fpage.input_value("#customPrices") == "server"
    fpage.select_option("#source", "blockstream")
    assert fpage.is_hidden("#customPricesRow")


def test_transactions_come_from_your_server_and_prices_from_mempool_space_when_asked(fpage, mock):
    use_own(fpage, "mempool")
    open_query(fpage, NORMAL["txid"])
    fiat_loaded(fpage)
    assert hosts(mock, "/tx/") == {OWN}, "the blockchain data never leaves your server"
    assert hosts(mock, "/v1/") == {"https://mempool.space"}, "only the price endpoints go to mempool.space"
    assert "1 BTC =" in fpage.inner_text("#fiatStatus")
    sent = [p for h, p in mock.requests if h == "https://mempool.space"]
    assert all(p.startswith("/v1/") and "bc1" not in p and NORMAL["txid"] not in p for p in sent), "no address or transaction id is sent along: only a currency"


def test_by_default_prices_are_asked_of_your_own_server(fpage, mock):
    use_own(fpage)
    open_query(fpage, NORMAL["txid"])
    fiat_loaded(fpage)
    assert hosts(mock, "/v1/") == {OWN}


def test_nowhere_means_no_price_requests_at_all(fpage, mock):
    use_own(fpage, "off")
    open_query(fpage, NORMAL["txid"])
    fpage.select_option("#fiatCur", "USD"); settle(fpage)
    assert hosts(mock, "/v1/") == set()
    assert "Prices need" in fpage.inner_text("#fiatStatus")


def test_changing_the_price_source_loads_the_prices_again_and_is_remembered(fpage, mock):
    use_own(fpage)
    open_query(fpage, NORMAL["txid"])
    fiat_loaded(fpage)
    before = len([1 for h, p in mock.requests if p.startswith("/v1/")])
    fpage.select_option("#customPrices", "mempool")
    fpage.wait_for_function("() => /1 BTC =/.test(document.getElementById('fiatStatus').textContent)"); settle(fpage)
    assert len([1 for h, p in mock.requests if p.startswith("/v1/")]) > before and "https://mempool.space" in hosts(mock, "/v1/")
    fpage.reload(); fpage.wait_for_function("window.__orion && window.__orion.renderer")
    assert fpage.input_value("#source") == "custom" and fpage.input_value("#customPrices") == "mempool" and fpage.is_visible("#customPricesRow")
