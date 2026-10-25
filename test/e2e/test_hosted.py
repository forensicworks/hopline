"""A published copy (public/config.js says hosted): no Tor, no session kept unless asked, and visits counted by page and feature name only.
The settings are injected the way tools/build_site.py writes them; the counting address is answered here, so nothing leaves the machine."""
import json
import re

import pytest

from conftest import ADDRESS, NORMAL, PAGE_URL, ROOT
from helpers import idle, open_query
from test_wallet_page import WALLET_URL, goto, wpage  # noqa: F401  (the fixture is used by name)
from test_wallet_sample import SAMPLE, serve_sample

INDEX_URL = (ROOT / "index.html").as_uri()
COUNT = "https://stats.example/count"
GIF = b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;"
SHAPE = re.compile(r"^https://stats\.example/count\?p=(%2F[a-z]*|[a-z][a-z0-9-]*)(&e=1)?&rnd=[a-z0-9]+$")


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def settings(ctx, hosted=True, endpoint=COUNT, dnt=False):
    cfg = {"hosted": hosted}
    if endpoint:
        cfg["stats"] = {"endpoint": endpoint}
    ctx.add_init_script("window.HOPLINE_CONFIG = %s;" % json.dumps(cfg))
    if dnt:
        ctx.add_init_script("Object.defineProperty(navigator, 'doNotTrack', { get: () => '1' });")


def seed_prefs(ctx, prefs):
    ctx.add_init_script("try { if (!localStorage.getItem('hopline.prefs.v1')) localStorage.setItem('hopline.prefs.v1', %s); } catch (e) {}" % json.dumps(json.dumps(prefs)))


@pytest.fixture
def hits(ctx):
    seen = []

    def handle(route):
        seen.append({"url": route.request.url, "headers": route.request.headers})
        route.fulfill(status=200, body=GIF, content_type="image/gif")
    ctx.route(re.compile(r"^https://stats\.example/"), handle)
    return seen


def names(hits):
    out = []
    for h in hits:
        m = re.search(r"\?p=([^&]+)", h["url"])
        out.append(re.sub(r"^%2F", "/", m.group(1)))
    return out


def new_page(ctx, errors, url):
    p = ctx.new_page(); p.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    p.goto(url)
    return p


# ---- no Tor ---------------------------------------------------------------------------------------------------------------------------------

def test_a_published_copy_offers_no_tor_and_ignores_it_when_saved_or_asked_for(ctx, errors):
    settings(ctx, endpoint=None); seed_prefs(ctx, {"source": "tor"})
    p = new_page(ctx, errors, PAGE_URL + "?source=tor"); p.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert p.eval_on_selector_all("#source option", "os => os.map(o => o.value)") == ["clearnet", "blockstream", "custom"]
    assert p.evaluate("() => window.__hopline.state.source") == "clearnet" and p.input_value("#source") == "clearnet"
    assert p.evaluate("() => window.__hopline.state.client.base") == "https://mempool.space/api"


def test_the_wallet_page_of_a_published_copy_does_not_use_tor_either(ctx, wpage, mock):
    settings(ctx, endpoint=None); seed_prefs(ctx, {"source": "tor"})
    goto(wpage)
    assert {h for h, _ in mock.requests} == {"https://mempool.space"}
    assert "mempool.space" in wpage.inner_text("#source")


def test_a_copy_that_is_not_published_still_offers_tor(ctx, errors):
    p = new_page(ctx, errors, PAGE_URL); p.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert "tor" in p.eval_on_selector_all("#source option", "os => os.map(o => o.value)")


# ---- the session --------------------------------------------------------------------------------------------------------------------------

def test_a_published_copy_keeps_no_session_unless_the_visitor_ticks_it(ctx, errors):
    settings(ctx, endpoint=None)
    p = new_page(ctx, errors, PAGE_URL); p.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert not p.is_checked("#persist")
    open_query(p, NORMAL["txid"]); p.wait_for_timeout(1300)
    assert p.evaluate("() => localStorage.getItem('hopline.workspace.v1')") is None, "nothing was written to the browser"
    p.click("summary:has-text('Privacy')"); p.check("#persist"); p.wait_for_timeout(1300)
    assert p.evaluate("() => localStorage.getItem('hopline.workspace.v1')") is not None, "ticking it keeps the session"
    p.reload(); p.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert p.is_checked("#persist") and p.is_visible("#restore"), "the choice is remembered, and the saved session is offered"


def test_other_saved_choices_do_not_turn_the_session_on_in_a_published_copy(ctx, errors):
    settings(ctx, endpoint=None); seed_prefs(ctx, {"stepSize": 7})
    p = new_page(ctx, errors, PAGE_URL); p.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert p.evaluate("() => window.__hopline.state.stepSize") == 7 and not p.is_checked("#persist")


def test_a_copy_that_is_not_published_keeps_the_session_by_default(ctx, errors):
    p = new_page(ctx, errors, PAGE_URL); p.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert p.is_checked("#persist")
    seed = p.evaluate("() => { localStorage.setItem('hopline.prefs.v1', JSON.stringify({ stepSize: 7 })); return true; }")
    p.reload(); p.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert seed and p.is_checked("#persist"), "unchanged where nothing is hosted"


# ---- the counter ----------------------------------------------------------------------------------------------------------------------------

def test_the_workspace_counts_its_page_and_a_few_features_by_name_and_nothing_else(ctx, errors, hits):
    settings(ctx)
    p = new_page(ctx, errors, PAGE_URL); p.wait_for_function("window.__hopline && window.__hopline.renderer")
    open_query(p, NORMAL["txid"]); idle(p)
    p.evaluate("(id) => window.__hopline.autoExpand(id, { dir: 'next', hops: 1, follow: 'all' })", "tx:" + NORMAL["txid"]); idle(p)
    p.wait_for_timeout(500)
    got = names(hits)
    assert got[0] == "/workspace" and "trace-start" in got and "auto-follow" in got, got
    for h in hits:
        assert SHAPE.match(h["url"]), h["url"]
        assert "referer" not in h["headers"], "no referrer is sent"
    everything = " ".join(h["url"] for h in hits)
    assert NORMAL["txid"] not in everything and ADDRESS not in everything and "bc1" not in everything
    assert p.evaluate("() => { const n = [...document.querySelectorAll('[data-counter]')]; return n.length > 0 && n.every((x) => !x.hidden); }"), "the note that says so is shown"


def test_the_wallet_page_and_the_landing_page_are_counted_and_say_so(ctx, wpage, errors, hits):
    settings(ctx)
    goto(wpage)
    wpage.click("#csv"); wpage.wait_for_timeout(500)
    got = names(hits)
    assert got[0] == "/wallet" and "wallet-csv" in got, got
    assert wpage.is_visible(".counterbar")
    assert ADDRESS not in " ".join(h["url"] for h in hits)
    n0 = len(hits)
    home = new_page(ctx, errors, INDEX_URL); home.wait_for_timeout(500)
    assert names(hits[n0:]) == ["/"]
    assert home.is_visible(".counterbar") and "GoatCounter" in home.inner_text(".counterbar") and "Do Not Track" in home.inner_text(".counterbar")


def test_the_landing_page_no_longer_claims_that_nothing_is_stored_on_a_server(ctx, errors):
    home = new_page(ctx, errors, INDEX_URL)
    text = home.inner_text(".lead")
    assert "none of your work is stored on a server" in text and "nothing is stored on a server" not in text
    assert home.is_hidden(".counterbar"), "and with no counter there is no note about one"


def test_a_browser_that_says_do_not_track_is_not_counted_and_no_note_appears(ctx, errors, hits):
    settings(ctx, dnt=True)
    p = new_page(ctx, errors, PAGE_URL); p.wait_for_function("window.__hopline && window.__hopline.renderer")
    open_query(p, NORMAL["txid"]); idle(p)
    home = new_page(ctx, errors, INDEX_URL); home.wait_for_timeout(500)
    assert hits == [] and home.is_hidden(".counterbar")


@pytest.mark.parametrize("endpoint", [None, "http://stats.example/count", "https://stats.example/count?site=1", "https://user@stats.example/count"])
def test_without_a_proper_counting_address_nothing_is_sent(ctx, errors, hits, endpoint):
    settings(ctx, endpoint=endpoint)
    p = new_page(ctx, errors, PAGE_URL); p.wait_for_function("window.__hopline && window.__hopline.renderer")
    open_query(p, NORMAL["txid"]); idle(p); p.wait_for_timeout(300)
    assert hits == [] and p.evaluate("() => !window.HoplineStats.enabled")


def test_trying_the_sample_wallet_is_counted_by_name_before_the_page_moves_on(ctx, wpage, mock, hits):
    settings(ctx); serve_sample(mock)
    wpage.goto(WALLET_URL); wpage.wait_for_selector("#sample")
    wpage.click("#sample"); wpage.wait_for_url("**/wallet.html?q=" + SAMPLE)
    wpage.wait_for_function("() => document.querySelectorAll('#ledger .tx').length > 0"); wpage.wait_for_timeout(300)
    got = names(hits)
    assert got[0] == "/wallet" and "sample-wallet" in got, got
    assert SAMPLE not in " ".join(h["url"] for h in hits) and all(SHAPE.match(h["url"]) for h in hits)


def test_every_page_shows_the_visit_counter_banner_when_it_counts(ctx, errors, hits):
    settings(ctx)
    for name, url in (("start page", INDEX_URL), ("wallet page", WALLET_URL), ("workspace", PAGE_URL)):
        p = new_page(ctx, errors, url); p.wait_for_timeout(600)
        bar = p.locator(".counterbar")
        assert bar.count() == 1 and bar.is_visible(), name
        text = bar.inner_text()
        assert "Visit counter" in text and "GoatCounter" in text and "Do Not Track" in text and "never addresses" in text, (name, text)
        links = bar.locator("a").evaluate_all("els => els.map((e) => [e.getAttribute('href'), e.getAttribute('rel'), e.getAttribute('target')])")
        assert ["https://www.goatcounter.com", "noopener noreferrer", "_blank"] in links, (name, links)
        assert ["https://github.com/forensicworks/hopline/wiki/Publishing-a-copy", "noopener noreferrer", "_blank"] in links, (name, links)
        p.close()


def test_without_counting_no_page_shows_the_banner(ctx, errors):
    for name, url in (("start page", INDEX_URL), ("wallet page", WALLET_URL), ("workspace", PAGE_URL)):
        p = new_page(ctx, errors, url); p.wait_for_timeout(500)
        assert p.locator(".counterbar").count() == 1 and p.locator(".counterbar").is_hidden(), name
        p.close()
