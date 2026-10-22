"""The time bar: it folds away like the side panels, has a time scale, and shows exact times when you hover its dots."""
from datetime import datetime, timezone

import pytest

from conftest import NORMAL
from helpers import click_node, idle, open_query, set_slider, settle, toast_text


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def utc(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def box(page, sel):
    return page.locator(sel).bounding_box()


def hist_origin(page):
    b = box(page, "#hist")
    return b["x"], b["y"]


def dots(page):
    """Every transaction on the time line with the x it is drawn at (relative to the canvas) and its exact time."""
    return page.evaluate("""() => { const o = window.__hopline, w = o.state.tbGeom.w;
      return o.state.tbTxs.map(t => ({ id: t.id, time: t.time, loaded: t.loaded, x: o.timeX(t.time, w) })); }""")


def open_with_timeline(fpage):
    open_query(fpage, NORMAL["txid"])
    idle(fpage); settle(fpage)
    assert len(dots(fpage)) >= 2, "the neighbouring transactions give the time line a span"


def hover_dot(page, d):
    ox, oy = hist_origin(page)
    page.mouse.move(ox + d["x"], oy + 40)
    page.wait_for_function("() => !document.getElementById('tooltip').hidden")
    return page.inner_text("#tooltip")


def lone_dots(page):
    ds = dots(page)
    return [d for d in ds if all(o is d or abs(o["x"] - d["x"]) > 16 for o in ds)]


def drawn_on_hist(page):
    """The text drawn on the time line's canvas (a spy on fillText for one redraw)."""
    return page.evaluate("""() => { const seen = [], orig = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (t) { if (this.canvas.id === 'hist') seen.push(String(t)); return orig.apply(this, arguments); };
      try { window.__hopline.drawHistogram(); } finally { CanvasRenderingContext2D.prototype.fillText = orig; }
      return seen; }""")


# ---------------------------------------------------------------- folding away
def test_the_time_bar_folds_away_gives_the_room_to_the_graph_and_comes_back(fpage):
    open_with_timeline(fpage)
    full = box(fpage, "#cv")["height"]
    assert fpage.get_attribute("#tbCollapse", "aria-expanded") == "true" and fpage.is_visible("#hist")
    fpage.click("#tbCollapse")
    fpage.wait_for_function("(h) => document.getElementById('cv').getBoundingClientRect().height > h + 60", arg=full)
    idle(fpage); settle(fpage)
    assert fpage.evaluate("() => document.body.classList.contains('tb-collapsed')")
    assert fpage.get_attribute("#tbCollapse", "aria-expanded") == "false"
    assert fpage.is_hidden("#hist") and fpage.is_visible("#tbPlay"), "the slider body folds, the title row with the range and Replay stays"
    assert box(fpage, "#timebar")["height"] < 60
    assert fpage.evaluate("""() => { const r = window.__hopline.renderer, b = r.canvas.getBoundingClientRect();
        return [...r.data.visible.nodes].every(id => { const p = r.positionOf(id), y = b.top + p.y * r.view.k + r.view.y; return y > b.top && y < b.bottom; }); }"""), "the graph was refitted to the taller canvas"
    bar_top, step_bottom = box(fpage, "#timebar")["y"], box(fpage, "#stepbar")["y"] + box(fpage, "#stepbar")["height"]
    assert step_bottom <= bar_top, "the Previous / Next bar moved down with it, it does not sit on the time bar"
    fpage.click("#tbCollapse")
    fpage.wait_for_function("(h) => Math.abs(document.getElementById('cv').getBoundingClientRect().height - h) < 2", arg=full)
    assert fpage.is_visible("#hist") and fpage.get_attribute("#tbCollapse", "aria-expanded") == "true"
    fpage.wait_for_function("() => window.__hopline.state.tbGeom && window.__hopline.state.tbGeom.w > 100")


def test_t_key_toggles_it_and_the_choice_is_remembered(fpage):
    open_with_timeline(fpage)
    fpage.locator("#cv").focus()
    fpage.keyboard.press("t")
    assert fpage.evaluate("() => document.body.classList.contains('tb-collapsed')")
    assert fpage.evaluate("() => JSON.parse(localStorage.getItem('hopline.prefs.v1')).tbCollapsed") is True
    fpage.reload(); fpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert fpage.evaluate("() => document.body.classList.contains('tb-collapsed')") and fpage.is_hidden("#hist")
    fpage.locator("#cv").focus()
    fpage.keyboard.press("t")
    assert fpage.is_visible("#hist")
    assert fpage.evaluate("() => JSON.parse(localStorage.getItem('hopline.prefs.v1')).tbCollapsed") is False


def test_t_is_ignored_while_typing_in_a_box(fpage):
    fpage.click("#q"); fpage.keyboard.type("tt")
    assert fpage.input_value("#q") == "tt" and not fpage.evaluate("() => document.body.classList.contains('tb-collapsed')")


def test_a_hover_tooltip_does_not_outlive_folding_the_bar(fpage):
    open_with_timeline(fpage)
    hover_dot(fpage, dots(fpage)[0])
    fpage.click("#tbCollapse")
    assert fpage.is_hidden("#tooltip")


# ---------------------------------------------------------------- the scale
def test_the_time_line_has_a_scale_with_dates(fpage):
    open_with_timeline(fpage)
    texts = drawn_on_hist(fpage)
    assert len(texts) >= 2, texts
    assert all(len(t) >= 4 for t in texts) and any(t[:2] == "20" for t in texts), "calendar labels such as 2022-06: %s" % texts
    span = fpage.evaluate("() => { const b = window.__hopline.state.tb; return [b.min, b.max]; }")
    assert any(utc(span[0])[:4] in t or utc(span[1])[:4] in t for t in texts), "the labels belong to the years the graph spans"


def test_the_time_line_is_drawn_and_a_hover_guide_does_not_disturb_the_scale(fpage):
    open_with_timeline(fpage)
    plain = drawn_on_hist(fpage)
    fpage.evaluate("() => { window.__hopline.state.tbHover = { x: 60 }; }")
    assert drawn_on_hist(fpage) == plain
    fpage.evaluate("() => { window.__hopline.state.tbHover = null; }")


# ---------------------------------------------------------------- hovering the dots
def test_hovering_a_dot_shows_its_exact_timestamp_with_seconds(fpage):
    open_with_timeline(fpage)
    ds = lone_dots(fpage)
    assert ds, "at least one dot that is clear of the others"
    for d in ds:
        tip = hover_dot(fpage, d)
        assert utc(d["time"]) in tip, "%s not in %r" % (utc(d["time"]), tip)
        assert d["id"][3:11] in tip, "the transaction id is named"
        if d["loaded"]:
            assert "BTC" in tip and "Value" in tip
        else:
            assert "Not loaded" in tip
        assert "Click to select" in tip


def test_hovering_between_dots_shows_the_time_under_the_pointer(fpage):
    open_with_timeline(fpage)
    ds = dots(fpage)
    gap = max(range(len(ds) - 1), key=lambda i: ds[i + 1]["x"] - ds[i]["x"])
    x = (ds[gap]["x"] + ds[gap + 1]["x"]) / 2
    ox, oy = hist_origin(fpage)
    fpage.mouse.move(ox + x, oy + 20)
    fpage.wait_for_function("() => !document.getElementById('tooltip').hidden")
    tip = fpage.inner_text("#tooltip")
    assert "No transactions here" in tip
    stamp = tip.split("Time")[1].split("UTC")[0].strip()
    t = datetime.strptime(stamp, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).timestamp()
    assert ds[gap]["time"] < t < ds[gap + 1]["time"], "the time shown lies between its neighbours: %s" % stamp
    fpage.mouse.move(700, 300)
    assert fpage.is_hidden("#tooltip"), "gone when the pointer leaves the time line"


def test_the_tooltip_stays_inside_the_window_at_both_ends(fpage):
    open_with_timeline(fpage)
    ox, oy = hist_origin(fpage)
    w = box(fpage, "#hist")["width"]
    for x in (4, w - 4):
        fpage.mouse.move(ox + x, oy + 20)
        fpage.wait_for_function("() => !document.getElementById('tooltip').hidden")
        tb = box(fpage, "#tooltip")
        assert tb["x"] >= 0 and tb["x"] + tb["width"] <= 1400 and tb["y"] >= 0


# ---------------------------------------------------------------- clicking
def test_clicking_a_dot_selects_that_transaction(fpage):
    open_with_timeline(fpage)
    d = lone_dots(fpage)[-1]
    ox, oy = hist_origin(fpage)
    fpage.mouse.click(ox + d["x"], oy + 40); settle(fpage)
    assert fpage.evaluate("() => [...window.__hopline.state.selected]") == [d["id"]]
    assert d["id"][3:8] in fpage.inner_text("#inspBody")


def test_dots_drawn_on_top_of_each_other_are_one_spot_that_lists_and_selects_them_all(fpage):
    open_with_timeline(fpage)
    every = dots(fpage)
    stack = [d for d in every if d["x"] == every[0]["x"]]
    assert len(stack) == 2, "the transaction and the one that spent it are in the same block, so at the same time"
    ox, oy = hist_origin(fpage)
    tip = hover_dot(fpage, stack[0])
    assert "2 transactions here" in tip and utc(stack[0]["time"]) in tip
    assert all(d["id"][3:9] in tip for d in stack), tip
    fpage.mouse.click(ox + stack[0]["x"], oy + 40); settle(fpage)
    assert set(fpage.evaluate("() => [...window.__hopline.state.selected]")) == {d["id"] for d in stack}


def test_clicking_where_nothing_happened_selects_nothing(fpage):
    open_with_timeline(fpage)
    click_node(fpage, "tx:" + NORMAL["txid"]); settle(fpage)
    before = fpage.evaluate("() => [...window.__hopline.state.selected]")
    ds = dots(fpage)
    gap = max(range(len(ds) - 1), key=lambda i: ds[i + 1]["x"] - ds[i]["x"])
    ox, oy = hist_origin(fpage)
    fpage.mouse.click(ox + (ds[gap]["x"] + ds[gap + 1]["x"]) / 2, oy + 20); settle(fpage)
    assert fpage.evaluate("() => [...window.__hopline.state.selected]") == before


def test_a_dot_outside_the_chosen_window_says_so_instead_of_selecting(fpage):
    open_with_timeline(fpage)
    click_node(fpage, "tx:" + NORMAL["txid"]); settle(fpage)
    before = fpage.evaluate("() => [...window.__hopline.state.selected]")
    set_slider(fpage, "#tTo", 10); idle(fpage); settle(fpage)
    late = [d for d in dots(fpage) if d["time"] > fpage.evaluate("() => window.__hopline.state.filter.timeTo")]
    assert late, "a transaction lies after the window"
    ox, oy = hist_origin(fpage)
    fpage.mouse.click(ox + late[-1]["x"], oy + 40); settle(fpage)
    assert "not on screen" in toast_text(fpage)
    assert fpage.evaluate("() => [...window.__hopline.state.selected]") == before
