"""Finding a vertex in a crowded graph: what a click on a finding selects pulses for a few seconds, in a colour and a size that stand out."""
import pytest

from chains import addr, consolidation, tid
from helpers import click_node, idle, open_query, settle, xy


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def beacon(page):
    return page.evaluate("() => { const b = window.__hopline.renderer.beacon; return b ? { ids: [...b.ids], ms: b.ms } : null; }")


def yellow_pixels(page, node_id):
    """Pixels of a warm yellow (the pulse's glow and ring) in a square around a vertex; the vertices there are blue, the wallets a darker orange, so the pulse adds a lot."""
    return page.evaluate("""(id) => { const r = window.__hopline.renderer, p = r.positionOf(id), v = r.view, c = r.canvas, dpr = r.dpr;
        const x = Math.round((p.x * v.k + v.x) * dpr), y = Math.round((p.y * v.k + v.y) * dpr), half = Math.round(60 * dpr);
        const x0 = Math.max(0, x - half), y0 = Math.max(0, y - half), w = Math.min(c.width - x0, 2 * half), h = Math.min(c.height - y0, 2 * half);
        const d = c.getContext('2d').getImageData(x0, y0, w, h).data; let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 110 && d[i + 1] > 90 && d[i] - d[i + 2] > 30) n++;
        return n; }""", node_id)


def redraw(page):
    page.evaluate("() => { const r = window.__hopline.renderer; r.draw(); }")


def test_a_row_of_the_detections_list_makes_its_vertex_pulse(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30)); settle(fpage)
    fpage.evaluate("() => window.__hopline.setSel([])"); settle(fpage)
    assert beacon(fpage) is None
    fpage.click("#detList .detrow >> nth=0"); settle(fpage)
    b = beacon(fpage)
    assert b and b["ids"] == ["tx:" + tid(30)] and b["ms"] >= 3000


def test_a_chip_makes_everything_it_selects_pulse(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30)); settle(fpage)
    fpage.click("#findStrip [data-key=clusters]"); settle(fpage)
    b = beacon(fpage)
    assert b and sorted(b["ids"]) == sorted("addr:" + addr("k%d" % i) for i in range(6))


def test_the_pulse_is_drawn_in_a_colour_nothing_else_uses_and_goes_away(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30)); settle(fpage)
    node = "tx:" + tid(30)
    fpage.evaluate("() => window.__hopline.setSel([])"); settle(fpage)
    fpage.wait_for_timeout(100); redraw(fpage)
    quiet = yellow_pixels(fpage, node)
    fpage.evaluate("(id) => window.__hopline.renderer.pulse([id], 1500)", node)
    fpage.wait_for_timeout(500); redraw(fpage)                                      # it has eased in
    loud = yellow_pixels(fpage, node)
    assert loud > quiet + 150, (quiet, loud)
    fpage.wait_for_function("() => window.__hopline.renderer.beacon === null", timeout=5000)
    fpage.wait_for_timeout(100); redraw(fpage)
    assert yellow_pixels(fpage, node) <= quiet + 5, "and it is gone when its time is up"


def test_it_breathes_the_canvas_is_redrawn_while_it_lasts_and_rests_afterwards(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30)); settle(fpage)
    fpage.evaluate("""() => { const r = window.__hopline.renderer, orig = r.draw.bind(r); window.__draws = 0; r.draw = function () { window.__draws++; return orig(); }; }""")
    fpage.evaluate("(id) => window.__hopline.renderer.pulse([id], 1500)", "tx:" + tid(30))
    fpage.wait_for_timeout(600)
    assert fpage.evaluate("() => window.__draws") >= 8, "a frame at a time"
    fpage.wait_for_function("() => window.__hopline.renderer.beacon === null", timeout=5000)
    fpage.wait_for_timeout(200)
    before = fpage.evaluate("() => window.__draws"); fpage.wait_for_timeout(400)
    assert fpage.evaluate("() => window.__draws") == before, "nothing keeps drawing once it is over"


def test_with_reduce_motion_set_it_stands_still(ctx, fpage, mock):
    fpage.emulate_media(reduced_motion="reduce")
    consolidation(mock)
    open_query(fpage, tid(30)); settle(fpage)
    node = "tx:" + tid(30)
    fpage.evaluate("() => window.__hopline.setSel([])"); settle(fpage); redraw(fpage)
    quiet = yellow_pixels(fpage, node)
    fpage.evaluate("""() => { const r = window.__hopline.renderer, orig = r.draw.bind(r); window.__draws = 0; r.draw = function () { window.__draws++; return orig(); }; }""")
    fpage.evaluate("(id) => window.__hopline.renderer.pulse([id], 1500)", node)
    fpage.wait_for_timeout(300)
    assert fpage.evaluate("() => window.__draws") <= 3, "no frame-by-frame animation"
    redraw(fpage)
    assert yellow_pixels(fpage, node) > quiet + 40, (quiet, yellow_pixels(fpage, node))
    fpage.wait_for_function("() => window.__hopline.renderer.beacon === null", timeout=5000)


def test_a_new_pulse_replaces_the_last_and_none_clears_it(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30)); settle(fpage)
    fpage.evaluate("(id) => window.__hopline.renderer.pulse([id])", "tx:" + tid(30))
    fpage.evaluate("(id) => window.__hopline.renderer.pulse([id])", "addr:" + addr("k0"))
    assert beacon(fpage)["ids"] == ["addr:" + addr("k0")]
    fpage.evaluate("() => window.__hopline.renderer.pulse([])")
    assert beacon(fpage) is None


def test_a_vertex_that_is_off_screen_or_hidden_draws_nothing_and_breaks_nothing(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30)); settle(fpage)
    fpage.evaluate("() => window.__hopline.renderer.pulse(['tx:nothing-like-this', 'addr:no'])")
    fpage.wait_for_timeout(200)
    assert beacon(fpage) is not None


def test_a_find_result_pulses_too(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30)); settle(fpage)
    fpage.evaluate("() => window.__hopline.setSel([])"); settle(fpage)
    fpage.evaluate("(id) => { window.__hopline.renderer.pulse([]); }", "tx:" + tid(30))
    fpage.evaluate("() => { document.getElementById('findQ').value = ''; }")
    fpage.click("#btnFind") if fpage.locator("#btnFind").count() else fpage.keyboard.press("Control+f")
    fpage.fill("#findQ", tid(30)[:8]); fpage.keyboard.press("Enter")
    fpage.wait_for_function("() => window.__hopline.renderer.beacon && window.__hopline.renderer.beacon.ids.includes('tx:' + '%s')" % tid(30), timeout=10000)
