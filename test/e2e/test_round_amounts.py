"""ROUND: an output that is a round amount, a number somebody chose. A badge, a chip, a row in the Findings, a detection, a report line, two settings,
and nothing for what a machine made."""
import json

import pytest

from chains import IN, OUT, addr, tid, tx
from helpers import open_query, settle
from test_find_strip import labels
from test_report import make_report, verify
from test_trace import drawn_texts

BTC = 100_000_000


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def pay(mock, n, payer, payee, amount, change):
    """One payer pays `amount` to one payee and gets `change` back; the fee is 150 satoshis."""
    tx(mock, n, [IN(90 + n, 0, payer, amount + change + 150)], [OUT(payee, amount), OUT("chg%d" % n, change)])
    return "tx:" + tid(n)


def flags(page):
    return dict(page.evaluate("() => [...window.__hopline.analysis().tx].map(([id, r]) => [id, r.flags.map((f) => f.short)])"))


def badge_text_drawn(page, id_):
    """A name shows where there is room; the selected vertex always gets its text (the ring is there whatever the room)."""
    page.evaluate("(id) => window.__hopline.setSel([id])", id_); settle(page)
    return any(t.startswith("ROUND") for t in drawn_texts(page))


def round_chip(page):
    return labels(page).get("round")


def test_a_round_payment_gets_a_badge_a_chip_a_findings_row_and_a_detection_and_an_odd_one_does_not(page, mock):
    one = pay(mock, 1, "alice", "shop", 1 * BTC, 49_991_234)                          # exactly 1 BTC
    two = pay(mock, 2, "bob", "cafe", 12_345_678, 5_001_234)                          # an odd amount
    open_query(page, tid(1)); open_query(page, tid(2))
    f = flags(page)
    assert f[one] == ["ROUND 1 BTC"] and f[two] == [], f
    assert badge_text_drawn(page, one), "the badge is drawn above the transaction"
    page.evaluate("() => window.__hopline.setSel([])"); settle(page)
    assert round_chip(page) == "ROUND1"
    page.click("#findStrip [data-key=round]"); settle(page)
    assert set(page.evaluate("() => [...window.__hopline.state.selected]")) == {one}, "the chip selects the transaction"
    page.evaluate("() => window.__hopline.openFindings()"); settle(page)
    assert "ROUND" in page.inner_text("#anFindings [data-group=round]") and "1" in page.inner_text("#anFindings [data-group=round]")
    pill = page.locator("#detKinds button:has-text('ROUND 1')")
    assert pill.count() == 1
    pill.click(); settle(page)
    rows = page.locator("#detList .detrow")
    assert rows.count() == 1 and "ROUND 1 BTC" in rows.first.inner_text() and "somebody chose" in rows.first.inner_text()


def test_the_switch_decides_what_is_drawn_and_the_settings_decide_what_is_round(page, mock):
    pay(mock, 1, "alice", "shop", 1 * BTC, 49_991_234)
    pay(mock, 3, "carl", "dan", 1_230_000, 769_321)                                   # 0.0123 BTC: a multiple of 0.0001 BTC but not of 0.001 BTC
    open_query(page, tid(1)); open_query(page, tid(3))
    assert round_chip(page) == "ROUND2"
    assert badge_text_drawn(page, "tx:" + tid(1)), "drawn while the switch is on"
    page.uncheck("#anKRound"); settle(page)
    assert not badge_text_drawn(page, "tx:" + tid(1)), "switched off: nothing is drawn"
    assert round_chip(page) == "ROUND2", "the findings still count what was found"
    page.check("#anKRound"); settle(page)
    page.select_option("#anRoundZeros", "5"); settle(page)
    assert round_chip(page) == "ROUND1", "a multiple of 0.001 BTC: only the 1 BTC payment"
    page.select_option("#anRoundZeros", "4"); settle(page)
    page.fill("#anRoundMin", "2"); page.dispatch_event("#anRoundMin", "change"); settle(page)
    assert round_chip(page) is None, "nothing is that large"
    page.fill("#anRoundMin", "0.01"); page.dispatch_event("#anRoundMin", "change"); settle(page)
    assert round_chip(page) == "ROUND2"
    page.select_option("#anRoundZeros", "5"); settle(page)
    prefs = json.loads(page.evaluate("() => localStorage.getItem('hopline.prefs.v1')"))["analysis"]
    assert prefs["round"] == {"minZeros": 5, "minSats": 1_000_000} and prefs["kinds"]["round"] is True
    page.reload(); page.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert page.evaluate("() => document.getElementById('anRoundZeros').value") == "5" and float(page.evaluate("() => document.getElementById('anRoundMin').value")) == 0.01, "kept"


def test_settings_saved_before_the_option_get_the_defaults_and_rubbish_is_clamped(newpage):
    newpage.evaluate("() => localStorage.setItem('hopline.prefs.v1', JSON.stringify({ analysis: { flags: true, kinds: { peel: true } } }))")
    newpage.reload(); newpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert newpage.evaluate("() => document.getElementById('anKRound').checked") is True
    assert newpage.evaluate("() => document.getElementById('anRoundZeros').value") == "4" and float(newpage.evaluate("() => document.getElementById('anRoundMin').value")) == 0.01
    newpage.evaluate("() => localStorage.setItem('hopline.prefs.v1', JSON.stringify({ analysis: { round: { minZeros: 99, minSats: 'a lot' } } }))")
    newpage.reload(); newpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert newpage.evaluate("() => window.__hopline.state.analysis.round") == {"minZeros": 6, "minSats": 1_000_000}


def test_spending_from_a_service_wallet_is_left_out_and_a_payment_into_one_is_not(page, mock):
    one = pay(mock, 1, "alice", "shop", 1 * BTC, 49_991_234)
    open_query(page, tid(1))
    assert flags(page)[one] == ["ROUND 1 BTC"]
    tag = "([id, t]) => { window.__hopline.state.graph.nodes.get(id).tag = t; window.__hopline.refresh(); }"
    page.evaluate(tag, ["addr:" + addr("shop"), "EXCH"]); settle(page)
    assert flags(page)[one] == ["ROUND 1 BTC"], "the shop is a service wallet: a round payment into it is the kind of thing this is for"
    page.evaluate(tag, ["addr:" + addr("alice"), "EXCH"]); settle(page)
    assert flags(page)[one] == [], "alice is a service wallet: an exchange paying out, not somebody choosing"
    assert round_chip(page) is None


def test_what_a_machine_made_is_not_round(page, mock):
    one = pay(mock, 1, "alice", "shop", 1 * BTC, 49_991_234)                          # a person's payment, for contrast
    tx(mock, 5, [IN(70 + i, 0, "k%d" % i, 30_000_000) for i in range(5)], [OUT("sink", 1 * BTC), OUT("chg5", 49_991_234)])                  # a consolidation
    tx(mock, 6, [IN(95, 0, "src", 5 * BTC)], [OUT("r%d" % i, 1 * BTC) for i in range(3)] + [OUT("chg6", 199_991_234)])                       # the same amount to three recipients
    open_query(page, tid(1)); open_query(page, tid(5)); open_query(page, tid(6))
    f = flags(page)
    assert f[one] == ["ROUND 1 BTC"], "the person's payment is flagged"
    assert f["tx:" + tid(5)] == ["CONSOL 5→2"] and f["tx:" + tid(6)] == [], "and the machine shapes are not: " + str(f)
    assert round_chip(page) == "ROUND1"


def test_the_report_names_the_amount_and_says_what_the_rule_is(page, mock, tmp_path):
    pay(mock, 1, "alice", "shop", 1 * BTC, 49_991_234)
    open_query(page, tid(1))
    p = make_report(page, tmp_path)
    body = p.read_text(encoding="utf-8")
    assert "ROUND 1 BTC" in body and "round amount (an output of at least 0.01 BTC that is a multiple of 0.0001 BTC" in body
    r = verify(p)
    assert r.returncode == 0 and "OK:" in r.stdout, r.stdout + r.stderr
