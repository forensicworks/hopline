"""The time axis along the top of the time-based views: a line with ticks and timestamps that also reads out exact times."""
import re

import pytest

from chains import IN, OUT, peel_chain, tid, tx
from helpers import idle, open_query, settle, xy

FULL = re.compile(r"^(≈ )?\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC( · shortened gap)?$")


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def drawn_texts(page):
    return page.evaluate("""() => { const r = window.__orion.renderer, ctx = r.ctx, orig = ctx.fillText.bind(ctx), seen = [];
        ctx.fillText = (t, ...a) => { seen.push(String(t)); return orig(t, ...a); }; r.draw(); ctx.fillText = orig; return seen; }""")


def readouts(page):
    return [t for t in drawn_texts(page) if FULL.match(t)]


def chain(fpage, mock, length=8, hops=6, late=True, trace=False):
    peel_chain(mock, length)
    if late:                                                                     # one transaction hours after the rest: a long gap
        tx(mock, 40, [IN(12, 0, "peel12", 1026)], [OUT("branchA", 600), OUT("branchB", 300)])
        mock.routes["/tx/" + tid(12) + "/outspends"] = [{"spent": True, "txid": tid(40), "vin": 0, "status": {"confirmed": True, "block_time": 1650000000 + 40 * 600}},
                                                        {"spent": True, "txid": tid(13), "vin": 0, "status": {"confirmed": True, "block_time": 1650000000 + 13 * 600}}]
    open_query(fpage, tid(10))
    if trace:
        fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    fpage.evaluate("(id) => window.__orion.autoExpand(id, { dir: 'next', hops: %d, follow: 'all' })" % hops, "tx:" + tid(10)); idle(fpage); settle(fpage)
    fpage.click("#inspClose"); settle(fpage)


def canvas_origin(page):
    b = page.locator("#cv").bounding_box()
    return b["x"], b["y"], b["width"], b["height"]


def axis_state(page):
    return page.evaluate("""() => { const r = window.__orion.renderer, a = r.data.axis, v = r.view;
        return { tMin: a.tMin, pps: a.pxPerSec, x0: a.x0 || 0, vx: v.x, k: v.k, mode: a.mode, breaks: a.breaks.map(b => [b.x0, b.x1, b.t0, b.t1]) }; }""")


def parse(text):
    from datetime import datetime, timezone
    m = re.search(r"(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) UTC", text)
    return datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).timestamp()


def test_the_timeline_layout_axis_is_a_line_with_ticks_and_timestamps(fpage, mock):
    chain(fpage, mock, late=False)
    fpage.click("#layoutSeg [data-layout=timeline]"); settle(fpage)
    texts = drawn_texts(fpage)
    assert sum(1 for t in texts if re.match(r"^\d{2}-\d{2} \d{2}:\d{2}$|^\d{4}-\d{2}-\d{2}", t)) >= 3, "timestamps along the line: %s" % texts
    ink = fpage.evaluate("""() => { const r = window.__orion.renderer, c = r.canvas, ctx = c.getContext('2d'), y = Math.floor(22 * r.dpr), row = ctx.getImageData(0, y, c.width, 1).data;
        let lit = 0; for (let i = 0; i < row.length; i += 4) if (row[i] > 0x50) lit++; return lit / (row.length / 4); }""")
    assert ink > 0.8, "the line runs the whole width of the canvas (%.2f of the row is lit)" % ink


def test_hovering_the_axis_reads_out_the_exact_time_under_the_pointer(fpage, mock):
    chain(fpage, mock, late=False)
    fpage.click("#layoutSeg [data-layout=timeline]"); settle(fpage)
    fpage.click("#scaleSeg [data-scale=proportional]"); settle(fpage)
    x0, y0, w, h = canvas_origin(fpage)
    assert readouts(fpage) == [], "nothing until the pointer is on the axis"
    for frac in (0.25, 0.5, 0.75):
        fpage.mouse.move(x0 + w * frac, y0 + 10)
        got = readouts(fpage)
        assert len(got) == 1 and "≈" not in got[0], got
        a = axis_state(fpage)
        want = a["tMin"] + ((w * frac - a["vx"]) / a["k"] - a["x0"]) / a["pps"]
        assert abs(parse(got[0]) - want) <= 1.5 / a["pps"] / a["k"] + 1, (got[0], want)      # (the pointer position is a whole number of pixels)
    fpage.mouse.move(x0 + w / 2, y0 + 300)
    assert readouts(fpage) == [], "gone when the pointer leaves the axis"


def test_hovering_a_transaction_writes_its_exact_time_on_the_axis(fpage, mock):
    chain(fpage, mock, late=False)
    fpage.click("#layoutSeg [data-layout=timeline]"); settle(fpage)
    p = xy(fpage, "tx:" + tid(12)); fpage.mouse.move(p["x"], p["y"])
    t = fpage.evaluate("(id) => window.__orion.state.graph.nodes.get(id).time", "tx:" + tid(12))
    got = readouts(fpage)
    assert len(got) == 1 and abs(parse(got[0]) - t) == 0, (got, t)
    tip = fpage.inner_text("#tooltip")
    assert re.search(r"\d{2}:\d{2}:\d{2} UTC", tip), "the tooltip gives the time to the second too: %s" % tip
    w = xy(fpage, "addr:" + "bc1q" + "c12".ljust(20, "x")); fpage.mouse.move(w["x"], w["y"])
    assert readouts(fpage) == [], "a wallet has no time of its own: nothing is written"


def test_inside_a_shortened_gap_the_readout_says_it_is_interpolated(fpage, mock):
    chain(fpage, mock)
    fpage.click("#layoutSeg [data-layout=timeline]"); settle(fpage)
    a = axis_state(fpage)
    assert a["mode"] == "compact" and a["breaks"], "the late transaction leaves a long gap that the compact scale shortens"
    x0, y0, w, h = canvas_origin(fpage)
    bx = (a["breaks"][0][0] + a["breaks"][0][1]) / 2
    fpage.mouse.move(x0 + bx * a["k"] + a["vx"], y0 + 10)
    got = readouts(fpage)
    assert len(got) == 1 and got[0].startswith("≈ ") and "shortened gap" in got[0], got
    outside = a["breaks"][0][0] - 40
    fpage.mouse.move(x0 + outside * a["k"] + a["vx"], y0 + 10)
    got = readouts(fpage)
    assert len(got) == 1 and "≈" not in got[0] and "shortened" not in got[0], got


def test_the_trace_arrangements_with_time_have_the_same_axis_and_the_others_have_none(fpage, mock):
    chain(fpage, mock, late=False, hops=4, trace=True)
    x0, y0, w, h = canvas_origin(fpage)
    for name in ("timeline", "timeforce", "timeamount"):
        fpage.select_option("#traceArrange", name); idle(fpage); settle(fpage)
        fpage.mouse.move(x0 + w / 2 + 3, y0 + 10)
        got = readouts(fpage)
        assert len(got) == 1, (name, got)
        p = xy(fpage, "tx:" + tid(11)); fpage.mouse.move(p["x"], p["y"])
        t = fpage.evaluate("(id) => window.__orion.state.graph.nodes.get(id).time", "tx:" + tid(11))
        assert [abs(parse(g) - t) for g in readouts(fpage)] == [0], name
    fpage.select_option("#traceArrange", "force"); idle(fpage); settle(fpage)
    fpage.mouse.move(x0 + w / 2, y0 + 10)
    assert readouts(fpage) == [], "Force has no time axis"


def test_a_stale_readout_does_not_survive_leaving_the_time_layout(fpage, mock):
    chain(fpage, mock, late=False)
    fpage.click("#layoutSeg [data-layout=timeline]"); settle(fpage)
    x0, y0, w, h = canvas_origin(fpage)
    fpage.mouse.move(x0 + w / 2, y0 + 10)
    assert len(readouts(fpage)) == 1
    fpage.click("#layoutSeg [data-layout=flow]"); settle(fpage)
    assert readouts(fpage) == []
    fpage.click("#layoutSeg [data-layout=timeline]"); settle(fpage)
    fpage.mouse.move(x0 + w / 2, y0 + 400)
    assert readouts(fpage) == [], "back in the time layout the old pointer position is not remembered"


# ---------------------------------------------------------------- Columns: timestamps over hand-placed transactions
def tx_marks(page):
    """{id: (screen x, time)} of the transactions on screen."""
    return page.evaluate("""() => { const r = window.__orion.renderer, b = r.canvas.getBoundingClientRect(), v = r.view, g = window.__orion.state.graph, out = {};
        r.data.visible.nodes.forEach(id => { const n = g.nodes.get(id); if (n.type === 'tx' && n.time != null) out[id] = [b.left + r.positionOf(id).x * v.k + v.x, n.time]; }); return out; }""")


def fmt_minute(t):
    from datetime import datetime, timezone
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d %H:%M")


def test_a_trace_in_columns_has_a_line_of_timestamps_over_its_transactions(fpage, mock):
    chain(fpage, mock, late=False, hops=4, trace=True)
    assert fpage.evaluate("() => window.__orion.renderer.data.axis.mode") == "marks" and fpage.is_hidden("#scaleRow")
    marks = tx_marks(fpage)
    labels = [t for t in drawn_texts(fpage) if re.match(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$", t)]
    assert labels and set(labels) <= {fmt_minute(t) for _, t in marks.values()}, "every label is a transaction's time"
    first = min(marks.items(), key=lambda kv: kv[1][0])
    assert fmt_minute(first[1][1]) in labels, "the leftmost transaction is labelled"
    ink = fpage.evaluate("""() => { const r = window.__orion.renderer, c = r.canvas, ctx = c.getContext('2d'), y = Math.floor(22 * r.dpr), row = ctx.getImageData(0, y, c.width, 1).data;
        let lit = 0; for (let i = 0; i < row.length; i += 4) if (row[i] > 0x50) lit++; return lit / (row.length / 4); }""")
    assert ink > 0.8, "a line runs along the top (%.2f)" % ink
    assert fpage.locator("#traceBar").bounding_box()["y"] > 30, "the bar steps down below it"


def test_hovering_the_line_near_a_tick_gives_that_transactions_exact_time_and_elsewhere_nothing(fpage, mock):
    chain(fpage, mock, late=False, hops=4, trace=True)
    x0, y0, w, h = canvas_origin(fpage)
    marks = tx_marks(fpage)
    for id_, (x, t) in marks.items():
        fpage.mouse.move(x + 3, y0 + 10)
        got = readouts(fpage)
        assert len(got) == 1 and parse(got[0]) == t, (id_, got, t)
    free = next(x for x in range(int(x0) + 5, int(x0 + w) - 5, 7) if all(abs(x - mx) > 40 for mx, _ in marks.values()))
    fpage.mouse.move(free, y0 + 10)
    assert readouts(fpage) == [], "away from every tick there is no time to read: the columns are not a scale"


def test_the_ticks_follow_the_transactions_when_you_move_them(fpage, mock):
    chain(fpage, mock, late=False, hops=3, trace=True)
    target = "tx:" + tid(11)
    before = tx_marks(fpage)[target]
    p = xy(fpage, target); fpage.mouse.move(p["x"], p["y"]); fpage.mouse.down(); fpage.mouse.move(p["x"] + 90, p["y"] + 60, steps=6); fpage.mouse.up(); settle(fpage)
    after = tx_marks(fpage)[target]
    assert after[0] > before[0] + 60, "it moved right"
    x0, y0, w, h = canvas_origin(fpage)
    fpage.mouse.move(after[0], y0 + 10)
    got = readouts(fpage)
    assert len(got) == 1 and parse(got[0]) == before[1], "its tick is over it, where it now is"


def test_no_line_when_the_trace_shows_no_transaction_and_none_outside_a_trace(fpage, mock):
    from conftest import ADDRESS
    open_query(fpage, ADDRESS)
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    assert fpage.evaluate("() => [...window.__orion.renderer.data.visible.nodes].every(id => id.startsWith('addr:'))")
    assert fpage.evaluate("() => window.__orion.renderer.data.axis") is None and not fpage.evaluate("() => document.body.classList.contains('axis-on')")
    chain(fpage, mock, late=False, hops=3, trace=False)
    fpage.click("#layoutSeg [data-layout=flow]"); settle(fpage)
    assert fpage.evaluate("() => window.__orion.renderer.data.axis") is None
