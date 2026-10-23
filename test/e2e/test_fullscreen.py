"""Full screen: the graph alone, from a button under the zoom buttons, the M key, and back with Esc or the same button."""
import json

import pytest

from conftest import NORMAL
from helpers import click_node, open_query, settle

NORMAL_ID = "tx:" + NORMAL["txid"]


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def full(page):
    return page.evaluate("() => document.body.classList.contains('canvas-full')")


def canvas_width(page):
    return page.evaluate("() => Math.round(document.getElementById('cv').getBoundingClientRect().width)")


def renderer_width(page):
    return page.evaluate("() => window.__hopline.renderer.w")


def leave_the_way_the_browser_does(page):
    """What Esc does: out of real full screen where the browser gave it, otherwise the page's own Esc."""
    if page.evaluate("() => !!document.fullscreenElement"):
        page.evaluate("() => document.exitFullscreen()")
    else:
        page.locator("#cv").focus(); page.keyboard.press("Escape")
    page.wait_for_function("() => !document.body.classList.contains('canvas-full')")


def test_the_button_is_under_the_zoom_buttons_and_says_what_it_does(fpage):
    open_query(fpage, NORMAL["txid"])
    ids = fpage.evaluate("() => [...document.querySelectorAll('#zoomBtns button')].map((b) => b.id)")
    assert ids == ["zoomIn", "zoomOut", "fullBtn"]
    assert fpage.get_attribute("#fullBtn", "aria-label") == "Full screen" and fpage.get_attribute("#fullBtn", "aria-pressed") == "false"
    assert "Full screen" in fpage.get_attribute("#fullBtn", "title") and "(M)" in fpage.get_attribute("#fullBtn", "title")
    assert fpage.is_visible("#fullBtn .enter") and not fpage.is_visible("#fullBtn .exit")


def test_the_button_clears_everything_but_the_graph_and_gives_it_the_room(fpage):
    open_query(fpage, NORMAL["txid"]); settle(fpage)
    before = canvas_width(fpage)
    for sel in ("#top", "#side"):
        assert fpage.is_visible(sel)
    fpage.click("#fullBtn"); settle(fpage)
    assert full(fpage)
    for sel in ("#top", "#side", "#log"):
        assert not fpage.is_visible(sel), sel + " is out of the way"
    assert fpage.is_visible("#cv") and fpage.is_visible("#zoomBtns") and fpage.is_visible("#timebar"), "the graph and its own controls stay"
    assert canvas_width(fpage) > before + 200, "the room the left panel took goes to the graph"
    assert renderer_width(fpage) == canvas_width(fpage), "and the drawing follows the size"
    assert fpage.get_attribute("#fullBtn", "aria-pressed") == "true" and fpage.get_attribute("#fullBtn", "aria-label") == "Leave full screen"
    assert fpage.is_visible("#fullBtn .exit") and not fpage.is_visible("#fullBtn .enter")
    fpage.click("#fullBtn"); settle(fpage)
    assert not full(fpage) and fpage.is_visible("#top") and fpage.is_visible("#side")
    assert canvas_width(fpage) == before and renderer_width(fpage) == before
    assert fpage.get_attribute("#fullBtn", "aria-pressed") == "false" and fpage.get_attribute("#fullBtn", "aria-label") == "Full screen"


def test_the_m_key_does_the_same(fpage):
    open_query(fpage, NORMAL["txid"]); settle(fpage)
    fpage.locator("#cv").focus(); fpage.keyboard.press("m"); settle(fpage)
    assert full(fpage)
    fpage.keyboard.press("M"); settle(fpage)
    assert not full(fpage)


def test_m_typed_in_a_field_is_just_a_letter(fpage):
    open_query(fpage, NORMAL["txid"]); settle(fpage)
    fpage.fill("#q", ""); fpage.keyboard.type("m")
    assert not full(fpage) and fpage.input_value("#q") == "m"


def test_esc_leaves_it(fpage):
    open_query(fpage, NORMAL["txid"]); settle(fpage)
    fpage.click("#fullBtn"); settle(fpage)
    assert full(fpage)
    leave_the_way_the_browser_does(fpage); settle(fpage)
    assert fpage.is_visible("#top") and fpage.is_visible("#side")
    assert fpage.get_attribute("#fullBtn", "aria-pressed") == "false"


def refuse_real_full_screen(page):
    page.evaluate("() => { document.documentElement.requestFullscreen = () => Promise.reject(new Error('not allowed here')); }")


def test_esc_first_ends_box_select_and_then_leaves_full_screen(fpage):
    open_query(fpage, NORMAL["txid"]); settle(fpage)
    refuse_real_full_screen(fpage)                                                          # an embedded view: only the page itself can be cleared
    fpage.click("#fullBtn"); settle(fpage)
    assert full(fpage) and not fpage.evaluate("() => !!document.fullscreenElement")
    fpage.locator("#cv").focus(); fpage.keyboard.press("b")
    assert fpage.evaluate("() => window.__hopline.state.boxMode") is True
    fpage.keyboard.press("Escape"); settle(fpage)
    assert fpage.evaluate("() => window.__hopline.state.boxMode") is False and full(fpage), "box select ends first"
    fpage.keyboard.press("Escape"); settle(fpage)
    assert not full(fpage), "then full screen"
    assert fpage.is_visible("#top") and fpage.is_visible("#side")


def test_where_the_browser_has_no_full_screen_at_all_the_button_still_clears_the_page(fpage):
    open_query(fpage, NORMAL["txid"]); settle(fpage)
    fpage.evaluate("() => { const d = document.documentElement; d.requestFullscreen = undefined; d.webkitRequestFullscreen = undefined; }")
    fpage.click("#fullBtn"); settle(fpage)
    assert full(fpage) and not fpage.is_visible("#top")
    fpage.click("#fullBtn"); settle(fpage)
    assert not full(fpage) and fpage.is_visible("#top")


def test_the_details_panel_still_opens_on_a_selection(fpage):
    open_query(fpage, NORMAL["txid"]); settle(fpage)
    fpage.evaluate("() => window.__hopline.setSel([])"); settle(fpage)
    fpage.click("#fullBtn"); settle(fpage)
    click_node(fpage, NORMAL_ID); settle(fpage)
    assert fpage.is_visible("#inspector") and "TRANSACTION" in fpage.inner_text("#inspBody").upper()


def test_asking_for_find_or_the_address_field_brings_the_page_back(fpage):
    open_query(fpage, NORMAL["txid"]); settle(fpage)
    fpage.click("#fullBtn"); settle(fpage)
    fpage.locator("#cv").focus(); fpage.keyboard.press("Control+f"); settle(fpage)
    assert not full(fpage) and fpage.evaluate("() => document.activeElement.id") == "findQ"
    fpage.keyboard.press("Escape")
    fpage.click("#fullBtn"); settle(fpage)
    fpage.locator("#cv").focus(); fpage.keyboard.press("/"); settle(fpage)
    assert not full(fpage) and fpage.evaluate("() => document.activeElement.id") == "q"


def test_it_changes_nothing_that_is_saved(fpage):
    open_query(fpage, NORMAL["txid"]); settle(fpage)
    fpage.click("#fullBtn"); settle(fpage)
    prefs = json.loads(fpage.evaluate("() => localStorage.getItem('hopline.prefs.v1') || '{}'"))
    assert prefs.get("sideCollapsed", False) is False and "canvas-full" not in json.dumps(prefs) and "fullScreen" not in json.dumps(prefs)
    assert not fpage.evaluate("() => document.body.classList.contains('side-collapsed')"), "the left panel is hidden by full screen, not folded away"
    fpage.click("#fullBtn"); settle(fpage)
    fpage.reload(); fpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert not full(fpage) and fpage.is_visible("#side")


def test_the_graph_keeps_its_view_when_it_was_zoomed_by_hand_and_refits_when_it_was_not(fpage):
    open_query(fpage, NORMAL["txid"]); settle(fpage)
    fpage.evaluate("() => { const r = window.__hopline.renderer; r.zoomBy(1.5); }"); settle(fpage)
    k = fpage.evaluate("() => window.__hopline.renderer.view.k")
    fpage.click("#fullBtn"); settle(fpage)
    assert abs(fpage.evaluate("() => window.__hopline.renderer.view.k") - k) < 1e-6, "a view you set yourself is not thrown away"
    fpage.click("#fullBtn"); settle(fpage)
    fpage.keyboard.press("Escape")
    fpage.locator("#cv").focus(); fpage.keyboard.press("f"); settle(fpage)
    assert fpage.evaluate("() => window.__hopline.renderer.autoFit") is True
    fpage.click("#fullBtn"); settle(fpage)
    assert renderer_width(fpage) == canvas_width(fpage) and fpage.evaluate("() => window.__hopline.renderer.autoFit") is True
