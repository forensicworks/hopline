"""SWAP: an OP_RETURN in THORChain's swap-memo format. A badge, a chip, a row in the Findings, a detection, a hand-off row, a switch; and the SWAP tag for a swap or bridge service.
The memo, the wallets and the transactions here are invented in the shape THORChain documents: none of them is a real transaction."""
import json

import pytest

from chains import IN, OUT, addr, tid, tx
from conftest import NORMAL
from helpers import idle, open_query, settle
from test_find_strip import labels
from test_trace import drawn_texts

DEST = "0x" + "44" * 20
MEMO = "=:ETH.WBTC:" + DEST + ":1234e4/3/10:aff:5"


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def data_out(text):
    b = text.encode("utf-8")
    return {"scriptpubkey": "6a%02x%s" % (len(b), b.hex()), "scriptpubkey_type": "op_return", "value": 0}


def swap_tx(mock, n=1, memo=MEMO, payer="alice", spent=None):
    """The payer pays a service (vault) and gets change back; the memo asks for the payment to be swapped. Amounts are not round."""
    tx(mock, n, [IN(90 + n, 0, payer, 5_000_150)], [OUT("vault", 3_123_456), OUT("back%d" % n, 1_876_544), data_out(memo)], spent=spent)
    return "tx:" + tid(n)


def flags(page):
    return dict(page.evaluate("() => [...window.__hopline.analysis().tx].map(([id, r]) => [id, r.flags.map((f) => f.short)])"))


def badge_text_drawn(page, id_):
    page.evaluate("(id) => window.__hopline.setSel([id])", id_); settle(page)
    return any(t.startswith("SWAP") for t in drawn_texts(page))


def test_a_swap_memo_gets_a_badge_a_chip_a_findings_row_and_a_detection_and_a_plain_payment_does_not(page, mock):
    one = swap_tx(mock, 1)
    open_query(page, tid(1)); open_query(page, NORMAL["txid"])
    f = flags(page)
    assert f[one] == ["SWAP → ETH"] and f["tx:" + NORMAL["txid"]] == [], f
    assert badge_text_drawn(page, one), "the badge is drawn above the transaction"
    page.evaluate("() => window.__hopline.setSel([])"); settle(page)
    assert labels(page).get("swap") == "SWAP1"
    assert "THORChain" in page.get_attribute("#findStrip [data-key=swap]", "title") and "not proof" in page.get_attribute("#findStrip [data-key=swap]", "title")
    page.click("#findStrip [data-key=swap]"); settle(page)
    assert set(page.evaluate("() => [...window.__hopline.state.selected]")) == {one}, "the chip selects the transaction"
    page.evaluate("() => window.__hopline.openFindings()"); settle(page)
    assert "SWAP" in page.inner_text("#anFindings [data-group=swap]")
    pill = page.locator("#detKinds button:has-text('SWAP 1')")
    assert pill.count() == 1
    pill.click(); settle(page)
    rows = page.locator("#detList .detrow")
    assert rows.count() == 1 and "SWAP → ETH" in rows.first.inner_text() and "paid out to " + DEST in rows.first.inner_text()
    assert "does not show that the swap was carried out" in rows.first.inner_text()


def test_the_details_of_the_transaction_say_what_the_memo_asks_for(page, mock):
    one = swap_tx(mock, 1)
    open_query(page, tid(1))
    page.evaluate("(id) => window.__hopline.setSel([id])", one); settle(page)
    text = page.inner_text("#inspBody")
    assert "SWAP → ETH" in text and "into ETH.WBTC, paid out to " + DEST in text
    assert "limit 1234e4, streamed in 10 parts, every 3 blocks, affiliate aff (5 basis points)" in text


def test_other_memos_and_other_text_are_not_swaps(page, mock):
    swap_tx(mock, 1, memo="OUT:" + "ab" * 32)                                          # a THORChain payout, not a swap request
    swap_tx(mock, 2, memo="hello world", payer="bob")
    swap_tx(mock, 3, memo="=:e:short", payer="carl")                                   # the one-letter asset form needs an address-length destination
    for n in (1, 2, 3):
        open_query(page, tid(n))
    assert all(v == [] for v in flags(page).values()), flags(page)
    assert labels(page).get("swap") is None


def test_the_switch_decides_what_is_drawn_and_is_remembered(page, mock):
    one = swap_tx(mock, 1)
    open_query(page, tid(1))
    assert badge_text_drawn(page, one), "drawn while the switch is on"
    page.uncheck("#anKSwap"); settle(page)
    assert not badge_text_drawn(page, one), "switched off: nothing is drawn"
    assert labels(page).get("swap") == "SWAP1", "the findings still count what was found"
    assert json.loads(page.evaluate("() => localStorage.getItem('hopline.prefs.v1')"))["analysis"]["kinds"]["swap"] is False
    page.reload(); page.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert page.evaluate("() => window.__hopline.state.analysis.kinds.swap") is False


def test_the_hand_offs_name_a_swap_memo_the_trail_reaches_and_the_row_shows_the_route_to_it(tpage, mock):
    tx(mock, 1, [IN(90, 0, "ran", 900_150)], [OUT("mid", 900_000)], spent={0: 2})
    swap_tx(mock, 2, payer="mid")
    mock.routes["/tx/" + tid(2)]["vin"][0] = IN(1, 0, "mid", 900_000)                  # tx 2 spends what tx 1 paid to mid
    open_query(tpage, tid(1)); open_query(tpage, tid(2))
    tpage.evaluate("() => window.__hopline.openFindings()"); settle(tpage)
    chip = tpage.inner_text("#findStrip [data-key=handoff]")
    assert chip, "a hand-off chip"
    tpage.click("#findStrip [data-key=handoff]"); settle(tpage)
    row = tpage.locator("#anFindings [data-handoff=deposit][data-swap]")
    assert row.count() == 1
    assert "Swap memo: into ETH.WBTC, paid out to " + DEST in row.inner_text() and "swap memo" in row.inner_text()
    text = tpage.inner_text("#anFindings").lower()                                       # the headings are in capitals
    assert "hand-offs" in text and "service hand-offs" not in text, "a swap memo makes the heading plain Hand-offs"
    row.click(); idle(tpage); settle(tpage)
    ids = set(tpage.evaluate("() => { const c = window.__hopline.renderer.chain; return c ? [...c.ids] : []; }"))
    assert {"tx:" + tid(1), "tx:" + tid(2)} <= ids, "the route from the reference to the swap is lit"


def test_a_wallet_tagged_swap_is_a_service_and_the_preset_is_offered(tpage, mock):
    tx(mock, 1, [IN(90, 0, "ran", 900_150)], [OUT("mid", 900_000)], spent={0: 2})
    swap_tx(mock, 2, payer="mid", memo="hello world")                                    # no memo to read: only the tag makes the vault a service
    mock.routes["/tx/" + tid(2)]["vin"][0] = IN(1, 0, "mid", 900_000)
    open_query(tpage, tid(1)); open_query(tpage, tid(2))
    tpage.evaluate("(id) => window.__hopline.setSel([id])", "addr:" + addr("vault")); settle(tpage)    # the tag controls are in the Details of a selected vertex
    assert tpage.locator("#fTag option[value=SWAP]").count() == 1 and "Swap / bridge" in tpage.inner_text("#fTag option[value=SWAP]")
    assert tpage.locator("#findStrip [data-key=handoff]").count() == 0, "nothing is a service yet"
    tpage.select_option("#fTag", "SWAP"); settle(tpage)
    assert tpage.evaluate("(id) => window.__hopline.state.graph.nodes.get(id).tag", "addr:" + addr("vault")) == "SWAP"
    tpage.click("#findStrip [data-key=handoff]"); settle(tpage)
    row = tpage.locator("#anFindings [data-handoff=deposit]")
    assert row.count() == 1 and row.get_attribute("data-swap") is None, "a service hand-off, not a swap memo"


RID = "0x" + "ab" * 32                                                                 # invented: the shape of a cross-chain request ID, not a real one


def test_a_request_id_is_flagged_and_the_details_offer_a_look_up_in_relay_for_it_alone(page, mock):
    one = swap_tx(mock, 1, memo=RID)
    two = swap_tx(mock, 2, payer="bob")                                                # a swap memo: nothing to look up in Relay
    open_query(page, tid(1)); open_query(page, tid(2))
    assert flags(page)[one] == ["SWAP ID"] and flags(page)[two] == ["SWAP → ETH"], flags(page)
    assert labels(page).get("swap") == "SWAP2"
    page.evaluate("(id) => window.__hopline.setSel([id])", one); settle(page)
    link = page.locator("#inspBody a:has-text('Look up in Relay')")
    assert link.count() == 1 and link.get_attribute("href") == "https://relay.link/transaction/" + RID
    assert link.get_attribute("target") == "_blank" and link.get_attribute("rel") == "noopener noreferrer"
    text = page.inner_text("#inspBody")
    assert "SWAP ID" in text and RID in text and "does not say where the money went" in text
    page.evaluate("(id) => window.__hopline.setSel([id])", two); settle(page)
    assert page.locator("#inspBody a:has-text('Look up in Relay')").count() == 0


def test_the_relay_link_is_not_offered_while_the_data_source_is_tor(page, mock):
    one = swap_tx(mock, 1, memo=RID)
    open_query(page, tid(1))
    page.select_option("#source", "tor"); settle(page)
    page.evaluate("(id) => window.__hopline.setSel([id])", one); settle(page)
    assert page.locator("#inspBody a:has-text('Look up in Relay')").count() == 0, "it would go outside Tor and tell Relay what is being looked at"
    assert "SWAP ID" in page.inner_text("#inspBody"), "the flag is still there"


def test_the_hand_offs_name_a_request_id_as_a_cross_chain_request(tpage, mock):
    tx(mock, 1, [IN(90, 0, "ran", 900_150)], [OUT("mid", 900_000)], spent={0: 2})
    swap_tx(mock, 2, payer="mid", memo=RID)
    mock.routes["/tx/" + tid(2)]["vin"][0] = IN(1, 0, "mid", 900_000)
    open_query(tpage, tid(1)); open_query(tpage, tid(2))
    tpage.evaluate("() => window.__hopline.openFindings()"); settle(tpage)
    tpage.click("#findStrip [data-key=handoff]"); settle(tpage)
    row = tpage.locator("#anFindings [data-handoff=deposit][data-swap]")
    assert row.count() == 1 and "Cross-chain request: ID 0xabababab…ababab" in row.inner_text()


def halves(page, id_):
    """The canvas colour a few pixels up and to the left of a vertex's centre, and the same distance down and to the right: the two halves of a transaction."""
    return page.evaluate("""(id) => { const r = window.__hopline.renderer, p = r.positionOf(id), v = r.view, c = r.canvas, k = c.width / c.clientWidth, ctx = c.getContext('2d');
        const at = (dx, dy) => Array.from(ctx.getImageData(Math.round((p.x * v.k + v.x + dx) * k), Math.round((p.y * v.k + v.y + dy) * k), 1, 1).data).slice(0, 3);
        return { upper: at(-3, -3), lower: at(3, 3) }; }""", id_)


def orange(rgb):
    return rgb[0] > rgb[2] + 60 and rgb[0] > 150


def blue(rgb):
    return rgb[2] > rgb[0] + 40


def test_a_transaction_with_a_swap_memo_has_its_upper_left_half_in_the_swap_colour_and_a_plain_one_does_not(page, mock):
    one = swap_tx(mock, 1)
    open_query(page, tid(1)); open_query(page, NORMAL["txid"])
    page.evaluate("() => window.__hopline.setSel([])"); settle(page)
    h = halves(page, one)
    assert orange(h["upper"]) and blue(h["lower"]), h
    plain = halves(page, "tx:" + NORMAL["txid"])
    assert blue(plain["upper"]) and blue(plain["lower"]), plain


def test_the_half_follows_the_switches_and_the_legend_says_what_it_is(page, mock):
    one = swap_tx(mock, 1)
    open_query(page, tid(1)); page.evaluate("() => window.__hopline.setSel([])"); settle(page)
    assert orange(halves(page, one)["upper"]) and "orange half" in page.inner_text("#legend")
    page.uncheck("#anKSwap"); settle(page)
    assert blue(halves(page, one)["upper"]) and "orange half" not in page.inner_text("#legend"), "SWAP switched off"
    page.check("#anKSwap"); settle(page)
    assert orange(halves(page, one)["upper"])
    page.uncheck("#anFlags"); settle(page)
    assert blue(halves(page, one)["upper"]) and "orange half" not in page.inner_text("#legend"), "Flag patterns on transactions switched off"


def test_a_plain_transaction_has_no_swap_entry_in_the_legend(page, mock):
    open_query(page, NORMAL["txid"]); settle(page)
    assert "orange half" not in page.inner_text("#legend")


def test_on_a_round_payment_the_swap_badge_gets_the_text_and_the_half_marks_it_whatever_the_badges_do(page, mock):
    tx(mock, 5, [IN(95, 0, "carl", 150_000_273)], [OUT("vault5", 100_000_000), OUT("back5", 49_999_123), data_out(MEMO)])
    open_query(page, tid(5))
    flags_of = flags(page)
    assert flags_of["tx:" + tid(5)] == ["SWAP → ETH", "ROUND 1 BTC"], "the memo comes first"
    page.evaluate("(id) => window.__hopline.setSel([id])", "tx:" + tid(5)); settle(page)
    texts = drawn_texts(page)
    assert any(t.startswith("SWAP") for t in texts) and not any(t.startswith("ROUND") for t in texts), "the second badge is the dot"
    page.evaluate("() => window.__hopline.setSel([])"); settle(page)
    assert orange(halves(page, "tx:" + tid(5))["upper"]), "and the half marks it whatever the badges do"
