"""The wallet page without an address offers a sample wallet to try, as the workspace offers a sample transaction."""
import pytest

from chains import IN, tx
from conftest import ADDRESS
from test_wallet_history import to
from test_wallet_page import WALLET_URL, cards, goto, wpage  # noqa: F401  (the fixture is used by name)

SAMPLE = "bc1qq2euq8pw950klpjcawuy4uj39ym43hs6cfsegq"


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def serve_sample(mock):
    """Two payments to the sample wallet, answered from the mock like any other address."""
    ids = [tx(mock, 91, [IN(11, 0, "payer1", 90000)], [to(SAMPLE, 80000)]), tx(mock, 92, [IN(12, 0, "payer2", 60000)], [to(SAMPLE, 50000)])]
    mock.routes["/address/" + SAMPLE + "/txs"] = [mock.routes["/tx/" + i[3:]] for i in reversed(ids)]
    mock.routes["/address/" + SAMPLE] = {"address": SAMPLE, "chain_stats": {"funded_txo_count": 2, "funded_txo_sum": 130000, "spent_txo_count": 0, "spent_txo_sum": 0, "tx_count": 2},
                                         "mempool_stats": {"funded_txo_count": 0, "funded_txo_sum": 0, "spent_txo_count": 0, "spent_txo_sum": 0, "tx_count": 0}}


def test_without_an_address_the_page_invites_you_to_try_a_sample_wallet(wpage):
    wpage.goto(WALLET_URL)
    wpage.wait_for_selector("#sample")
    assert wpage.is_visible("#empty") and wpage.inner_text("#sample") == "Try a sample wallet"
    assert "Paste a Bitcoin address" in wpage.inner_text("#empty")
    assert "DarkSide affiliate" in wpage.inner_text("#empty") and "7 June 2021" in wpage.inner_text("#empty"), "what the sample is, as its source says"
    link = wpage.locator("#empty a")
    assert link.get_attribute("href") == "https://www.elliptic.co/insights/us-authorities-seize-darkside/" and link.get_attribute("rel") == "noopener noreferrer" and link.get_attribute("target") == "_blank"
    assert wpage.is_hidden("#message") and wpage.is_hidden("#head") and wpage.is_hidden("#summary") and cards(wpage).count() == 0


def test_the_sample_button_opens_the_sample_wallet(wpage, mock):
    serve_sample(mock)
    wpage.goto(WALLET_URL); wpage.wait_for_selector("#sample")
    wpage.click("#sample")
    wpage.wait_for_url("**/wallet.html?q=" + SAMPLE)
    wpage.wait_for_function("() => document.querySelectorAll('#ledger .tx').length > 0")
    assert wpage.inner_text("#addr") == SAMPLE and cards(wpage).count() == 2
    assert wpage.is_hidden("#empty"), "the invitation goes away once a wallet is shown"
    assert "0.00130000 BTC" in wpage.inner_text("#sReceived")


def test_the_sample_wallet_is_a_valid_address_the_page_accepts(wpage, mock):
    serve_sample(mock)
    goto(wpage, SAMPLE)
    assert wpage.is_hidden("#empty") and wpage.is_hidden("#message") and wpage.inner_text("#addr") == SAMPLE


def test_an_address_in_the_link_or_a_mistyped_one_does_not_show_the_invitation(wpage):
    goto(wpage)
    assert wpage.is_hidden("#empty") and wpage.inner_text("#addr") == ADDRESS
    wpage.goto(WALLET_URL + "?q=bc1qdg78fm9gjwwywsh3545qp4us4rpyrclm9v8udX")
    wpage.wait_for_function("() => /checksum|look like|Enter a/.test(document.getElementById('message').textContent)")
    assert wpage.is_hidden("#empty") and "bad" in (wpage.get_attribute("#message", "class") or "")
