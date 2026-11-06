"""Every transaction row in a wallet's details and in the choose-what-to-show list says when, to the minute and in UTC; a row with no time says why."""
import re
from datetime import datetime, timezone

import pytest

from helpers import idle, open_query, settle
from test_step_choice import trace_of
from test_trace import click_handle
from test_wallet_panel import W, W_ID, wallet

MINUTE = re.compile(r"\d{4}-\d\d-\d\d \d\d:\d\d UTC")
SECOND = re.compile(r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC")


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def utc(unix):
    return datetime.fromtimestamp(unix, timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def whens(page):
    return page.eval_on_selector_all("#inspBody .walletsec .rowcopy:not(.groupwrap) .linkrow .when", "els => els.map(e => ({ text: e.textContent, title: e.title, unknown: e.classList.contains('unknown') }))")


def test_every_transaction_of_a_wallet_says_when_to_the_minute_with_the_seconds_on_hover(fpage, mock):
    wallet(mock)
    open_query(fpage, W)
    w = whens(fpage)
    n = fpage.locator("#inspBody .walletsec .rowcopy .linkrow:not(.groupbtn)").count()
    assert len(w) == n, "a time, or the reason for none, on every row: %d rows, %d times" % (n, len(w))
    known = [x for x in w if not x["unknown"]]
    assert len(known) >= 12, "the twelve transactions of the history are loaded"
    assert all(MINUTE.fullmatch(x["text"]) for x in known), [x["text"] for x in known][:3]
    assert all(SECOND.fullmatch(x["title"]) and x["title"][:16] == x["text"][:16] for x in known), "the seconds are in the hover"
    assert utc(1650000000 + 100 * 600) in [x["text"] for x in known], "the transaction numbered 100 is at the time the fixture gives it"
    assert all(x["text"].startswith("date unknown") for x in w if x["unknown"]), "a row with no time says so instead of staying empty"


def test_a_row_without_a_time_says_why(fpage, mock):
    wallet(mock)
    open_query(fpage, W)
    before = len([x for x in whens(fpage) if x["unknown"]])
    fpage.evaluate("""() => { const h = window.__hopline, g = h.state.graph, ids = [...g.nodes.keys()].filter((k) => k.startsWith('tx:') && g.nodes.get(k).time != null).slice(0, 2);
        const a = g.nodes.get(ids[0]), b = g.nodes.get(ids[1]);
        a.time = null; a.confirmed = false;                       // in the mempool
        b.time = null; b.confirmed = null; b.loaded = false;      // known only as the spender of an output
        h.setSel([]); h.setSel(['""" + W_ID + """']); }""")
    w = whens(fpage)
    texts = [x["text"] for x in w]
    assert "unconfirmed" in texts and "date unknown (not loaded yet)" in texts, texts
    unknown = [x for x in w if x["unknown"]]
    assert len(unknown) == before + 2 and all(x["title"] for x in unknown), "two more, each with an explanation on hover: %r" % unknown[:2]
    assert [x["title"] for x in unknown if x["text"] == "unconfirmed"] == ["Not in a block yet"]


def test_the_choose_list_gives_the_time_of_the_transaction_for_wallet_rows(fpage, mock):
    tx = trace_of(fpage, mock, 6)
    click_handle(fpage, tx, "right"); idle(fpage)
    subs = fpage.eval_on_selector_all("#ctxMenu .chooserrow .what small", "els => els.map(e => e.textContent)")
    assert len(subs) == 6 and all(s.startswith(utc(1650000000)) for s in subs), subs


def test_the_choose_list_gives_the_time_of_a_transaction_to_the_minute(fpage, mock):
    wallet(mock)
    open_query(fpage, W)
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    click_handle(fpage, W_ID, "right"); idle(fpage)
    assert fpage.is_visible("#ctxMenu .chooser"), "a list to choose from"
    subs = fpage.eval_on_selector_all("#ctxMenu .chooserrow:not(.grouphead) .what small", "els => els.map(e => e.textContent)")
    assert subs and all(MINUTE.search(s) for s in subs), subs[:3]
