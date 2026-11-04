"""Undo where you look for it: the message of every load, import and Clear offers Undo, Undo load and Redo load are in the bar only when they can act
(and their coming and going moves nothing you click), and the Undo and Redo buttons of the Trace bar say what they will take back."""
import pytest

from conftest import NORMAL
from helpers import idle, layout_menu, open_query, settle
from test_layout_tools import place, ring, visible
from test_trace import click_handle

NORMAL_ID = "tx:" + NORMAL["txid"]


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def n_nodes(page):
    return page.evaluate("() => window.__hopline.state.graph.nodes.size")


def box(page, sel):
    b = page.locator(sel).bounding_box()
    return (round(b["x"], 1), round(b["y"], 1), round(b["width"], 1), round(b["height"], 1))


def import_text(page, text):
    page.evaluate("(text) => { const f = new File([text], 'w.json'); const dt = new DataTransfer(); dt.items.add(f); const i = document.getElementById('fileImport'); i.files = dt.files; i.dispatchEvent(new Event('change')); }", text)
    page.wait_for_function("() => window.__hopline.state.graph.nodes.size > 0"); settle(page)


def title(page, sel):
    return page.get_attribute(sel, "title")


def test_the_message_of_a_load_offers_undo_load_and_it_takes_the_load_back(fpage):
    open_query(fpage, NORMAL["txid"])
    assert n_nodes(fpage) > 0
    assert fpage.locator("#toast button:has-text('Undo load')").count() == 1, "an ordinary load, not only a big one"
    assert "That is a lot" not in fpage.inner_text("#toast")
    fpage.click("#toast button:has-text('Undo load')"); idle(fpage); settle(fpage)
    assert n_nodes(fpage) == 0


def test_an_import_and_a_clear_offer_undo_in_their_messages(fpage):
    open_query(fpage, NORMAL["txid"]); fpage.uncheck("#focusOn"); settle(fpage)
    full = n_nodes(fpage)
    exported = fpage.evaluate("() => HoplineIO.toJson(window.__hopline.state.graph, { view: {} })")
    fpage.click("#btnClear"); fpage.click("#btnClear"); settle(fpage)
    assert n_nodes(fpage) == 0 and "Cleared the workspace" in fpage.inner_text("#toast")
    fpage.click("#toast button:has-text('Undo clear')"); idle(fpage); settle(fpage)
    assert n_nodes(fpage) == full, "Undo in the message of Clear brings it all back"
    fpage.click("#btnClear"); fpage.click("#btnClear"); settle(fpage)
    import_text(fpage, exported)
    assert "Imported" in fpage.inner_text("#toast") and fpage.locator("#toast button:has-text('Undo import')").count() == 1
    fpage.click("#toast button:has-text('Undo import')"); idle(fpage); settle(fpage)
    assert n_nodes(fpage) == 0, "back to the empty workspace the import was made into"


def test_clearing_an_empty_workspace_says_nothing_and_offers_nothing(fpage):
    fpage.click("#btnClear"); fpage.click("#btnClear"); settle(fpage)
    assert fpage.is_hidden("#toast") or "Cleared" not in fpage.inner_text("#toast")


def test_undo_load_and_redo_load_are_in_the_bar_only_when_they_can_act(fpage):
    assert fpage.is_hidden("#btnUndoLoad") and fpage.is_hidden("#btnRedoLoad"), "a new visitor sees neither"
    open_query(fpage, NORMAL["txid"])
    assert fpage.is_visible("#btnUndoLoad") and fpage.is_enabled("#btnUndoLoad") and fpage.is_hidden("#btnRedoLoad"), "a load gives something to undo, nothing to redo"
    fpage.click("#btnUndoLoad"); idle(fpage); settle(fpage)
    assert fpage.is_hidden("#btnUndoLoad") and fpage.is_visible("#btnRedoLoad"), "undone: nothing more to undo, something to redo"
    fpage.click("#btnRedoLoad"); idle(fpage); settle(fpage)
    assert fpage.is_visible("#btnUndoLoad") and fpage.is_hidden("#btnRedoLoad")


def test_their_coming_and_going_moves_nothing_you_click(fpage):
    names = ["#btnImport", "#btnClear", "#exportMenu summary", "#btnFit", "#layoutMenu summary", "#findQ"]
    before = {n: box(fpage, n) for n in names}
    open_query(fpage, NORMAL["txid"])
    assert fpage.is_visible("#btnUndoLoad")
    assert {n: box(fpage, n) for n in names} == before, "Import, Clear, Export, Fit, Layout and Find stay where they were"
    fpage.click("#btnUndoLoad"); idle(fpage); settle(fpage)
    assert fpage.is_visible("#btnRedoLoad") and {n: box(fpage, n) for n in names} == before


def test_the_trace_undo_and_redo_buttons_name_the_step(tpage):
    open_query(tpage, NORMAL["txid"]); settle(tpage)
    assert tpage.is_disabled("#traceUndo") and "Undo load in the top bar" in title(tpage, "#traceUndo"), "no step of its own yet: it says where the load is undone"
    click_handle(tpage, NORMAL_ID, "right")
    assert title(tpage, "#traceUndo").startswith("Undo: Reveal ") and "(Ctrl+Z)" in title(tpage, "#traceUndo"), title(tpage, "#traceUndo")
    layout_menu(tpage, "#btnSpread"); idle(tpage); settle(tpage)
    assert title(tpage, "#traceUndo") == "Undo: Spread (Ctrl+Z)", title(tpage, "#traceUndo")
    layout_menu(tpage, "#btnTighten"); idle(tpage); settle(tpage)
    assert title(tpage, "#traceUndo") == "Undo: Tighten (Ctrl+Z)"
    tpage.keyboard.press("Control+z"); settle(tpage)
    assert tpage.is_enabled("#traceRedo") and title(tpage, "#traceRedo") == "Redo: Tighten (Ctrl+Shift+Z or Ctrl+Y)", title(tpage, "#traceRedo")
    assert title(tpage, "#traceUndo") == "Undo: Spread (Ctrl+Z)"


def test_declutter_and_flow_hide_are_named_too(fpage, mock):
    open_query(fpage, NORMAL["txid"]); fpage.uncheck("#focusOn"); settle(fpage)
    ids = visible(fpage)
    a, b = ids[0], ids[1]
    far = ring(ids)
    far[b] = [far[a][0] + 6, far[a][1] + 4]
    place(fpage, far)
    layout_menu(fpage, "#btnDeclutter"); idle(fpage); settle(fpage)
    assert title(fpage, "#traceUndo") == "Undo: Declutter (Ctrl+Z)", title(fpage, "#traceUndo")
    fpage.evaluate("(id) => window.__hopline.setSel([id])", NORMAL_ID); settle(fpage)
    fpage.click("#traceHide"); settle(fpage)
    assert title(fpage, "#traceUndo") == "Undo: Hide 1 vertex (Ctrl+Z)", title(fpage, "#traceUndo")
    fpage.click("#traceUndo"); settle(fpage)
    assert title(fpage, "#traceRedo") == "Redo: Hide 1 vertex (Ctrl+Shift+Z or Ctrl+Y)", title(fpage, "#traceRedo")
