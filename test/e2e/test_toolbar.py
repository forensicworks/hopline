"""The toolbar over the canvas: one row at every width, arrow icons for undo and redo, what does not fit in a ... menu, the graph fitted below it, clicks passing through its gaps."""
import pytest

from chains import peel_chain, tid
from conftest import NORMAL
from helpers import idle, open_query, settle

SHOWN = "() => window.__hopline.state.trace.shown.size"


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def bar_facts(page):
    return page.evaluate("""() => { const b = document.getElementById('traceBar'), r = b.getBoundingClientRect(), c = document.getElementById('cv').getBoundingClientRect(), t = document.getElementById('sideTab'), tr = t.getBoundingClientRect();
        return { x: r.x, right: r.right, h: r.height, wide: b.scrollWidth - b.clientWidth, canvasLeft: c.left, canvasRight: c.right, tabRight: t.offsetParent ? tr.right : null,
                 more: !document.getElementById('barMore').hidden,
                 over: [...b.querySelectorAll('.tb-over')].map(e => e.id) }; }""")


def traced_chain(page, mock, length=6, hops=3):
    peel_chain(mock, length)
    open_query(page, tid(10))
    page.evaluate("(id) => window.__hopline.autoExpand(id, { dir: 'next', hops: %d, follow: 'all' })" % hops, "tx:" + tid(10)); idle(page); settle(page)


@pytest.mark.parametrize("width", [1700, 1400, 1100, 1070, 900, 760, 700])        # 760 and 1070: the canvas is a little narrower than the whole row, which would sit under a tab if it were centred over all of it
def test_the_bar_is_one_row_at_every_width_and_stays_clear_of_the_tab_and_the_edge(tpage, width):
    tpage.set_viewport_size({"width": width, "height": 850})
    open_query(tpage, NORMAL["txid"]); tpage.wait_for_timeout(200)
    f = bar_facts(tpage)
    assert f["h"] < 50, "one row, not two or three: %r" % f
    assert f["wide"] <= 2, "nothing runs past the end of the bar: %r" % f
    assert f["right"] <= f["canvasRight"] - 12 + 1 and f["x"] >= (f["tabRight"] if f["tabRight"] is not None else f["canvasLeft"]) , "the bar stays between the Controls tab and the edge: %r" % f


def test_undo_and_redo_are_arrow_icons_that_keep_their_names(tpage):
    open_query(tpage, NORMAL["txid"])
    for id_, name in (("traceUndo", "Undo"), ("traceRedo", "Redo")):
        assert tpage.get_attribute("#" + id_, "aria-label") == name
        assert name not in tpage.inner_text("#" + id_), "an arrow, not a word"
        assert tpage.locator("#" + id_).bounding_box()["width"] < 44
    assert "Ctrl+Z" in tpage.get_attribute("#traceUndo", "title") and "Ctrl+Y" in tpage.get_attribute("#traceRedo", "title")


def test_everything_is_on_the_row_when_there_is_room_and_no_more_button(tpage):
    open_query(tpage, NORMAL["txid"])
    f = bar_facts(tpage)
    assert not f["more"] and f["over"] == []
    for id_ in ("traceUndo", "traceRedo", "traceHide", "traceKeep", "selMenu", "boxSel", "traceArrange", "traceReset"):
        assert tpage.is_visible("#" + id_), id_


def test_what_does_not_fit_goes_into_the_more_menu_and_comes_back_when_there_is_room(tpage, mock):
    traced_chain(tpage, mock)
    tpage.set_viewport_size({"width": 1000, "height": 850})                      # the details panel takes a third of it: too narrow for the whole row
    tpage.wait_for_timeout(300)
    f = bar_facts(tpage)
    assert f["more"] and "traceReset" in f["over"] and "arrangeBox" in f["over"], f
    assert tpage.is_hidden("#traceReset") and tpage.is_hidden("#traceArrange")
    assert tpage.is_visible("#traceUndo") and tpage.is_visible("#traceHide"), "the ones used most stay"
    tpage.click("#barMore")
    menu = tpage.locator("#ctxMenu")
    assert menu.is_visible()
    names = [t.strip() for t in menu.locator("button").all_inner_texts()]
    assert any(n.startswith("Reset to start") for n in names) and any(n.startswith("Flow") for n in names), names
    menu.locator("button", has_text="Flow (left to right)").click(); settle(tpage)
    assert tpage.evaluate("() => window.__hopline.state.arrange") == "flow" and tpage.input_value("#traceArrange") == "flow", "the choice reaches the hidden control too"
    tpage.click("#barMore")
    assert tpage.locator("#ctxMenu button", has_text="Flow (left to right)").inner_text().strip().startswith("✓"), "the current one is ticked"
    tpage.keyboard.press("Escape")
    before = tpage.evaluate(SHOWN)
    assert before > 1
    tpage.click("#barMore"); tpage.locator("#ctxMenu button", has_text="Reset to start").click(); settle(tpage)
    assert tpage.evaluate(SHOWN) == 1, "Reset to start from the menu does what the button does"
    tpage.set_viewport_size({"width": 1700, "height": 850})
    tpage.wait_for_timeout(300)
    f = bar_facts(tpage)
    assert not f["more"] and f["over"] == [] and tpage.is_visible("#traceReset") and tpage.is_visible("#traceArrange"), f


def test_select_and_box_and_keep_work_from_the_more_menu_when_they_have_moved(tpage, mock):
    traced_chain(tpage, mock)
    tpage.set_viewport_size({"width": 1000, "height": 850})
    tpage.click("#sideTab")                                                       # both panels open: the canvas is a third of the window
    tpage.wait_for_timeout(300)
    f = bar_facts(tpage)
    assert {"selMenu", "boxSel", "traceKeep"} <= set(f["over"]), f
    tpage.click("#barMore"); tpage.locator("#ctxMenu button", has_text="Box select").click()
    assert tpage.evaluate("() => window.__hopline.state.boxMode") is True
    tpage.click("#barMore"); tpage.locator("#ctxMenu button", has_text="Select…").click()
    assert tpage.is_visible("#ctxMenu") and "select (what is on screen)" in tpage.inner_text("#ctxMenu").lower(), "the Select menu opens from the ... button"
    tpage.locator("#ctxMenu button", has_text="All").first.click(); settle(tpage)
    assert tpage.evaluate("() => window.__hopline.state.selected.size") > 1


def test_the_graph_is_fitted_below_the_bar_and_the_room_goes_when_the_bar_does(tpage, mock):
    traced_chain(tpage, mock)
    bar = tpage.evaluate("() => { const b = document.getElementById('traceBar'); return b.offsetTop + b.offsetHeight; }")
    top = tpage.evaluate("() => window.__hopline.renderer.insets.top")
    assert bar < top <= bar + 12, "the inset is the bar's bottom edge and a little air: %r %r" % (bar, top)
    top_most = """() => { const r = window.__hopline.renderer; let m = Infinity;
        r.data.visible.nodes.forEach(id => { const p = r.positionOf(id); m = Math.min(m, r.view.y + p.y * r.view.k); }); return m; }"""
    tpage.evaluate("() => { const r = window.__hopline.renderer; r.fitPad = 40; r.insets.top = 0; r.fit(); }")
    free = tpage.evaluate(top_most)
    tpage.evaluate("() => { const r = window.__hopline.renderer; r.insets.top = 200; r.fit(); }")
    held = tpage.evaluate(top_most)
    assert held >= 200 + 40 - 1, "the top-most vertex keeps its padding below the inset: %r" % held
    assert held - free >= 99, "and fit() really moved the graph down for it: %r %r" % (held, free)
    tpage.click("#btnClear"); tpage.click("#btnClear"); settle(tpage)
    assert tpage.is_hidden("#traceBar") and tpage.evaluate("() => window.__hopline.renderer.insets.top") == 0, "no bar, no room kept for it"


def test_the_plate_of_the_bar_lets_clicks_through_and_only_its_controls_take_them(tpage):
    open_query(tpage, NORMAL["txid"])
    assert tpage.evaluate("() => getComputedStyle(document.getElementById('traceBar')).pointerEvents") == "none"
    assert tpage.evaluate("() => getComputedStyle(document.getElementById('traceUndo')).pointerEvents") == "auto"
    hit = tpage.evaluate("""() => { const b = document.getElementById('traceBar'), r = b.getBoundingClientRect(), u = document.getElementById('traceUndo').getBoundingClientRect();
        const edge = document.elementFromPoint(r.x + 3, r.y + r.height / 2), btn = document.elementFromPoint(u.x + u.width / 2, u.y + u.height / 2);
        return { edgeInBar: b.contains(edge), edgeId: edge && edge.id, btn: btn && btn.id }; }""")
    assert not hit["edgeInBar"] and hit["edgeId"] == "cv", "the padding of the plate belongs to the graph under it: %r" % hit
    assert hit["btn"] == "traceUndo", hit


def test_the_hint_and_the_selection_count_ride_on_the_count_line_not_in_the_bar(tpage, mock):
    open_query(tpage, NORMAL["txid"])
    assert tpage.locator("#hud #traceInfo").count() == 1 and tpage.locator("#traceBar #traceInfo").count() == 0
    assert "Click ◀ or ▶ beside the vertex" in tpage.inner_text("#hud")
    traced_chain(tpage, mock)
    tpage.evaluate("() => window.__hopline.setSel([])"); settle(tpage)
    assert tpage.inner_text("#traceInfo") == "", "nothing selected and nothing to teach: the line is just the counts"
    tpage.evaluate("() => window.__hopline.setSel([...window.__hopline.state.trace.shown].slice(0, 2))"); settle(tpage)
    assert tpage.inner_text("#traceInfo") == "2 selected" and "2 selected" in tpage.inner_text("#hud")
