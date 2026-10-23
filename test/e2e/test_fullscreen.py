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


def side_gone(page):
    """The left panel is out of sight: not drawn at all, or slid away (it takes a moment to finish)."""
    page.wait_for_function("() => { const s = document.getElementById('side'), c = getComputedStyle(s); return c.display === 'none' || c.visibility === 'hidden'; }")


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
    assert ids == ["zoomIn", "zoomOut", "fullControls", "fullBtn"]
    assert fpage.get_attribute("#fullBtn", "aria-label") == "Full screen" and fpage.get_attribute("#fullBtn", "aria-pressed") == "false"
    assert "Full screen" in fpage.get_attribute("#fullBtn", "title") and "(M)" in fpage.get_attribute("#fullBtn", "title")
    assert fpage.is_visible("#fullBtn .enter") and not fpage.is_visible("#fullBtn .exit")
    assert not fpage.is_visible("#fullControls"), "the Controls button is for full screen only: the panel is already there"


def test_the_button_clears_everything_but_the_graph_and_gives_it_the_room(fpage):
    open_query(fpage, NORMAL["txid"]); settle(fpage)
    before = canvas_width(fpage)
    for sel in ("#top", "#side"):
        assert fpage.is_visible(sel)
    fpage.click("#fullBtn"); settle(fpage)
    assert full(fpage)
    side_gone(fpage)
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


# ---- the Controls stay within reach ------------------------------------------------------------------------------------------------------

def go_full(page):
    open_query(page, NORMAL["txid"]); settle(page)
    page.evaluate("() => { document.documentElement.requestFullscreen = () => Promise.reject(new Error('not allowed here')); }")        # the page's own full screen: Esc reaches the page
    page.click("#fullBtn"); settle(page)
    assert full(page)


def test_in_full_screen_a_controls_button_opens_the_left_panel_over_the_graph(fpage):
    go_full(fpage)
    assert fpage.is_visible("#fullControls") and fpage.get_attribute("#fullControls", "aria-expanded") == "false" and fpage.get_attribute("#fullControls", "aria-label") == "Controls"
    side_gone(fpage)                                                                         # closed: out of sight, and its fields cannot be tabbed to
    width = canvas_width(fpage)
    fpage.click("#fullControls"); settle(fpage)
    assert fpage.is_visible("#side") and fpage.get_attribute("#fullControls", "aria-expanded") == "true"
    fpage.wait_for_function("() => getComputedStyle(document.getElementById('side')).transform === 'none'")           # it has finished sliding in
    box = fpage.locator("#side").bounding_box()
    assert box["x"] >= -1 and box["width"] <= 301 and box["height"] > 300, "a panel along the left edge"
    assert canvas_width(fpage) == width, "over the graph: the graph does not shrink or move"
    assert fpage.is_visible("#layoutSeg") and fpage.evaluate("() => document.activeElement && document.getElementById('side').contains(document.activeElement)"), "focus moved into it"


def test_the_controls_work_from_the_drawer_and_the_graph_stays_full_screen(fpage):
    go_full(fpage)
    fpage.click("#fullControls"); settle(fpage)
    fpage.click("#layoutSeg [data-layout=timeline]"); settle(fpage)
    assert fpage.evaluate("() => window.__hopline.state.layout") == "timeline" and full(fpage)
    fpage.click("#fullControls"); settle(fpage)
    side_gone(fpage); assert fpage.get_attribute("#fullControls", "aria-expanded") == "false"


def test_c_opens_and_closes_the_drawer_in_full_screen_and_still_folds_the_panel_otherwise(fpage):
    go_full(fpage)
    fpage.locator("#cv").focus(); fpage.keyboard.press("c"); settle(fpage)
    assert fpage.is_visible("#side")
    fpage.locator("#cv").focus(); fpage.keyboard.press("c"); settle(fpage)
    side_gone(fpage)
    fpage.keyboard.press("m"); settle(fpage)
    assert not full(fpage) and fpage.is_visible("#side")
    fpage.keyboard.press("c"); settle(fpage)
    assert not fpage.is_visible("#side"), "outside full screen C folds the panel, as before"
    fpage.keyboard.press("c"); settle(fpage)
    assert fpage.is_visible("#side")


def test_esc_closes_the_drawer_first_even_from_a_field_in_it_and_then_leaves_full_screen(fpage):
    go_full(fpage)
    fpage.click("#fullControls"); settle(fpage)
    fpage.click("#side summary >> nth=0"); fpage.evaluate("() => { const i = document.querySelector('#side input[type=number], #side input[type=text], #side input[type=url]'); if (i) i.focus(); }")
    fpage.keyboard.press("Escape"); settle(fpage)
    side_gone(fpage); assert full(fpage), "the drawer closes first"
    fpage.locator("#cv").focus(); fpage.keyboard.press("Escape"); settle(fpage)
    assert not full(fpage) and fpage.is_visible("#top") and fpage.is_visible("#side")


def test_leaving_full_screen_closes_the_drawer_and_gives_the_normal_panel_back(fpage):
    go_full(fpage)
    fpage.click("#fullControls"); settle(fpage)
    fpage.click("#fullBtn"); settle(fpage)
    assert not full(fpage) and fpage.evaluate("() => document.body.classList.contains('full-side-open')") is False
    assert fpage.is_visible("#side") and not fpage.is_visible("#fullControls")
    box = fpage.locator("#side").bounding_box()
    assert box["x"] >= -1 and fpage.evaluate("() => getComputedStyle(document.getElementById('side')).position") != "absolute", "back in the layout, not over the graph"


def test_the_fold_button_in_the_drawer_closes_it_and_does_not_change_the_saved_choice(fpage):
    go_full(fpage)
    fpage.click("#fullControls"); settle(fpage)
    fpage.click("#sideCollapse"); settle(fpage)
    side_gone(fpage)
    assert fpage.evaluate("() => window.__hopline.state.sideCollapsed") is False
    fpage.click("#fullBtn"); settle(fpage)
    assert fpage.is_visible("#side"), "the panel is back as it was"
