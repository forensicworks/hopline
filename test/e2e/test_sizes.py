"""Shape size by value: proportional in the Force layout (and wherever asked), compact elsewhere, and the Force layout leaves room for it."""
import json

import pytest

from chains import peel_chain, tid
from helpers import idle, open_query, settle


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def chain(fpage, mock, length=6, hops=5):
    peel_chain(mock, length)
    open_query(fpage, tid(10))
    fpage.evaluate("(id) => window.__hopline.autoExpand(id, { dir: 'next', hops: %d, follow: 'all' })" % hops, "tx:" + tid(10)); idle(fpage); settle(fpage)


def layout(page, name):
    page.click("#layoutSeg [data-layout=%s]" % name); idle(page); settle(page)


def size_by(page, name):
    page.click("#sizeSeg [data-size=%s]" % name); idle(page); settle(page)


def sizes(page):
    """{id: (radius drawn, value it stands for)} for what is on screen."""
    return page.evaluate("""() => { const o = window.__hopline, g = o.state.graph, st = o.renderer.data.style, out = {};
        o.renderer.data.visible.nodes.forEach(id => { const n = g.nodes.get(id); out[id] = [st.nodeRadius(n), n.type === 'tx' ? n.valueOut : n.received]; }); return out; }""")


def legend(page):
    return page.inner_text("#legend").lower()


def test_auto_is_proportional_in_the_force_layout_and_compact_in_the_others(fpage, mock):
    chain(fpage, mock)
    assert fpage.get_attribute("#sizeSeg [data-size=auto]", "aria-checked") == "true"
    flow = sizes(fpage)
    assert max(r for r, _ in flow.values()) <= 16.01 and "compact scale" in legend(fpage)
    layout(fpage, "force")
    force = sizes(fpage)
    assert abs(max(r for r, _ in force.values()) - 20) < 0.5, "the largest shape takes the full radius"
    assert "area proportional" in legend(fpage)
    layout(fpage, "timeline")
    assert max(r for r, _ in sizes(fpage).values()) <= 16.01, "back to compact when the layout is not Force"


def test_the_radius_follows_the_square_root_of_the_value_so_the_area_follows_the_value(fpage, mock):
    chain(fpage, mock)
    layout(fpage, "force")
    valued = {i: rv for i, rv in sizes(fpage).items() if rv[1] is not None}           # (a transaction that is not loaded has no value)
    big = max(valued.values(), key=lambda rv: rv[1])
    assert abs(big[0] - 20) < 0.01
    for r, v in valued.values():
        if r > 4.01:
            assert abs(r - big[0] * (v / big[1]) ** 0.5) < 0.01, (r, v)           # radius ~ sqrt(value): area ~ value
    small = [rv for rv in valued.values() if rv[1] < 0.01 * big[1]]
    assert small and all(abs(r - 4) < 0.01 for r, _ in small), "tiny amounts stay visible as small dots"


def test_the_size_buttons_override_auto_and_are_remembered(fpage, mock):
    chain(fpage, mock)
    size_by(fpage, "area")
    assert abs(max(r for r, _ in sizes(fpage).values()) - 20) < 0.5, "proportional even in the flow layout"
    layout(fpage, "force")
    size_by(fpage, "log")
    assert max(r for r, _ in sizes(fpage).values()) <= 16.01 and "compact scale" in legend(fpage), "compact even in the force layout"
    size_by(fpage, "area")
    fpage.wait_for_timeout(1100)
    fpage.reload(); fpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    fpage.click("#restoreYes"); fpage.wait_for_function("() => window.__hopline.state.graph.nodes.size > 0"); settle(fpage)
    assert fpage.evaluate("() => window.__hopline.state.sizeBy") == "area"
    assert fpage.get_attribute("#sizeSeg [data-size=area]", "aria-checked") == "true"


def test_the_force_layout_leaves_room_for_the_shapes(fpage, mock):
    chain(fpage, mock)
    layout(fpage, "force")
    for mode in ("area", "log"):
        size_by(fpage, mode)
        pts = fpage.evaluate("""() => { const o = window.__hopline, g = o.state.graph, st = o.renderer.data.style, out = [];
            o.renderer.data.visible.nodes.forEach(id => { const p = o.renderer.positionOf(id); out.push([p.x, p.y, st.nodeRadius(g.nodes.get(id))]); }); return out; }""")
        for i, a in enumerate(pts):
            for b in pts[i + 1:]:
                assert ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5 >= a[2] + b[2] + 7, (mode, a, b)


def test_a_trace_arranged_by_force_gets_proportional_sizes_under_auto(fpage, mock):
    chain(fpage, mock, hops=3)
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    assert max(r for r, _ in sizes(fpage).values()) <= 16.01
    fpage.select_option("#traceArrange", "force"); idle(fpage); settle(fpage)
    assert "area proportional" in legend(fpage)
    fpage.select_option("#traceArrange", "columns"); idle(fpage); settle(fpage)
    assert "compact scale" in legend(fpage)


def test_the_size_choice_is_part_of_the_exported_view(fpage, mock, tmp_path):
    chain(fpage, mock, hops=2)
    size_by(fpage, "area")
    fpage.click("#exportMenu summary")
    with fpage.expect_download() as dl:
        fpage.click("[data-export=json]")
    p = tmp_path / "w.json"; dl.value.save_as(p)
    assert json.loads(p.read_text(encoding="utf-8"))["view"]["sizeBy"] == "area"
