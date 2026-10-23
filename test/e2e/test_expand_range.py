"""A range dragged on the time line that only the arrows follow: nothing is hidden, the arrows and their lists reach just that stretch of time."""
import json
import re

import pytest

from chains import tid
from conftest import ADDRESS
from helpers import idle, open_query, settle
from test_more_history import history
from test_trace import click_handle, shown

W = ADDRESS
W_ID = "addr:" + W
BASE = 1650000000


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def hist_box(page):
    return page.evaluate("() => { const r = document.getElementById('hist').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }")


def drag(page, f0, f1):
    """Drag across the time line from f0 to f1 (fractions of its width)."""
    b = hist_box(page)
    y = b["y"] + b["h"] / 2
    page.mouse.move(b["x"] + b["w"] * f0, y); page.mouse.down()
    page.mouse.move(b["x"] + b["w"] * (f0 + f1) / 2, y, steps=4)
    page.mouse.move(b["x"] + b["w"] * f1, y, steps=4); page.mouse.up()
    settle(page)


def rng(page):
    return page.evaluate("() => window.__hopline.state.expandRange")


def left_tip(page):
    return page.evaluate("(id) => { const h = window.__hopline.renderer.handleRects.find((x) => x.id === id && x.dir === 'left'); return h ? h.tip : null; }", W_ID)


def known_on_left(page):
    m = re.search(r"Show (\d+) ", left_tip(page) or "")
    return int(m.group(1)) if m else 0


def opened(tpage, mock, n=25):
    """The wallet with its oldest and newest payment shown: the time line spans them, and the 23 in between are still hidden behind the arrow."""
    history(mock, n)
    open_query(tpage, W); settle(tpage)
    ends = {"tx:" + tid(200), "tx:" + tid(176)}
    tpage.evaluate("([id, ends]) => window.__hopline.traceExpand(id, 'prev', { only: new Set(ends) })", [W_ID, sorted(ends)]); idle(tpage); settle(tpage)
    assert tpage.is_enabled("#tFrom"), "the time line is on"


def times():
    """When the hidden payments happened."""
    return [BASE + k * 600 for k in range(177, 200)]


def test_dragging_across_the_time_line_sets_a_range_and_shows_it(tpage, mock):
    opened(tpage, mock)
    assert rng(tpage) is None and not tpage.is_visible("#expandChip")
    drag(tpage, 0.25, 0.60)
    r = rng(tpage)
    tb = tpage.evaluate("() => window.__hopline.state.tb")
    assert r and tb["min"] <= r["from"] < r["to"] <= tb["max"]
    assert abs((r["from"] - tb["min"]) / (tb["max"] - tb["min"]) - 0.25) < 0.03 and abs((r["to"] - tb["min"]) / (tb["max"] - tb["min"]) - 0.60) < 0.03
    assert tpage.is_visible("#expandChip") and "Arrows reach" in tpage.inner_text("#expandChip") and "→" in tpage.inner_text("#expandChip")


def test_it_hides_nothing_the_time_bars_own_window_is_untouched(tpage, mock):
    opened(tpage, mock)
    before = shown(tpage)
    drag(tpage, 0.25, 0.60)
    assert shown(tpage) == before
    f = tpage.evaluate("() => window.__hopline.state.filter")
    assert f["timeFrom"] is None and f["timeTo"] is None
    assert tpage.input_value("#tFrom") == "0" and tpage.input_value("#tTo") == "1000", "the sliders did not move"


def test_the_arrows_reach_only_that_stretch_of_time(tpage, mock):
    opened(tpage, mock)
    assert known_on_left(tpage) == 23
    drag(tpage, 0.25, 0.60)
    r = rng(tpage)
    inside = [t for t in times() if r["from"] <= t <= r["to"]]
    assert 0 < len(inside) < 23
    assert known_on_left(tpage) == len(inside), (known_on_left(tpage), len(inside))
    assert "fall outside the range you drew on the time line" in left_tip(tpage)


def test_a_click_on_the_arrow_shows_only_what_is_in_the_range(tpage, mock):
    opened(tpage, mock)
    tpage.evaluate("() => { window.__hopline.state.stepMode = 'all'; }")
    drag(tpage, 0.25, 0.60)
    r = rng(tpage)
    inside = [t for t in times() if r["from"] <= t <= r["to"]]
    click_handle(tpage, W_ID, "left"); idle(tpage); settle(tpage)
    new = [s for s in shown(tpage) if s.startswith("tx:")]
    assert len(new) == len(inside) + 2, "the two shown before and one transaction per payment inside the range"


def test_it_beats_the_preference_that_ties_the_arrows_to_the_time_bar(tpage, mock):
    opened(tpage, mock)
    tpage.evaluate("() => { const c = document.getElementById('arrowsInRange'); c.checked = false; c.dispatchEvent(new Event('change')); }"); settle(tpage)
    assert known_on_left(tpage) == 23, "with the preference off the arrows ignore the time bar"
    drag(tpage, 0.25, 0.60)
    assert known_on_left(tpage) < 23, "a range drawn on purpose still applies"


def test_the_chip_clears_it_and_so_does_reset(tpage, mock):
    opened(tpage, mock)
    drag(tpage, 0.25, 0.60)
    tpage.click("#expandChipClear"); settle(tpage)
    assert rng(tpage) is None and not tpage.is_visible("#expandChip") and known_on_left(tpage) == 23
    drag(tpage, 0.25, 0.60)
    assert rng(tpage)
    tpage.click("#tbReset"); settle(tpage)
    assert rng(tpage) is None and not tpage.is_visible("#expandChip")


def test_a_plain_click_still_selects_and_a_wobble_is_not_a_range(tpage, mock):
    opened(tpage, mock)
    tpage.evaluate("() => window.__hopline.setSel([])"); settle(tpage)
    b = hist_box(tpage)
    on_dot = tpage.evaluate("() => { const t = window.__hopline.state.tbTxs[0]; return window.__hopline.timeX(t.time, document.getElementById('hist').clientWidth); }")
    tpage.mouse.click(b["x"] + on_dot, b["y"] + b["h"] - 20)
    settle(tpage)
    assert rng(tpage) is None
    b = hist_box(tpage)
    tpage.mouse.move(b["x"] + 100, b["y"] + 20); tpage.mouse.down(); tpage.mouse.move(b["x"] + 103, b["y"] + 20); tpage.mouse.up(); settle(tpage)
    assert rng(tpage) is None, "three pixels is not a range"


def test_a_drag_that_ends_with_a_click_does_not_select_what_it_ended_on(tpage, mock):
    opened(tpage, mock)
    tpage.evaluate("() => window.__hopline.setSel([])"); settle(tpage)
    drag(tpage, 0.30, 0.55)
    assert tpage.evaluate("() => window.__hopline.state.selected.size") == 0


def test_dragging_backwards_works_and_it_keeps_inside_the_line(tpage, mock):
    opened(tpage, mock)
    drag(tpage, 0.7, 0.3)
    r = rng(tpage)
    assert r and r["from"] < r["to"]
    tpage.click("#expandChipClear"); settle(tpage)
    b = hist_box(tpage); y = b["y"] + b["h"] / 2
    tpage.mouse.move(b["x"] + b["w"] * 0.5, y); tpage.mouse.down(); tpage.mouse.move(b["x"] + b["w"] + 200, y, steps=5); tpage.mouse.up(); settle(tpage)
    tb = tpage.evaluate("() => window.__hopline.state.tb")
    r = rng(tpage)
    assert r and r["to"] == tb["max"], "dragged past the end: it stops at the end"


def test_a_range_with_nothing_in_it_says_so_when_the_arrow_is_clicked(tpage, mock):
    opened(tpage, mock)
    tpage.evaluate("() => { window.__hopline.state.stepMode = 'all'; }")
    drag(tpage, 0.97, 1.0)                                                                  # the very end of the line: the newest payment is shown, the hidden ones are all earlier
    r = rng(tpage)
    assert r and not [t for t in times() if r["from"] <= t <= r["to"]]
    assert known_on_left(tpage) == 0 and "Nothing inside the range you drew on the time line" in left_tip(tpage) and "23 more fall outside" in left_tip(tpage)
    click_handle(tpage, W_ID, "left"); settle(tpage)
    assert "Nothing inside the range you drew on the time line" in tpage.inner_text("#toast")


def test_the_range_is_not_available_outside_the_trace_layout(fpage, mock):
    history(mock)
    open_query(fpage, W); settle(fpage)
    drag(fpage, 0.25, 0.60)
    assert rng(fpage) is None and not fpage.is_visible("#expandChip")


def test_the_range_travels_with_the_saved_workspace(tpage, mock, tmp_path):
    opened(tpage, mock)
    drag(tpage, 0.25, 0.60)
    r = rng(tpage)
    tpage.evaluate("() => { document.getElementById('exportMenu').open = true; }")
    with tpage.expect_download() as dl:
        tpage.click("[data-export=json]")
    p = tmp_path / "ws.json"; dl.value.save_as(p)
    saved = json.loads(p.read_text(encoding="utf-8"))
    assert saved["view"]["expandRange"] == r
    tpage.click("#btnClear"); tpage.click("#btnClear"); settle(tpage)
    assert rng(tpage) is None and not tpage.is_visible("#expandChip"), "an emptied workspace has no range"
    tpage.set_input_files("#fileImport", str(p))
    tpage.wait_for_function("() => window.__hopline.state.expandRange !== null")
    assert rng(tpage) == r and tpage.is_visible("#expandChip")
