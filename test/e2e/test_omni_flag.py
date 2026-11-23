"""OMNI: an OP_RETURN that starts with "omni" holds an instruction of the Omni Layer (the protocol Tether's USDT began on). It is decoded (the token and the amount of a simple send, who sends and who
receives), flagged with a badge, a chip and a detection, and said not to be a movement of bitcoin. It is what the sender wrote, so it is not counted with the findings. The transaction here is invented;
the payload is the one of a real Tether send, which is public."""
import json
import re

import pytest

from chains import IN, OUT, tid, tx
from conftest import NORMAL
from helpers import open_query, settle
from test_find_strip import labels
from test_trace import drawn_texts

SEND_USDT = "6f6d6e69000000000000001f0000048c27395000"                                  # omni, version 0, simple send, property 31, 5,000,000,000,000 units = 50,000 USDT


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def data_out(payload_hex):
    return {"scriptpubkey": "6a%02x%s" % (len(payload_hex) // 2, payload_hex), "scriptpubkey_type": "op_return", "value": 0}


def omni_tx(mock, n=1, payload=SEND_USDT, sender="sender"):
    """The sender pays a marker to the receiver, writes the instruction, and pays the change back to itself (the shape of a Tether send)."""
    tx(mock, n, [IN(90 + n, 0, sender, 500_000)], [OUT("receiver%d" % n, 546), data_out(payload), OUT(sender, 499_000)])
    return "tx:" + tid(n)


def flags(page):
    return dict(page.evaluate("() => [...window.__hopline.analysis().tx].map(([id, r]) => [id, r.flags.map((f) => f.short)])"))


def badge_drawn(page, id_):
    page.evaluate("(id) => window.__hopline.setSel([id])", id_); settle(page)
    return any(t.startswith("OMNI") for t in drawn_texts(page))


def test_an_omni_instruction_gets_a_badge_a_chip_and_a_detection_and_is_not_counted_with_the_findings(page, mock):
    one = omni_tx(mock, 1)
    open_query(page, tid(1)); open_query(page, NORMAL["txid"])
    f = flags(page)
    assert f[one] == ["OMNI"] and f["tx:" + NORMAL["txid"]] == [], f
    assert badge_drawn(page, one), "the badge is drawn above the transaction"
    page.evaluate("() => window.__hopline.setSel([])"); settle(page)
    assert labels(page).get("omni") == "OMNI1"
    title = page.get_attribute("#findStrip [data-key=omni]", "title")
    assert "Omni Layer instruction" in title and "Not a finding" in title and "not on Bitcoin" in title
    counted = sum(int(re.search(r"(\d+)$", t).group(1)) for k, t in labels(page).items() if k not in ("omni", "known", "open", "handoff", "offscreen", "holding", "details"))
    assert page.inner_text("#findCount").strip() == "(%d)" % counted and counted > 0, "what the sender wrote is not counted with the findings: the other chips add up to the count shown"
    page.click("#findStrip [data-key=omni]"); settle(page)
    assert set(page.evaluate("() => [...window.__hopline.state.selected]")) == {one}, "the chip selects the transaction"
    page.evaluate("() => window.__hopline.openFindings()"); settle(page)
    pill = page.locator("#detKinds button:has-text('OMNI 1')")
    assert pill.count() == 1
    pill.click(); settle(page)
    rows = page.locator("#detList .detrow")
    assert rows.count() == 1 and "OMNI" in rows.first.inner_text() and "simple send of 50,000 TetherUS (USDT)" in rows.first.inner_text()


def test_the_details_say_what_it_asks_who_sends_and_who_receives_and_that_the_bitcoin_amounts_are_not_the_value(page, mock):
    one = omni_tx(mock, 1)
    open_query(page, tid(1))
    page.evaluate("(id) => window.__hopline.setSel([id])", one); settle(page)
    text = page.inner_text("#inspBody")
    assert "OMNI" in text and "simple send of 50,000 TetherUS (USDT)" in text
    assert "From bc1qsender" in text and " to bc1qreceiver1" in text
    assert "the bitcoin amounts of this transaction are not the value moved" in text
    assert "Hopline cannot check that" in text


def test_the_op_return_output_is_decoded_instead_of_left_as_hex(page, mock):
    omni_tx(mock, 1)
    open_query(page, tid(1))
    page.evaluate("(id) => window.__hopline.setSel([id])", "data:%s:1" % tid(1)); settle(page)
    text = page.inner_text("#inspBody")
    assert SEND_USDT in text, "the hex is still there"
    assert "Omni Layer" in text and "simple send of 50,000 TetherUS (USDT)" in text
    assert "not on Bitcoin" in text


def test_the_legend_names_the_ring_only_while_there_is_one_and_the_switch_is_on(page, mock):
    omni_tx(mock, 1)
    open_query(page, tid(1))
    body = lambda: page.evaluate("() => document.body.textContent")
    assert "yellow ring = an Omni Layer instruction" in body()
    page.uncheck("#anKOmni"); settle(page)
    assert "yellow ring = an Omni Layer instruction" not in body()


def test_other_text_in_an_op_return_is_not_an_omni_instruction(page, mock):
    omni_tx(mock, 1, payload="68656c6c6f20776f726c64")                                  # "hello world"
    omni_tx(mock, 2, payload="6f6d6e6900", sender="bob")                               # starts with omni and says nothing
    for n in (1, 2):
        open_query(page, tid(n))
    assert all(v == [] for v in flags(page).values()), flags(page)
    assert labels(page).get("omni") is None


def test_the_switch_decides_what_is_drawn_and_is_remembered(page, mock):
    one = omni_tx(mock, 1)
    open_query(page, tid(1))
    assert badge_drawn(page, one), "drawn while the switch is on"
    page.uncheck("#anKOmni"); settle(page)
    assert not badge_drawn(page, one), "switched off: nothing is drawn"
    assert labels(page).get("omni") == "OMNI1", "the findings still show what was found"
    assert json.loads(page.evaluate("() => localStorage.getItem('hopline.prefs.v1')"))["analysis"]["kinds"]["omni"] is False
    page.reload(); page.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert page.evaluate("() => window.__hopline.state.analysis.kinds.omni") is False
