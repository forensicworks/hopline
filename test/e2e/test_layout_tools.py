"""Spread, Tighten and Declutter: moving vertices without placing them all again. Each is one step that Undo takes back."""
import pytest

from chains import consolidation, tid
from conftest import NORMAL
from helpers import idle, layout_menu, open_query, settle


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def visible(page):
    return page.evaluate("() => [...window.__hopline.renderer.data.visible.nodes].sort()")


def where(page, ids=None):
    """World positions of the vertices drawn (all of them, or the ids given)."""
    return page.evaluate("(ids) => Object.fromEntries([...window.__hopline.renderer.cur].filter(([id]) => !ids || ids.includes(id)).map(([id, p]) => [id, [p.x, p.y]]))", ids)


def close(a, b, tol=1e-6):
    return a.keys() == b.keys() and all(abs(a[k][0] - b[k][0]) <= tol and abs(a[k][1] - b[k][1]) <= tol for k in a)


def dist(p, q):
    return ((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2) ** 0.5


def place(page, coords):
    """Put vertices where the test wants them (world units), keep the layout's own record in step, and fit the view."""
    page.evaluate("""(c) => { const h = window.__hopline, r = h.renderer, m = new Map(r.cur);
        for (const [id, xy] of Object.entries(c)) m.set(id, { x: xy[0], y: xy[1] });
        h.state.layoutRes.pos = new Map(m); r.setPositions(m, true); r.fit(); r.draw(); }""", coords)
    settle(page)


def ring(ids, radius=1600):
    """Positions on a circle: the line between two vertices never passes through a third, so only what a test sets up overlaps."""
    import math
    return {i: [radius * math.cos(2 * math.pi * n / len(ids)), radius * math.sin(2 * math.pi * n / len(ids))] for n, i in enumerate(ids)}


def touching(page, a, b):
    """Whether the footprints of two vertices overlap on the canvas, from what the canvas says it drew."""
    return page.evaluate("""([a, b]) => { const r = window.__hopline.renderer, fp = r.footprints(), k = r.view.k;
        const rect = (id) => { const p = r.cur.get(id), f = fp.get(id), x = p.x * k + r.view.x, y = p.y * k + r.view.y; return [x + f.l, y + f.t, x + f.r, y + f.b]; };
        const A = rect(a), B = rect(b); return A[0] < B[2] && B[0] < A[2] && A[1] < B[3] && B[1] < A[3]; }""", [a, b])


def test_spread_moves_every_vertex_away_from_the_middle_by_a_third_and_tighten_undoes_it(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30)); fpage.uncheck("#focusOn"); settle(fpage)
    ids = visible(fpage)
    before = where(fpage, ids)
    layout_menu(fpage, "#btnSpread"); idle(fpage); settle(fpage)
    after = where(fpage, ids)
    xs = [before[i][0] for i in ids]; ys = [before[i][1] for i in ids]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    for i in ids:
        assert abs(after[i][0] - (cx + (before[i][0] - cx) * 1.3)) < 1e-6 and abs(after[i][1] - (cy + (before[i][1] - cy) * 1.3)) < 1e-6, i
    a, b = ids[0], ids[-1]
    assert abs(dist(after[a], after[b]) - 1.3 * dist(before[a], before[b])) < 1e-6, "every distance grows by the same factor: the arrangement stays"
    layout_menu(fpage, "#btnTighten"); idle(fpage); settle(fpage)
    assert close(where(fpage, ids), before), "Tighten is the opposite of Spread"


def test_spread_is_one_step_that_undo_takes_back_and_what_was_dragged_stays_pinned(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30)); fpage.uncheck("#focusOn"); settle(fpage)
    ids = visible(fpage)
    pin = ids[0]
    fpage.evaluate("(id) => { const h = window.__hopline, p = h.renderer.cur.get(id); h.state.pinned.set(id, { x: p.x, y: p.y }); }", pin)
    before = where(fpage, ids)
    layout_menu(fpage, "#btnSpread"); idle(fpage); settle(fpage)
    moved = where(fpage, ids)
    assert not close(moved, before)
    pinned = fpage.evaluate("(id) => { const p = window.__hopline.state.pinned.get(id); return p ? [p.x, p.y] : null; }", pin)
    assert pinned is not None and abs(pinned[0] - moved[pin][0]) < 1e-6 and abs(pinned[1] - moved[pin][1]) < 1e-6, "it is still pinned, and where it is drawn"
    fpage.keyboard.press("Control+z"); settle(fpage)
    assert close(where(fpage, ids), before), "Ctrl+Z puts every vertex back"
    layout_menu(fpage, "#btnSpread"); idle(fpage); settle(fpage)
    assert not close(where(fpage, ids), before)


def test_in_a_trace_the_columns_are_spread_and_undo_takes_it_back(tpage, mock):
    consolidation(mock)
    open_query(tpage, tid(30)); settle(tpage)
    tpage.evaluate("() => { window.__hopline.state.stepMode = 'all'; }")
    tpage.evaluate("(id) => window.__hopline.traceExpand(id, 'prev')", "tx:" + tid(30)); idle(tpage); settle(tpage)
    ids = visible(tpage)
    assert len(ids) >= 3
    before = where(tpage, ids)
    layout_menu(tpage, "#btnSpread"); idle(tpage); settle(tpage)
    after = where(tpage, ids)
    a, b = ids[0], ids[-1]
    assert abs(dist(after[a], after[b]) - 1.3 * dist(before[a], before[b])) < 1e-6
    tpage.keyboard.press("Control+z"); settle(tpage)
    assert close(where(tpage, ids), before)


def test_where_x_is_time_only_the_heights_change(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30)); fpage.uncheck("#focusOn"); settle(fpage)
    fpage.click("#layoutSeg [data-layout=timeline]"); idle(fpage); settle(fpage)
    ids = visible(fpage)
    before = where(fpage, ids)
    layout_menu(fpage, "#btnSpread"); idle(fpage); settle(fpage)
    after = where(fpage, ids)
    assert all(abs(after[i][0] - before[i][0]) < 1e-6 for i in ids), "x is time: it stays"
    assert any(abs(after[i][1] - before[i][1]) > 1 for i in ids), "the heights moved"


def test_declutter_moves_apart_only_the_vertices_that_touch_and_undo_puts_them_back(fpage, mock):
    open_query(fpage, NORMAL["txid"]); fpage.uncheck("#focusOn"); settle(fpage)
    ids = visible(fpage)
    a, b = ids[0], ids[1]
    far = ring(ids)
    far[b] = [far[a][0] + 6, far[a][1] + 4]                                          # b sits on top of a
    place(fpage, far)
    assert touching(fpage, a, b)
    before = where(fpage, ids)
    layout_menu(fpage, "#btnDeclutter"); idle(fpage); settle(fpage)
    after = where(fpage, ids)
    assert not touching(fpage, a, b), "the two now have their own room"
    assert all(abs(after[i][0] - before[i][0]) < 1e-6 and abs(after[i][1] - before[i][1]) < 1e-6 for i in ids if i not in (a, b)), "nothing else moved"
    assert "Moved 2 vertices" in fpage.inner_text("#toast")
    fpage.keyboard.press("Control+z"); settle(fpage)
    assert close(where(fpage, ids), before) and touching(fpage, a, b), "Ctrl+Z puts them back where they were"


def test_declutter_leaves_what_was_dragged_where_it_is_and_says_so_when_nothing_touches(fpage, mock):
    open_query(fpage, NORMAL["txid"]); fpage.uncheck("#focusOn"); settle(fpage)
    ids = visible(fpage)
    a, b = ids[0], ids[1]
    far = ring(ids)
    far[b] = [far[a][0] + 6, far[a][1] + 4]
    place(fpage, far)
    fpage.evaluate("(id) => { const h = window.__hopline, p = h.renderer.cur.get(id); h.state.pinned.set(id, { x: p.x, y: p.y }); }", a)
    before = where(fpage, ids)
    layout_menu(fpage, "#btnDeclutter"); idle(fpage); settle(fpage)
    after = where(fpage, ids)
    assert after[a] == before[a], "the pinned vertex stayed"
    assert dist(after[b], before[b]) > 5, "the other one gave way"
    assert not touching(fpage, a, b)
    undo = fpage.evaluate("() => window.__hopline.state.hideUndo.length")
    layout_menu(fpage, "#btnDeclutter"); idle(fpage); settle(fpage)
    assert "Nothing overlaps" in fpage.inner_text("#toast")
    assert fpage.evaluate("() => window.__hopline.state.hideUndo.length") == undo, "nothing moved, so no step"


def test_the_three_are_in_the_menu_of_the_empty_canvas_too(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30)); fpage.uncheck("#focusOn"); settle(fpage)
    box = fpage.locator("#cv").bounding_box()
    fpage.mouse.click(box["x"] + 5, box["y"] + 5, button="right"); settle(fpage)
    menu = fpage.inner_text("#ctxMenu")
    assert "Spread" in menu and "Tighten" in menu and "Declutter" in menu and "Re-layout" in menu


def on_the_line(page, edge_a, edge_b, w):
    """Whether any point of the line between two vertices, as drawn, is inside the footprint of a third one (screen pixels, sampled)."""
    return page.evaluate("""([a, b, w]) => { const r = window.__hopline.renderer, fp = r.footprints(), k = r.view.k;
        const P = (id) => { const p = r.cur.get(id); return [p.x * k + r.view.x, p.y * k + r.view.y]; };
        const A = P(a), B = P(b), W = P(w), f = fp.get(w);
        for (let i = 0; i <= 200; i++) { const x = A[0] + (B[0] - A[0]) * i / 200, y = A[1] + (B[1] - A[1]) * i / 200;
            if (x > W[0] + f.l && x < W[0] + f.r && y > W[1] + f.t && y < W[1] + f.b) return true; }
        return false; }""", [edge_a, edge_b, w])


def test_declutter_moves_a_vertex_off_the_line_of_an_edge_it_is_not_an_end_of_and_leaves_the_ends(fpage, mock):
    open_query(fpage, NORMAL["txid"]); fpage.uncheck("#focusOn"); settle(fpage)
    ids = visible(fpage)
    edge = fpage.evaluate("""() => { const g = window.__hopline.state.graph, vis = window.__hopline.renderer.data.visible.nodes;
        for (const e of g.edges.values()) if (vis.has(e.source) && vis.has(e.target)) return [e.source, e.target]; return null; }""")
    a, b = edge
    w = next(i for i in ids if i not in edge)
    far = ring(ids)
    far[w] = [(far[a][0] + far[b][0]) / 2, (far[a][1] + far[b][1]) / 2]                           # w sits in the middle of the line a -> b
    place(fpage, far)
    assert on_the_line(fpage, a, b, w), "the setup: the vertex is on the line"
    before = where(fpage, ids)
    layout_menu(fpage, "#btnDeclutter"); idle(fpage); settle(fpage)
    after = where(fpage, ids)
    assert not on_the_line(fpage, a, b, w), "it is off the line now"
    assert after[a] == before[a] and after[b] == before[b], "the ends of the edge did not move for it"
    assert "Moved" in fpage.inner_text("#toast")
    fpage.keyboard.press("Control+z"); settle(fpage)
    assert close(where(fpage, ids), before) and on_the_line(fpage, a, b, w), "Ctrl+Z puts it back"


def test_the_layout_menu_holds_the_four_and_closes_when_one_is_chosen(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30)); fpage.uncheck("#focusOn"); settle(fpage)
    assert fpage.locator("#layoutMenu").evaluate("(el) => el.open") is False
    assert not fpage.is_visible("#btnSpread") and not fpage.is_visible("#btnRelayout"), "closed: no row of buttons in the bar"
    fpage.click("#layoutMenu summary")
    for item in ("#btnRelayout", "#btnSpread", "#btnTighten", "#btnDeclutter"):
        assert fpage.is_visible(item), item
    text = fpage.inner_text("#layoutBody")
    assert "Re-layout" in text and "Spread" in text and "Tighten" in text and "Declutter" in text
    fpage.click("#btnSpread"); settle(fpage)
    assert fpage.locator("#layoutMenu").evaluate("(el) => el.open") is False, "choosing one closes the menu"
