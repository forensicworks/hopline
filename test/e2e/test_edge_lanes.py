"""A wallet that put coins into a transaction and got change back from it has two arrows between the same two vertices, one each way. They lie on top of each other and read as ONE double-headed
arrow; each is drawn in its own lane instead, and the pointer picks the one it is on."""
import pytest

from chains import IN, OUT, tid, tx
from helpers import open_query, settle

TX = "tx:" + tid(80)
WALLET = "addr:bc1q" + "w".ljust(20, "x")
SHOP = "addr:bc1q" + "pay".ljust(20, "x")


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def change(mock):
    """The wallet puts 100,000 in, 30,000 go to a shop and 69,850 come back to the wallet (150 of fee)."""
    tx(mock, 80, [IN(5, 0, "w", 100000)], [OUT("pay", 30000), OUT("w", 69850)])


def edge_ids(page):
    return page.evaluate("""([w, t]) => { const g = window.__hopline.state.graph, out = {};
        g.edges.forEach((e) => { if (e.source === w && e.target === t) out.into = e.id; if (e.source === t && e.target === w) out.back = e.id; }); return out; }""", [WALLET, TX])


def lane_points(page, f=0.3):
    """Page coordinates of the two lanes at a fraction f of the way from the wallet to the transaction, worked out the way the drawing does it: the coins going in keep to the right of their way."""
    return page.evaluate("""([w, t, f]) => { const r = window.__hopline.renderer, g = window.__hopline.state.graph, s = r._scale(), box = r.canvas.getBoundingClientRect();
        const a = r._toScreen(r.cur.get(w)), b = r._toScreen(r.cur.get(t)), dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
        const into = [...g.edges.values()].find((e) => e.source === w && e.target === t), wd = r.data.style.edgeWidth(into) * s * 0.8, lane = Math.min(20, Math.max(4, wd / 2 + 2));
        const x = a.x + dx * f, y = a.y + dy * f, nx = -dy / len * lane, ny = dx / len * lane;
        return { into: { x: box.left + x + nx, y: box.top + y + ny }, back: { x: box.left + x - nx, y: box.top + y - ny }, middle: { x: box.left + x, y: box.top + y }, lane: lane, len: len }; }""", [WALLET, TX, f])


def hovered(page):
    return page.evaluate("() => window.__hopline.renderer.hover.edge")


def test_each_lane_picks_its_own_arrow(fpage, mock):
    change(mock)
    open_query(fpage, tid(80)); settle(fpage)
    ids = edge_ids(fpage)
    assert ids.get("into") and ids.get("back") and ids["into"] != ids["back"], "two arrows between the same two vertices: %s" % ids
    p = lane_points(fpage)
    assert p["len"] > 120, "far enough apart to tell the lanes apart"
    fpage.mouse.move(p["into"]["x"], p["into"]["y"]); fpage.wait_for_timeout(250)
    assert hovered(fpage) == ids["into"], "the lane the coins going in keep to"
    fpage.mouse.move(p["back"]["x"], p["back"]["y"]); fpage.wait_for_timeout(250)
    assert hovered(fpage) == ids["back"], "the lane the change keeps to"
    fpage.mouse.move(5, 5); fpage.wait_for_timeout(150)
    assert hovered(fpage) is None


def test_the_card_of_each_lane_says_input_or_output(fpage, mock):
    change(mock)
    open_query(fpage, tid(80)); settle(fpage)
    p = lane_points(fpage)
    fpage.mouse.move(p["into"]["x"], p["into"]["y"])
    fpage.wait_for_function("() => !document.getElementById('tooltip').hidden", timeout=4000)
    assert "Input" in fpage.inner_text("#tooltip") and "0.00100000 BTC" in fpage.inner_text("#tooltip"), fpage.inner_text("#tooltip")
    fpage.mouse.move(5, 5); fpage.mouse.move(p["back"]["x"], p["back"]["y"])
    fpage.wait_for_function("() => /Output/.test(document.getElementById('tooltip').textContent)", timeout=4000)
    assert "0.00069850 BTC" in fpage.inner_text("#tooltip"), fpage.inner_text("#tooltip")


def test_both_lanes_are_drawn_and_nothing_is_drawn_between_them(fpage, mock):
    change(mock)
    open_query(fpage, tid(80)); settle(fpage)
    p = lane_points(fpage)

    def ink(pt):
        return fpage.evaluate("""(pt) => { const c = window.__hopline.renderer.canvas, b = c.getBoundingClientRect(), k = c.width / c.clientWidth, g = c.getContext('2d');
            const d = g.getImageData(Math.floor((pt.x - b.left) * k), Math.floor((pt.y - b.top) * k), 1, 1).data; return d[0] + d[1] + d[2]; }""", pt)
    assert ink(p["into"]) > 150 and ink(p["back"]) > 150, "a line in each lane (%s, %s)" % (ink(p["into"]), ink(p["back"]))
    assert ink(p["middle"]) < 100, "and the old single line down the middle is gone: only the background shows there (%s)" % ink(p["middle"])


def test_a_single_arrow_between_two_vertices_stays_on_the_line(fpage, mock):
    change(mock)
    open_query(fpage, tid(80)); settle(fpage)
    ids = fpage.evaluate("([t, s]) => { const g = window.__hopline.state.graph; const e = [...g.edges.values()].find((x) => x.source === t && x.target === s); return e ? e.id : null; }", [TX, SHOP])
    assert ids, "the payment to the shop has no partner"
    got = fpage.evaluate("""([t, s]) => { const r = window.__hopline.renderer, a = r._toScreen(r.cur.get(t)), b = r._toScreen(r.cur.get(s)), box = r.canvas.getBoundingClientRect();
        return { x: box.left + a.x + (b.x - a.x) * 0.3, y: box.top + a.y + (b.y - a.y) * 0.3 }; }""", [TX, SHOP])
    fpage.mouse.move(got["x"], got["y"]); fpage.wait_for_timeout(250)
    assert hovered(fpage) == ids, "no partner, no lane: it is picked on the line between its vertices"
