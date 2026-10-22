"""Amounts written along the edges must stay readable: two labels never sit on top of each other."""
import pytest

from conftest import ADDRESS, NORMAL
from helpers import idle, open_query, settle
from test_trace import click_handle

ROBINHOOD = "addr:bc1qprdf80adfz7aekh5nejjfrp3jksc8r929svpxk"          # on the built-in list; an output of the first fixture transaction


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def edge_labels(page):
    """The amounts drawn along the edges (the 10.5 px text), each with the rectangle it covers."""
    return page.evaluate("""() => { const r = window.__hopline.renderer, ctx = r.ctx, orig = ctx.fillText.bind(ctx), seen = [];
        ctx.fillText = (t, x, y, ...a) => { if (/^10[.]5px/.test(ctx.font)) seen.push({ text: String(t), x, y, w: ctx.measureText(String(t)).width }); return orig(t, x, y, ...a); };
        r.draw(); ctx.fillText = orig; return seen; }""")


def overlaps(labels):
    out = []
    for i, a in enumerate(labels):
        for b in labels[i + 1:]:
            ax0, ax1, ay0, ay1 = a["x"] - a["w"] / 2, a["x"] + a["w"] / 2, a["y"] - 10, a["y"] + 3
            bx0, bx1, by0, by1 = b["x"] - b["w"] / 2, b["x"] + b["w"] / 2, b["y"] - 10, b["y"] + 3
            if ax0 < bx1 and bx0 < ax1 and ay0 < by1 and by0 < ay1:
                out.append((a["text"], b["text"]))
    return out


def build_scene(fpage):
    """The scene of the README screenshot: the first transaction traced forward, then the wallets it pays and funds."""
    open_query(fpage, NORMAL["txid"])
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    click_handle(fpage, "tx:" + NORMAL["txid"], "right")
    click_handle(fpage, ROBINHOOD, "right")
    click_handle(fpage, "addr:" + ADDRESS, "right")


def test_amounts_along_the_edges_do_not_sit_on_top_of_each_other(fpage):
    build_scene(fpage)
    labels = edge_labels(fpage)
    assert len(labels) >= 3, "the scene shows several amounts: %s" % [l["text"] for l in labels]
    assert overlaps(labels) == [], "labels cover each other"
