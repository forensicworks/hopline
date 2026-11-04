"""Pointing at a finding shows where it is (a ring in its colour, the rest faded) and pointing at a vertex shows its findings. It only looks: nothing is selected, loaded or moved."""
import json
import re

import pytest

from chains import consolidation, peel_chain, tid
from conftest import NORMAL
from helpers import idle, open_query, settle, xy
from test_more_routes import show_first_route, start as start_routes

CONSOL = "tx:" + tid(30)
NORMAL_ID = "tx:" + NORMAL["txid"]


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def preview(page):
    return page.evaluate("() => { const p = window.__hopline.renderer.preview; return p ? { ids: [...p.ids].sort(), color: p.color, rings: window.__hopline.renderer.previewDrawn } : null; }")


def wait_preview(page, on=True):
    page.wait_for_function("(on) => (window.__hopline.renderer.preview !== null) === on", arg=on, timeout=4000)
    page.wait_for_timeout(150)                                                           # a frame is drawn


def look(page):
    """What hovering must not change: the graph, the selection, the view and what was asked of the server."""
    return page.evaluate("() => { const h = window.__hopline, v = h.renderer.view; return [h.state.graph.nodes.size, h.state.graph.edges.size, [...h.state.selected].sort().join(), v.x, v.y, v.k]; }")


def pixel(page, id_):
    return page.evaluate("""(id) => { const r = window.__hopline.renderer, p = r.positionOf(id), v = r.view, c = r.canvas, k = c.width / c.clientWidth;
        const d = c.getContext('2d').getImageData(Math.round((p.x * v.k + v.x) * k), Math.round((p.y * v.k + v.y) * k), 1, 1).data; return d[0] + d[1] + d[2]; }""", id_)


def test_pointing_at_a_chip_rings_what_it_counts_and_leaving_takes_it_away_and_nothing_else_changes(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30))
    before, asked = look(fpage), len(mock.requests)
    fpage.hover("#findStrip [data-key=consolidation]")
    wait_preview(fpage)
    p = preview(fpage)
    assert p["ids"] == [CONSOL] and p["rings"] == 1 and p["color"], p
    assert look(fpage) == before and len(mock.requests) == asked, "it only looks: nothing selected, loaded or moved"
    fpage.mouse.move(5, 5)
    wait_preview(fpage, on=False)
    assert preview(fpage) is None and look(fpage) == before


def test_what_is_not_near_the_finding_fades_and_the_finding_does_not(page, mock):
    consolidation(mock)
    open_query(page, tid(30)); open_query(page, NORMAL["txid"])
    page.evaluate("() => window.__hopline.setSel([])"); settle(page)
    far, mine = pixel(page, NORMAL_ID), pixel(page, CONSOL)
    page.hover("#findStrip [data-key=consolidation]")
    wait_preview(page)
    far2, mine2 = pixel(page, NORMAL_ID), pixel(page, CONSOL)
    assert far2 < far - 60, "an unrelated transaction fades (%s -> %s)" % (far, far2)
    assert abs(mine2 - mine) < 12, "the finding itself stays as it is (%s -> %s)" % (mine, mine2)
    page.mouse.move(5, 5); wait_preview(page, on=False)
    assert abs(pixel(page, NORMAL_ID) - far) < 12, "and it comes back"


def test_the_tooltip_says_how_many_of_them_are_on_screen_and_only_those_are_ringed(fpage, mock):
    peel_chain(mock, 8)
    open_query(fpage, tid(10))
    fpage.evaluate("(id) => window.__hopline.autoExpand(id, { dir: 'next', hops: 7, follow: 'largest' })", "tx:" + tid(10)); idle(fpage); settle(fpage)
    fpage.check("#focusOn"); fpage.select_option("#depth", "1"); settle(fpage)             # the Focus view keeps most of the chain off the screen
    fpage.hover("#findStrip [data-key=peel]")
    wait_preview(fpage)
    title = fpage.get_attribute("#findStrip [data-key=peel]", "title")
    m = re.search(r"\((\d+) of (\d+) on screen\)", title)
    assert m and int(m.group(2)) == 8 and 1 <= int(m.group(1)) < 8, title
    assert preview(fpage)["rings"] == int(m.group(1)), "a ring for each one that is on screen, none for the others"


def test_when_none_of_them_is_on_screen_the_tooltip_says_so_and_nothing_fades(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30)); open_query(fpage, NORMAL["txid"]); settle(fpage)          # the Focus view is on the second one: the consolidation is loaded, not on screen
    assert CONSOL not in set(fpage.evaluate("() => [...window.__hopline.renderer.data.visible.nodes]"))
    fpage.hover("#findStrip [data-key=consolidation]")
    fpage.wait_for_timeout(400)
    assert "0 of 1 on screen" in fpage.get_attribute("#findStrip [data-key=consolidation]", "title")
    assert preview(fpage) is None, "nothing to ring, so nothing fades"


def test_keyboard_focus_does_the_same_as_the_pointer(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30))
    fpage.focus("#findStrip [data-key=consolidation]")
    wait_preview(fpage)
    assert preview(fpage)["ids"] == [CONSOL]
    fpage.evaluate("() => document.activeElement.blur()")
    wait_preview(fpage, on=False)


def test_a_row_in_the_findings_and_a_detection_ring_their_vertices(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30))
    fpage.evaluate("() => window.__hopline.openFindings()"); settle(fpage)
    before = look(fpage)
    fpage.hover("#anFindings [data-group=consolidation]")
    wait_preview(fpage)
    assert preview(fpage)["ids"] == [CONSOL]
    fpage.mouse.move(5, 5); wait_preview(fpage, on=False)
    fpage.hover("#detList .detrow")
    wait_preview(fpage)
    assert preview(fpage)["ids"] == [CONSOL]
    assert look(fpage) == before


def test_pointing_at_a_vertex_marks_the_chips_and_rows_that_count_it(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30))
    fpage.evaluate("() => window.__hopline.openFindings()"); settle(fpage)
    fpage.evaluate("() => window.__hopline.renderer.fit()"); settle(fpage)
    p = xy(fpage, CONSOL)
    fpage.mouse.move(p["x"] - 30, p["y"] - 30); fpage.mouse.move(p["x"], p["y"], steps=4)
    fpage.wait_for_selector("#findStrip [data-key=consolidation].hl", timeout=4000)
    assert fpage.locator("#detList .detrow.hl").count() == 1 and fpage.locator("#anFindings [data-group=consolidation].hl").count() == 1
    assert fpage.locator("#findStrip [data-key=clusters].hl").count() == 0, "the clusters count addresses, not this transaction"
    fpage.mouse.move(5, 5)
    fpage.wait_for_function("() => document.querySelectorAll('.hl').length === 0", timeout=4000)


def test_the_routes_in_the_list_ring_their_route(tpage, mock):
    start_routes(tpage, mock)
    show_first_route(tpage)
    tpage.click("#anFindings [data-more-routes=find]"); idle(tpage); settle(tpage)
    tpage.hover("#anFindings [data-route='2']")
    wait_preview(tpage)
    ids = set(preview(tpage)["ids"])
    assert {"tx:" + tid(n) for n in (1, 4, 5, 6)} <= ids and not ({"tx:" + tid(n) for n in (2, 3)} & ids), ids


def test_it_can_be_switched_off_and_nothing_is_ringed_marked_or_counted_in_the_tooltip(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30))
    fpage.evaluate("() => window.__hopline.openFindings()"); settle(fpage)
    fpage.uncheck("#hoverPreview")
    assert fpage.evaluate("() => window.__hopline.state.hoverPreview") is False
    before = look(fpage)
    fpage.hover("#findStrip [data-key=consolidation]")
    fpage.wait_for_timeout(400)
    assert preview(fpage) is None, "no ring and nothing fades"
    assert "on screen" not in (fpage.get_attribute("#findStrip [data-key=consolidation]", "title") or "")
    fpage.mouse.move(5, 5)
    fpage.hover("#detList .detrow")
    fpage.wait_for_timeout(400)
    assert preview(fpage) is None
    fpage.evaluate("() => window.__hopline.renderer.fit()"); settle(fpage)
    p = xy(fpage, CONSOL)
    fpage.mouse.move(p["x"] - 30, p["y"] - 30); fpage.mouse.move(p["x"], p["y"], steps=4)
    fpage.wait_for_timeout(400)
    assert fpage.locator(".hl").count() == 0, "pointing at a vertex marks nothing"
    assert look(fpage)[:3] == before[:3]


def test_switching_it_off_takes_away_what_is_showing_and_on_again_brings_it_back(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30))
    fpage.hover("#findStrip [data-key=consolidation]")
    wait_preview(fpage)
    fpage.uncheck("#hoverPreview")
    wait_preview(fpage, on=False)
    fpage.check("#hoverPreview")
    fpage.mouse.move(5, 5)
    fpage.hover("#findStrip [data-key=consolidation]")
    wait_preview(fpage)
    assert preview(fpage)["ids"] == [CONSOL]


def test_the_choice_is_remembered_and_it_is_on_for_a_new_visitor(fpage, mock):
    assert fpage.is_checked("#hoverPreview") and fpage.evaluate("() => window.__hopline.state.hoverPreview") is True
    fpage.uncheck("#hoverPreview")
    assert json.loads(fpage.evaluate("() => localStorage.getItem('hopline.prefs.v1')"))["hoverPreview"] is False
    fpage.reload(); fpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert fpage.evaluate("() => window.__hopline.state.hoverPreview") is False and not fpage.is_checked("#hoverPreview")


def handle_brightness(page, id_, dir_):
    """The brightness (R+G+B) of a handle pill at its left end, where there is no text; None when the vertex has no such handle."""
    return page.evaluate("""([id, dir]) => { const r = window.__hopline.renderer, h = r.handleRects.find((q) => q.id === id && q.dir === dir); if (!h) return null;
        const c = r.canvas, k = c.width / c.clientWidth, d = c.getContext('2d').getImageData(Math.round((h.x + 5) * k), Math.round((h.y + h.h / 2) * k), 1, 1).data; return d[0] + d[1] + d[2]; }""", [id_, dir_])


def test_the_handles_of_what_fades_fade_with_it_and_those_of_the_finding_do_not(tpage, mock):
    consolidation(mock)
    open_query(tpage, tid(30)); open_query(tpage, NORMAL["txid"]); settle(tpage)
    far0, mine0 = handle_brightness(tpage, NORMAL_ID, "left"), handle_brightness(tpage, CONSOL, "left")
    assert far0 and mine0 and far0 > 300 and mine0 > 300, "both transactions have a light handle on the left: %s %s" % (far0, mine0)
    tpage.hover("#findStrip [data-key=consolidation]")
    wait_preview(tpage)
    far, mine = handle_brightness(tpage, NORMAL_ID, "left"), handle_brightness(tpage, CONSOL, "left")
    assert far < far0 * 0.6, "the handle of a vertex that fades fades with it (%s -> %s)" % (far0, far)
    assert abs(mine - mine0) < 15, "the handle of the finding's own vertex stays as it is (%s -> %s)" % (mine0, mine)
    tpage.mouse.move(5, 5); wait_preview(tpage, on=False)
    assert abs(handle_brightness(tpage, NORMAL_ID, "left") - far0) < 15, "and it comes back"
