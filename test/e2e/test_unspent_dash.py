"""An arrow for an output that is not spent yet is dashed whatever its width. The dash and the gap grow with the line, and the dashes have square ends: with round ends every dash grows by the width of the line
at both ends, and on an arrow wider than the 4 px gap the gaps closed up and a large unspent output looked solid (reported on a transaction of more than 1 BTC whose details said "unspent")."""
import pytest

from chains import IN, OUT, tid, tx
from helpers import open_query, settle


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def scene(mock, spend_big=False):
    """A transaction with two inputs and two outputs, a large one (1.08 BTC: a thick arrow) and a small one (10,000 sat: a thin one). Both are unspent unless asked."""
    tx(mock, 60, [IN(5, 0, "up1", 108_581_012), IN(6, 0, "up2", 20_000)], [OUT("big", 108_590_684), OUT("small", 10_000)], spent={0: 61} if spend_big else None)
    if spend_big:
        tx(mock, 61, [IN(60, 0, "big", 108_590_684)], [OUT("onward", 108_590_000)])


def arrow_gaps(page, a, b):
    """Walk along the arrow from the transaction `a` to the wallet `b` between 25% and 75% of the way and report { width, ink, gaps, longest }: how far the line is drawn, how many gaps, and the longest gap in pixels.
    A pixel is drawn when it differs from the canvas background; the walk is on the side of the line away from the amount label."""
    return page.evaluate("""([a, b]) => {
        const r = window.__hopline.renderer, c = r.canvas, g = c.getContext('2d'), k = c.width / c.clientWidth, P = r._toScreen(r.cur.get(a)), Q = r._toScreen(r.cur.get(b));
        const dx = Q.x - P.x, dy = Q.y - P.y, len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len, nx = -uy, ny = ux, bg = g.getImageData(2, 2, 1, 1).data;
        const edge = [...window.__hopline.state.graph.edges.values()].find((e) => e.source === a && e.target === b), w = r.data.style.edgeWidth(edge) * r._scale() * 0.8;
        let gaps = 0, run = 0, longest = 0, ink = 0, steps = 0;
        for (let t = 0.25 * len; t <= 0.75 * len; t += 1) {
          let best = 0;
          for (const off of [0, 1, 2, 3]) {
            const x = Math.floor((P.x + ux * t + nx * off) * k), y = Math.floor((P.y + uy * t + ny * off) * k), d = g.getImageData(x, y, 1, 1).data;
            best = Math.max(best, Math.abs(d[0] - bg[0]) + Math.abs(d[1] - bg[1]) + Math.abs(d[2] - bg[2]));
          }
          steps++;
          if (best >= 40) { ink++; if (run) { gaps++; longest = Math.max(longest, run); run = 0; } } else run++;
        }
        return { width: w, ink: ink, gaps: gaps, longest: longest, steps: steps };
      }""", [a, b])


def test_a_thick_arrow_for_an_unspent_output_shows_its_dashes(fpage, mock):
    scene(mock)
    open_query(fpage, tid(60)); settle(fpage)
    got = arrow_gaps(fpage, "tx:" + tid(60), "addr:bc1q" + "big".ljust(20, "x"))
    assert got["width"] >= 7, "a thick arrow: %s" % got
    assert got["gaps"] >= 2 and got["longest"] >= 6, "dashes with gaps you can see (a solid line has none): %s" % got
    assert got["ink"] > got["steps"] * 0.35, "and mostly ink"


def test_a_thin_arrow_for_an_unspent_output_is_still_dashed(fpage, mock):
    scene(mock)
    open_query(fpage, tid(60)); settle(fpage)
    got = arrow_gaps(fpage, "tx:" + tid(60), "addr:bc1q" + "small".ljust(20, "x"))
    assert got["width"] < 4, "a thin arrow: %s" % got
    assert got["gaps"] >= 2, "dashes as before: %s" % got


def test_an_arrow_for_a_spent_output_is_a_solid_line_whatever_its_width(fpage, mock):
    scene(mock, spend_big=True)
    open_query(fpage, tid(60)); settle(fpage)
    got = arrow_gaps(fpage, "tx:" + tid(60), "addr:bc1q" + "big".ljust(20, "x"))
    assert got["width"] >= 7 and got["gaps"] == 0 and got["ink"] >= got["steps"] - 1, "no gap in a spent arrow: %s" % got


def test_the_details_and_the_arrow_agree_on_an_output_that_is_unspent(fpage, mock):
    scene(mock)
    open_query(fpage, tid(60)); settle(fpage)
    fpage.evaluate("(id) => window.__hopline.setSel([id])", "tx:" + tid(60)); settle(fpage)
    assert "unspent" in fpage.inner_text("#inspBody").lower(), "the details say unspent"
    got = arrow_gaps(fpage, "tx:" + tid(60), "addr:bc1q" + "big".ljust(20, "x"))
    assert got["gaps"] >= 2, "and the arrow is dashed: %s" % got
