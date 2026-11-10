"""SWAP: an OP_RETURN in THORChain's swap-memo format, the OUT: and REFUND: memos THORChain writes on a payment it makes, and a Rootstock peg-in. A badge, a chip, a row in the Findings, a detection, a hand-off row, a switch;
and the SWAP tag for a swap or bridge service. The memos, the wallets and the transactions here are invented in the shape the documents give: none of them is a real transaction."""
import json

import pytest

from chains import IN, OUT, addr, tid, tx
from conftest import NORMAL
from helpers import idle, open_query, settle
from test_copy import capture, copied
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
    swap_tx(mock, 1, memo="+:ETH.ETH:" + DEST)                                         # THORChain's memo for adding liquidity: not a swap request, not a payout, not a refund
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


def rings_of(page, id_=None):
    """The finding rings the canvas draws (all, or those of one transaction): kind and colour, innermost first."""
    rs = page.evaluate("() => { const r = window.__hopline.renderer; r.draw(); return r.findingRings.map((q) => ({ id: q.id, kind: q.kind, color: q.color })); }")
    return [q for q in rs if id_ is None or q["id"] == id_]


def blue(rgb):
    return rgb[2] > rgb[0] + 40


def test_a_transaction_with_a_swap_memo_has_a_ring_in_the_swap_colour_and_keeps_its_own_fill_and_a_plain_one_has_no_ring(page, mock):
    one = swap_tx(mock, 1)
    open_query(page, tid(1)); open_query(page, NORMAL["txid"])
    page.evaluate("() => window.__hopline.setSel([])"); settle(page)
    assert [(q["kind"], q["color"]) for q in rings_of(page, one)] == [("swap", "#d98a3d")]
    h = halves(page, one)
    assert blue(h["upper"]) and blue(h["lower"]), "one fill colour: the swap is a ring, not a half: %s" % h
    assert rings_of(page, "tx:" + NORMAL["txid"]) == []
    plain = halves(page, "tx:" + NORMAL["txid"])
    assert blue(plain["upper"]) and blue(plain["lower"]), plain


def test_the_ring_follows_the_switches_and_the_legend_says_what_it_is(page, mock):
    one = swap_tx(mock, 1)
    open_query(page, tid(1)); page.evaluate("() => window.__hopline.setSel([])"); settle(page)
    assert [q["kind"] for q in rings_of(page, one)] == ["swap"] and "orange ring" in page.inner_text("#legend")
    page.uncheck("#anKSwap"); settle(page)
    assert rings_of(page, one) == [] and "orange ring" not in page.inner_text("#legend"), "SWAP switched off"
    page.check("#anKSwap"); settle(page)
    assert [q["kind"] for q in rings_of(page, one)] == ["swap"]
    page.uncheck("#anFlags"); settle(page)
    assert rings_of(page, one) == [] and "orange ring" not in page.inner_text("#legend"), "Flag patterns on transactions switched off"


def test_a_plain_transaction_has_no_swap_entry_in_the_legend(page, mock):
    open_query(page, NORMAL["txid"]); settle(page)
    assert "orange ring" not in page.inner_text("#legend")


def test_on_a_round_payment_the_swap_ring_is_innermost_and_both_names_show_when_selected(page, mock):
    tx(mock, 5, [IN(95, 0, "carl", 150_000_273)], [OUT("vault5", 100_000_000), OUT("back5", 49_999_123), data_out(MEMO)])
    open_query(page, tid(5))
    flags_of = flags(page)
    assert flags_of["tx:" + tid(5)] == ["SWAP → ETH", "ROUND 1 BTC"], "the memo comes first"
    page.evaluate("(id) => window.__hopline.setSel([id])", "tx:" + tid(5)); settle(page)
    texts = drawn_texts(page)
    assert any(t.startswith("SWAP") for t in texts) and any(t.startswith("ROUND") for t in texts), "selected: both names, the SWAP one nearest the vertex"
    page.evaluate("() => window.__hopline.setSel([])"); settle(page)
    assert [q["kind"] for q in rings_of(page, "tx:" + tid(5))] == ["swap", "round"], "a ring each, the swap innermost"
    h = halves(page, "tx:" + tid(5))
    assert blue(h["upper"]) and blue(h["lower"]), "the vertex keeps one fill colour"


def test_a_payment_to_a_wallet_tagged_swap_that_also_carries_a_request_id_is_one_hand_off_not_two(tpage, mock):
    tx(mock, 1, [IN(90, 0, "ran", 900_150)], [OUT("mid", 900_000)], spent={0: 2})
    swap_tx(mock, 2, payer="mid", memo=RID)
    mock.routes["/tx/" + tid(2)]["vin"][0] = IN(1, 0, "mid", 900_000)
    open_query(tpage, tid(1)); open_query(tpage, tid(2))
    tpage.evaluate("(id) => window.__hopline.setSel([id])", "addr:" + addr("vault")); settle(tpage)
    tpage.select_option("#fTag", "SWAP"); settle(tpage)
    chip = tpage.inner_text("#findStrip [data-key=handoff]")
    assert chip.endswith("1"), "one transaction, one place: %s" % chip
    tpage.click("#findStrip [data-key=handoff]"); settle(tpage)
    assert tpage.locator("#anFindings [data-handoff=deposit]").count() == 1
    assert tpage.locator("#anFindings [data-handoff=deposit][data-swap]").count() == 0, "the memo has no row of its own"
    assert "Cross-chain request: ID 0xabababab…ababab" in tpage.inner_text("#anFindings [data-handoff=deposit]"), "it is noted on the service's row"


def two_trails(mock):
    """Two starting points: tx 1 -> tx 2 (a swap memo) and tx 3 -> tx 4 (a request ID)."""
    tx(mock, 1, [IN(91, 0, "one", 900_150)], [OUT("m1", 900_000)], spent={0: 2})
    swap_tx(mock, 2, payer="m1")
    mock.routes["/tx/" + tid(2)]["vin"][0] = IN(1, 0, "m1", 900_000)
    tx(mock, 3, [IN(92, 0, "two", 700_150)], [OUT("m2", 700_000)], spent={0: 4})
    swap_tx(mock, 4, payer="m2", memo=RID)
    mock.routes["/tx/" + tid(4)]["vin"][0] = IN(3, 0, "m2", 700_000)


def test_the_hand_offs_run_from_every_starting_point_unless_one_is_picked(tpage, mock):
    two_trails(mock)
    for n in (1, 2, 3, 4):
        open_query(tpage, tid(n))
    tpage.evaluate("(ids) => window.__hopline.state.trace.seeds.splice(0, 99, ...ids)", ["tx:" + tid(1), "tx:" + tid(3)]); tpage.evaluate("() => window.__hopline.refresh()"); settle(tpage)
    assert tpage.evaluate("() => window.__hopline.state.trace.seeds.length") == 2
    chip = tpage.inner_text("#findStrip [data-key=handoff]")
    assert chip.endswith("2"), "both trails: %s" % chip
    assert "the 2 starting points" in tpage.get_attribute("#findStrip [data-key=handoff]", "title")
    tpage.hover("#findStrip [data-key=handoff]"); tpage.wait_for_function("() => window.__hopline.renderer.preview !== null", timeout=4000)
    ring = set(tpage.evaluate("() => [...window.__hopline.renderer.preview.ids]"))
    assert {"tx:" + tid(2), "tx:" + tid(4)} <= ring, "the hover rings the hand-off of each start: %s" % ring
    tpage.mouse.move(5, 5)
    tpage.evaluate("() => window.__hopline.openFindings()"); settle(tpage)
    tpage.click("#findStrip [data-key=handoff]"); settle(tpage)
    rows = tpage.locator("#anFindings [data-handoff=deposit][data-swap]")
    assert rows.count() == 2
    texts = [rows.nth(i).inner_text() for i in range(2)]
    assert all("start tx" in t for t in texts), "each row says which start it comes from: %s" % texts
    rows.nth(1).locator(".linkrow").click(); idle(tpage); settle(tpage)
    ids = tpage.evaluate("() => { const c = window.__hopline.renderer.chain; return c ? [...c.ids] : []; }")
    assert ids and ids[0] == "tx:" + tid(3) and ids[-1] == "tx:" + tid(4), "the route starts at the row's own start: %s" % ids
    tpage.evaluate("(id) => { window.__hopline.state.routeRef = id; window.__hopline.refresh(); }", "tx:" + tid(1)); settle(tpage)
    assert tpage.inner_text("#findStrip [data-key=handoff]").endswith("1"), "a pick is honoured: one start, one hand-off"


# ---- payouts, refunds and a Rootstock peg-in -----------------------------------------------------------------------------------------------------------------------

INBOUND = "A7" * 32                                                                    # invented: 64 hex digits, upper case, as the THORChain documentation shows an inbound hash
RSK_DEST = "0e537aad84447a2c2a7590d5f2665ef5cf9b667a"                                  # the example address of RSKIP-170
RSK = "52534b54" + "01" + RSK_DEST + "01" + "4f4c767a2d308eebb3f0f1247f9163c896e0b7d2"


def hex_out(hexstr):
    return {"scriptpubkey": "6a%02x%s" % (len(hexstr) // 2, hexstr), "scriptpubkey_type": "op_return", "value": 0}


def memo_tx(mock, n, out, payer="vaultx"):
    """A transaction paid by the payer, to a user and back, carrying the given OP_RETURN output."""
    tx(mock, n, [IN(90 + n, 0, payer, 5_000_150)], [OUT("user%d" % n, 3_123_456), OUT("back%d" % n, 1_876_544), out])
    return "tx:" + tid(n)


def test_a_payout_a_refund_and_a_peg_in_get_their_own_badges_and_count_as_swaps(page, mock):
    out = memo_tx(mock, 1, data_out("OUT:" + INBOUND))
    ref = memo_tx(mock, 2, data_out("REFUND:" + tid(7)))
    peg = memo_tx(mock, 3, hex_out(RSK))
    for n in (1, 2, 3):
        open_query(page, tid(n))
    f = flags(page)
    assert f[out] == ["SWAP OUT"] and f[ref] == ["SWAP REFUND"] and f[peg] == ["PEG-IN RSK"], f
    assert labels(page).get("swap") == "SWAP3"
    assert "payout or refund" in page.get_attribute("#findStrip [data-key=swap]", "title") and "Rootstock" in page.get_attribute("#findStrip [data-key=swap]", "title")
    assert badge_text_drawn(page, out), "the badge is drawn above the transaction"
    page.evaluate("() => window.__hopline.openFindings()"); settle(page)
    page.locator("#detKinds button:has-text('SWAP 3')").click(); settle(page)
    text = page.inner_text("#detList")
    assert "OUT:" in text and "REFUND:" in text and "RSKIP-170" in text, text


def test_the_details_say_what_each_memo_names_and_are_clear_that_it_is_the_senders_word(page, mock):
    out = memo_tx(mock, 1, data_out("OUT:" + INBOUND))
    ref = memo_tx(mock, 2, data_out("REFUND:" + tid(7)))
    peg = memo_tx(mock, 3, hex_out(RSK))
    for n in (1, 2, 3):
        open_query(page, tid(n))
    page.evaluate("(id) => window.__hopline.setSel([id])", out); settle(page)
    text = page.inner_text("#inspBody")
    assert "SWAP OUT" in text and INBOUND.lower() in text and "usually on another chain" in text and "Anyone can write the same text" in text, text
    page.evaluate("(id) => window.__hopline.setSel([id])", ref); settle(page)
    text = page.inner_text("#inspBody")
    assert "SWAP REFUND" in text and tid(7) in text and "was not carried out" in text
    page.evaluate("(id) => window.__hopline.setSel([id])", peg); settle(page)
    text = page.inner_text("#inspBody")
    assert "PEG-IN RSK" in text and "0x" + RSK_DEST in text and "refund to a Bitcoin P2PKH address" in text and "RSKIP-170" in text


def test_the_buttons_copy_the_hash_or_the_address_and_a_refund_opens_the_payment_it_gives_back(page, mock):
    tx(mock, 7, [IN(95, 0, "sender", 4_000_150)], [OUT("vaultx", 4_000_000)])                       # the payment that is refunded
    out = memo_tx(mock, 1, data_out("OUT:" + INBOUND))
    ref = memo_tx(mock, 2, data_out("REFUND:" + tid(7)))
    peg = memo_tx(mock, 3, hex_out(RSK))
    for n in (1, 2, 3):
        open_query(page, tid(n))
    capture(page)
    page.evaluate("(id) => window.__hopline.setSel([id])", out); settle(page)
    page.click("#inspBody button:has-text('Copy inbound hash')")
    page.evaluate("(id) => window.__hopline.setSel([id])", peg); settle(page)
    page.click("#inspBody button:has-text('Copy Rootstock address')")
    assert copied(page) == [INBOUND.lower(), "0x" + RSK_DEST]
    page.evaluate("(id) => window.__hopline.setSel([id])", ref); settle(page)
    assert page.locator("#inspBody button:has-text('Copy inbound hash')").count() == 0, "only a payout has that one"
    assert "tx:" + tid(7) not in set(page.evaluate("() => [...window.__hopline.state.graph.nodes.keys()]"))
    page.click("#inspBody button:has-text('Open the refunded payment')"); idle(page); settle(page)
    assert page.evaluate("() => window.__hopline.state.focus") == "tx:" + tid(7), "the payment that was refunded is loaded and shown"


def test_a_plain_transaction_has_none_of_these_buttons(page, mock):
    open_query(page, NORMAL["txid"])
    page.evaluate("(id) => window.__hopline.setSel([id])", "tx:" + NORMAL["txid"]); settle(page)
    for label in ("Copy inbound hash", "Open the refunded payment", "Copy Rootstock address"):
        assert page.locator("#inspBody button:has-text('%s')" % label).count() == 0, label


def test_the_hand_offs_have_a_row_for_a_peg_in_the_trail_reaches_and_none_for_a_payout(tpage, mock):
    tx(mock, 1, [IN(90, 0, "ran", 900_150)], [OUT("mid", 900_000)], spent={0: 2})
    memo_tx(mock, 2, hex_out(RSK), payer="mid")
    mock.routes["/tx/" + tid(2)]["vin"][0] = IN(1, 0, "mid", 900_000)                  # tx 2 spends what tx 1 paid to mid
    open_query(tpage, tid(1)); open_query(tpage, tid(2))
    tpage.evaluate("() => window.__hopline.openFindings()"); settle(tpage)
    tpage.click("#findStrip [data-key=handoff]"); settle(tpage)
    row = tpage.locator("#anFindings [data-handoff=deposit][data-swap]")
    assert row.count() == 1 and "Rootstock peg-in: to 0x" in row.inner_text()


def test_a_payout_the_trail_reaches_is_not_a_hand_off(tpage, mock):
    tx(mock, 1, [IN(90, 0, "ran", 900_150)], [OUT("mid", 900_000)], spent={0: 2})
    memo_tx(mock, 2, data_out("OUT:" + INBOUND), payer="mid")
    mock.routes["/tx/" + tid(2)]["vin"][0] = IN(1, 0, "mid", 900_000)
    open_query(tpage, tid(1)); open_query(tpage, tid(2))
    tpage.evaluate("() => window.__hopline.openFindings()"); settle(tpage)
    assert tpage.locator("#findStrip [data-key=handoff]").count() == 0, "money coming out of the service is not a place the trail went into it"
