"""The transaction inspector's "Funded by" and "Spent by": a row rings its transaction on the graph while the pointer is on it, a row is marked while its transaction is under the pointer on the graph,
and the heading's "Select all" selects them (the ones that are on screen) and rings them all while the pointer is on it. All of it only looks, until the button is pressed."""
import re

import pytest

from chains import IN, OUT, tid, tx
from conftest import NORMAL, SPENDERS
from helpers import idle, open_query, selected, settle, xy

HUB = "tx:" + tid(70)
FUNDERS = ["tx:" + tid(61), "tx:" + tid(62)]
SPENT = ["tx:" + tid(71), "tx:" + tid(72), "tx:" + tid(73)]


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def hub(mock):
    """A transaction funded by two others and spent by three."""
    tx(mock, 61, [IN(5, 0, "o1", 90000)], [OUT("m1", 80000)], spent={0: 70})
    tx(mock, 62, [IN(6, 0, "o2", 70000)], [OUT("m2", 60000)], spent={0: 70})
    tx(mock, 70, [IN(61, 0, "m1", 80000), IN(62, 0, "m2", 60000)], [OUT("p1", 50000), OUT("p2", 40000), OUT("p3", 49000)], spent={0: 71, 1: 72, 2: 73})
    for n, who, v in ((71, "p1", 50000), (72, "p2", 40000), (73, "p3", 49000)):
        tx(mock, n, [IN(70, n - 71, who, v)], [OUT("z%d" % n, v - 300)])


def preview(page):
    return page.evaluate("() => { const p = window.__hopline.renderer.preview; return p ? { ids: [...p.ids].sort(), rings: window.__hopline.renderer.previewDrawn } : null; }")


def wait_preview(page, on=True):
    page.wait_for_function("(on) => (window.__hopline.renderer.preview !== null) === on", arg=on, timeout=4000)
    page.wait_for_timeout(150)                                                           # a frame is drawn


def look(page):
    """What hovering must not change: the graph, the selection, the view and what was asked of the server."""
    return page.evaluate("() => { const h = window.__hopline, v = h.renderer.view; return [h.state.graph.nodes.size, h.state.graph.edges.size, [...h.state.selected].sort().join(), v.x, v.y, v.k]; }")


def section(page, title):
    return page.locator("#inspBody .insp-section").filter(has=page.locator(".lbl", has_text=re.compile(title, re.I)))


def opened(fpage, mock):
    hub(mock)
    open_query(fpage, tid(70))
    settle(fpage)
    assert {HUB, *FUNDERS, *SPENT} <= set(fpage.evaluate("() => [...window.__hopline.renderer.data.visible.nodes]")), "the hub and its neighbours are on the screen"
    body = fpage.inner_text("#inspBody").lower()
    assert "funded by (2)" in body and "spent by (3)" in body, body


# ---- a row ---------------------------------------------------------------------------------------------------------------------------------------------------

def test_pointing_at_a_row_rings_that_transaction_and_leaving_takes_it_away(fpage, mock):
    opened(fpage, mock)
    before, asked = look(fpage), len(mock.requests)
    fpage.hover("#inspBody .linkrow[title^='%s']" % SPENT[1])
    wait_preview(fpage)
    p = preview(fpage)
    assert p["ids"] == [SPENT[1]] and p["rings"] == 1, p
    assert look(fpage) == before and len(mock.requests) == asked, "it only looks: nothing selected, loaded or moved"
    fpage.mouse.move(5, 5)
    wait_preview(fpage, on=False)
    assert look(fpage) == before


def test_the_tooltip_of_a_row_keeps_what_it_said_and_adds_how_many_are_on_screen(fpage, mock):
    opened(fpage, mock)
    fpage.hover("#inspBody .linkrow[title^='%s']" % FUNDERS[0])
    wait_preview(fpage)
    title = fpage.get_attribute("#inspBody .linkrow[title*='%s']" % FUNDERS[0], "title")
    assert title.startswith(FUNDERS[0]) and "(1 of 1 on screen)" in title, title


def test_a_row_is_marked_while_its_transaction_is_under_the_pointer_on_the_graph(fpage, mock):
    opened(fpage, mock)
    p = xy(fpage, SPENT[2])
    fpage.mouse.move(p["x"], p["y"])
    fpage.wait_for_function("() => document.querySelectorAll('#inspBody .linkrow.hl').length === 1", timeout=4000)
    assert fpage.locator("#inspBody .linkrow.hl").get_attribute("title").startswith(SPENT[2])
    fpage.mouse.move(5, 5)
    fpage.wait_for_function("() => document.querySelectorAll('#inspBody .linkrow.hl').length === 0", timeout=4000)


def test_switching_the_hover_preview_off_stops_the_ring(fpage, mock):
    opened(fpage, mock)
    fpage.evaluate("() => { const c = document.getElementById('hoverPreview'); c.checked = false; c.dispatchEvent(new Event('change')); }")
    fpage.hover("#inspBody .linkrow[title^='%s']" % SPENT[0])
    fpage.wait_for_timeout(400)
    assert preview(fpage) is None


# ---- Select all ----------------------------------------------------------------------------------------------------------------------------------------------

def test_each_heading_with_two_or_more_has_select_all_with_the_count(fpage, mock):
    opened(fpage, mock)
    assert section(fpage, "Funded by").locator(".selall").inner_text() == "Select all 2"
    assert section(fpage, "Spent by").locator(".selall").inner_text() == "Select all 3"
    assert "(2)" in section(fpage, "Funded by").locator(".lbl").inner_text() and "(3)" in section(fpage, "Spent by").locator(".lbl").inner_text()


def test_pointing_at_select_all_rings_every_one_of_them(fpage, mock):
    opened(fpage, mock)
    before = look(fpage)
    section(fpage, "Spent by").locator(".selall").hover()
    wait_preview(fpage)
    p = preview(fpage)
    assert p["ids"] == sorted(SPENT) and p["rings"] == 3, p
    assert "(3 of 3 on screen)" in section(fpage, "Spent by").locator(".selall").get_attribute("title")
    assert look(fpage) == before
    fpage.mouse.move(5, 5); wait_preview(fpage, on=False)


def test_select_all_selects_the_funders_or_the_spenders(fpage, mock):
    opened(fpage, mock)
    section(fpage, "Funded by").locator(".selall").click()
    fpage.wait_for_function("() => window.__hopline.state.selected.size === 2", timeout=4000)
    assert sorted(selected(fpage)) == sorted(FUNDERS)
    assert "2 selected" in fpage.inner_text("#inspBody") or "Tag all 2" in fpage.inner_text("#inspBody"), "the details show a selection of two"
    open_query(fpage, tid(70))                                                           # back to the hub
    fpage.evaluate("(id) => window.__hopline.setSel([id])", HUB); settle(fpage)
    section(fpage, "Spent by").locator(".selall").click()
    fpage.wait_for_function("() => window.__hopline.state.selected.size === 3", timeout=4000)
    assert sorted(selected(fpage)) == sorted(SPENT)


def test_a_single_neighbour_has_no_select_all(fpage):
    open_query(fpage, NORMAL["txid"])
    body = fpage.inner_text("#inspBody").lower()
    assert "funded by (1)" in body and "spent by (2)" in body
    assert fpage.locator("#inspBody .selall").count() == 1, "only the two spenders have it: one transaction needs no 'all'"
    assert fpage.locator("#inspBody .selall").inner_text() == "Select all %d" % len(SPENDERS)


def test_neighbours_that_are_not_on_screen_are_said_so_and_only_the_others_are_selected(fpage, mock):
    opened(fpage, mock)
    open_query(fpage, NORMAL["txid"]); settle(fpage)                                     # the Focus view moves away: the hub is loaded, not on screen
    assert HUB not in set(fpage.evaluate("() => [...window.__hopline.renderer.data.visible.nodes]"))
    fpage.evaluate("(id) => window.__hopline.setSel([id])", HUB); settle(fpage)
    btn = section(fpage, "Spent by").locator(".selall")
    btn.hover(); fpage.wait_for_timeout(400)
    assert "(0 of 3 on screen)" in btn.get_attribute("title") and preview(fpage) is None, "nothing to ring, so nothing fades"
    btn.click()
    fpage.wait_for_function("() => !document.getElementById('toast').hidden", timeout=4000)
    assert "None of the spending transactions is on screen" in fpage.inner_text("#toast")


# ---- what was reported: after Select all the ring stayed and Esc or an empty click seemed to do nothing -------------------------------------------------------------

def empty_spot(page):
    box = page.locator("#cv").bounding_box()
    return box["x"] + 40, box["y"] + box["height"] * 0.3


def test_after_select_all_the_ring_goes_at_once_and_it_is_the_selection_that_shows(fpage, mock):
    opened(fpage, mock)
    section(fpage, "Spent by").locator(".selall").click()
    fpage.wait_for_function("() => window.__hopline.state.selected.size === 3", timeout=4000)
    fpage.wait_for_timeout(400)                                                          # a preview is drawn 90 ms after the pointer arrives: the button that asked for it is long gone
    assert preview(fpage) is None, "its mouseleave never comes, so without a guard the ring is drawn after the click and stays"
    assert sorted(selected(fpage)) == sorted(SPENT)


def test_after_select_all_escape_clears_the_selection_and_leaves_nothing_ringed(fpage, mock):
    opened(fpage, mock)
    section(fpage, "Spent by").locator(".selall").click()
    fpage.wait_for_function("() => window.__hopline.state.selected.size === 3", timeout=4000)
    fpage.wait_for_timeout(400)
    fpage.keyboard.press("Escape")
    fpage.wait_for_function("() => window.__hopline.state.selected.size === 0", timeout=4000)
    fpage.wait_for_timeout(300)
    assert preview(fpage) is None, "no ring is left on the vertices that were selected"


def test_after_select_all_a_click_on_empty_space_clears_the_selection_and_leaves_nothing_ringed(fpage, mock):
    opened(fpage, mock)
    section(fpage, "Funded by").locator(".selall").click()
    fpage.wait_for_function("() => window.__hopline.state.selected.size === 2", timeout=4000)
    fpage.wait_for_timeout(400)
    x, y = empty_spot(fpage)
    fpage.mouse.click(x, y)
    fpage.wait_for_function("() => window.__hopline.state.selected.size === 0", timeout=4000)
    fpage.wait_for_timeout(300)
    assert preview(fpage) is None


def test_a_row_that_moves_the_focus_does_not_leave_its_ring_behind(fpage, mock):
    opened(fpage, mock)
    fpage.hover("#inspBody .linkrow[title^='%s']" % SPENT[0])
    wait_preview(fpage)
    assert preview(fpage)["ids"] == [SPENT[0]]
    fpage.click("#inspBody .linkrow[title*='%s']" % SPENT[0])
    fpage.wait_for_function("(id) => window.__hopline.state.focus === id", arg=SPENT[0], timeout=4000); idle(fpage)
    fpage.wait_for_timeout(300)
    p = preview(fpage)
    assert p is None or p["ids"] != [SPENT[0]], "the row that was clicked is gone from the list: its ring must not stay (a row now under the pointer may ring its own transaction)"


def test_a_preview_whose_element_was_taken_out_of_the_page_is_taken_off_at_the_next_key(fpage, mock):
    opened(fpage, mock)
    fpage.hover("#inspBody .linkrow[title^='%s']" % SPENT[1])
    wait_preview(fpage)
    assert fpage.evaluate("() => { const b = document.querySelector('#inspBody .linkrow:hover'); if (!b) return false; b.closest('.insp-section').remove(); return true; }"), "the row under the pointer"   # as a list drawn again does; nothing that rings is left under the pointer
    fpage.wait_for_timeout(300)
    assert preview(fpage) is not None, "its mouseleave never comes: the ring stays until something looks"
    fpage.keyboard.press("Shift")                                                        # a key is nothing else's business: only the guard takes the stale ring off
    wait_preview(fpage, on=False)
