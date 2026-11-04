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
    assert ids == ["zoomIn", "zoomOut", "zoomFit", "fullBtn"]
    assert fpage.get_attribute("#fullBtn", "aria-label") == "Full screen" and fpage.get_attribute("#fullBtn", "aria-pressed") == "false"
    assert "Full screen" in fpage.get_attribute("#fullBtn", "title") and "(M)" in fpage.get_attribute("#fullBtn", "title")
    assert fpage.is_visible("#fullBtn .enter") and not fpage.is_visible("#fullBtn .exit")
    assert fpage.is_visible("#zoomFit") and fpage.get_attribute("#zoomFit", "aria-label") == "Fit everything in view" and "(F)" in fpage.get_attribute("#zoomFit", "title")
    assert not fpage.is_visible("#sideTab"), "the Controls tab is for a folded panel (and for full screen): the panel is already there"
    assert fpage.locator("#btnFit").count() == 0, "Fit is a camera control: it lives with the zoom buttons, not in the top bar"


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


def test_in_full_screen_a_controls_tab_opens_the_left_panel_over_the_graph(fpage):
    go_full(fpage)
    assert fpage.is_visible("#sideTab") and fpage.get_attribute("#sideTab", "aria-expanded") == "false" and "Controls" in fpage.inner_text("#sideTab")
    side_gone(fpage)                                                                         # closed: out of sight, and its fields cannot be tabbed to
    width = canvas_width(fpage)
    fpage.click("#sideTab"); settle(fpage)
    assert fpage.is_visible("#side") and fpage.get_attribute("#sideTab", "aria-expanded") == "true" and not fpage.is_visible("#sideTab"), "open: the tab is out of the way"
    fpage.wait_for_function("() => getComputedStyle(document.getElementById('side')).transform === 'none'")           # it has finished sliding in
    box = fpage.locator("#side").bounding_box()
    assert box["x"] >= -1 and box["width"] <= 301 and box["height"] > 300, "a panel along the left edge"
    assert canvas_width(fpage) == width, "over the graph: the graph does not shrink or move"
    assert fpage.is_visible("#layoutSeg") and fpage.evaluate("() => document.activeElement && document.getElementById('side').contains(document.activeElement)"), "focus moved into it"


def test_the_controls_work_from_the_drawer_and_the_graph_stays_full_screen(fpage):
    go_full(fpage)
    fpage.click("#sideTab"); settle(fpage)
    fpage.click("#layoutSeg [data-layout=timeline]"); settle(fpage)
    assert fpage.evaluate("() => window.__hopline.state.layout") == "timeline" and full(fpage)
    fpage.click("#sideCollapse"); settle(fpage)
    side_gone(fpage); assert fpage.get_attribute("#sideTab", "aria-expanded") == "false" and fpage.is_visible("#sideTab"), "closed: the tab is back"


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
    fpage.click("#sideTab"); settle(fpage)
    fpage.click("#side summary >> nth=0"); fpage.evaluate("() => { const i = document.querySelector('#side input[type=number], #side input[type=text], #side input[type=url]'); if (i) i.focus(); }")
    fpage.keyboard.press("Escape"); settle(fpage)
    side_gone(fpage); assert full(fpage), "the drawer closes first"
    fpage.locator("#cv").focus(); fpage.keyboard.press("Escape"); settle(fpage)
    assert not full(fpage) and fpage.is_visible("#top") and fpage.is_visible("#side")


def test_leaving_full_screen_closes_the_drawer_and_gives_the_normal_panel_back(fpage):
    go_full(fpage)
    fpage.click("#sideTab"); settle(fpage)
    fpage.click("#fullBtn"); settle(fpage)
    assert not full(fpage) and fpage.evaluate("() => document.body.classList.contains('full-side-open')") is False
    assert fpage.is_visible("#side") and not fpage.is_visible("#sideTab")
    box = fpage.locator("#side").bounding_box()
    assert box["x"] >= -1 and fpage.evaluate("() => getComputedStyle(document.getElementById('side')).position") != "absolute", "back in the layout, not over the graph"


def test_the_fold_button_in_the_drawer_closes_it_and_does_not_change_the_saved_choice(fpage):
    go_full(fpage)
    fpage.click("#sideTab"); settle(fpage)
    fpage.click("#sideCollapse"); settle(fpage)
    side_gone(fpage)
    assert fpage.evaluate("() => window.__hopline.state.sideCollapsed") is False
    fpage.click("#fullBtn"); settle(fpage)
    assert fpage.is_visible("#side"), "the panel is back as it was"


def test_the_findings_tab_does_not_sit_on_a_button_when_the_findings_are_folded_in_full_screen(fpage):
    from helpers import open_query
    from conftest import NORMAL
    open_query(fpage, NORMAL["txid"])
    fpage.click("#fullBtn"); settle(fpage)
    assert fpage.evaluate("() => document.body.classList.contains('canvas-full')")
    fpage.evaluate("() => window.__hopline.state.inspCollapsed || document.getElementById('inspCollapse').click()"); settle(fpage)
    fpage.wait_for_selector("#inspTab:not([hidden])", timeout=5000)
    tab = fpage.locator("#inspTab").bounding_box()
    for id_ in ("zoomIn", "zoomOut", "zoomFit", "fullBtn"):
        b = fpage.locator("#" + id_).bounding_box()
        assert b["y"] + b["height"] <= tab["y"] or tab["y"] + tab["height"] <= b["y"] or b["x"] + b["width"] <= tab["x"], "the tab is on the %s button: %s %s" % (id_, tab, b)


def view(page):
    return page.evaluate("() => { const v = window.__hopline.renderer.view; return [v.k, v.x, v.y]; }")


def test_the_fit_button_under_the_zoom_buttons_fits_the_view_like_the_f_key_and_works_in_full_screen(fpage):
    open_query(fpage, NORMAL["txid"]); settle(fpage)
    fpage.click("#zoomIn"); fpage.click("#zoomIn"); settle(fpage)
    zoomed = view(fpage)
    fpage.click("#zoomFit"); settle(fpage)
    fitted = view(fpage)
    assert fitted != zoomed
    fpage.click("#zoomIn"); settle(fpage)
    fpage.locator("#cv").focus(); fpage.keyboard.press("f"); settle(fpage)
    assert all(abs(a - b) < 0.5 for a, b in zip(view(fpage), fitted)), "F and the button do the same"
    go_full(fpage)
    fpage.click("#zoomIn"); fpage.click("#zoomIn"); settle(fpage)
    fpage.click("#zoomFit"); settle(fpage)
    assert fpage.is_visible("#zoomFit") and full(fpage)
    k = view(fpage)[0]
    fpage.click("#zoomIn"); settle(fpage)
    assert view(fpage)[0] != k
    fpage.click("#zoomFit"); settle(fpage)
    assert abs(view(fpage)[0] - k) < 1e-6, "Fit again: the same fit"


def test_the_controls_tab_is_there_in_full_screen_even_when_the_panel_was_open_and_on_a_narrow_screen(fpage):
    fpage.set_viewport_size({"width": 700, "height": 800})
    open_query(fpage, NORMAL["txid"]); settle(fpage)
    assert not fpage.is_visible("#sideTab"), "a narrow screen has its own Controls button in the top bar"
    go_full(fpage)
    assert fpage.is_visible("#sideTab"), "in full screen the tab is the way to the panel, at any width"
    fpage.click("#sideTab"); settle(fpage)
    assert fpage.is_visible("#side") and fpage.is_visible("#sideCollapse")
    fpage.click("#sideCollapse"); settle(fpage)
    side_gone(fpage); assert fpage.is_visible("#sideTab")
    fpage.click("#fullBtn"); settle(fpage)
    assert not full(fpage) and not fpage.is_visible("#sideTab")


def test_the_controls_tab_does_not_sit_on_the_trace_bar_in_full_screen(tpage):
    open_query(tpage, NORMAL["txid"]); settle(tpage)
    tpage.click("#fullBtn"); settle(tpage)
    assert tpage.is_visible("#sideTab") and tpage.is_visible("#traceBar")
    tab, bar = tpage.locator("#sideTab").bounding_box(), tpage.locator("#traceBar").bounding_box()
    assert tab["x"] + tab["width"] <= bar["x"] or tab["y"] + tab["height"] <= bar["y"] or bar["y"] + bar["height"] <= tab["y"], "%s %s" % (tab, bar)


def test_the_details_tab_does_not_sit_on_a_zoom_button_in_the_normal_view_either(fpage):
    open_query(fpage, NORMAL["txid"]); settle(fpage)
    fpage.evaluate("() => window.__hopline.state.inspCollapsed || document.getElementById('inspCollapse').click()"); settle(fpage)
    fpage.wait_for_selector("#inspTab:not([hidden])", timeout=5000)
    tab = fpage.locator("#inspTab").bounding_box()
    for id_ in ("zoomIn", "zoomOut", "zoomFit", "fullBtn"):
        b = fpage.locator("#" + id_).bounding_box()
        assert b["y"] + b["height"] <= tab["y"] or tab["y"] + tab["height"] <= b["y"] or b["x"] + b["width"] <= tab["x"], "the tab is on the %s button: %s %s" % (id_, tab, b)
