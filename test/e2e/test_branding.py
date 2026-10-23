"""The favicon and the logo in the headers of the three pages."""
import os

import pytest

from conftest import ROOT
from test_wallet_page import WALLET_URL, wpage  # noqa: F401  (the fixture is used by name)

PUBLIC = ROOT / "public"
WORKSPACE_URL = (PUBLIC / "workspace.html").as_uri()
INDEX_URL = (ROOT / "index.html").as_uri()


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def logo_state(page, selector):
    return page.evaluate("""(sel) => { const i = document.querySelector(sel); if (!i) return null;
        const r = i.getBoundingClientRect(); return { loaded: i.complete && i.naturalWidth > 0, natural: i.naturalWidth, w: Math.round(r.width), h: Math.round(r.height), alt: i.getAttribute('alt') }; }""", selector)


def icon_href(page):
    return page.evaluate("() => { const l = document.querySelector('link[rel=icon]'); return l ? l.href : null; }")


def test_the_logo_file_for_the_icon_is_small_and_square():
    f = PUBLIC / "logo-96.png"
    assert f.exists() and os.path.getsize(f) < 40000, "a small file: it is fetched on every page"
    data = f.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    width, height = int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
    assert (width, height) == (96, 96)


def test_the_workspace_has_a_favicon_and_the_logo_beside_its_name(fpage):
    assert icon_href(fpage).endswith("/public/logo-96.png")
    s = logo_state(fpage, "header#top .brand .logo")
    assert s["loaded"] and s["natural"] == 96 and (s["w"], s["h"]) == (26, 26), s
    assert s["alt"] == "", "decorative: the name is written next to it"
    assert "Hopline" in fpage.inner_text("header#top .brand") and "workspace" in fpage.inner_text("header#top .brand")


def test_the_logo_does_not_push_the_workspace_bar_onto_a_second_row(ctx):
    page = ctx.new_page()
    page.set_viewport_size({"width": 1366, "height": 768})
    page.goto(WORKSPACE_URL); page.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert page.evaluate("() => Math.round(document.getElementById('top').getBoundingClientRect().height)") <= 56, "still one row at 1366 px"
    page.close()


def test_the_wallet_page_has_the_same_favicon_and_logo(wpage):
    wpage.goto(WALLET_URL)
    assert icon_href(wpage).endswith("/public/logo-96.png")
    s = logo_state(wpage, "header#top .brand .logo, header .brand .logo")
    assert s["loaded"] and (s["w"], s["h"]) == (26, 26) and s["alt"] == ""


def test_the_start_page_has_the_favicon_and_a_larger_logo(ctx):
    page = ctx.new_page()
    page.goto(INDEX_URL)
    assert icon_href(page).endswith("/public/logo-96.png")
    s = logo_state(page, "h1 .logo")
    assert s["loaded"] and (s["w"], s["h"]) == (44, 44), s
    assert page.inner_text("h1").startswith("Hopline")
    page.close()


def test_a_missing_logo_file_leaves_the_name_readable(ctx):
    page = ctx.new_page()
    page.route("**/logo-96.png", lambda route: route.abort())
    page.goto(WORKSPACE_URL); page.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert "Hopline" in page.inner_text("header#top .brand")
    assert page.is_visible("header#top .brand")
    page.close()
