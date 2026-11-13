"""A link that cuts a transaction carries the pattern names the sender's Hopline found on it: the reader sees them at once, drawn dashed and labelled as the sender's, unchecked and
apart from the findings, and loading the transaction in full replaces them with what the data says."""
import pytest

from helpers import idle, settle
from test_share_link import capture, make_link, open_link
from test_share_partial_tx import CJ, flags, reader, select, sender


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def carried(page):
    return page.evaluate("(id) => { const n = window.__hopline.state.graph.nodes.get(id); return n && n.carried ? n.carried : null; }", CJ)


def rings(page):
    return page.evaluate("(id) => window.__hopline.renderer.findingRings.filter((r) => r.id === id).map((r) => r.kind)", CJ)


def test_a_cut_transaction_arrives_with_the_sender_pattern_and_the_canvas_draws_it(tpage, ctx, mock):
    r = reader(tpage, ctx, mock, 5)
    assert carried(r) == ["COINJOIN?"]
    assert rings(r) == ["coinjoin"], "a ring in the pattern's colour round the transaction"
    assert "carries the patterns the sender saw, drawn dashed with (sender)" in r.inner_text("#toast")


def test_the_mark_is_not_a_finding_it_stays_out_of_the_analysis_counts(tpage, ctx, mock):
    r = reader(tpage, ctx, mock, 5)
    assert flags(r) == [], "nothing is concluded from a transaction that is only partly there"
    an = r.evaluate("() => { const a = window.__hopline.analysis(); return { flagged: a.counts.flagged, carried: a.carried.size }; }")
    assert an == {"flagged": 0, "carried": 1}


def test_the_details_say_the_sender_saw_it_and_that_it_has_not_been_checked_here(tpage, ctx, mock):
    r = reader(tpage, ctx, mock, 5)
    select(r)
    box = r.inner_text("#inspector")
    assert "patterns the sender saw" in box.lower() and "COINJOIN?" in box, box                      # the label is drawn in capitals by the page style
    assert "has not been checked here" in box and "Show backward or Show forward" in box


def test_loading_the_transaction_in_full_replaces_the_mark_with_what_the_data_says(tpage, ctx, mock):
    r = reader(tpage, ctx, mock, 5)
    select(r)
    r.click("#inspector button:has-text('Show backward')"); idle(r); settle(r)
    assert carried(r) is None, "the field is gone"
    assert any(f.startswith("COINJOIN") for f in flags(r)), "the analysis itself says it now"
    select(r)
    assert "patterns the sender saw" not in r.inner_text("#inspector").lower()


def test_a_link_that_kept_the_whole_transaction_carries_nothing(tpage, ctx, mock):
    r = reader(tpage, ctx, mock, 500)
    assert carried(r) is None and any(f.startswith("COINJOIN") for f in flags(r))
    assert "carries the patterns" not in r.inner_text("#toast")


def test_the_mark_costs_a_few_dozen_characters_of_link(tpage, mock):
    sender(tpage, mock)
    marked = make_link(tpage, limit=5)
    tpage.evaluate("() => { const c = document.getElementById('anFlags'); c.checked = false; c.dispatchEvent(new Event('change')); }"); settle(tpage)
    plain = make_link(tpage, limit=5)
    assert 0 < len(marked) - len(plain) < 150, (len(marked), len(plain))


def test_marks_the_reader_only_received_are_not_passed_on_in_the_next_link(tpage, ctx, mock):
    r = reader(tpage, ctx, mock, 5)
    assert carried(r) == ["COINJOIN?"]
    capture(r)
    again = open_link(ctx, make_link(r, limit=5))
    assert carried(again) is None, "only patterns your own analysis found travel"


def test_what_a_link_cannot_say_never_reaches_the_screen(tpage, ctx, mock):
    r = reader(tpage, ctx, mock, 5)
    r.evaluate("(id) => { window.__hopline.state.graph.nodes.get(id).carried = ['<img src=x onerror=alert(1)>', 'COINJOIN?', 'ROUND 1e999 BTC', 'PWNED']; window.__hopline.refresh(); }", CJ)
    settle(r)
    select(r)
    box = r.inner_text("#inspector")
    assert "COINJOIN?" in box and "pwned" not in box.lower() and "onerror" not in box.lower() and "1e999" not in box.lower()
    assert r.evaluate("() => document.querySelectorAll('#inspector img').length") == 0
    assert rings(r) == ["coinjoin"]
