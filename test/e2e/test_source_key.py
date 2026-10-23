"""A key for your own Esplora server, and the pace of your own server."""
import json
import re

import pytest

from conftest import NORMAL
from helpers import idle, open_query, settle, toast_text
from test_report import make_report
from test_wallet_page import WALLET_URL, wpage  # noqa: F401  (the fixture is used by name)
from conftest import ADDRESS

OWN = "https://my-node.example/api"
OWN_HOST = "https://my-node.example"
SECRET = "SECRET-TOKEN-7731"


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def watch(page):
    """Record the headers of every request to the own server; answer the browser's pre-flight check the way a server that allows the header would."""
    seen = []

    def handle(route):
        req = route.request
        if req.method == "OPTIONS":
            return route.fulfill(status=204, headers={"access-control-allow-origin": "*", "access-control-allow-headers": "authorization, x-api-key, accept, content-type",
                                                      "access-control-allow-methods": "GET, OPTIONS"})
        seen.append({"url": req.url, "path": re.sub(r"^https?://[^/]+/api", "", req.url), "headers": req.headers})
        route.fallback()
    page.route(OWN_HOST + "/**", handle)
    return seen


def use_own(page, base=OWN):
    page.select_option("#source", "custom")
    page.fill("#customBase", base); page.dispatch_event("#customBase", "change")


def set_key(page, value=SECRET, header="", remember=False):
    page.fill("#srcKey", value)
    if header:
        page.fill("#srcKeyHeader", header)
    page.dispatch_event("#srcKey", "change")
    if header:
        page.dispatch_event("#srcKeyHeader", "change")
    if remember:
        page.check("#srcKeyRemember")


def stored(page):
    return page.evaluate("() => JSON.stringify(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]))")


# ---- what is shown ------------------------------------------------------------------------------------------------------------------------

def test_the_key_and_pace_fields_are_only_there_for_your_own_server(fpage):
    for src in ("clearnet", "tor", "blockstream"):
        fpage.select_option("#source", src)
        assert not fpage.is_visible("#srcKey") and not fpage.is_visible("#paceConc"), src
    fpage.select_option("#source", "custom")
    assert fpage.is_visible("#srcKey") and fpage.is_visible("#srcKeyHeader") and fpage.is_visible("#srcKeyRemember")
    assert fpage.is_visible("#paceConc") and fpage.is_visible("#paceDelay")
    assert fpage.get_attribute("#srcKey", "type") == "password", "the key is not shown on the screen"
    assert fpage.input_value("#paceConc") == "8" and fpage.input_value("#paceDelay") == "20", "faster than the public servers by default"
    assert "CORS" in fpage.inner_text("#keyHint") and "never put in a web address" in fpage.inner_text("#keyHint")


# ---- the key is sent, and only to that server ------------------------------------------------------------------------------------------------

def test_the_key_is_sent_as_a_bearer_token_with_every_request_to_that_server_and_not_in_the_address(fpage, mock):
    seen = watch(fpage)
    use_own(fpage); set_key(fpage)
    open_query(fpage, NORMAL["txid"])
    assert seen, "the own server was asked"
    assert all(s["headers"].get("authorization") == "Bearer " + SECRET for s in seen), [s["headers"].get("authorization") for s in seen]
    assert all(SECRET not in s["url"] for s in seen), "never in a web address"
    assert all(SECRET not in "".join(r) for r in mock.requests), "and the log of requests does not hold it"
    assert SECRET not in fpage.url and SECRET not in fpage.inner_text("#logList")


def test_another_header_name_is_used_as_it_is(fpage, mock):
    seen = watch(fpage)
    use_own(fpage); set_key(fpage, header="X-API-Key")
    open_query(fpage, NORMAL["txid"])
    assert seen and all(s["headers"].get("x-api-key") == SECRET and "authorization" not in s["headers"] for s in seen)


def test_no_key_means_no_header_and_a_cleared_key_stops_being_sent(fpage, mock):
    seen = watch(fpage)
    use_own(fpage)
    open_query(fpage, NORMAL["txid"])
    assert seen and all("authorization" not in s["headers"] for s in seen)
    set_key(fpage); fpage.fill("#srcKey", ""); fpage.dispatch_event("#srcKey", "change")
    before = len(seen)
    open_query(fpage, NORMAL["vout"][0]["scriptpubkey_address"]); idle(fpage)
    assert len(seen) > before and all("authorization" not in s["headers"] for s in seen[before:])


def test_the_key_of_your_own_server_is_not_sent_to_a_public_server(fpage, mock):
    seen = watch(fpage)
    use_own(fpage); set_key(fpage)
    fpage.select_option("#source", "clearnet"); settle(fpage)
    open_query(fpage, NORMAL["txid"])
    public = [r for r in mock.requests if "my-node" not in r[0]]
    assert public, "mempool.space was asked"
    asked = fpage.evaluate("() => window.__hopline.state.client.auth")
    assert asked == {}, "no key is attached to the public server's client"
    assert not seen


# ---- a refusal is explained -------------------------------------------------------------------------------------------------------------------

def test_a_rejected_key_is_said_to_be_rejected_and_nothing_is_retried(fpage, mock):
    watch(fpage)
    mock.fail["/tx/" + NORMAL["txid"]] = 401
    use_own(fpage); set_key(fpage)
    fpage.fill("#q", NORMAL["txid"]); fpage.click("#searchForm button[type=submit]")
    fpage.wait_for_function("() => /rejected the key/.test(document.getElementById('toast').textContent)")
    assert "HTTP 401" in toast_text(fpage) and SECRET not in toast_text(fpage)
    assert len([r for r in mock.requests if r[1] == "/tx/" + NORMAL["txid"]]) == 1, "asking again with the same key would change nothing"


def test_a_server_that_wants_a_key_says_where_to_put_it(fpage, mock):
    watch(fpage)
    mock.fail["/tx/" + NORMAL["txid"]] = 403
    use_own(fpage)
    fpage.fill("#q", NORMAL["txid"]); fpage.click("#searchForm button[type=submit]")
    fpage.wait_for_function("() => /add one under Data source/.test(document.getElementById('toast').textContent)")
    assert "HTTP 403" in toast_text(fpage)


def test_test_connection_uses_the_key_and_reports_a_rejection(fpage, mock):
    seen = watch(fpage)
    use_own(fpage); set_key(fpage)
    fpage.click("#testSource")
    fpage.wait_for_function("() => /OK|Failed/.test(document.getElementById('testResult').textContent)")
    assert fpage.inner_text("#testResult").startswith("OK"), fpage.inner_text("#testResult")
    assert seen and seen[-1]["headers"].get("authorization") == "Bearer " + SECRET
    mock.fail["/blocks/tip/height"] = 401
    fpage.click("#testSource")
    fpage.wait_for_function("() => /Failed/.test(document.getElementById('testResult').textContent)")
    assert "the server rejected the key" in fpage.inner_text("#testResult")


def test_an_http_address_that_is_not_this_computer_is_warned_about(fpage):
    use_own(fpage, "http://my-node.example/api"); set_key(fpage)
    assert "http, not https" in fpage.inner_text("#keyHint")
    use_own(fpage, "http://127.0.0.1:3000/api")
    assert "http, not https" not in fpage.inner_text("#keyHint")
    use_own(fpage, OWN)
    assert "http, not https" not in fpage.inner_text("#keyHint")


# ---- where it is kept ----------------------------------------------------------------------------------------------------------------------------

def test_by_default_the_key_is_forgotten_when_the_page_is_closed_and_kept_nowhere(fpage, mock):
    watch(fpage)
    use_own(fpage); set_key(fpage)
    open_query(fpage, NORMAL["txid"]); settle(fpage)
    assert SECRET not in stored(fpage), "not in the saved session, the preferences or anywhere else"
    fpage.reload(); fpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert fpage.evaluate("() => window.__hopline.state.source") == "custom"
    assert fpage.input_value("#srcKey") == "" and fpage.evaluate("() => window.__hopline.state.client.auth") == {}


def test_remember_keeps_it_apart_from_everything_else_and_unticking_deletes_it(fpage, mock):
    seen = watch(fpage)
    use_own(fpage); set_key(fpage, remember=True)
    s = json.loads(stored(fpage))
    keyed = [k for k, v in s if SECRET in v]
    assert keyed == ["hopline.keys.v1"], "only in its own entry: %s" % keyed
    prefs = json.loads(fpage.evaluate("() => localStorage.getItem('hopline.prefs.v1')"))
    assert prefs["keyRemember"] is True and SECRET not in json.dumps(prefs)
    fpage.reload(); fpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert fpage.input_value("#srcKey") == SECRET
    open_query(fpage, NORMAL["txid"])
    assert seen and all(s["headers"].get("authorization") == "Bearer " + SECRET for s in seen)
    fpage.uncheck("#srcKeyRemember")
    assert SECRET not in stored(fpage), "unticking deletes the saved copy"
    assert fpage.input_value("#srcKey") == SECRET, "this session still has it"


def test_the_key_is_never_in_an_export_or_a_report(fpage, mock, tmp_path):
    watch(fpage)
    use_own(fpage); set_key(fpage, remember=True)
    open_query(fpage, NORMAL["txid"]); settle(fpage)
    fpage.evaluate("() => { document.getElementById('exportMenu').open = true; }")
    with fpage.expect_download() as dl:
        fpage.click("[data-export=json]")
    p = tmp_path / "ws.json"; dl.value.save_as(p)
    assert SECRET not in p.read_text(encoding="utf-8")
    html = make_report(fpage, tmp_path).read_text(encoding="utf-8")
    assert SECRET not in html and "my-node.example" in html, "the report names the server, never the key"


def test_the_wallet_page_uses_a_key_you_chose_to_remember(ctx, wpage, mock):
    seen = watch(wpage)
    prefs = {"source": "custom", "customBase": OWN, "keyRemember": True, "fallback": False}
    ctx.add_init_script("localStorage.setItem('hopline.prefs.v1', %s); localStorage.setItem('hopline.keys.v1', %s);"
                        % (json.dumps(json.dumps(prefs)), json.dumps(json.dumps({"custom": {"header": "Authorization", "value": SECRET}}))))
    wpage.goto(WALLET_URL + "?q=" + ADDRESS)
    wpage.wait_for_function("() => document.querySelectorAll('#ledger .tx').length > 0")
    assert seen and all(s["headers"].get("authorization") == "Bearer " + SECRET for s in seen)


def test_the_wallet_page_sends_no_key_you_did_not_choose_to_remember(ctx, wpage, mock):
    seen = watch(wpage)
    prefs = {"source": "custom", "customBase": OWN, "keyRemember": False, "fallback": False}
    ctx.add_init_script("localStorage.setItem('hopline.prefs.v1', %s); localStorage.setItem('hopline.keys.v1', %s);"
                        % (json.dumps(json.dumps(prefs)), json.dumps(json.dumps({"custom": {"header": "Authorization", "value": SECRET}}))))
    wpage.goto(WALLET_URL + "?q=" + ADDRESS)
    wpage.wait_for_function("() => document.querySelectorAll('#ledger .tx').length > 0")
    assert seen and all("authorization" not in s["headers"] for s in seen)


# ---- the pace ---------------------------------------------------------------------------------------------------------------------------------------

def test_the_pace_of_your_own_server_can_be_set_and_is_remembered_and_the_public_servers_keep_theirs(fpage):
    use_own(fpage)
    assert fpage.evaluate("() => [window.__hopline.state.client.concurrency, window.__hopline.state.client.delayMs]") == [8, 20]
    fpage.fill("#paceConc", "16"); fpage.dispatch_event("#paceConc", "change")
    fpage.fill("#paceDelay", "0"); fpage.dispatch_event("#paceDelay", "change")
    assert fpage.evaluate("() => [window.__hopline.state.client.concurrency, window.__hopline.state.client.delayMs]") == [16, 0]
    assert json.loads(fpage.evaluate("() => localStorage.getItem('hopline.prefs.v1')"))["pace"] == {"concurrency": 16, "delayMs": 0}
    fpage.fill("#paceConc", "500"); fpage.dispatch_event("#paceConc", "change")
    assert fpage.input_value("#paceConc") == "32", "kept within what is sensible"
    fpage.select_option("#source", "clearnet")
    assert fpage.evaluate("() => [window.__hopline.state.client.concurrency, window.__hopline.state.client.delayMs]") == [4, 150]
    fpage.reload(); fpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    fpage.select_option("#source", "custom")
    assert fpage.input_value("#paceConc") == "32" and fpage.input_value("#paceDelay") == "0"
