"""Patterns that are context (test payment, hand-off before confirming, split and collect) and the time of day of the trail, in the Findings and in the report.

The scene is the money scene (a victim pays the reference, which passes it on in two transactions) plus a test payment, a hand-off in one block and a split-and-collect run, all made up.
"""
import json
from datetime import datetime, timezone

import pytest

from chains import IN, OUT, addr, tid, tx
from helpers import idle, open_query, selected, settle, show_findings
from test_money_now import fix_fee, scene as money_scene
from test_time_evidence import bc, press, report_html, select  # noqa: F401 (bc is a fixture)


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def block(mock, n, height, time):
    r = mock.routes["/tx/" + tid(n)]
    r["status"]["block_height"], r["status"]["block_time"] = height, time


LATER = {3: 1650000000 + 3 * 86400}                                                    # transaction 3 is three days after transaction 2


def patterns_scene(page, mock):
    """The money scene, and then three more shapes loaded beside it."""
    money_scene(page, mock, unread=False, times=LATER)
    # a test payment: the same sender pays the same wallet 10,000 sat and ten minutes later 1,000,000
    tx(mock, 11, [IN(95, 0, "vv", 2000000)], [OUT("rr", 10000), OUT("vchg", 1989000)])
    tx(mock, 12, [IN(96, 0, "vv", 2000000)], [OUT("rr", 1000000), OUT("vchg2", 989000)])
    # a hand-off: 22 spends what 21 paid to another wallet, and both are in the same block
    tx(mock, 21, [IN(97, 0, "pa", 100000)], [OUT("px", 90000), OUT("pchg", 9000)], spent={0: 22})
    tx(mock, 22, [IN(21, 0, "px", 90000)], [OUT("py", 80000)], spent={0: 23})
    tx(mock, 23, [IN(22, 0, "py", 80000)], [OUT("pz", 70000)])
    for n in (21, 22, 23):
        block(mock, n, 700500, 1650300000)
    for n in (11, 12, 21, 22, 23):
        fix_fee(mock, n)
    # a run of three: each pays 'sr' and passes the rest on
    tx(mock, 31, [IN(98, 0, "s0", 1000000)], [OUT("sr", 60000), OUT("s1", 939900)], spent={1: 32})
    tx(mock, 32, [IN(31, 1, "s1", 939900)], [OUT("sr", 40000), OUT("s2", 899800)], spent={1: 33})
    tx(mock, 33, [IN(32, 1, "s2", 899800)], [OUT("sr", 20000), OUT("s3", 879700)])
    for n in (31, 32, 33):
        fix_fee(mock, n)
    for n in (11, 12, 21, 22, 23, 31, 32, 33):
        open_query(page, tid(n)); settle(page)
    page.evaluate("(ids) => window.__hopline.setSel(ids)", ["addr:" + addr("ref")]); settle(page)         # adding more may have moved the trail: the reference is the wallet the victim paid
    if page.locator("#inspBody .relbtn[data-use-ref]").count():
        page.click("#inspBody .relbtn[data-use-ref]"); settle(page)
    show_findings(page); settle(page)


def findings(page):
    return page.inner_text("#anFindings")


def test_the_three_patterns_are_listed_as_context_with_what_each_is(tpage, mock):
    patterns_scene(tpage, mock)
    t = findings(tpage).lower()
    assert "patterns that are context" in t and "not a lead" in t and "not counted with them" in t
    assert "test payment" in t and "0.00010000 btc, then 0.01000000 btc" in t and "×100" in t
    assert "hand-off before confirming" in t and "2 hand-offs in block 700,500" in t
    assert "split and collect" in t and "3 steps paying" in t and "0.00120000 btc" in t


def test_pressing_a_row_selects_the_transactions_of_the_pattern(tpage, mock):
    patterns_scene(tpage, mock)
    tpage.locator("#anFindings .linkrow", has_text="0.00010000 BTC, then").first.click(); settle(tpage)
    assert sorted(selected(tpage)) == sorted(["tx:" + tid(11), "tx:" + tid(12)])
    tpage.locator("#anFindings .linkrow", has_text="3 steps paying").first.click(); settle(tpage)
    assert sorted(selected(tpage)) == sorted(["tx:" + tid(31), "tx:" + tid(32), "tx:" + tid(33)])
    tpage.locator("#anFindings .linkrow", has_text="Hand-off before confirming").first.click(); settle(tpage)
    assert sorted(selected(tpage)) == sorted(["tx:" + tid(21), "tx:" + tid(22), "tx:" + tid(23)])


def test_without_any_of_the_shapes_there_is_no_such_group(tpage, mock):
    money_scene(tpage, mock, unread=False)
    assert "patterns that are context" not in findings(tpage).lower()


def test_the_time_of_day_of_the_trail_is_a_hypothesis_and_says_when_it_is_too_little(tpage, mock):
    money_scene(tpage, mock, unread=False, times=LATER)
    t = findings(tpage)
    assert "When the trail moved" in t or "WHEN THE TRAIL MOVED" in t
    assert "2 events" in t and "too few to say anything about a daily rhythm" in t and "At least 8 events over 3 days" in t
    assert "Not a finding" in t and "The times are those of the blocks" in t
    assert tpage.locator("#anFindings details.tztable summary").inner_text() == "All 27 offsets"
    table = tpage.evaluate("() => document.querySelector('#anFindings details.tztable pre').textContent")
    assert "UTC-12" in table and "UTC+14" in table and "waking" in table and "at night" in table


def test_asking_blockcypher_changes_the_times_and_the_panel_follows_without_anything_being_added(tpage, mock, bc):
    money_scene(tpage, mock, unread=False, times=LATER)
    first_seen = "2022-04-15T05:35:00.250Z"                                                      # the block of transaction 2 is at 05:40:00
    bc.replies[tid(2)] = {"hash": tid(2), "block_height": 700002, "confirmed": "2022-04-15T05:40:00Z", "received": first_seen, "relayed_by": "1.2.3.4:8333"}
    before = findings(tpage)
    assert "The times are those of the blocks" in before
    select(tpage, "tx:" + tid(2))
    press(tpage, "#btnFirstSeen", ok="#chkBlockcypher")
    show_findings(tpage); settle(tpage)
    after = findings(tpage)
    assert "Some times are when a service first saw the transaction" in after, after
    assert "2022-04-15 05:35:00 UTC" in after and "first seen" in after, "the event is at the time BlockCypher saw it, not at its block"
    assert "2022-04-15 05:35:00 UTC" not in before


def show_everything(page):
    """The report covers what is on screen: switch to the layout that shows all that is loaded."""
    page.click("#sideTab"); page.click("#layoutSeg [data-layout=flow]"); page.uncheck("#focusOn"); settle(page)


def test_the_report_has_both_sections_with_their_cautions_and_what_was_found(tpage, mock, tmp_path):
    patterns_scene(tpage, mock)
    show_everything(tpage)
    html = report_html(tpage, tmp_path, False)
    assert "<h2>When the trail moved</h2>" in html and "hypothesis about the local time of whoever sent them, not a finding" in html
    assert "2 events over" in html and "too few to say anything about a daily rhythm" in html and "<td>UTC-12</td>" in html and "<td>UTC+14</td>" in html
    assert "<h2>Patterns that are context</h2>" in html and "not a lead" in html
    assert "<h3>Test payment (1)</h3>" in html and "<h3>Hand-off before confirming (1)</h3>" in html and "<h3>Split and collect (1)</h3>" in html
    assert "100 times as much" in html and "3 transactions confirmed together in block 700,500" in html and "A run of 3 transactions with one input and two outputs" in html
    assert addr("rr") in html and tid(11) in html and tid(33) in html


def test_with_nothing_to_show_the_report_has_neither_section(tpage, mock, tmp_path):
    tx(mock, 1, [IN(90, 0, "a", 100000)], [OUT("b", 90000), OUT("c", 9000)])
    open_query(tpage, tid(1)); settle(tpage)
    html = report_html(tpage, tmp_path, False)
    assert "When the trail moved" not in html and "Patterns that are context" not in html
