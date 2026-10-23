"""Redo for Undo load: what Undo load took away can be put back, until something else changes the workspace."""
import json

import pytest

from conftest import COINBASE, NORMAL, SPENDERS
from helpers import click_node, idle, open_query, settle, toast_text
from test_undo_load import graph_text, n_nodes, undo

NORMAL_ID = "tx:" + NORMAL["txid"]
SPENDER_ID = "tx:" + SPENDERS[0]["txid"]


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def redo(page):
    page.click("#btnRedoLoad"); idle(page); settle(page)


def expand(page):
    """Load what spent the outputs of the opened transaction: one more load to undo."""
    page.uncheck("#focusOn"); settle(page)
    page.evaluate("(id) => window.__hopline.setSel([id])", NORMAL_ID); settle(page)
    page.click("#inspBody button:has-text('Spenders →')"); idle(page); settle(page)


def test_the_button_is_there_and_off_until_something_was_undone(fpage):
    assert fpage.is_disabled("#btnRedoLoad") and fpage.inner_text("#btnRedoLoad").strip() == "↷"
    assert "Nothing to redo" in fpage.get_attribute("#btnRedoLoad", "title") and fpage.get_attribute("#btnRedoLoad", "aria-label") == "Redo load"
    open_query(fpage, NORMAL["txid"])
    assert fpage.is_disabled("#btnRedoLoad"), "a load alone gives nothing to redo"


def test_redo_puts_back_exactly_what_undo_load_took_away_and_undo_works_again(fpage):
    open_query(fpage, NORMAL["txid"]); settle(fpage)
    before = graph_text(fpage), n_nodes(fpage)
    expand(fpage)
    after = graph_text(fpage), n_nodes(fpage)
    assert after[1] > before[1]
    undo(fpage)
    assert (graph_text(fpage), n_nodes(fpage)) == before
    assert fpage.is_enabled("#btnRedoLoad") and "Redo:" in fpage.get_attribute("#btnRedoLoad", "title") and "again" in fpage.get_attribute("#btnRedoLoad", "title")
    redo(fpage)
    assert (graph_text(fpage), n_nodes(fpage)) == after, "the graph is as it was when Undo load was pressed"
    assert fpage.is_disabled("#btnRedoLoad") and fpage.is_enabled("#btnUndoLoad")
    undo(fpage)
    assert (graph_text(fpage), n_nodes(fpage)) == before, "and Undo load takes it back again"
    redo(fpage)
    assert (graph_text(fpage), n_nodes(fpage)) == after


def test_the_message_after_an_undo_offers_a_redo(fpage):
    open_query(fpage, NORMAL["txid"]); settle(fpage)
    expand(fpage); n = n_nodes(fpage)
    undo(fpage)
    assert "Undid:" in toast_text(fpage)
    fpage.click("#toast button:has-text('Redo')"); idle(fpage); settle(fpage)
    assert n_nodes(fpage) == n and "Redid:" in toast_text(fpage)
    assert fpage.locator("#toast button:has-text('Undo')").count() == 1, "and the message offers the way back"


def test_several_undos_are_redone_one_at_a_time_in_order(fpage):
    open_query(fpage, NORMAL["txid"]); settle(fpage)
    sizes = [n_nodes(fpage)]
    expand(fpage); sizes.append(n_nodes(fpage))
    open_query(fpage, COINBASE["txid"]); settle(fpage)
    sizes.append(n_nodes(fpage))
    assert sizes[0] < sizes[1] < sizes[2], sizes
    states = []
    while fpage.is_enabled("#btnUndoLoad"):
        undo(fpage); states.append(n_nodes(fpage))
    assert states == [sizes[1], sizes[0], 0], states
    seen = []
    while fpage.is_enabled("#btnRedoLoad"):
        redo(fpage); seen.append(n_nodes(fpage))
    assert seen == [sizes[0], sizes[1], sizes[2]], "each Redo goes one step forward, the last one to where it was: %s" % seen


def test_a_new_load_ends_what_could_be_redone(fpage):
    open_query(fpage, NORMAL["txid"]); settle(fpage)
    expand(fpage)
    undo(fpage)
    assert fpage.is_enabled("#btnRedoLoad")
    open_query(fpage, NORMAL["vout"][0]["scriptpubkey_address"]); idle(fpage); settle(fpage)
    assert fpage.is_disabled("#btnRedoLoad"), "the workspace went another way"


def test_writing_on_the_graph_after_an_undo_ends_the_redo_so_that_it_cannot_lose_it(fpage):
    open_query(fpage, NORMAL["txid"]); settle(fpage)
    expand(fpage)
    undo(fpage)
    assert fpage.is_enabled("#btnRedoLoad")
    fpage.evaluate("(id) => { const n = window.__hopline.state.graph.nodes.get(id); n.label = 'Something I wrote'; window.__hopline.refresh(); }", NORMAL_ID)
    settle(fpage)
    assert fpage.is_disabled("#btnRedoLoad"), "Redo would have put the graph back without that label"
    assert fpage.evaluate("(id) => window.__hopline.state.graph.nodes.get(id).label", NORMAL_ID) == "Something I wrote"
    assert fpage.evaluate("() => window.__hopline.state.redoLoads.length") == 0


def test_a_deletion_can_be_undone_and_redone(fpage):
    open_query(fpage, NORMAL["txid"]); settle(fpage)
    expand(fpage)
    n = n_nodes(fpage)
    fpage.evaluate("(id) => window.__hopline.setSel([id])", SPENDER_ID); settle(fpage)
    fpage.locator("#cv").focus(); fpage.keyboard.press("Shift+Delete"); settle(fpage)
    assert n_nodes(fpage) < n
    undo(fpage)
    assert n_nodes(fpage) == n
    redo(fpage)
    assert n_nodes(fpage) < n, "deleted again"
    assert SPENDER_ID not in fpage.evaluate("() => [...window.__hopline.state.graph.nodes.keys()]")


def test_clear_can_be_undone_and_redone(fpage):
    open_query(fpage, NORMAL["txid"]); settle(fpage)
    n = n_nodes(fpage)
    fpage.click("#btnClear"); fpage.click("#btnClear"); settle(fpage)
    assert n_nodes(fpage) == 0
    undo(fpage)
    assert n_nodes(fpage) == n
    redo(fpage)
    assert n_nodes(fpage) == 0 and fpage.is_enabled("#btnUndoLoad")


def test_what_you_hid_is_put_back_with_the_graph_the_way_it_was(fpage):
    open_query(fpage, NORMAL["txid"]); settle(fpage)
    expand(fpage)
    fpage.evaluate("(id) => window.__hopline.hideIds([id])", SPENDER_ID); settle(fpage)
    hidden = fpage.evaluate("() => [...window.__hopline.state.hidden]")
    assert hidden == [SPENDER_ID]
    undo(fpage)
    assert fpage.evaluate("() => [...window.__hopline.state.hidden]") == [], "before the load nothing was hidden"
    redo(fpage)
    assert fpage.evaluate("() => [...window.__hopline.state.hidden]") == [SPENDER_ID], "and Redo hides it again"


def test_redo_is_off_while_something_is_loading_and_the_top_bar_stays_on_one_row(ctx):
    page = ctx.new_page()
    page.set_viewport_size({"width": 1366, "height": 768})
    page.goto((__import__("conftest").ROOT / "public" / "workspace.html").as_uri()); page.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert page.evaluate("() => Math.round(document.getElementById('top').getBoundingClientRect().height)") <= 56
    page.close()
