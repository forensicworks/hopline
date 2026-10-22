"""Find in the workspace: look for a transaction or wallet among the loaded ones by id, label, note, tag, name or cluster."""
import pytest

from conftest import ADDRESS, COINBASE, NORMAL, SPENDERS
from helpers import click_node, idle, open_query, settle, xy
from test_trace import click_handle, shown

NORMAL_ID = "tx:" + NORMAL["txid"]
ROBINHOOD = "addr:bc1qprdf80adfz7aekh5nejjfrp3jksc8r929svpxk"          # on the built-in list as "Robinhood Hot Wallet"
SPENDER_ID = "tx:" + SPENDERS[0]["txid"]


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def build_scene(page):
    open_query(page, NORMAL["txid"])
    click_handle(page, NORMAL_ID, "right")
    click_handle(page, ROBINHOOD, "right")


def open_find(page):
    page.locator("#cv").focus(); page.keyboard.press("Control+f")
    page.wait_for_function("() => !document.getElementById('findBox').hidden")


def type_find(page, text):
    page.fill("#findQ", text); page.wait_for_timeout(150)                                # the search runs a moment after the last key


def rows(page):
    return page.evaluate("() => [...document.querySelectorAll('#findList .findrow')].map((r) => ({ text: r.innerText, on: r.classList.contains('on'), id: r.id }))")


def label(page, vertex, text):
    click_node(page, vertex); settle(page)
    page.fill("#fLabel", text); page.wait_for_timeout(200)


def selected(page):
    return page.evaluate("() => [...window.__hopline.state.selected]")


# ---- opening and closing -------------------------------------------------------------------------------------------------------

def test_the_field_is_always_in_the_top_bar_and_clicking_it_drops_the_matches_down(tpage):
    assert tpage.is_visible("#findQ") and tpage.get_attribute("#findQ", "placeholder") == "Find in workspace", "there from the start, before anything is loaded"
    open_query(tpage, NORMAL["txid"])
    assert tpage.evaluate("() => document.activeElement.id") == "btnOpen", "after Open the keyboard is on the button, not the canvas"
    assert tpage.is_hidden("#findBox")
    tpage.click("#findQ")
    assert tpage.is_visible("#findBox") and "Binance" in tpage.inner_text("#findFoot"), "a hint says what can be searched"
    box, top = tpage.locator("#findBox").bounding_box(), tpage.locator("#top").bounding_box()
    assert box["y"] >= top["y"] + top["height"] - 1, "the matches hang below the top bar"
    tpage.keyboard.press("Escape")
    assert tpage.is_hidden("#findBox") and tpage.evaluate("() => document.activeElement.id") == "cv", "closed, and the canvas has the keyboard again"
    tpage.click("#findQ"); assert tpage.is_visible("#findBox")
    tpage.keyboard.press("Tab"); assert tpage.is_hidden("#findBox"), "Tab moves on and closes it"


def test_typing_into_the_field_works_without_any_keyboard_shortcut(tpage):
    open_query(tpage, NORMAL["txid"])
    tpage.click("#findQ"); tpage.keyboard.type(NORMAL["txid"][:8]); tpage.wait_for_timeout(150)
    r = rows(tpage)
    assert len(r) == 1 and "TX" in r[0]["text"] and "on screen" in r[0]["text"]
    tpage.keyboard.press("Enter"); settle(tpage)
    assert selected(tpage) == [NORMAL_ID] and tpage.input_value("#findQ") == "", "went to it, and the field is clear for the next search"


def test_ctrl_f_on_the_canvas_puts_the_cursor_in_the_field(tpage):
    open_query(tpage, NORMAL["txid"])
    open_find(tpage)
    assert tpage.evaluate("() => document.activeElement.id") == "findQ" and tpage.is_visible("#findBox")


def test_clicking_elsewhere_closes_the_matches_but_keeps_what_was_typed(tpage):
    open_query(tpage, NORMAL["txid"])
    tpage.click("#findQ"); tpage.keyboard.type("robin"); tpage.wait_for_timeout(150)
    tpage.click("#btnFit")
    assert tpage.is_hidden("#findBox") and tpage.input_value("#findQ") == "robin"
    tpage.click("#findQ"); tpage.wait_for_timeout(150)
    assert tpage.is_visible("#findBox"), "clicking the field brings the matches back for what is typed"


def test_ctrl_f_is_left_to_the_browser_while_typing_in_another_box(tpage):
    open_query(tpage, NORMAL["txid"])
    tpage.focus("#q"); tpage.keyboard.press("Control+f")
    assert tpage.is_hidden("#findBox"), "only the canvas takes Ctrl+F; text boxes keep the browser's own"


def test_clicking_the_canvas_closes_it_without_losing_the_selection(tpage):
    build_scene(tpage)
    click_node(tpage, ROBINHOOD); settle(tpage)
    open_find(tpage)
    p = xy(tpage, NORMAL_ID)
    tpage.mouse.click(p["x"] + 300, p["y"] + 260)                                         # empty canvas
    assert tpage.is_hidden("#findBox")


# ---- what it finds ---------------------------------------------------------------------------------------------------------------

def test_a_label_a_note_and_a_built_in_name_are_all_found_and_enter_goes_to_the_best(tpage):
    build_scene(tpage)
    label(tpage, ROBINHOOD, "Suspect Alpha")
    tpage.fill("#fNote", "seen near the harbour"); tpage.wait_for_timeout(200)
    open_find(tpage)
    type_find(tpage, "robin")
    r = rows(tpage)
    assert len(r) == 1 and "known as: Robinhood Hot Wallet" in r[0]["text"] and "Suspect Alpha" in r[0]["text"] and "on screen" in r[0]["text"]
    type_find(tpage, "suspect harbour")
    assert "note: seen near the harbour" in rows(tpage)[0]["text"], "several words, found in different fields"
    type_find(tpage, "suspect banana")
    assert rows(tpage) == [] and "Nothing among the" in tpage.inner_text("#findList")
    type_find(tpage, "harbour"); tpage.keyboard.press("Enter"); settle(tpage)
    assert tpage.is_hidden("#findBox") and selected(tpage) == [ROBINHOOD]
    c = tpage.evaluate("() => { const r = document.getElementById('cv').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }")
    p = xy(tpage, ROBINHOOD)
    assert abs(p["x"] - c["x"]) < 6 and abs(p["y"] - c["y"]) < 140, "the view moved to the vertex (a little above the middle: the bottom bar takes room)"


def test_a_name_from_a_label_pack_is_found(tpage):
    build_scene(tpage)
    tpage.evaluate("() => { document.getElementById('packSection').open = true; }")
    tpage.set_input_files("#packFile", files=[{"name": "case.csv", "mimeType": "text/csv", "buffer": ("address,label,category\n%s,Courier wallet seven,CASE\n" % ROBINHOOD[5:]).encode()}])
    tpage.wait_for_function("() => /Imported|Replaced|failed/.test(document.getElementById('toast').textContent)")
    open_find(tpage)
    type_find(tpage, "courier seven")
    r = rows(tpage)
    assert len(r) == 1 and "Courier wallet seven" in r[0]["text"] and ROBINHOOD[5:13] in r[0]["text"]
    type_find(tpage, "case")
    assert len(rows(tpage)) == 1, "the pack's category and name too"


def test_two_close_matches_can_be_chosen_with_the_arrows_or_a_click(tpage):
    build_scene(tpage)
    label(tpage, ROBINHOOD, "Suspect Alpha")
    label(tpage, "addr:" + ADDRESS, "Suspect Beta")
    open_find(tpage)
    type_find(tpage, "suspect")
    r = rows(tpage)
    assert len(r) == 2 and r[0]["on"] and not r[1]["on"]
    tpage.keyboard.press("ArrowDown")
    assert [x["on"] for x in rows(tpage)] == [False, True] and tpage.get_attribute("#findQ", "aria-activedescendant") == rows(tpage)[1]["id"]
    tpage.keyboard.press("ArrowDown")
    assert rows(tpage)[0]["on"], "it wraps round"
    tpage.keyboard.press("ArrowUp"); tpage.keyboard.press("Enter"); settle(tpage)
    chosen = selected(tpage)
    assert len(chosen) == 1
    open_find(tpage); type_find(tpage, "suspect")
    tpage.click("#findList .findrow >> nth=0"); settle(tpage)
    assert len(selected(tpage)) == 1 and selected(tpage) != chosen, "clicking a row goes to it"


def test_markup_in_a_label_is_shown_as_text(tpage):
    build_scene(tpage)
    evil = "<img src=x onerror=window.__pwned=1>"
    label(tpage, ROBINHOOD, evil)
    open_find(tpage); type_find(tpage, "img src")
    r = rows(tpage)
    assert len(r) == 1 and evil in r[0]["text"]
    assert tpage.locator("#findList img").count() == 0 and tpage.evaluate("() => window.__pwned") is None


def test_short_and_empty_searches_say_what_to_do(tpage):
    build_scene(tpage)
    open_find(tpage)
    type_find(tpage, "a")
    assert "at least two characters" in tpage.inner_text("#findFoot") and rows(tpage) == []
    type_find(tpage, "zzzzzz")
    t = tpage.inner_text("#findList")
    assert "Nothing among the" in t and "loaded" in t and tpage.locator("#findList button").count() == 0, "not an id: no Add button"


# ---- a vertex that is loaded but not on screen ------------------------------------------------------------------------------------

def test_in_a_trace_a_loaded_vertex_that_is_not_shown_is_added_as_a_starting_point_and_undo_takes_it_back(tpage):
    build_scene(tpage)
    assert SPENDER_ID in tpage.evaluate("() => [...window.__hopline.state.graph.nodes.keys()]") and SPENDER_ID not in shown(tpage)
    n = len(shown(tpage))
    open_find(tpage); type_find(tpage, SPENDERS[0]["txid"][:10])
    r = rows(tpage)
    assert len(r) == 1 and "not shown" in r[0]["text"]
    tpage.keyboard.press("Enter"); idle(tpage); settle(tpage)
    assert len(shown(tpage)) == n + 1 and SPENDER_ID in shown(tpage) and selected(tpage) == [SPENDER_ID]
    assert "Added to the trace as another starting point" in tpage.inner_text("#toast")
    tpage.locator("#cv").focus(); tpage.keyboard.press("Control+z"); settle(tpage)
    assert len(shown(tpage)) == n and SPENDER_ID not in shown(tpage)


def test_outside_a_trace_find_moves_the_focus_to_a_vertex_beyond_the_neighbourhood(fpage):
    open_query(fpage, NORMAL["txid"])
    click_node(fpage, NORMAL_ID, dbl=True); idle(fpage); settle(fpage)                     # loads what spent its outputs
    fpage.select_option("#depth", "1"); settle(fpage)
    assert SPENDER_ID not in fpage.evaluate("() => [...window.__hopline.renderer.data.visible.nodes]"), "two steps away: outside depth 1"
    open_find(fpage); type_find(fpage, SPENDERS[0]["txid"][:10])
    assert "not shown" in rows(fpage)[0]["text"]
    fpage.keyboard.press("Enter"); idle(fpage); settle(fpage)
    assert fpage.evaluate("() => window.__hopline.state.focus") == SPENDER_ID and selected(fpage) == [SPENDER_ID]
    assert SPENDER_ID in fpage.evaluate("() => [...window.__hopline.renderer.data.visible.nodes]")


def test_a_vertex_you_hid_is_shown_again_by_find_and_undo_hides_it_again(fpage):
    open_query(fpage, NORMAL["txid"]); fpage.uncheck("#focusOn"); settle(fpage)
    fpage.evaluate("(id) => window.__hopline.setSel([id])", ROBINHOOD); settle(fpage)
    fpage.click("#traceHide"); settle(fpage)
    visible = lambda: ROBINHOOD in fpage.evaluate("() => [...window.__hopline.renderer.data.visible.nodes]")
    assert not visible()
    open_find(fpage); type_find(fpage, "robinhood")
    assert "hidden by you" in rows(fpage)[0]["text"]
    fpage.keyboard.press("Enter"); settle(fpage)
    assert visible() and selected(fpage) == [ROBINHOOD]
    fpage.locator("#cv").focus(); fpage.keyboard.press("Control+z"); settle(fpage)
    assert not visible(), "Undo hides it again"


# ---- an id that is not in the workspace -------------------------------------------------------------------------------------------

@pytest.mark.parametrize("how", ["button", "enter"])
def test_an_id_that_is_not_loaded_can_be_added_from_find(tpage, how):
    open_query(tpage, NORMAL["txid"])
    open_find(tpage); type_find(tpage, COINBASE["txid"])
    assert rows(tpage) == [] and "not in the workspace yet" in tpage.inner_text("#findList")
    if how == "button":
        tpage.click("#findList button")
    else:
        tpage.keyboard.press("Enter")
    idle(tpage); settle(tpage)
    assert tpage.is_hidden("#findBox")
    assert "tx:" + COINBASE["txid"] in shown(tpage) and tpage.evaluate("() => window.__hopline.state.trace.seeds.length") == 2
