"""An IDs link can carry the sender's labels and tags (and notes) and the trace, each only when asked: what the reader gets, what the reader keeps of their own, and what the sender is told."""
import base64
import json
import zlib

import pytest

from chains import peel_chain, tid
from conftest import PAGE_URL
from helpers import idle, open_query, settle, toast_text
from test_share_ids_link import LOADED_JS, chain, fragment, open_link, payload_of
from test_share_link import START, capture, open_menu, scene

SOME_WALLET = "bc1q" + "origin".ljust(20, "x")                                   # the first transaction of the peel chain is paid from this wallet (see chains.peel_chain)


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def make(page, labels=False, trace=False, notes=False):
    """Set the boxes under the IDs link button and press it; returns the link that was copied."""
    open_menu(page)
    page.set_checked("#idsLabels", labels); page.set_checked("#idsTrace", trace); page.set_checked("#shareNotes", notes)
    before = page.evaluate("() => window.__copied.length")
    page.click("[data-export=idlink]")
    page.wait_for_function("(n) => window.__copied.length > n", arg=before)
    return page.evaluate("() => window.__copied[window.__copied.length - 1]")


def trace_scene(tpage, mock):
    """The Trace layout, a peel chain followed forward from its first transaction: START and a few steps, each with its wallets."""
    peel_chain(mock, 6)
    open_query(tpage, tid(10))
    tpage.evaluate("(id) => window.__hopline.autoExpand(id, { dir: 'next', hops: 4, follow: 'largest' })", START); idle(tpage); settle(tpage)
    capture(tpage)
    assert tpage.evaluate("() => window.__hopline.state.layout") == "trace" and tpage.evaluate("() => window.__hopline.state.trace.shown.size") > 6


def mark(page):
    """A label, a tag and a note on the first transaction, a label on a wallet next to it."""
    page.evaluate("""([id, a]) => { const g = window.__hopline.state.graph, n = g.nodes.get(id); n.label = 'Payment to the broker'; n.tag = 'PAYMENT'; n.note = 'asked for twice';
                     const w = g.nodes.get('addr:' + a); if (w) w.label = 'Suspect wallet'; }""", [START, SOME_WALLET])


def node(page, id_):
    return page.evaluate("(id) => { const n = window.__hopline.state.graph.nodes.get(id); return n ? { label: n.label || null, tag: n.tag || null, note: n.note || null } : null; }", id_)


# ---- what the sender adds ---------------------------------------------------------------------------------------------------------------------------

def test_nothing_of_yours_goes_in_unless_a_box_is_ticked(page, mock):
    scene(page, mock); mark(page)
    p = payload_of(make(page))
    assert "l" not in p and "trace" not in p, "the default is the IDs and the picture's settings"


def test_labels_and_tags_go_in_when_asked_and_notes_only_with_the_notes_box(page, mock):
    scene(page, mock); mark(page)
    p = payload_of(make(page, labels=True))
    mine = [e for e in p["l"] if e[0] == p["t"].index(START[3:])]
    assert mine == [[p["t"].index(START[3:]), "Payment to the broker", "PAYMENT"]], "label and tag, no note"
    assert any(e[0] == SOME_WALLET and e[1] == "Suspect wallet" for e in p["l"]), "a wallet is its address"
    assert "asked for twice" not in str(p)
    q = payload_of(make(page, labels=True, notes=True))
    assert [p["t"].index(START[3:]), "Payment to the broker", "PAYMENT", "asked for twice"] in q["l"], "with the notes box the note comes too"


def test_the_message_says_what_was_added_and_what_was_not(tpage, mock):
    trace_scene(tpage, mock); mark(tpage)
    make(tpage)
    assert "your labels, tags and notes are not in it" in toast_text(tpage) and "neither is the layout" in toast_text(tpage), toast_text(tpage)
    make(tpage, labels=True, trace=True)
    text = toast_text(tpage)
    assert "label or tag" in text and "of yours" in text and "and so is the trace with the places of its vertices" in text, text


def test_ticking_labels_when_nothing_has_one_says_so(page, mock):
    scene(page, mock)
    p = payload_of(make(page, labels=True))
    assert "l" not in p and "None of the vertices in the link has a label or a tag" in page.inner_text("#shareNote")


def test_the_trace_goes_in_with_its_places_and_the_trace_layout_stays(tpage, mock):
    trace_scene(tpage, mock)
    p = payload_of(make(tpage, trace=True))
    t = p["trace"]
    assert t["seed"] == START and START in t["shown"] and len(t["shown"]) > len(p["t"]) and "groups" not in t
    assert t["pos"][START] == [0, 0] and all(len(v) == 2 for v in t["pos"].values())
    assert p["view"]["layout"] == "trace"
    assert "l" not in p


def test_without_a_trace_on_screen_the_box_says_so_and_nothing_is_added(page, mock):
    scene(page, mock)
    page.click("[data-layout=flow]"); settle(page)
    p = payload_of(make(page, trace=True))
    assert "trace" not in p and p["view"]["layout"] == "flow"
    assert "no trace on screen" in page.inner_text("#shareNote")


# ---- what the reader gets ---------------------------------------------------------------------------------------------------------------------------

def test_the_reader_gets_the_labels_and_tags_and_the_note_only_if_it_was_sent(page, ctx, mock):
    scene(page, mock); mark(page)
    other = open_link(ctx, make(page, labels=True))
    assert node(other, START) == {"label": "Payment to the broker", "tag": "PAYMENT", "note": None}
    assert node(other, "addr:" + SOME_WALLET)["label"] == "Suspect wallet"
    assert "label" in toast_text(other) and "put on the canvas" in toast_text(other), toast_text(other)
    withnote = open_link(ctx, make(page, labels=True, notes=True))
    assert node(withnote, START)["note"] == "asked for twice"


def test_a_label_or_a_tag_the_reader_already_has_stays_theirs(page, ctx, mock):
    scene(page, mock); mark(page)
    link = make(page, labels=True, notes=True)
    mine = ctx.new_page()
    mine.goto(PAGE_URL); mine.wait_for_function("window.__hopline && window.__hopline.renderer")
    open_query(mine, tid(10)); settle(mine)
    mine.evaluate("(id) => { const n = window.__hopline.state.graph.nodes.get(id); n.label = 'My own name'; n.tag = 'WATCH'; }", START)
    before = len(mine.evaluate(LOADED_JS))
    mine.evaluate("(h) => { window.location.hash = h; }", fragment(link))
    mine.wait_for_function("(n) => window.__hopline.state.graph.nodes.size > n", arg=before, timeout=30000); idle(mine)
    got = node(mine, START)
    assert got["label"] == "My own name" and got["tag"] == "WATCH", "what the reader wrote is not replaced"
    assert got["note"] == "asked for twice", "but what they had no value for is filled in"
    assert node(mine, "addr:" + SOME_WALLET)["label"] == "Suspect wallet", "and the rest comes"
    assert "kept your own" in toast_text(mine), toast_text(mine)


def test_a_tag_that_is_not_one_is_dropped_and_a_label_is_cut_to_the_length_a_label_has(ctx, mock):
    t = chain(mock, 2)
    payload = {"format": "hopline-ids", "version": 1, "t": t, "f": None, "of": 2, "view": {},
               "l": [[0, "x" * 500, "NOT-A-REAL-TAG<script>"], [1, "ok", "WATCH"]]}
    z = zlib.compressobj(wbits=-15)
    link = PAGE_URL + "#i1/" + base64.urlsafe_b64encode(z.compress(json.dumps(payload).encode()) + z.flush()).decode().rstrip("=")
    other = open_link(ctx, link)
    first, second = node(other, "tx:" + t[0]), node(other, "tx:" + t[1])
    assert len(first["label"]) == 120 and first["tag"] != "NOT-A-REAL-TAG<script>", first
    assert second == {"label": "ok", "tag": "WATCH", "note": None}


def test_the_reader_gets_the_trace_with_the_senders_places_on_an_empty_canvas(tpage, ctx, mock):
    trace_scene(tpage, mock)
    sent = tpage.evaluate("() => { const T = window.__hopline.state.trace; return { shown: [...T.shown].sort(), seeds: [...T.seeds], pos: [...T.pos].sort((a, b) => (a[0] < b[0] ? -1 : 1)) }; }")
    other = open_link(ctx, make(tpage, trace=True))
    got = other.evaluate("() => { const T = window.__hopline.state.trace; return { shown: [...T.shown].sort(), seeds: [...T.seeds], pos: [...T.pos].sort((a, b) => (a[0] < b[0] ? -1 : 1)), layout: window.__hopline.state.layout }; }")
    assert got["layout"] == "trace" and got["seeds"] == sent["seeds"] == [START]
    assert got["shown"] == sent["shown"], "the same vertices are on the trace"
    for (i, a), (j, b) in zip(got["pos"], sent["pos"]):
        assert i == j and abs(a["x"] - b["x"]) < 0.11 and abs(a["y"] - b["y"]) < 0.11, "%s is where it was: %s against %s" % (i, a, b)


def test_a_trace_is_added_below_the_one_the_reader_already_has(tpage, ctx, mock):
    trace_scene(tpage, mock)
    link = make(tpage, trace=True)
    t = chain(mock, 1, first=200)
    mine = ctx.new_page()
    mine.goto(PAGE_URL); mine.wait_for_function("window.__hopline && window.__hopline.renderer")
    open_query(mine, t[0]); settle(mine)
    own = mine.evaluate("() => [...window.__hopline.state.trace.shown].sort()")
    mine.evaluate("(h) => { window.location.hash = h; }", fragment(link))
    mine.wait_for_function("(n) => window.__hopline.state.graph.nodes.size > n", arg=len(mine.evaluate("() => [...window.__hopline.state.graph.nodes.keys()]")), timeout=30000); idle(mine)
    shown = set(mine.evaluate("() => [...window.__hopline.state.trace.shown]"))
    assert set(own) <= shown and START in shown, "what the reader had stays, and the link's trace is added"
    assert "is shown below the current one" in toast_text(mine), toast_text(mine)
    ys = mine.evaluate("(id) => window.__hopline.state.trace.pos.get(id).y", START)
    assert ys > mine.evaluate("(id) => window.__hopline.state.trace.pos.get(id).y", own[0]), "below it"


def test_a_link_without_a_trace_still_opens_in_the_automatic_layout(page, ctx, mock):
    scene(page, mock)
    other = open_link(ctx, make(page))
    assert other.evaluate("() => window.__hopline.state.layout") == "flow"
