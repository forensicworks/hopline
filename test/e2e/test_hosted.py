"""A published copy (public/config.js says hosted): no Tor, and no session kept unless asked.
The settings are injected the way tools/build_site.py writes them."""
import json

import pytest

from conftest import NORMAL, PAGE_URL, ROOT
from helpers import open_controls, open_query
from test_wallet_page import goto, wpage  # noqa: F401  (the fixture is used by name)

INDEX_URL = (ROOT / "index.html").as_uri()


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def settings(ctx, hosted=True):
    ctx.add_init_script("window.HOPLINE_CONFIG = %s;" % json.dumps({"hosted": hosted}))


def seed_prefs(ctx, prefs):
    ctx.add_init_script("try { if (!localStorage.getItem('hopline.prefs.v1')) localStorage.setItem('hopline.prefs.v1', %s); } catch (e) {}" % json.dumps(json.dumps(prefs)))


def new_page(ctx, errors, url):
    p = ctx.new_page(); p.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    p.goto(url)
    return p


# ---- no Tor ---------------------------------------------------------------------------------------------------------------------------------

def test_a_published_copy_offers_no_tor_and_ignores_it_when_saved_or_asked_for(ctx, errors):
    settings(ctx); seed_prefs(ctx, {"source": "tor"})
    p = new_page(ctx, errors, PAGE_URL + "?source=tor"); p.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert p.eval_on_selector_all("#source option", "os => os.map(o => o.value)") == ["clearnet", "blockstream", "custom"]
    assert p.evaluate("() => window.__hopline.state.source") == "clearnet" and p.input_value("#source") == "clearnet"
    assert p.evaluate("() => window.__hopline.state.client.base") == "https://mempool.space/api"


def test_the_wallet_page_of_a_published_copy_does_not_use_tor_either(ctx, wpage, mock):
    settings(ctx); seed_prefs(ctx, {"source": "tor"})
    goto(wpage)
    assert {h for h, _ in mock.requests} == {"https://mempool.space"}
    assert "mempool.space" in wpage.inner_text("#source")


def test_a_copy_that_is_not_published_still_offers_tor(ctx, errors):
    p = new_page(ctx, errors, PAGE_URL); p.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert "tor" in p.eval_on_selector_all("#source option", "os => os.map(o => o.value)")


# ---- the session --------------------------------------------------------------------------------------------------------------------------

def test_a_published_copy_keeps_no_session_unless_the_visitor_ticks_it(ctx, errors):
    settings(ctx)
    p = new_page(ctx, errors, PAGE_URL); p.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert not p.is_checked("#persist")
    open_query(p, NORMAL["txid"]); p.wait_for_timeout(1300)
    assert p.evaluate("() => localStorage.getItem('hopline.workspace.v1')") is None, "nothing was written to the browser"
    open_controls(p); p.click("summary:has-text('Privacy')"); p.check("#persist"); p.wait_for_timeout(1300)
    assert p.evaluate("() => localStorage.getItem('hopline.workspace.v1')") is not None, "ticking it keeps the session"
    p.reload(); p.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert p.is_checked("#persist") and p.is_visible("#restore"), "the choice is remembered, and the saved session is offered"


def test_other_saved_choices_do_not_turn_the_session_on_in_a_published_copy(ctx, errors):
    settings(ctx); seed_prefs(ctx, {"stepSize": 7})
    p = new_page(ctx, errors, PAGE_URL); p.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert p.evaluate("() => window.__hopline.state.stepSize") == 7 and not p.is_checked("#persist")


def test_a_copy_that_is_not_published_keeps_the_session_by_default(ctx, errors):
    p = new_page(ctx, errors, PAGE_URL); p.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert p.is_checked("#persist")
    seed = p.evaluate("() => { localStorage.setItem('hopline.prefs.v1', JSON.stringify({ stepSize: 7 })); return true; }")
    p.reload(); p.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert seed and p.is_checked("#persist"), "unchanged where nothing is hosted"


# ---- the start page --------------------------------------------------------------------------------------------------------------------------

def test_the_landing_page_no_longer_claims_that_nothing_is_stored_on_a_server(ctx, errors):
    home = new_page(ctx, errors, INDEX_URL)
    text = home.inner_text(".proof")
    assert "none of your work is stored on a server" in text and "nothing is stored on a server" not in text
