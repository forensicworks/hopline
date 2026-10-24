"""Undo and Redo (also for Re-layout), and adding more wallets to what is already in the workspace."""
import pytest

from chains import real_addr
from conftest import ADDRESS, COINBASE, NORMAL
from helpers import click_node, idle, open_query, settle, xy
from test_trace import click_handle, shown

NORMAL_ID = "tx:" + NORMAL["txid"]
ROBINHOOD = "addr:bc1qprdf80adfz7aekh5nejjfrp3jksc8r929svpxk"          # on the built-in list; an output of the first fixture transaction


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def counts_of(page):
    return page.evaluate("() => { const T = window.__hopline.state.trace; return { shown: T.shown.size, seeds: T.seeds.length, undo: T.undo.length, redo: T.redo.length }; }")


def buttons(page):
    return page.evaluate("() => ({ undo: !document.getElementById('traceUndo').disabled, redo: !document.getElementById('traceRedo').disabled })")


def trace_pos(page):
    return page.evaluate("""() => Object.fromEntries([...window.__hopline.state.trace.shown].map((id) => { const q = window.__hopline.state.trace.pos.get(id); return [id, [Math.round(q.x * 10) / 10, Math.round(q.y * 10) / 10]]; }))""")


def screen_pos(page):
    return page.evaluate("""() => Object.fromEntries([...window.__hopline.renderer.data.visible.nodes].map((id) => { const q = window.__hopline.renderer.positionOf(id); return [id, [Math.round(q.x), Math.round(q.y)]]; }))""")


def key(page, combo):
    page.locator("#cv").focus(); page.keyboard.press(combo); settle(page)


def drag(page, node_id, dx, dy):
    p = xy(page, node_id)
    page.mouse.move(p["x"], p["y"]); page.mouse.down()
    page.mouse.move(p["x"] + dx / 2, p["y"] + dy / 2, steps=4); page.mouse.move(p["x"] + dx, p["y"] + dy, steps=4)
    page.mouse.up(); settle(page)


def build_scene(page):
    open_query(page, NORMAL["txid"])
    page.select_option("#traceArrange", "columns"); settle(page)                       # these tests were written around Columns
    click_handle(page, NORMAL_ID, "right")
    click_handle(page, ROBINHOOD, "right")


# ---- Re-layout can be taken back (and put back) -------------------------------------------------------------------------------

def test_a_relayout_in_a_trace_is_one_undo_step_that_puts_every_vertex_back(tpage):
    build_scene(tpage)
    before, n = trace_pos(tpage), counts_of(tpage)
    tpage.click("#btnRelayout"); settle(tpage)
    after = trace_pos(tpage)
    assert after != before, "Re-layout placed the vertices again"
    assert counts_of(tpage)["undo"] == n["undo"] + 1 and "Undo (Ctrl+Z) puts every vertex back" in tpage.inner_text("#toast")
    key(tpage, "Control+z")
    assert trace_pos(tpage) == before, "every vertex is back where it was"
    assert counts_of(tpage)["shown"] == n["shown"] and counts_of(tpage)["undo"] == n["undo"], "and the step before it was NOT undone"
    key(tpage, "Control+Shift+z")
    assert trace_pos(tpage) == after, "Redo re-arranges again"


def test_a_relayout_that_changes_nothing_leaves_no_step(tpage):
    build_scene(tpage)
    tpage.click("#btnRelayout"); settle(tpage)
    n = counts_of(tpage)["undo"]
    tpage.click("#btnRelayout"); settle(tpage)
    assert counts_of(tpage)["undo"] == n, "the vertices were already tidy: nothing to take back"


def test_a_relayout_in_another_arrangement_gives_the_dragged_vertex_back_on_undo(tpage):
    build_scene(tpage)
    tpage.select_option("#traceArrange", "flow"); settle(tpage)
    drag(tpage, ROBINHOOD, 140, 90)
    dragged = screen_pos(tpage)
    tpage.click("#btnRelayout"); settle(tpage)
    tidy = screen_pos(tpage)
    assert tidy[ROBINHOOD] != dragged[ROBINHOOD], "Re-layout released the dragged vertex"
    key(tpage, "Control+z")
    assert screen_pos(tpage)[ROBINHOOD] == dragged[ROBINHOOD], "Undo put it where you had dragged it"
    key(tpage, "Control+Shift+z")
    assert screen_pos(tpage)[ROBINHOOD] == tidy[ROBINHOOD]


def test_a_relayout_in_the_flow_layout_can_be_taken_back_too(fpage):
    open_query(fpage, NORMAL["txid"]); fpage.uncheck("#focusOn"); settle(fpage)
    drag(fpage, NORMAL_ID, 160, 120)
    dragged = screen_pos(fpage)
    fpage.click("#btnRelayout"); settle(fpage)
    assert screen_pos(fpage)[NORMAL_ID] != dragged[NORMAL_ID]
    assert buttons(fpage)["undo"]
    key(fpage, "Control+z")
    assert screen_pos(fpage)[NORMAL_ID] == dragged[NORMAL_ID], "the vertex you dragged is back"
    assert buttons(fpage)["redo"]
    key(fpage, "Control+y")
    assert screen_pos(fpage)[NORMAL_ID] != dragged[NORMAL_ID]


# ---- Redo -----------------------------------------------------------------------------------------------------------------------

def test_redo_puts_back_a_revealed_branch_with_the_places_it_had(tpage):
    open_query(tpage, NORMAL["txid"])
    assert not buttons(tpage)["redo"], "nothing has been undone yet"
    click_handle(tpage, NORMAL_ID, "right")
    full, places = shown(tpage), trace_pos(tpage)
    key(tpage, "Control+z")
    assert shown(tpage) == {NORMAL_ID} and buttons(tpage)["redo"]
    tpage.click("#traceRedo"); settle(tpage)
    assert shown(tpage) == full and trace_pos(tpage) == places, "the same vertices in the same places"
    assert not buttons(tpage)["redo"], "and nothing is left to redo"


def test_undo_twice_and_redo_twice_walk_back_and_forth_over_the_steps(tpage):
    build_scene(tpage)
    states = [counts_of(tpage)["shown"]]
    key(tpage, "Control+z"); states.append(counts_of(tpage)["shown"])
    key(tpage, "Control+z"); states.append(counts_of(tpage)["shown"])
    assert states[0] > states[1] > states[2] == 1
    key(tpage, "Control+Shift+z"); assert counts_of(tpage)["shown"] == states[1]
    key(tpage, "Control+y"); assert counts_of(tpage)["shown"] == states[0]
    key(tpage, "Control+y"); assert counts_of(tpage)["shown"] == states[0], "nothing more to redo"


def test_a_new_step_ends_the_chain_of_redo_steps(tpage):
    build_scene(tpage)
    key(tpage, "Control+z")
    assert buttons(tpage)["redo"]
    click_handle(tpage, "addr:" + ADDRESS, "right")                                   # something new
    assert not buttons(tpage)["redo"], "what was undone can no longer be put back on top of something new"
    before = counts_of(tpage)
    key(tpage, "Control+Shift+z")
    assert counts_of(tpage)["shown"] == before["shown"], "Redo does nothing now"


def test_redo_puts_back_hidden_vertices_and_an_added_start_point(tpage):
    build_scene(tpage)
    click_node(tpage, ROBINHOOD); settle(tpage)
    tpage.click("#traceHide"); settle(tpage)
    hidden_now = shown(tpage)
    assert ROBINHOOD not in hidden_now
    key(tpage, "Control+z"); assert ROBINHOOD in shown(tpage)
    key(tpage, "Control+Shift+z"); assert shown(tpage) == hidden_now, "hidden again"
    tpage.fill("#q", COINBASE["txid"]); tpage.keyboard.press("Enter"); idle(tpage); settle(tpage)
    assert counts_of(tpage)["seeds"] == 2
    key(tpage, "Control+z"); assert counts_of(tpage)["seeds"] == 1
    key(tpage, "Control+y"); assert counts_of(tpage)["seeds"] == 2, "the added start point is back"


def test_outside_a_trace_redo_hides_again_and_a_new_hide_ends_the_chain(fpage):
    open_query(fpage, NORMAL["txid"]); fpage.uncheck("#focusOn"); settle(fpage)
    fpage.evaluate("(id) => window.__hopline.setSel([id])", ROBINHOOD); settle(fpage)
    fpage.click("#traceHide"); settle(fpage)
    assert ROBINHOOD not in screen_pos(fpage)
    key(fpage, "Control+z"); assert ROBINHOOD in screen_pos(fpage) and buttons(fpage)["redo"]
    key(fpage, "Control+Shift+z"); assert ROBINHOOD not in screen_pos(fpage) and not buttons(fpage)["redo"]
    key(fpage, "Control+z")
    fpage.evaluate("(id) => window.__hopline.setSel([id])", "addr:" + ADDRESS); settle(fpage)
    fpage.click("#traceHide"); settle(fpage)
    assert not buttons(fpage)["redo"], "a new hide ends the chain"


# ---- adding wallets to what is open -----------------------------------------------------------------------------------------------

def test_the_box_says_add_once_something_is_open(tpage):
    assert tpage.inner_text("#btnOpen") == "Open" and tpage.get_attribute("#q", "placeholder") == "Transaction ID or address"
    open_query(tpage, NORMAL["txid"])
    assert tpage.inner_text("#btnOpen") == "Add" and "Add a transaction ID or address" == tpage.get_attribute("#q", "placeholder")
    assert "another starting point" in tpage.get_attribute("#btnOpen", "title")
    tpage.click("#btnClear"); tpage.click("#btnClear"); settle(tpage)
    assert tpage.inner_text("#btnOpen") == "Open", "an empty workspace opens"


def test_several_ids_pasted_at_once_are_all_added_as_starting_points(tpage):
    open_query(tpage, NORMAL["txid"])
    tpage.fill("#q", "  %s , %s\n" % (COINBASE["txid"], ADDRESS)); tpage.keyboard.press("Enter"); idle(tpage, timeout=60000); settle(tpage)
    n = counts_of(tpage)
    assert n["seeds"] == 3 and {NORMAL_ID, "tx:" + COINBASE["txid"], "addr:" + ADDRESS} <= shown(tpage)
    assert "Added 2 transactions and wallets" in tpage.inner_text("#toast") and tpage.input_value("#q") == ""
    key(tpage, "Control+z"); assert counts_of(tpage)["seeds"] == 2, "each is its own step: Undo takes the last one back"


def test_things_that_are_not_ids_or_cannot_be_loaded_are_reported_by_name(tpage):
    open_query(tpage, NORMAL["txid"])
    tpage.fill("#q", "nonsense %s %s" % (COINBASE["txid"], real_addr(77))); tpage.keyboard.press("Enter"); idle(tpage, timeout=60000); settle(tpage)
    t = tpage.inner_text("#toast")
    assert "Added 1 transaction or wallet" in t and "not recognised: nonsense" in t and "1 could not be loaded" in t, t
    tpage.fill("#q", "foo bar"); tpage.keyboard.press("Enter"); settle(tpage)
    assert "does not look like" in tpage.inner_text("#toast"), "nothing usable: the usual explanation of what a valid id looks like"


def test_at_most_ten_are_added_at_a_time(tpage):
    open_query(tpage, NORMAL["txid"])
    tpage.fill("#q", " ".join(real_addr(i) for i in range(100, 112))); tpage.keyboard.press("Enter"); idle(tpage, timeout=120000); settle(tpage)
    assert "2 more left out (at most 10 at a time)" in tpage.inner_text("#toast")


def test_shift_enter_starts_over_with_what_is_typed(tpage):
    build_scene(tpage)
    assert counts_of(tpage)["shown"] > 1
    tpage.fill("#q", COINBASE["txid"]); tpage.keyboard.press("Shift+Enter"); idle(tpage); settle(tpage)
    assert counts_of(tpage)["shown"] == 1 and counts_of(tpage)["seeds"] == 1 and "tx:" + COINBASE["txid"] in shown(tpage)
    key(tpage, "Control+z")
    assert counts_of(tpage)["shown"] > 1 and NORMAL_ID in shown(tpage), "starting over can be taken back"
    tpage.fill("#q", COINBASE["txid"]); tpage.click("#btnOpen", modifiers=["Shift"]); idle(tpage); settle(tpage)
    assert counts_of(tpage)["shown"] == 1, "Shift-click on the button does the same"
