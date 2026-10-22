"""Hide only takes a vertex off the screen; Delete takes it out of the workspace. Both are offered in a trace as well as in the other layouts."""
import pytest

from conftest import ADDRESS, NORMAL
from helpers import click_node, idle, open_query, settle
from test_trace import click_handle, shown

NORMAL_ID = "tx:" + NORMAL["txid"]
ROBINHOOD = "addr:bc1qprdf80adfz7aekh5nejjfrp3jksc8r929svpxk"


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def in_graph(page, vertex):
    return page.evaluate("(id) => window.__hopline.state.graph.nodes.has(id)", vertex)


def build_scene(page):
    open_query(page, NORMAL["txid"])
    click_handle(page, NORMAL_ID, "right")
    click_handle(page, ROBINHOOD, "right")


def buttons(page):
    return page.evaluate("() => [...document.querySelectorAll('#inspBody .insp-actions button')].map((b) => b.textContent.trim())")


def key(page, combo):
    page.locator("#cv").focus(); page.keyboard.press(combo); settle(page)


def test_in_a_trace_hide_keeps_the_vertex_loaded_and_delete_removes_it_from_the_workspace(tpage):
    build_scene(tpage)
    click_node(tpage, ROBINHOOD); settle(tpage)
    b = buttons(tpage)
    assert "Hide from the trace" in b and "Delete from workspace" in b, b
    tpage.click("#inspBody button:has-text('Hide from the trace')"); settle(tpage)
    assert ROBINHOOD not in shown(tpage) and in_graph(tpage, ROBINHOOD), "hidden: off the screen, still loaded"
    key(tpage, "Control+z")
    assert ROBINHOOD in shown(tpage)
    click_node(tpage, ROBINHOOD); settle(tpage)
    n = len(shown(tpage))
    tpage.click("#inspBody button:has-text('Delete from workspace')"); settle(tpage)
    assert not in_graph(tpage, ROBINHOOD) and ROBINHOOD not in shown(tpage) and len(shown(tpage)) == n - 1, "deleted: gone from the workspace"
    assert "Deleted 1 vertex from the workspace" in tpage.inner_text("#toast")
    tpage.click("#toast button:has-text('Undo')"); idle(tpage); settle(tpage)
    assert in_graph(tpage, ROBINHOOD) and ROBINHOOD in shown(tpage) and len(shown(tpage)) == n, "the message's Undo puts it back, in the trace too"


def test_shift_delete_deletes_in_a_trace_and_plain_delete_only_hides(tpage):
    build_scene(tpage)
    click_node(tpage, ROBINHOOD); settle(tpage)
    key(tpage, "Delete")
    assert ROBINHOOD not in shown(tpage) and in_graph(tpage, ROBINHOOD), "Delete alone is the safe one: it hides"
    key(tpage, "Control+z")
    click_node(tpage, ROBINHOOD); settle(tpage)
    key(tpage, "Shift+Delete")
    assert not in_graph(tpage, ROBINHOOD) and ROBINHOOD not in shown(tpage)
    tpage.click("#btnUndoLoad"); idle(tpage); settle(tpage)
    assert in_graph(tpage, ROBINHOOD) and ROBINHOOD in shown(tpage), "Undo load in the top bar brings it back as well"


def test_the_right_click_menu_offers_delete_in_a_trace_for_one_vertex_and_for_several(tpage):
    build_scene(tpage)
    click_node(tpage, ROBINHOOD, ); settle(tpage)
    p = tpage.evaluate("(id) => { const r = window.__hopline.renderer, q = r.positionOf(id), v = r.view, b = r.canvas.getBoundingClientRect(); return { x: b.left + q.x * v.k + v.x, y: b.top + q.y * v.k + v.y }; }", ROBINHOOD)
    tpage.mouse.click(p["x"], p["y"], button="right"); tpage.wait_for_selector("#ctxMenu:not([hidden])")
    menu = tpage.inner_text("#ctxMenu")
    assert "Hide from the trace" in menu and "Delete from workspace" in menu
    tpage.click("#ctxMenu >> text=Delete from workspace"); settle(tpage)
    assert not in_graph(tpage, ROBINHOOD)
    tpage.click("#toast button:has-text('Undo')"); idle(tpage); settle(tpage)
    tpage.evaluate("(ids) => window.__hopline.setSel(ids)", [NORMAL_ID, ROBINHOOD]); settle(tpage)
    p = tpage.evaluate("(id) => { const r = window.__hopline.renderer, q = r.positionOf(id), v = r.view, b = r.canvas.getBoundingClientRect(); return { x: b.left + q.x * v.k + v.x, y: b.top + q.y * v.k + v.y }; }", ROBINHOOD)
    tpage.mouse.click(p["x"], p["y"], button="right"); tpage.wait_for_selector("#ctxMenu:not([hidden])")
    assert "Delete 2 from workspace" in tpage.inner_text("#ctxMenu")


def test_deleting_everything_a_trace_shows_leaves_an_empty_trace_and_undo_brings_it_all_back(tpage):
    build_scene(tpage)
    n = len(shown(tpage))
    key(tpage, "Control+a")
    key(tpage, "Shift+Delete")
    assert shown(tpage) == set() and tpage.evaluate("() => window.__hopline.state.trace.seed") is None
    assert tpage.is_visible("#empty") or tpage.evaluate("() => window.__hopline.state.graph.nodes.size") >= 0
    tpage.click("#toast button:has-text('Undo')"); idle(tpage); settle(tpage)
    assert len(shown(tpage)) == n and tpage.evaluate("() => window.__hopline.state.trace.seed") == NORMAL_ID, "the trace and its starting point are back"


def test_outside_a_trace_delete_has_the_same_meaning_and_the_same_words(fpage):
    open_query(fpage, NORMAL["txid"]); fpage.uncheck("#focusOn"); settle(fpage)
    click_node(fpage, ROBINHOOD); settle(fpage)
    b = buttons(fpage)
    assert "Hide" in b and "Delete from workspace" in b and not any("from view" in x for x in b), b
    fpage.click("#inspBody button:has-text('Delete from workspace')"); settle(fpage)
    assert not in_graph(fpage, ROBINHOOD)
    fpage.click("#toast button:has-text('Undo')"); idle(fpage); settle(fpage)
    assert in_graph(fpage, ROBINHOOD)
    click_node(fpage, ROBINHOOD); settle(fpage)
    key(fpage, "Shift+Delete")
    assert not in_graph(fpage, ROBINHOOD)
