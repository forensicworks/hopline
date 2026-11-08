"""A link to the canvas (Export > Link to this canvas): the canvas packed into the address after the #, a limit with a warning, and opening it in another page."""
import json

import pytest

from chains import peel_chain, tid
from helpers import idle, open_query, settle, toast_text

START = "tx:" + tid(10)


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def capture(page):
    """Replace the clipboard with a list the test can read (the real one cannot be read back without a permission prompt)."""
    page.evaluate("""() => {
      window.__copied = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__copied.push(t); return Promise.resolve(); } } });
    }""")


def scene(page, mock, n=8):
    """A peel chain of n steps opened from its first transaction and followed forward: some twenty-five vertices, with START the first transaction."""
    peel_chain(mock, n)
    open_query(page, tid(10))
    page.evaluate("(id) => window.__hopline.autoExpand(id, { dir: 'next', hops: 8, follow: 'largest' })", START); idle(page); settle(page)
    capture(page)


def open_menu(page):
    if not page.evaluate("() => document.getElementById('exportMenu').open"):
        page.click("#exportMenu summary")


def make_link(page, limit=None, notes=False):
    """Press the menu's link button with the given limit; returns the link that was copied."""
    open_menu(page)
    if limit is not None:
        page.fill("#shareMax", str(limit)); page.dispatch_event("#shareMax", "change")
    page.set_checked("#shareNotes", notes)
    page.click("[data-export=link]")
    page.wait_for_function("() => window.__copied.length > 0")
    link = page.evaluate("() => window.__copied[window.__copied.length - 1]")
    assert link == page.input_value("#shareOut"), "what was copied is what the menu shows, to copy by hand if the clipboard is not allowed"
    return link


def open_link(ctx, link):
    """The link in a page of its own, as someone who was sent it would open it; waits until the canvas has come in."""
    p = ctx.new_page()
    p.goto(link)
    p.wait_for_function("window.__hopline && window.__hopline.renderer")
    p.wait_for_function("() => window.__hopline.state.graph.nodes.size > 0 || !document.getElementById('toast').hidden")
    settle(p)
    return p


def ids(page):
    return set(page.evaluate("() => [...window.__hopline.state.graph.nodes.keys()]"))


def test_a_link_to_the_whole_canvas_opens_the_same_vertices_in_another_page_and_the_address_is_cleaned(page, ctx, mock):
    scene(page, mock)
    mine = ids(page)
    assert len(mine) > 10
    link = make_link(page, limit=500)
    assert "#s1/" in link and link.startswith("file:///") and len(link) < 12000, len(link)
    assert "Link copied: %d vertices" % len(mine) in toast_text(page), toast_text(page)
    assert "only the" not in page.inner_text("#shareNote"), "nothing was left out, so no warning about that"
    other = open_link(ctx, link)
    assert ids(other) == mine
    assert "#s1/" not in other.url, "the address no longer carries the canvas, so a reload does not open it again"
    assert "Opened a shared canvas" in toast_text(other) and "cut it down" not in toast_text(other)
    assert other.evaluate("() => window.__hopline.analysis().tx.size") >= 8, "the analysis runs on what came in"


def test_over_the_limit_only_the_vertices_nearest_start_go_in_and_the_sender_and_the_reader_are_told(page, ctx, mock):
    scene(page, mock)
    mine = ids(page)
    link = make_link(page, limit=5)
    said, note = toast_text(page), page.inner_text("#shareNote")
    assert "not everything is in it" in said and "only the 5 vertices nearest START, not all %d" % len(mine) in said, said
    assert "only the 5 vertices nearest START, not all %d" % len(mine) in note, "the warning stays in the menu"
    assert page.locator("#shareNote.warn").count() == 1
    other = open_link(ctx, link)
    got = ids(other)
    assert len(got) == 5 and got <= mine and START in got, "the five nearest START, START among them: %s" % got
    assert "cut it down to the 5 vertices nearest START (they had %d)" % len(mine) in toast_text(other), toast_text(other)
    edges = other.evaluate("() => [...window.__hopline.state.graph.edges.values()].map((e) => [e.source, e.target])")
    assert edges and all(a in got and b in got for a, b in edges), "only the edges between the vertices that came"


def test_the_limit_is_clamped_remembered_and_changes_the_link(page, mock):
    scene(page, mock)
    open_menu(page)
    page.fill("#shareMax", "2"); page.dispatch_event("#shareMax", "change")
    assert page.input_value("#shareMax") == "5"
    page.fill("#shareMax", "99999"); page.dispatch_event("#shareMax", "change")
    assert page.input_value("#shareMax") == "500"
    page.fill("#shareMax", "7"); page.dispatch_event("#shareMax", "change")
    small = make_link(page, limit=7)
    big = make_link(page, limit=500)
    assert len(small) < len(big)
    assert json.loads(page.evaluate("() => localStorage.getItem('hopline.prefs.v1')"))["shareMax"] == 500
    page.reload(); page.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert page.input_value("#shareMax") == "500"


def test_notes_stay_home_unless_the_box_is_ticked_and_labels_and_tags_go(page, ctx, mock):
    scene(page, mock)
    page.evaluate("(id) => { const n = window.__hopline.state.graph.nodes.get(id); n.label = 'the exchange'; n.note = 'my private note'; n.tag = 'EXCH'; }", START)
    plain = open_link(ctx, make_link(page, limit=500))
    n = plain.evaluate("(id) => { const x = window.__hopline.state.graph.nodes.get(id); return { label: x.label, note: x.note || null, tag: x.tag || null }; }", START)
    assert n == {"label": "the exchange", "note": None, "tag": "EXCH"}, n
    assert "your notes are not" in toast_text(page)
    with_notes = open_link(ctx, make_link(page, limit=500, notes=True))
    assert with_notes.evaluate("(id) => window.__hopline.state.graph.nodes.get(id).note", START) == "my private note"
    assert "and your notes" in toast_text(page)


def test_a_trace_comes_back_as_a_trace_from_the_same_start(tpage, ctx, mock):
    peel_chain(mock, 8)
    open_query(tpage, tid(10)); capture(tpage)
    assert tpage.evaluate("() => window.__hopline.state.layout") == "trace"
    seeds = tpage.evaluate("() => window.__hopline.state.trace.seeds")
    assert seeds == [START]
    other = open_link(ctx, make_link(tpage, limit=50))
    assert other.evaluate("() => window.__hopline.state.layout") == "trace"
    assert other.evaluate("() => window.__hopline.state.trace.seeds") == seeds
    assert other.evaluate("() => window.__hopline.renderer.data.seedIds.has(%s)" % json.dumps(START)), "START is marked START on the other side too"


def test_a_link_pasted_into_an_open_page_is_merged_and_can_be_undone(page, ctx, mock):
    scene(page, mock)
    link = make_link(page, limit=5)
    fresh = ctx.new_page(); fresh.goto(page.url.split("#")[0]); fresh.wait_for_function("window.__hopline && window.__hopline.renderer")
    open_query(fresh, tid(14)); settle(fresh)
    before = ids(fresh)
    fresh.evaluate("(h) => { window.location.hash = h; }", link[link.index("#"):])
    fresh.wait_for_function("() => document.getElementById('toast').textContent.indexOf('Opened a shared canvas') >= 0")
    after = ids(fresh)
    assert before < after, "the vertices of the link were added to what was open"
    assert "merged into the current workspace" in toast_text(fresh)
    assert "#s1/" not in fresh.url
    fresh.click("#btnUndoLoad"); settle(fresh)
    assert ids(fresh) == before, "undone"


def test_a_damaged_or_foreign_link_says_why_and_leaves_the_page_working(page, ctx, mock):
    base = page.url.split("#")[0]
    for tail, words in (("abc def", "characters that do not belong"), ("AAAA", "damaged or was cut short"), ("", "empty")):
        p = ctx.new_page(); p.goto(base + "#s1/" + tail)
        p.wait_for_function("window.__hopline && window.__hopline.renderer")
        p.wait_for_function("() => !document.getElementById('toast').hidden")
        assert "could not be opened" in toast_text(p) and words in toast_text(p), (tail, toast_text(p))
        assert p.evaluate("() => window.__hopline.state.graph.nodes.size") == 0
        assert "#s1/" not in p.url
        p.close()


def test_there_is_nothing_to_share_on_an_empty_canvas(page):
    capture(page)
    open_menu(page); page.click("[data-export=link]")
    page.wait_for_function("() => !document.getElementById('toast').hidden")
    assert "Nothing on the canvas to share" in toast_text(page) or "Nothing to export yet" in toast_text(page)
    assert page.evaluate("() => window.__copied.length") == 0
