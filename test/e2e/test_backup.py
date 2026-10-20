"""mempool.space with Blockstream.info as the backup (and the other way round), on by default, never for Tor or your own server."""
import pytest

from conftest import NORMAL
from helpers import idle, open_query, settle, toast_text

MEMPOOL = "https://mempool.space"
BLOCKSTREAM = "https://blockstream.info"
TX = "tx:" + NORMAL["txid"]


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def hosts_of(mock, prefix="/tx/"):
    return [h for h, p in mock.requests if p.startswith(prefix)]


def log_text(page):
    return page.evaluate("() => [...document.querySelectorAll('#logList li')].map(l => l.textContent).join('\\n')")


def source_of(page, id_=TX):
    return page.evaluate("(id) => window.__orion.state.graph.nodes.get(id).source", id_)


def test_the_backup_option_is_on_by_default_and_names_the_other_server(fpage):
    assert fpage.is_visible("#fallbackRow") and fpage.is_checked("#fallbackOn")
    assert fpage.inner_text("#fallbackName") == "blockstream.info"
    assert "blockstream.info answers instead" in fpage.inner_text("#sourceHint")
    fpage.select_option("#source", "blockstream")
    assert fpage.is_visible("#fallbackRow") and fpage.inner_text("#fallbackName") == "mempool.space"


def test_it_is_not_offered_for_tor_or_your_own_server(fpage):
    fpage.select_option("#source", "tor")
    assert fpage.is_hidden("#fallbackRow") and "answers instead" not in fpage.inner_text("#sourceHint")
    fpage.select_option("#source", "custom")
    assert fpage.is_hidden("#fallbackRow")
    assert fpage.evaluate("() => window.__orion.state.client.backup") is None


def test_a_throttled_mempool_space_hands_the_work_to_blockstream_and_says_so(fpage, mock):
    mock.fail_host[MEMPOOL] = 429
    open_query(fpage, NORMAL["txid"])
    assert fpage.evaluate("() => window.__orion.state.graph.nodes.size") == 7, "everything loaded anyway"
    assert BLOCKSTREAM in hosts_of(mock)
    assert source_of(fpage) == BLOCKSTREAM + "/api", "the transaction records the server that really sent it"
    t = log_text(fpage)
    assert "mempool.space is throttling (HTTP 429): using blockstream.info for about 60 seconds." in t
    assert t.count("is throttling") == 1, "one message for the whole spell"
    assert " went to blockstream.info." in t


def test_a_failing_server_is_retried_once_before_the_backup_is_used(fpage, mock):
    mock.fail_host[MEMPOOL] = 503
    open_query(fpage, NORMAL["txid"])
    first = [h for h, p in mock.requests if p == "/tx/" + NORMAL["txid"]]
    assert first[:3] == [MEMPOOL, MEMPOOL, BLOCKSTREAM], first
    assert "returned a server error" in log_text(fpage)


def test_turning_it_off_keeps_every_request_on_one_server(fpage, mock):
    fpage.uncheck("#fallbackOn")
    assert "answers instead" not in fpage.inner_text("#sourceHint")
    mock.fail_host[MEMPOOL] = 429
    fpage.fill("#q", NORMAL["txid"]); fpage.click("#searchForm button[type=submit]")
    fpage.wait_for_function("() => window.__orion.state.graph.nodes.size === 0 && /failed/.test(document.getElementById('toast').textContent)", timeout=60000)
    assert set(hosts_of(mock)) == {MEMPOOL}, "blockstream.info was never asked"


def test_the_choice_is_remembered(fpage):
    fpage.uncheck("#fallbackOn")
    fpage.reload(); fpage.wait_for_function("window.__orion && window.__orion.renderer")
    assert not fpage.is_checked("#fallbackOn") and fpage.evaluate("() => window.__orion.state.client.backup") is None
    fpage.check("#fallbackOn")
    fpage.reload(); fpage.wait_for_function("window.__orion && window.__orion.renderer")
    assert fpage.is_checked("#fallbackOn") and fpage.evaluate("() => window.__orion.state.client.backup.base") == BLOCKSTREAM + "/api"


def test_with_blockstream_chosen_mempool_space_is_the_backup(fpage, mock):
    fpage.select_option("#source", "blockstream")
    mock.fail_host[BLOCKSTREAM] = 429
    open_query(fpage, NORMAL["txid"])
    assert MEMPOOL in hosts_of(mock) and source_of(fpage) == MEMPOOL + "/api"
    assert "blockstream.info is throttling" in log_text(fpage)


def test_tor_never_falls_back_to_the_open_internet(fpage, mock):
    fpage.select_option("#source", "tor")
    onion = fpage.evaluate("() => window.__orion.state.client.base")
    mock.fail_host[onion.rsplit("/api", 1)[0]] = 503
    fpage.fill("#q", NORMAL["txid"]); fpage.click("#searchForm button[type=submit]")
    fpage.wait_for_function("() => /failed/.test(document.getElementById('toast').textContent)", timeout=90000)
    assert all(h.endswith(".onion") or h.startswith("http://mempool") for h in hosts_of(mock)), set(hosts_of(mock))
    assert MEMPOOL not in hosts_of(mock) and BLOCKSTREAM not in hosts_of(mock)


def test_an_unknown_transaction_is_an_answer_not_a_reason_to_ask_the_backup(fpage, mock):
    fpage.fill("#q", "ab" * 32); fpage.click("#searchForm button[type=submit]")
    fpage.wait_for_function("() => /not found|failed|404/i.test(document.getElementById('toast').textContent)", timeout=30000)
    assert set(hosts_of(mock)) == {MEMPOOL}


def test_when_mempool_space_answers_again_it_is_used_again(fpage, mock):
    mock.fail_host[MEMPOOL] = 429
    open_query(fpage, NORMAL["txid"])
    fpage.evaluate("() => { window.__orion.state.client.coolMs = 200; window.__orion.state.client.cool = {}; }")   # do not wait a minute in a test
    del mock.fail_host[MEMPOOL]
    fpage.wait_for_timeout(250)
    spender = "tx:" + [t for t in mock.routes if t.startswith("/tx/") and "outspends" not in t and NORMAL["txid"] not in t][0].split("/")[2]
    fpage.evaluate("(id) => window.__orion.state.explorer.loadTx(id.slice(3)).then(() => window.__orion.refresh())", spender); idle(fpage)
    assert source_of(fpage, spender) == MEMPOOL + "/api"
    assert "mempool.space is answering again." in log_text(fpage)


def test_the_report_lists_both_servers(fpage, mock, tmp_path):
    from test_report import make_report
    mock.fail_host[MEMPOOL] = 429
    open_query(fpage, NORMAL["txid"])
    del mock.fail_host[MEMPOOL]
    fpage.evaluate("() => { window.__orion.state.client.cool = {}; }")
    spender = [t for t in mock.routes if t.startswith("/tx/") and "outspends" not in t and NORMAL["txid"] not in t][0].split("/")[2]
    fpage.evaluate("(id) => window.__orion.state.explorer.loadTx(id).then(() => window.__orion.refresh())", spender); idle(fpage)
    html = make_report(fpage, tmp_path).read_text(encoding="utf-8")
    assert "blockstream.info (" in html and "mempool.space (" in html
