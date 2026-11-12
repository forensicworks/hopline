"""Fingers on the workspace canvas: two pinch to zoom and pan together, one pans or carries a vertex, a finger left behind does nothing.
Firefox cannot make real touches here, so the pointer events a touch screen sends are made by the test (pointerType touch, as the wallet chart's tests do)."""
import pytest

from conftest import NORMAL
from helpers import idle, open_query, selected, settle, xy

START = "tx:" + NORMAL["txid"]


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def finger(page, kind, pid, x, y):
    """A touch pointer event on the canvas, (x, y) in the canvas's own pixels."""
    page.evaluate("""([kind, pid, x, y]) => { const cv = document.getElementById('cv'), r = cv.getBoundingClientRect();
                                              cv.dispatchEvent(new PointerEvent(kind, { pointerId: pid, pointerType: 'touch', isPrimary: pid === 1, button: 0, buttons: kind === 'pointerup' ? 0 : 1,
                                                  bubbles: true, cancelable: true, clientX: r.left + x, clientY: r.top + y })); }""", [kind, pid, x, y])


def view(page):
    return page.evaluate("() => { const v = window.__hopline.renderer.view; return { x: v.x, y: v.y, k: v.k }; }")


def size(page):
    return page.evaluate("() => { const r = window.__hopline.renderer; return { w: r.w, h: r.h }; }")


def where_on_canvas(page, node_id):
    """A vertex's place in the canvas's own pixels."""
    return page.evaluate("(id) => { const r = window.__hopline.renderer, p = r.positionOf(id), v = r.view; return { x: p.x * v.k + v.x, y: p.y * v.k + v.y }; }", node_id)


@pytest.fixture
def canvas(tpage):
    open_query(tpage, NORMAL["txid"]); settle(tpage)
    tpage.evaluate("() => window.__hopline.setSel([])")                                  # opening a transaction selects it: the tests look at what a finger selects
    assert selected(tpage) == []
    return tpage


def test_fingers_moving_apart_zoom_in_about_the_point_between_them(canvas):
    s = size(canvas); mx, my = s["w"] / 2, s["h"] / 2
    v0 = view(canvas)
    world = ((mx - v0["x"]) / v0["k"], (my - v0["y"]) / v0["k"])                 # the point of the graph between the fingers
    finger(canvas, "pointerdown", 1, mx - 40, my); finger(canvas, "pointerdown", 2, mx + 40, my)
    finger(canvas, "pointermove", 1, mx - 80, my); finger(canvas, "pointermove", 2, mx + 80, my)
    v1 = view(canvas)
    assert v1["k"] == pytest.approx(v0["k"] * 2, rel=1e-6), "twice as far apart: twice as large"
    assert world[0] * v1["k"] + v1["x"] == pytest.approx(mx, abs=0.5) and world[1] * v1["k"] + v1["y"] == pytest.approx(my, abs=0.5), "the point between the fingers has not moved"
    finger(canvas, "pointerup", 1, mx - 80, my); finger(canvas, "pointerup", 2, mx + 80, my)


def test_fingers_moving_together_zoom_out(canvas):
    s = size(canvas); mx, my = s["w"] / 2, s["h"] / 2
    v0 = view(canvas)
    finger(canvas, "pointerdown", 1, mx - 100, my); finger(canvas, "pointerdown", 2, mx + 100, my)
    finger(canvas, "pointermove", 1, mx - 50, my); finger(canvas, "pointermove", 2, mx + 50, my)
    assert view(canvas)["k"] == pytest.approx(v0["k"] / 2, rel=1e-6)
    finger(canvas, "pointerup", 1, mx - 50, my); finger(canvas, "pointerup", 2, mx + 50, my)


def test_two_fingers_moving_the_same_way_pan_without_zooming(canvas):
    s = size(canvas); mx, my = s["w"] / 2, s["h"] / 2
    v0 = view(canvas)
    finger(canvas, "pointerdown", 1, mx - 50, my); finger(canvas, "pointerdown", 2, mx + 50, my)
    finger(canvas, "pointermove", 1, mx - 50 + 60, my + 40); finger(canvas, "pointermove", 2, mx + 50 + 60, my + 40)
    v1 = view(canvas)
    assert v1["k"] == pytest.approx(v0["k"], rel=1e-9) and v1["x"] == pytest.approx(v0["x"] + 60, abs=1e-6) and v1["y"] == pytest.approx(v0["y"] + 40, abs=1e-6)
    finger(canvas, "pointerup", 1, mx + 10, my + 40); finger(canvas, "pointerup", 2, mx + 110, my + 40)


def test_one_finger_zooming_and_panning_in_the_same_gesture_work_together(canvas):
    s = size(canvas); mx, my = s["w"] / 2, s["h"] / 2
    v0 = view(canvas)
    world = ((mx - v0["x"]) / v0["k"], (my - v0["y"]) / v0["k"])
    finger(canvas, "pointerdown", 1, mx - 50, my); finger(canvas, "pointerdown", 2, mx + 50, my)
    finger(canvas, "pointermove", 1, mx - 100 + 30, my + 20); finger(canvas, "pointermove", 2, mx + 100 + 30, my + 20)       # twice as far apart and the middle moved by (30, 20)
    v1 = view(canvas)
    assert v1["k"] == pytest.approx(v0["k"] * 2, rel=1e-6)
    assert world[0] * v1["k"] + v1["x"] == pytest.approx(mx + 30, abs=0.5) and world[1] * v1["k"] + v1["y"] == pytest.approx(my + 20, abs=0.5), "the point that was between the fingers goes with them"
    finger(canvas, "pointerup", 1, mx - 70, my + 20); finger(canvas, "pointerup", 2, mx + 130, my + 20)


def test_the_zoom_stops_at_the_limits_and_the_view_stays_finite(canvas):
    s = size(canvas); mx, my = s["w"] / 2, s["h"] / 2
    finger(canvas, "pointerdown", 1, mx - 1, my); finger(canvas, "pointerdown", 2, mx + 1, my)
    finger(canvas, "pointermove", 1, mx - 400, my); finger(canvas, "pointermove", 2, mx + 400, my)
    assert view(canvas)["k"] == pytest.approx(6)
    finger(canvas, "pointermove", 1, mx, my); finger(canvas, "pointermove", 2, mx, my)                                  # both fingers on the same point
    v = view(canvas)
    assert v["k"] >= 0.03 and all(abs(v[a]) < 1e7 for a in "xy"), v
    finger(canvas, "pointerup", 1, mx, my); finger(canvas, "pointerup", 2, mx, my)


def test_a_tap_that_becomes_a_pinch_selects_nothing_but_a_plain_tap_does(canvas):
    p = where_on_canvas(canvas, START)
    finger(canvas, "pointerdown", 1, p["x"], p["y"]); finger(canvas, "pointerdown", 2, p["x"] + 120, p["y"])
    finger(canvas, "pointermove", 2, p["x"] + 200, p["y"])
    finger(canvas, "pointerup", 2, p["x"] + 200, p["y"]); finger(canvas, "pointerup", 1, p["x"], p["y"])
    assert selected(canvas) == [], "two fingers are never a click"
    finger(canvas, "pointerdown", 1, p["x"], p["y"]); finger(canvas, "pointerup", 1, p["x"], p["y"])
    q = where_on_canvas(canvas, START)
    finger(canvas, "pointerdown", 1, q["x"], q["y"]); finger(canvas, "pointerup", 1, q["x"], q["y"])
    assert START in selected(canvas), "one finger still taps a vertex to select it"


def test_the_finger_that_stays_does_nothing_until_it_is_lifted(canvas):
    s = size(canvas); mx, my = s["w"] / 2, s["h"] / 2
    finger(canvas, "pointerdown", 1, mx - 50, my); finger(canvas, "pointerdown", 2, mx + 50, my)
    finger(canvas, "pointermove", 2, mx + 70, my)
    finger(canvas, "pointerup", 2, mx + 70, my)
    v = view(canvas)
    finger(canvas, "pointermove", 1, mx - 50 + 90, my + 60)
    assert view(canvas) == v, "the finger left on the canvas does not pan (the picture would jump)"
    finger(canvas, "pointerup", 1, mx + 40, my + 60)
    assert selected(canvas) == []
    # and a new pair of fingers works again
    finger(canvas, "pointerdown", 1, mx - 20, my); finger(canvas, "pointerdown", 2, mx + 20, my)
    finger(canvas, "pointermove", 2, mx + 60, my)
    assert view(canvas)["k"] > v["k"]
    finger(canvas, "pointerup", 2, mx + 60, my); finger(canvas, "pointerup", 1, mx - 20, my)


def test_a_third_finger_changes_nothing(canvas):
    s = size(canvas); mx, my = s["w"] / 2, s["h"] / 2
    finger(canvas, "pointerdown", 1, mx - 50, my); finger(canvas, "pointerdown", 2, mx + 50, my)
    finger(canvas, "pointerdown", 3, mx, my - 80)
    v = view(canvas)
    finger(canvas, "pointermove", 3, mx + 200, my - 150)
    assert view(canvas) == v
    finger(canvas, "pointerup", 3, mx + 200, my - 150)
    finger(canvas, "pointermove", 2, mx + 100, my)
    assert view(canvas)["k"] == pytest.approx(v["k"] * 150 / 100, rel=1e-6), "the pair is still pinching"
    finger(canvas, "pointerup", 1, mx - 50, my); finger(canvas, "pointerup", 2, mx + 100, my)


def test_a_vertex_being_carried_by_one_finger_stays_where_it_was_left_when_a_second_finger_comes(canvas):
    p = where_on_canvas(canvas, START)
    finger(canvas, "pointerdown", 1, p["x"], p["y"]); finger(canvas, "pointermove", 1, p["x"] + 30, p["y"] + 40)
    carried = where_on_canvas(canvas, START)
    assert abs(carried["x"] - p["x"] - 30) < 1.5 or abs(carried["y"] - p["y"] - 40) < 1.5, "the vertex went with the finger (its x may be locked to time)"
    finger(canvas, "pointerdown", 2, p["x"] + 150, p["y"])
    v = view(canvas)
    finger(canvas, "pointermove", 1, p["x"] + 80, p["y"] + 90)
    assert view(canvas)["x"] != v["x"] or view(canvas)["y"] != v["y"] or view(canvas)["k"] != v["k"], "the fingers now move the view"
    finger(canvas, "pointerup", 2, p["x"] + 150, p["y"]); finger(canvas, "pointerup", 1, p["x"] + 80, p["y"] + 90)
    assert selected(canvas) == []


def test_a_mouse_still_pans_by_dragging_the_background_and_zooms_with_the_wheel(canvas):
    s = size(canvas)
    box = canvas.evaluate("() => { const r = document.getElementById('cv').getBoundingClientRect(); return { x: r.left, y: r.top }; }")
    v0 = view(canvas)
    canvas.mouse.move(box["x"] + 60, box["y"] + s["h"] - 60); canvas.mouse.down(); canvas.mouse.move(box["x"] + 130, box["y"] + s["h"] - 20, steps=4); canvas.mouse.up()
    v1 = view(canvas)
    assert v1["k"] == v0["k"] and v1["x"] == pytest.approx(v0["x"] + 70, abs=1) and v1["y"] == pytest.approx(v0["y"] + 40, abs=1)
    canvas.mouse.move(box["x"] + s["w"] / 2, box["y"] + s["h"] / 2)
    canvas.mouse.wheel(0, -300)
    assert view(canvas)["k"] > v1["k"]
