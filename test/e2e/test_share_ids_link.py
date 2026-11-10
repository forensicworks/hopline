"""A link of transaction IDs (Export > Link to these transactions, IDs only): the IDs of what is on screen and nothing else, and opening one loads them from the reader's own data source."""
import base64
import json
import zlib

import pytest

from chains import IN, OUT, tid, tx
from conftest import PAGE_URL
from helpers import idle, settle, toast_text
from test_share_link import START, capture, ids, make_link, open_menu, scene

LOADED_JS = "() => [...window.__hopline.state.graph.nodes.values()].filter((n) => n.type === 'tx' && n.loaded).map((n) => n.id)"


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def make_ids_link(page):
    open_menu(page)
    page.click("[data-export=idlink]")
    page.wait_for_function("() => window.__copied.length > 0")
    link = page.evaluate("() => window.__copied[window.__copied.length - 1]")
    assert link == page.input_value("#shareOut"), "what was copied is what the menu shows"
    return link


def payload_of(link):
    body = link.split("#i1/", 1)[1]
    return json.loads(zlib.decompress(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)), -15))


def link_of(txids, focus=None, view=None, of=None, fmt="hopline-ids"):
    """A link made by hand (as someone else's Hopline would make it): the JSON, deflated raw, in base64url."""
    payload = {"format": fmt, "version": 1, "t": txids, "f": focus, "of": len(txids) if of is None else of, "view": view or {}}
    z = zlib.compressobj(wbits=-15)
    data = z.compress(json.dumps(payload).encode()) + z.flush()
    return PAGE_URL + "#i1/" + base64.urlsafe_b64encode(data).decode().rstrip("=")


def fragment(link):
    """The part of a link from the # on, to put into the address bar of a page that is open."""
    return "#" + link.split("#", 1)[1]


def chain(mock, n, first=100):
    """n unconnected transactions, one payment each; returns their ids (hex)."""
    out = []
    for k in range(n):
        tx(mock, first + k, [IN(5, k, "src%d" % k, 50000)], [OUT("dst%d" % k, 40000 + k)])
        out.append(tid(first + k))
    return out


def open_link(ctx, link, on_dialog=None, wait=True):
    p = ctx.new_page()
    seen = []
    p.on("dialog", lambda d: (seen.append(d.message), on_dialog(d) if on_dialog else d.accept()))
    p.goto(link)
    p.wait_for_function("window.__hopline && window.__hopline.renderer")
    if wait:
        p.wait_for_function("() => window.__hopline.state.graph.nodes.size > 0 || !document.getElementById('toast').hidden", timeout=30000)
        idle(p, timeout=60000)
    p.dialogs = seen
    return p


def tx_requests(mock):
    return len([r for r in mock.requests if "/tx/" in r[1] and not r[1].endswith("/outspends")])


# ---- making one ----------------------------------------------------------------------------------------------------------------------------------

def test_the_link_lists_the_loaded_transactions_on_screen_nearest_start_first_and_nothing_else(page, mock):
    scene(page, mock)
    mine = set(page.evaluate(LOADED_JS))
    assert len(mine) >= 6
    link = make_ids_link(page)
    assert link.startswith("file:///") and "#i1/" in link
    p = payload_of(link)
    assert p["format"] == "hopline-ids" and p["version"] == 1
    assert {"tx:" + t for t in p["t"]} == mine, "every transaction that is loaded and on screen, and no other vertex"
    assert p["t"][0] == START[3:] and p["f"] == START, "START first, and the place it opens at"
    assert p["of"] == len(mine)
    assert set(p) == {"format", "version", "t", "f", "of", "view"}, "nothing else travels: no vertices, labels, tags, notes or look-ups"
    canvas = make_link(page, limit=500)
    assert len(link) < len(canvas) / 2, (len(link), len(canvas))


def test_it_says_how_many_transactions_and_what_the_reader_will_do_and_what_is_not_in_it(page, mock):
    scene(page, mock)
    make_ids_link(page)
    text = toast_text(page)
    n = len(page.evaluate(LOADED_JS))
    assert "Link copied: %d transactions" % n in text and "about %d requests" % (2 * n) in text, text
    assert "your labels, tags and notes are not in it, and neither is the layout" in text
    assert page.is_visible("#shareOut")


def test_a_label_a_tag_and_a_note_do_not_go_into_it(page, mock):
    scene(page, mock)
    page.evaluate("""(id) => { const n = window.__hopline.state.graph.nodes.get(id); n.label = 'Exchange Z'; n.tag = 'EXCH'; n.note = 'my private thought'; }""", START)
    text = json.dumps(payload_of(make_ids_link(page)))
    assert "Exchange Z" not in text and "EXCH" not in text and "private" not in text


def test_an_empty_canvas_has_nothing_to_share(page):
    capture(page)
    open_menu(page)
    page.click("[data-export=idlink]")
    page.wait_for_function("() => !document.getElementById('toast').hidden")
    assert "Nothing to export yet" in toast_text(page) and page.evaluate("() => window.__copied.length") == 0, "the export menu says so before any link is made"


def test_the_view_settings_that_make_the_same_picture_go_along_and_a_trace_becomes_the_flow_layout(page, mock):
    scene(page, mock)
    page.click("[data-color=age]")
    p = payload_of(make_ids_link(page))
    assert p["view"]["colorBy"] == "age"
    assert p["view"].get("layout") != "trace", "a trace's places are not in the link: the reader gets the automatic layout"


# ---- opening one ---------------------------------------------------------------------------------------------------------------------------------

def test_opening_it_loads_those_transactions_from_the_readers_data_source_and_starts_where_the_sender_did(page, ctx, mock):
    scene(page, mock)
    mine = set(page.evaluate(LOADED_JS))
    page.evaluate("(id) => { window.__hopline.state.graph.nodes.get(id).label = 'Exchange Z'; }", START)
    link = make_ids_link(page)
    before = tx_requests(mock)
    other = open_link(ctx, link)
    assert set(other.evaluate(LOADED_JS)) == mine
    assert tx_requests(mock) - before >= len(mine), "the transactions were asked for, by the reader's own browser"
    assert other.evaluate("() => window.__hopline.state.focus") == START and other.evaluate("() => window.__hopline.state.layout") == "flow"
    assert other.evaluate("(id) => window.__hopline.state.graph.nodes.get(id).label || null", START) is None, "the sender's labels are not in the link"
    assert not other.evaluate("() => location.hash").startswith("#i1/"), "the link is taken out of the address: a reload does not open it again (what is there now is the trail)"
    assert "Open %d transactions from a link" % len(mine) in toast_text(other) or other.is_visible("#btnUndoLoad")


def test_the_view_settings_of_the_link_are_applied_on_an_empty_canvas(ctx, mock):
    t = chain(mock, 3)
    other = open_link(ctx, link_of(t, focus="tx:" + t[1], view={"colorBy": "age", "sizeBy": "log", "timeScale": "proportional", "layout": "flow"}))
    s = other.evaluate("() => ({ color: window.__hopline.state.colorBy, size: window.__hopline.state.sizeBy, layout: window.__hopline.state.layout, scale: window.__hopline.state.timeScale, focus: window.__hopline.state.focus })")
    assert s == {"color": "age", "size": "log", "layout": "flow", "scale": "proportional", "focus": "tx:" + t[1]}, s


def test_without_a_place_to_start_it_opens_at_its_first_transaction(ctx, mock):
    t = chain(mock, 3)
    other = open_link(ctx, link_of(t))
    assert other.evaluate("() => window.__hopline.state.focus") == "tx:" + t[0]


def test_a_link_opened_in_a_page_with_a_canvas_adds_to_it_and_can_be_undone(page, mock):
    scene(page, mock)
    mine = set(page.evaluate(LOADED_JS))
    t = chain(mock, 3)
    page.evaluate("(h) => { window.location.hash = h; }", fragment(link_of(t)))
    page.wait_for_function("(n) => window.__hopline.state.graph.nodes.size > n", arg=len(mine), timeout=20000)
    idle(page)
    now = set(page.evaluate(LOADED_JS))
    assert mine <= now and {"tx:" + x for x in t} <= now, "what was there stays, what the link lists comes in"
    assert page.evaluate("() => window.__hopline.state.focus") == START, "the reader's own place is not moved"
    assert page.is_enabled("#btnUndoLoad")
    page.click("#btnUndoLoad"); idle(page)
    assert set(page.evaluate(LOADED_JS)) == mine


def test_transactions_that_are_all_on_the_canvas_already_are_said_so_and_nothing_is_asked_for(page, mock):
    scene(page, mock)
    mine = [n[3:] for n in page.evaluate(LOADED_JS)]
    asked = tx_requests(mock)
    page.evaluate("(h) => { window.location.hash = h; }", fragment(link_of(mine)))
    page.wait_for_function("() => /on the canvas already/.test(document.getElementById('toast').textContent)", timeout=10000)
    assert tx_requests(mock) == asked


# ---- a long list asks first ------------------------------------------------------------------------------------------------------------------------

def test_a_list_of_up_to_25_is_opened_without_asking(ctx, mock):
    t = chain(mock, 25)
    other = open_link(ctx, link_of(t))
    assert other.dialogs == [] and len(other.evaluate(LOADED_JS)) == 25


def test_a_longer_list_names_the_server_and_the_number_of_requests_and_declining_loads_nothing(ctx, mock):
    t = chain(mock, 26)
    before = tx_requests(mock)
    other = open_link(ctx, link_of(t), on_dialog=lambda d: d.dismiss(), wait=False)
    other.wait_for_function("() => /was not opened/.test(document.getElementById('toast').textContent)", timeout=10000)
    assert len(other.dialogs) == 1
    msg = other.dialogs[0]
    assert "26 transactions" in msg and "mempool.space" in msg and "about 52 requests" in msg and "learns which transactions you look at" in msg, msg
    assert other.evaluate("() => window.__hopline.state.graph.nodes.size") == 0 and tx_requests(mock) == before


def test_accepting_loads_them_all_even_past_the_usual_limit_of_requests(ctx, mock):
    t = chain(mock, 45)                                                                  # 90 requests: more than the 80 an action is allowed by default
    other = open_link(ctx, link_of(t, focus="tx:" + t[0]))
    assert len(other.evaluate(LOADED_JS)) == 45, "the limit was raised to what the link needs"
    assert len(other.dialogs) == 1


# ---- what the sender cut, and what is not a link ---------------------------------------------------------------------------------------------------

def test_the_reader_is_told_when_the_sender_cut_the_list_down(ctx, mock):
    t = chain(mock, 3)
    other = open_link(ctx, link_of(t, of=500))
    assert "The sender cut the list down to the 3 transactions nearest START (they had 500)" in toast_text(other), toast_text(other)


@pytest.mark.parametrize("name,link", [
    ("not hex", lambda: link_of(["zz" * 32])),
    ("too short", lambda: link_of(["ab" * 31])),
    ("not a list of transactions", lambda: link_of([], fmt="hopline-workspace")),
    ("empty", lambda: link_of([])),
    ("too many", lambda: link_of([("%064x" % i) for i in range(3001)])),
    ("damaged characters", lambda: PAGE_URL + "#i1/abc$def"),
    ("cut short", lambda: link_of([tid(1), tid(2)])[:-12]),
    ("nothing after the prefix", lambda: PAGE_URL + "#i1/"),
])
def test_a_link_that_is_not_one_is_refused_with_a_reason_and_loads_nothing(ctx, mock, name, link):
    before = len(mock.requests)
    other = open_link(ctx, link(), wait=False)
    other.wait_for_function("() => /could not be opened/.test(document.getElementById('toast').textContent)", timeout=15000)
    assert other.evaluate("() => window.__hopline.state.graph.nodes.size") == 0, name
    assert not [r for r in mock.requests[before:] if "/tx/" in r[1]], "nothing was asked for: " + name


def test_canvas_links_still_open_as_before(page, ctx, mock):
    scene(page, mock)
    mine = ids(page)
    other = ctx.new_page()
    other.goto(make_link(page, limit=500))
    other.wait_for_function("window.__hopline && window.__hopline.renderer")
    other.wait_for_function("() => window.__hopline.state.graph.nodes.size > 0")
    settle(other)
    assert ids(other) == mine
