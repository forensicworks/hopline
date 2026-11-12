"""The version in the footer of each page, and the bar a page left open shows when its site holds a later version.
The settings are injected the way tools/build_site.py writes them and the site's version.json is answered by the test, so nothing leaves the machine."""
import json

import pytest

from conftest import PAGE_URL, ROOT

PAGES = {"start page": ((ROOT / "index.html").as_uri(), ""), "wallet page": ((ROOT / "public" / "wallet.html").as_uri(), "../"), "workspace": (PAGE_URL, "../")}
OWN = {"version": "aaaaaaa", "committed": "2026-11-01T10:00:00Z"}
LATER = {"version": "bbbbbbb", "committed": "2026-11-12T00:00:00Z"}
FAST = {"first": 100, "every": 500, "idle": 100}


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def site(ctx, published, own=OWN, timing=FAST):
    """The pages are published with `own` as their version, and the site answers version.json with `published` (None: 404, "fail": the request fails).
    window.__published can be changed afterwards; window.__asked lists what was asked."""
    cfg = {"hosted": True}
    if own:
        cfg.update(own)
    if timing:
        cfg["versionCheck"] = timing
    ctx.add_init_script("""
      window.HOPLINE_CONFIG = %s; window.__published = %s; window.__asked = [];
      const real = window.fetch.bind(window);
      window.fetch = (url, init) => {
        if (String(url).indexOf('version.json') < 0) return real(url, init);
        window.__asked.push({ url: String(url), cache: init && init.cache, credentials: init && init.credentials });
        const p = window.__published;
        if (p === 'fail') return Promise.reject(new TypeError('offline'));
        return Promise.resolve(new Response(p === null ? 'not found' : JSON.stringify(p), { status: p === null ? 404 : 200 }));
      };""" % (json.dumps(cfg), json.dumps(published)))


def open_page(ctx, errors, name):
    p = ctx.new_page(); p.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    p.goto(PAGES[name][0])
    return p


def bar_visible(p):
    return p.evaluate("() => !document.getElementById('newVersion').hidden")


@pytest.mark.parametrize("name", sorted(PAGES))
def test_each_page_shows_its_version_where_it_ends(ctx, errors, name):
    site(ctx, OWN)
    p = open_page(ctx, errors, name)
    el = p.locator("[data-version]")
    assert el.count() == 1
    el.wait_for(state="visible")
    assert el.inner_text() == "Version aaaaaaa"
    assert "1 Nov 2026 10:00 UTC" in el.get_attribute("title") and "label packs" in el.get_attribute("title")


@pytest.mark.parametrize("name", sorted(PAGES))
def test_a_copy_with_no_version_shows_none_and_asks_nothing(ctx, errors, name):
    site(ctx, LATER, own=None)
    p = open_page(ctx, errors, name)
    p.wait_for_timeout(900)
    assert p.is_hidden("[data-version]") and not bar_visible(p)
    assert p.evaluate("() => window.__asked") == [], "a local copy never asks"


@pytest.mark.parametrize("name", sorted(PAGES))
def test_a_later_version_shows_the_bar_and_reload_starts_the_page_over(ctx, errors, name):
    site(ctx, LATER)
    p = open_page(ctx, errors, name)
    p.wait_for_selector("#newVersion:not([hidden])")
    text = p.inner_text("#newVersion")
    assert "A newer version of Hopline is available (bbbbbbb, committed 12 Nov 2026 00:00 UTC)." in text
    assert ("Export your work first" in text) == (name == "workspace"), "only where a reload costs work"
    asked = p.evaluate("() => window.__asked")
    assert asked and asked[0]["url"].startswith(PAGES[name][1] + "version.json?t=") and asked[0]["cache"] == "no-store" and asked[0]["credentials"] == "omit"
    assert [b.strip() for b in p.eval_on_selector_all("#newVersion button", "els => els.map(e => e.textContent)")] == ["Reload", "Not now"]
    p.evaluate("() => { window.__mark = 1; }")
    p.click("#newVersionReload")
    p.wait_for_function("() => window.__mark === undefined")


@pytest.mark.parametrize("published", [OWN, {"version": "bbbbbbb", "committed": "2026-10-31T00:00:00Z"}, {"version": "bbbbbbb", "committed": OWN["committed"]},
                                       {"version": "bbbbbbb"}, {"version": "bbbbbbb", "committed": "tomorrow"}, {"nothing": 1}, [], None, "fail"],
                         ids=["same", "older", "same moment", "no date", "bad date", "no version", "not an object", "404", "offline"])
def test_a_version_that_is_not_known_to_be_later_says_nothing(ctx, errors, published):
    site(ctx, published)
    p = open_page(ctx, errors, "start page")
    p.wait_for_function("() => window.__asked.length >= 3", timeout=5000)
    assert not bar_visible(p)


def test_not_now_hides_the_bar_until_a_still_later_version_appears(ctx, errors):
    site(ctx, LATER)
    p = open_page(ctx, errors, "workspace")
    p.wait_for_selector("#newVersion:not([hidden])")
    p.click("#newVersionLater")
    assert not bar_visible(p)
    n = p.evaluate("() => window.__asked.length")
    p.wait_for_function("(n) => window.__asked.length >= n + 2", arg=n, timeout=5000)
    assert not bar_visible(p), "asked again and still the same: it does not nag"
    p.evaluate("() => { window.__published = { version: 'ccccccc', committed: '2026-11-13T00:00:00Z' }; }")
    p.wait_for_selector("#newVersion:not([hidden])")
    assert "ccccccc" in p.inner_text("#newVersion")


def test_the_bar_goes_away_when_the_site_no_longer_holds_a_later_version(ctx, errors):
    site(ctx, LATER)
    p = open_page(ctx, errors, "wallet page")
    p.wait_for_selector("#newVersion:not([hidden])")
    p.evaluate("() => { window.__published = %s; }" % json.dumps(OWN))
    p.wait_for_function("() => document.getElementById('newVersion').hidden")


def test_coming_back_to_the_tab_after_a_while_looks_again_but_not_over_and_over(ctx, errors):
    site(ctx, LATER, timing={"first": 10 ** 9, "every": 10 ** 9, "idle": 60000})
    p = open_page(ctx, errors, "start page")
    p.wait_for_timeout(300)
    assert p.evaluate("() => window.__asked.length") == 0
    p.evaluate("() => document.dispatchEvent(new Event('visibilitychange'))")
    p.wait_for_selector("#newVersion:not([hidden])")
    p.evaluate("() => { document.dispatchEvent(new Event('visibilitychange')); document.dispatchEvent(new Event('visibilitychange')); }")
    p.wait_for_timeout(300)
    assert p.evaluate("() => window.__asked.length") == 1, "a tab switched to again within the idle time does not ask again"


def test_the_pages_work_as_before_while_the_bar_is_shown(ctx, errors):
    site(ctx, LATER)
    p = open_page(ctx, errors, "start page")
    p.wait_for_selector("#newVersion:not([hidden])")
    p.fill("#q", "0f58c9a7aee48bd72ffd929fd3ac80bf95db5be13a6493b2f954de9ae659710d")
    assert p.is_visible("#toWorkspace") and p.is_visible("#q") and p.evaluate("() => document.documentElement.scrollWidth <= document.documentElement.clientWidth")
