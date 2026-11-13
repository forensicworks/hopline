"""A canvas link keeps only what was on screen, so a big transaction (a CoinJoin) arrives with a handful of its inputs and outputs: the page says so, the arrows
offer to load the rest, "nothing before this in what is loaded" is no longer said about a transaction that is only partly there, and loading it brings the patterns."""
import pytest

from chains import addr, coinjoin, tid
from helpers import idle, open_query, settle
from test_share_link import capture, make_link, open_link

CJ = "tx:" + tid(50)


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def flags(page, id_=CJ):
    return page.evaluate("(id) => { const r = window.__hopline.analysis().tx.get(id); return r ? r.flags.map((f) => f.short) : null; }", id_)


def sender(tpage, mock, everything=True):
    """The CoinJoin (5 inputs, 7 outputs) opened and followed both ways in the Trace layout and flagged. With `everything` all of it is drawn; without, the default
    step shows the five inputs and leaves the seven outputs behind the arrow (more than one click shows unasked)."""
    coinjoin(mock, 50)
    open_query(tpage, tid(50))
    if everything: tpage.evaluate("() => { window.__hopline.state.stepMode = 'all'; }")
    for d in ("prev", "next"):
        tpage.evaluate("([id, d]) => window.__hopline.traceExpand(id, d)", [CJ, d]); idle(tpage); settle(tpage)
    capture(tpage)
    assert any(f.startswith("COINJOIN") for f in flags(tpage)), "the sender sees the pattern"


def reader(tpage, ctx, mock, limit, everything=True):
    sender(tpage, mock, everything)
    return open_link(ctx, make_link(tpage, limit=limit))


def handle_tips(page, id_=CJ):
    return {h["dir"]: h["tip"] for h in page.evaluate("(id) => window.__hopline.renderer.handleRects.filter((h) => h.id === id).map((h) => ({ dir: h.dir, tip: h.tip }))", id_)}


def select(page, id_=CJ):
    page.evaluate("(id) => window.__hopline.setSel([id])", id_); settle(page)


def test_a_link_that_cut_the_transaction_says_so_when_it_is_opened(tpage, ctx, mock):
    r = reader(tpage, ctx, mock, 5)
    text = r.inner_text("#toast")
    assert "only partly on the canvas" in text and "no pattern is checked" in text and "a link keeps only what was on screen" in text, text
    assert flags(r) == [], "with some of its inputs and outputs missing nothing can be concluded from it"


def test_the_arrows_of_the_cut_transaction_say_how_much_is_there_and_offer_the_rest(tpage, ctx, mock):
    r = reader(tpage, ctx, mock, 5)
    tips = handle_tips(r)
    assert set(tips) == {"left", "right"}, "both arrows are drawn, also the one on the side the trace came from"
    assert "on this canvas" in tips["left"] and "of its 5 inputs" in tips["left"], tips
    assert "on this canvas" in tips["right"] and "of its 7 outputs" in tips["right"], tips


def test_the_details_say_how_much_of_the_transaction_is_on_the_canvas(tpage, ctx, mock):
    r = reader(tpage, ctx, mock, 5)
    select(r)
    box = r.inner_text("#inspector")
    assert "On this canvas" in box and "of 5 inputs and" in box and "of 7 outputs" in box and "no pattern is checked for it" in box, box
    assert "Show backward or Show forward loads the rest" in box


def test_show_backward_loads_the_rest_instead_of_saying_nothing_before_this(tpage, ctx, mock):
    r = reader(tpage, ctx, mock, 5)
    select(r)
    r.click("#inspector button:has-text('Show backward')"); idle(r); settle(r)
    assert "Nothing before this" not in r.inner_text("#toast")
    shown = set(r.evaluate("() => [...window.__hopline.renderer.data.visible.nodes]"))
    assert {"addr:" + addr("w%d" % i) for i in range(5)} <= shown, "all five input wallets are on the canvas now"
    assert any(f.startswith("COINJOIN") for f in flags(r)), "loaded in full, the transaction shows its pattern"
    select(r)
    assert "On this canvas" not in r.inner_text("#inspector"), "nothing is missing any more"


def test_show_forward_loads_the_rest_too(tpage, ctx, mock):
    r = reader(tpage, ctx, mock, 5)
    r.evaluate("() => { window.__hopline.state.stepMode = 'all'; }")                       # seven outputs are more than one click shows unasked: take them all
    select(r)
    r.click("#inspector button:has-text('Show forward')"); idle(r); settle(r)
    shown = set(r.evaluate("() => [...window.__hopline.renderer.data.visible.nodes]"))
    assert {"addr:" + addr("e%d" % i) for i in range(5)} <= shown, "the five equal outputs are on the canvas now"
    assert any(f.startswith("COINJOIN") for f in flags(r))


def test_a_link_that_kept_everything_says_nothing_about_partial_transactions(tpage, ctx, mock):
    r = reader(tpage, ctx, mock, 500)
    assert "partly" not in r.inner_text("#toast")
    assert any(f.startswith("COINJOIN") for f in flags(r)), "the pattern arrives with a complete transaction"
    select(r)
    assert "On this canvas" not in r.inner_text("#inspector")


def test_a_link_of_the_whole_canvas_still_cuts_what_the_sender_had_not_drawn(tpage, ctx, mock):
    """The situation the report came from: the canvas shows some of a big transaction's wallets, the link keeps what is on screen, and the reader gets the rest as missing."""
    r = reader(tpage, ctx, mock, 500, everything=False)
    assert "only partly on the canvas" in r.inner_text("#toast")
    select(r)
    box = r.inner_text("#inspector")
    assert "5 of 5 inputs and 0 of 7 outputs" in box, box
    assert "of its 7 outputs" in handle_tips(r)["right"]
    assert "Nothing after this" not in handle_tips(r)["right"]


def test_the_arrow_on_the_side_the_trace_came_from_stays_for_a_cut_transaction(tpage, ctx, mock):
    """A bare ? on the side a vertex was reached from is noise for an ordinary transaction; for one that is only partly on the canvas it says that most of its inputs are missing."""
    r = reader(tpage, ctx, mock, 5)
    came_from = "addr:" + addr("w0")
    r.evaluate("([id, via]) => { window.__hopline.state.trace.prov.set(id, { via: via, dir: 'next' }); window.__hopline.refresh(); }", [CJ, came_from])
    settle(r)
    tips = handle_tips(r)
    assert "left" in tips and "of its 5 inputs" in tips["left"], tips
