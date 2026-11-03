"""The counts ("N vertices loaded · M shown") ride on the time bar's header row, not in the stack over the graph, so a large graph keeps its room."""
import re

import pytest

from chains import consolidation, tid
from helpers import open_query, settle


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def box(page, sel):
    return page.locator(sel).bounding_box()


def inside(inner, outer):
    return inner["x"] >= outer["x"] - 1 and inner["x"] + inner["width"] <= outer["x"] + outer["width"] + 1 and inner["y"] >= outer["y"] - 1 and inner["y"] + inner["height"] <= outer["y"] + outer["height"] + 1


def clear(a, b):
    return a["x"] + a["width"] <= b["x"] + 1 or b["x"] + b["width"] <= a["x"] + 1 or a["y"] + a["height"] <= b["y"] + 1 or b["y"] + b["height"] <= a["y"] + 1


def test_the_counts_are_on_the_time_bar_header_clear_of_its_buttons(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30)); settle(fpage)
    assert re.search(r"[\d,]+ vertices? loaded · [\d,]+ shown", fpage.inner_text("#hud")), fpage.inner_text("#hud")
    h, head, t = box(fpage, "#hud"), box(fpage, ".tb-head"), box(fpage, "#timebar")
    assert inside(h, t) and inside(h, head), "the counts are on the header row of the time bar"
    for other in ("#tbPlay", "#tbReset", "#tbCollapse", "#tbTo", "#tbInfo"):
        assert clear(h, box(fpage, other)), "the counts do not sit on %s" % other
    assert h["x"] > box(fpage, "#tbTo")["x"] and h["x"] + h["width"] <= box(fpage, "#tbPlay")["x"] + 1, "between the dates and the buttons"


def test_the_counts_are_still_there_when_the_time_line_is_folded_and_in_the_trace_layout(tpage, mock):
    consolidation(mock)
    open_query(tpage, tid(30)); settle(tpage)
    assert "Trace from" in tpage.inner_text("#hud")
    tpage.click("#tbCollapse"); settle(tpage)
    assert tpage.is_visible("#hud") and "Trace from" in tpage.inner_text("#hud")
    h, t = box(tpage, "#hud"), box(tpage, "#timebar")
    assert inside(h, t) and clear(h, box(tpage, "#tbPlay"))


def test_on_a_narrow_canvas_the_counts_stay_on_the_row_and_the_title_has_all_of_them(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30)); settle(fpage)
    fpage.set_viewport_size({"width": 760, "height": 850}); settle(fpage)
    head, h = box(fpage, ".tb-head"), box(fpage, "#hud")
    assert inside(h, head) and clear(h, box(fpage, "#tbPlay")), "the counts are cut, not pushed out of the row"
    assert fpage.evaluate("() => { const e = document.querySelector('.tb-head'); return e.scrollWidth <= e.clientWidth + 1; }"), "the header row does not overflow"
    assert "vertices loaded" in fpage.get_attribute("#hud", "title")


def test_the_hint_rides_after_the_counts_and_is_cut_before_they_are(tpage, mock):
    consolidation(mock)
    open_query(tpage, tid(30)); settle(tpage)
    assert tpage.locator("#hud #traceInfo").count() == 1 and tpage.inner_text("#traceInfo").strip()
    h, c, i = box(tpage, "#hud"), box(tpage, "#counts"), box(tpage, "#traceInfo")
    assert inside(c, h), "the counts are whole"
    assert i["x"] >= c["x"] + c["width"] - 1 and i["x"] < h["x"] + h["width"], "the hint comes after them and starts on the row"
