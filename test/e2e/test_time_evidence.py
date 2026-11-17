"""When a transaction was first seen: the button for BlockCypher in a transaction's details, for several selected, the card, the file, the report and the words.

The time on a transaction is the time of its block. BlockCypher can say when it first saw a transaction, and sometimes which peer passed it on. The answers here are made up (BlockCypher is
served by the test, never asked): the first transaction was seen 200 s before its block with a peer named, the second only appears in BlockCypher's records with its block.
"""
import json
import re
from datetime import datetime, timezone

import pytest

from chains import IN, OUT, addr, tid, tx
from helpers import idle, open_query, selected, settle, toast_text, xy

STATE = "window.__hopline.state"
PEER = "203.0.113.9:8333"
BLOCK1 = 1650000000 + 1 * 600
BLOCK2 = 1650000000 + 2 * 600


def iso(sec, ms=None):
    return datetime.fromtimestamp(sec, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S") + ("" if ms is None else ".%03d" % ms) + "Z"


class BlockCypher:
    """The service as the test makes it: records every request, answers from `replies` (404 for a transaction it does not know) and can run out of requests."""
    def __init__(self):
        self.requests, self.replies, self.limit_after = [], {}, None

    def handle(self, route):
        url = route.request.url
        self.requests.append(url)
        m = re.search(r"/txs/([0-9a-f]{64})", url)
        head = {"access-control-allow-origin": "*"}
        if self.limit_after is not None and len(self.requests) > self.limit_after:
            return route.fulfill(status=429, headers=head, json={"error": "Limits reached."})
        body = self.replies.get(m.group(1)) if m else None
        if body is None:
            return route.fulfill(status=404, headers=head, json={"error": "Transaction not found."})
        route.fulfill(status=200, headers=head, json=body)


@pytest.fixture
def bc(ctx):
    b = BlockCypher()
    ctx.route(re.compile(r"^https://api\.blockcypher\.com/"), b.handle)
    return b


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def scene(page, mock, bc):
    """Transaction 1 pays a and b, a is spent by transaction 2. BlockCypher saw 1 before its block, with a peer; it learned of 2 from its block."""
    tx(mock, 1, [IN(90, 0, "src", 200000)], [OUT("a", 150000), OUT("b", 49000)], spent={0: 2})
    tx(mock, 2, [IN(1, 0, "a", 150000)], [OUT("c", 140000)])
    bc.replies[tid(1)] = {"hash": tid(1), "block_height": 700001, "confirmed": iso(BLOCK1), "received": iso(BLOCK1 - 200, 652), "relayed_by": PEER, "double_spend": False}
    bc.replies[tid(2)] = {"hash": tid(2), "block_height": 700002, "confirmed": iso(BLOCK2), "received": iso(BLOCK2), "double_spend": False}
    open_query(page, tid(1)); settle(page)
    page.evaluate("() => window.__hopline.traceExpand('tx:' + '%s', 'next')" % tid(1)); idle(page); settle(page)
    page.evaluate("() => window.__hopline.traceExpand('addr:' + '%s', 'next')" % addr("a")); idle(page); settle(page)       # both transactions are on screen


def select(page, *ids):
    page.evaluate("(ids) => window.__hopline.setSel(ids)", list(ids)); settle(page)


def ext(page, n):
    return page.evaluate("(id) => { const x = window.__hopline.state.graph.nodes.get(id); return x && x.ext ? x.ext.blockcypher || null : null; }", "tx:" + tid(n))


def dialogs_of(page, answer):
    seen = []
    page.on("dialog", lambda d: (seen.append(d.message), d.accept() if answer else d.dismiss()))
    return seen


def press(page, selector, ok=None):
    """Tick the box that confirms what is sent (when there is one), press a look-up button and wait until the look-up is over: the page's own idle does not cover it."""
    if ok:
        page.check(ok)
    page.click(selector)
    page.wait_for_function("() => !window.__hopline.state.ext.busy", timeout=20000)
    idle(page); settle(page)


def details(page):
    """The details as text, in lower case (the labels are drawn in capitals)."""
    return page.inner_text("#inspBody").lower()


def test_the_button_waits_for_a_ticked_box_that_says_what_is_sent_and_no_dialog_asks(tpage, mock, bc):
    scene(tpage, mock, bc)
    select(tpage, "tx:" + tid(1))
    assert "block time" in details(tpage) and not re.search(r"^time$", details(tpage), re.M), "the time on a transaction is named for what it is"
    assert tpage.inner_text("#btnBlockcypher") == "Ask BlockCypher when it was first seen"
    assert tpage.get_attribute("#btnBlockcypher", "title").startswith("Sends this transaction id to BlockCypher") and "Tick the box to confirm" in tpage.get_attribute("#btnBlockcypher", "title")
    said = dialogs_of(tpage, True)
    assert "Send the transaction id to BlockCypher (api.blockcypher.com)" in tpage.inner_text("#inspBody")
    assert tpage.is_disabled("#btnBlockcypher") and not tpage.is_checked("#chkBlockcypher"), "nothing can be sent until the box is ticked"
    tpage.check("#chkBlockcypher")
    assert tpage.is_enabled("#btnBlockcypher")
    tpage.uncheck("#chkBlockcypher")
    assert tpage.is_disabled("#btnBlockcypher"), "unticked again: it cannot be sent"
    assert bc.requests == [] and ext(tpage, 1) is None and said == [], "nothing was sent, nothing was kept, and no dialog came up"


def test_the_answer_is_a_card_with_the_first_seen_time_and_how_much_earlier_and_the_peer(tpage, mock, bc):
    scene(tpage, mock, bc)
    select(tpage, "tx:" + tid(1))
    before = tpage.evaluate("(id) => window.__hopline.state.graph.nodes.get(id).time", "tx:" + tid(1))
    press(tpage, "#btnBlockcypher", ok="#chkBlockcypher")
    assert bc.requests == ["https://api.blockcypher.com/v1/btc/main/txs/%s?limit=1" % tid(1)]
    card = tpage.inner_text("#inspBody .extcard")
    assert iso(BLOCK1 - 200).replace("T", " ").replace("Z", "") + " UTC" in card, card
    assert "3 min 19 s" in card and PEER in card and "not part of the blockchain" in card
    e = ext(tpage, 1)
    assert e["seen"] is True and e["relay"] == PEER and abs(e["received"] - (BLOCK1 - 200 + 0.652)) < 0.001 and e["found"] is True
    assert "relayed_by" in e["raw"], "the reply is kept as it came"
    assert tpage.evaluate("(id) => window.__hopline.state.graph.nodes.get(id).time", "tx:" + tid(1)) == before, "the time of the block is not touched"
    assert tpage.inner_text("#btnBlockcypher") == "Ask BlockCypher again"
    assert "1 with a first-seen time" in toast_text(tpage)


def test_a_transaction_blockcypher_learned_of_from_its_block_has_no_first_seen_time(tpage, mock, bc):
    scene(tpage, mock, bc)
    select(tpage, "tx:" + tid(2))
    press(tpage, "#btnBlockcypher", ok="#chkBlockcypher")
    card = tpage.inner_text("#inspBody .extcard")
    assert "learned of this transaction from its block" in card and "says nothing about when it was sent" in card
    assert "First seen" not in card and "Peer that passed it on" not in card, "no record is not shown as a time"
    e = ext(tpage, 2)
    assert e["found"] is True and e["seen"] is False and e["received"] is None and e["relay"] == ""
    assert "no record" in toast_text(tpage)


def test_a_transaction_unknown_to_blockcypher_is_an_answer_not_an_error(tpage, mock, bc):
    scene(tpage, mock, bc)
    bc.replies.pop(tid(2))
    select(tpage, "tx:" + tid(2))
    press(tpage, "#btnBlockcypher", ok="#chkBlockcypher")
    assert "does not know this transaction" in tpage.inner_text("#inspBody .extcard")
    e = ext(tpage, 2)
    assert e["found"] is False and e["seen"] is False


def test_several_selected_transactions_are_asked_together_and_a_limit_stops_it_but_keeps_what_was_answered(tpage, mock, bc):
    scene(tpage, mock, bc)
    select(tpage, "tx:" + tid(1), "tx:" + tid(2))
    assert "when first seen (2 transactions)" in details(tpage)
    assert tpage.inner_text("#btnAskTimes") == "Ask BlockCypher about 2 transactions"
    assert "send the 2 transaction ids to blockcypher (api.blockcypher.com)" in details(tpage) and tpage.is_disabled("#btnAskTimes")
    bc.limit_after = 1
    said = dialogs_of(tpage, True)
    tpage.check("#chkAskTimes"); tpage.click("#btnAskTimes")
    tpage.wait_for_function("() => /limit/.test(document.getElementById('toast').textContent)", timeout=15000); idle(tpage); settle(tpage)
    assert said == [], "no dialog: the box was the confirmation"
    assert "1 of 2 were answered" in toast_text(tpage)
    assert ext(tpage, 1) is not None and ext(tpage, 2) is None, "the one answered before the limit is kept"
    select(tpage, "tx:" + tid(1), "tx:" + tid(2))
    assert "blockcypher was asked about 1: 1 with a first-seen time, 0 with no record from before the block. 1 not asked yet." in details(tpage)
    assert tpage.inner_text("#btnAskTimes") == "Ask BlockCypher about 1 transaction"
    assert tpage.is_disabled("#btnAskTimes") and not tpage.is_checked("#chkAskTimes"), "the box is clear again: every look-up is confirmed"
    assert "send the transaction id to blockcypher" in details(tpage), "and says what is sent this time: one id"
    bc.limit_after = None
    tpage.check("#chkAskTimes"); tpage.click("#btnAskTimes"); tpage.wait_for_function("() => /answered, /.test(document.getElementById('toast').textContent)", timeout=15000); idle(tpage)
    assert len(bc.requests) == 3, "the second press asked only about the one not asked yet"
    assert ext(tpage, 2)["seen"] is False
    select(tpage, "tx:" + tid(1), "tx:" + tid(2))
    assert "was asked about 2: 1 with a first-seen time, 1 with no record from before the block." in details(tpage)
    assert tpage.locator("#btnAskTimes").count() == 0


def test_over_tor_it_is_not_asked_and_nothing_is_sent(tpage, mock, bc):
    scene(tpage, mock, bc)
    tpage.click("#sideTab"); tpage.select_option("#source", "tor")
    select(tpage, "tx:" + tid(1))
    tpage.check("#chkBlockcypher"); tpage.click("#btnBlockcypher")
    assert "Tor" in toast_text(tpage) and bc.requests == []
    select(tpage, "tx:" + tid(1), "tx:" + tid(2))
    tpage.check("#chkAskTimes"); tpage.click("#btnAskTimes")
    assert "Tor" in toast_text(tpage) and bc.requests == []


def test_only_transactions_are_asked_and_a_wallet_has_no_such_button(tpage, mock, bc):
    scene(tpage, mock, bc)
    select(tpage, "addr:" + addr("a"))
    assert tpage.locator("#btnBlockcypher").count() == 0 and "first on chain" in details(tpage) and "first seen" not in details(tpage)
    select(tpage, "addr:" + addr("a"), "addr:" + addr("b"))
    assert tpage.locator("#btnAskTimes").count() == 0, "two wallets selected: nothing to ask about"
    assert bc.requests == []


def test_the_right_click_menu_of_a_transaction_goes_to_the_box_that_confirms_what_is_sent(tpage, mock, bc):
    scene(tpage, mock, bc)
    p = xy(tpage, "tx:" + tid(1))
    tpage.mouse.click(p["x"], p["y"], button="right")
    items = tpage.locator("#ctxMenu [role=menuitem]").all_inner_texts()
    assert any("Ask BlockCypher when it was first seen" in t for t in items), items
    tpage.locator("#ctxMenu [role=menuitem]", has_text="Ask BlockCypher when it was first seen").first.click(); settle(tpage)
    assert selected(tpage) == ["tx:" + tid(1)], "a menu has no room for a box: it goes to the details"
    assert tpage.evaluate("() => document.activeElement && document.activeElement.id") == "chkBlockcypher", "with the box in front of you"
    assert bc.requests == [], "and nothing was sent"


def test_the_answer_survives_a_file_and_the_other_kind_of_vertex_does_not_get_it(tpage, mock, bc, tmp_path):
    scene(tpage, mock, bc)
    select(tpage, "tx:" + tid(1), "tx:" + tid(2))
    tpage.check("#chkAskTimes")
    tpage.click("#btnAskTimes"); tpage.wait_for_function("() => /answered, /.test(document.getElementById('toast').textContent)", timeout=15000); idle(tpage)
    tpage.click("summary:has-text('Export')")
    with tpage.expect_download() as d:
        tpage.click("[data-export=json]")
    f = tmp_path / "w.json"; d.value.save_as(str(f))
    data = json.loads(f.read_text(encoding="utf-8"))
    by_id = {n["id"]: n for n in data["nodes"]}
    assert by_id["tx:" + tid(1)]["ext"]["blockcypher"]["relay"] == PEER and "ext" not in by_id["addr:" + addr("a")]
    tpage.evaluate("() => { const m = document.getElementById('exportMenu'); if (m) m.open = false; }")
    tpage.click("#btnClear"); tpage.click("#btnClear"); settle(tpage)
    tpage.set_input_files("#fileImport", str(f)); tpage.wait_for_timeout(900); idle(tpage); settle(tpage)
    assert ext(tpage, 1)["seen"] is True and ext(tpage, 1)["relay"] == PEER and ext(tpage, 2)["seen"] is False
    select(tpage, "tx:" + tid(1))
    assert PEER in tpage.inner_text("#inspBody .extcard"), "the card comes back with the file"


def test_a_link_to_the_canvas_and_the_nodes_csv_do_not_carry_the_peer(tpage, mock, bc, tmp_path):
    scene(tpage, mock, bc)
    select(tpage, "tx:" + tid(1))
    press(tpage, "#btnBlockcypher", ok="#chkBlockcypher")
    tpage.evaluate("""() => { window.__copied = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__copied.push(t); return Promise.resolve(); } } }); }""")
    tpage.click("summary:has-text('Export')")
    tpage.click("[data-export=link]"); tpage.wait_for_function("() => window.__copied.length > 0", timeout=15000)
    link = tpage.evaluate("() => window.__copied[0]")
    assert PEER not in link and "203.0.113" not in link and "blockcypher" not in link.lower()
    with tpage.expect_download() as d:
        tpage.click("[data-export=csv-nodes]")
    f = tmp_path / "n.csv"; d.value.save_as(str(f))
    text = f.read_text(encoding="utf-8")
    assert "BlockCypher: first seen" in text and "203.0.113.9" not in text


def report_html(page, tmp_path, with_peers):
    page.evaluate("() => { document.getElementById('exportMenu').open = true; }")
    if with_peers:
        page.check("#reportRelay")
    with page.expect_download() as dl:
        page.click("[data-export=report]")
    p = tmp_path / ("r-%s.html" % with_peers); dl.value.save_as(p)
    return p.read_text(encoding="utf-8")


def test_the_report_has_a_table_and_leaves_the_peers_out_of_it_and_of_its_data_unless_asked(tpage, mock, bc, tmp_path):
    scene(tpage, mock, bc)
    select(tpage, "tx:" + tid(1), "tx:" + tid(2))
    tpage.check("#chkAskTimes")
    tpage.click("#btnAskTimes"); tpage.wait_for_function("() => /answered, /.test(document.getElementById('toast').textContent)", timeout=15000); idle(tpage)
    assert tpage.evaluate("() => document.getElementById('reportRelay').checked") is False, "the peers are left out unless asked for"
    without = report_html(tpage, tmp_path, False)
    assert "<h2>When transactions were first seen</h2>" in without and "3 min 19 s" in without and '<span class="hint">no record</span>' in without
    assert "The peers that passed the transactions on were left out of this report" in without
    assert PEER not in without and "203.0.113.9" not in without, "not in the table and not in the data embedded in the file"
    assert "BlockCypher - 2 transactions asked, 1 with a first-seen time, 1 with no record from before the block" in without
    assert "<th>First on chain</th>" in without and "all times UTC · a transaction's time is the time of its block" in without
    tpage.evaluate("() => { document.getElementById('exportMenu').open = false; }")
    with_ = report_html(tpage, tmp_path, True)
    assert "<th>Peer</th>" in with_ and PEER in with_
    assert with_.count(PEER) >= 2, "in the table and in the embedded data"


def test_without_a_look_up_the_report_has_no_such_table_but_still_says_what_the_time_is(tpage, mock, bc, tmp_path):
    scene(tpage, mock, bc)
    html = report_html(tpage, tmp_path, False)
    assert "When transactions were first seen" not in html and "A first-seen time is what an outside service recorded" not in html
    assert "<b>Times:</b> a transaction's time is the time of the block that holds it, which the miner sets" in html
    assert bc.requests == [], "making a report asks nobody"


def test_the_box_is_clear_again_after_every_look_up_and_a_button_forced_open_sends_nothing(tpage, mock, bc):
    scene(tpage, mock, bc)
    select(tpage, "tx:" + tid(1))
    press(tpage, "#btnBlockcypher", ok="#chkBlockcypher")
    assert len(bc.requests) == 1 and tpage.inner_text("#btnBlockcypher") == "Ask BlockCypher again"
    assert tpage.is_disabled("#btnBlockcypher") and not tpage.is_checked("#chkBlockcypher"), "asking again needs a new tick"
    tpage.evaluate("() => { document.getElementById('btnBlockcypher').disabled = false; }")       # as if the page were tampered with
    tpage.click("#btnBlockcypher")
    assert "Tick the box first" in toast_text(tpage) and len(bc.requests) == 1, "the button itself checks that the box was ticked"


def test_the_peer_has_a_copy_button_that_copies_the_address_without_the_port(tpage, mock, bc):
    scene(tpage, mock, bc)
    select(tpage, "tx:" + tid(1))
    press(tpage, "#btnBlockcypher", ok="#chkBlockcypher")
    tpage.evaluate("""() => { window.__copied = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__copied.push(t); return Promise.resolve(); } } }); }""")
    assert tpage.locator("#inspBody .extcard .copybtn").count() == 1, "one copy button: beside the peer, not beside the other rows"
    row = tpage.locator("#inspBody .extcard dd", has_text=PEER)
    assert PEER in row.inner_text(), "the port stays visible"
    row.locator(".copybtn").click()
    tpage.wait_for_function("() => window.__copied.length > 0")
    assert tpage.evaluate("() => window.__copied") == ["203.0.113.9"], "the address alone, to paste into other tools"
    assert "Copied the IP address." in toast_text(tpage)
