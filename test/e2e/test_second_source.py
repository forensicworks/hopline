"""Blockchain.com as a second source of first-seen times, next to BlockCypher: its own box and button, what it sends, what it shows (a time, never a peer), the report, and the time of day of the trail.

The answers here are made up (Blockchain.com and BlockCypher are served by the test, never asked). Blockchain.com's `time` is when its node first saw the transaction, or the block's time when it had no record from before the block.
"""
import csv
import io
import re
from datetime import datetime, timezone

import pytest

from chains import tid
from helpers import idle, selected, settle, show_findings, toast_text, xy
from test_money_now import scene as money_scene
from test_losses import capture, scene as losses_scene
from test_patterns_and_zone import LATER, findings
from test_time_evidence import BLOCK1, BLOCK2, PEER, bc, details, press, report_html, scene, select  # noqa: F401 (bc is a fixture)


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


class Blockchaincom:
    """The service as the test makes it: records every request, answers from `replies` (404 for a transaction it does not know) and can run out of requests."""
    def __init__(self):
        self.requests, self.replies, self.limit_after = [], {}, None

    def handle(self, route):
        url = route.request.url
        self.requests.append(url)
        m = re.search(r"/rawtx/([0-9a-f]{64})", url)
        head = {"access-control-allow-origin": "*"}
        if self.limit_after is not None and len(self.requests) > self.limit_after:
            return route.fulfill(status=429, headers=head, json={"error": "rate limited"})
        body = self.replies.get(m.group(1)) if m else None
        if body is None:
            return route.fulfill(status=404, headers=head, json={"error": "not-found-or-invalid-arg", "message": "Item not found or argument invalid"})
        route.fulfill(status=200, headers=head, json=body)


@pytest.fixture
def bi(ctx):
    b = Blockchaincom()
    ctx.route(re.compile(r"^https://blockchain\.info/"), b.handle)
    return b


def reply(n, time):
    """A Blockchain.com reply: it names no peer (its relayed_by is a placeholder), and carries the long lists of inputs and outputs."""
    return {"hash": tid(n), "ver": 2, "size": 235, "relayed_by": "0.0.0.0", "time": time, "block_height": 700000 + n, "double_spend": False, "inputs": [{"index": 0}], "out": [{"n": 0}]}


def both(page, mock, bc, bi):
    """The scene of the time-evidence tests, and Blockchain.com's records: transaction 1 seen 197 s before its block, transaction 2 only with its block (its time is the block's)."""
    scene(page, mock, bc)
    bi.replies[tid(1)] = reply(1, BLOCK1 - 197)
    bi.replies[tid(2)] = reply(2, BLOCK2)


def ext_of(page, n, source):
    return page.evaluate("([id, s]) => { const x = window.__hopline.state.graph.nodes.get(id); return x && x.ext ? x.ext[s] || null : null; }", ["tx:" + tid(n), source])


def test_each_service_has_its_own_box_and_button_and_ticking_one_enables_only_that_one(tpage, mock, bc, bi):
    both(tpage, mock, bc, bi)
    select(tpage, "tx:" + tid(1))
    d = details(tpage)
    assert "send the transaction id to blockcypher (api.blockcypher.com)" in d and "send the transaction id to blockchain.com (blockchain.info)" in d
    assert tpage.inner_text("#btnBlockchaincom") == "Ask Blockchain.com when it was first seen"
    assert tpage.get_attribute("#btnBlockchaincom", "title").startswith("Sends this transaction id to Blockchain.com (blockchain.info)")
    assert tpage.is_disabled("#btnBlockcypher") and tpage.is_disabled("#btnBlockchaincom"), "nothing can be sent until a box is ticked"
    tpage.check("#chkBlockchaincom")
    assert tpage.is_enabled("#btnBlockchaincom") and tpage.is_disabled("#btnBlockcypher") and not tpage.is_checked("#chkBlockcypher"), "the tick is for that service only"
    assert bc.requests == [] and bi.requests == [], "ticking sent nothing"


def test_the_right_click_menu_offers_both_services_and_goes_to_the_box_of_the_one_chosen(tpage, mock, bc, bi):
    both(tpage, mock, bc, bi)
    p = xy(tpage, "tx:" + tid(1))
    tpage.mouse.click(p["x"], p["y"], button="right")
    items = tpage.locator("#ctxMenu [role=menuitem]").all_inner_texts()
    assert any("Ask BlockCypher when it was first seen" in t for t in items) and any("Ask Blockchain.com when it was first seen" in t for t in items), items
    tpage.locator("#ctxMenu [role=menuitem]", has_text="Ask Blockchain.com when it was first seen").first.click(); settle(tpage)
    assert selected(tpage) == ["tx:" + tid(1)]
    assert tpage.evaluate("() => document.activeElement && document.activeElement.id") == "chkBlockchaincom", "the box of that service is in front of you"
    assert bc.requests == [] and bi.requests == [], "and nothing was sent"


def test_asking_blockchaincom_sends_to_blockchaincom_only_and_shows_a_time_but_no_peer(tpage, mock, bc, bi):
    both(tpage, mock, bc, bi)
    select(tpage, "tx:" + tid(1))
    press(tpage, "#btnBlockchaincom", ok="#chkBlockchaincom")
    assert bi.requests == ["https://blockchain.info/rawtx/" + tid(1)] and bc.requests == [], "only the service that was ticked was asked, with the id and nothing else"
    e = ext_of(tpage, 1, "blockchaincom")
    assert e["seen"] is True and e["received"] == BLOCK1 - 197 and e["confirmed"] == BLOCK1 and not e.get("relay") and e["url"] == bi.requests[0], e
    assert "inputs" not in e["raw"] and '"relayed_by":"0.0.0.0"' in e["raw"], "the reply as it came, without the long lists the graph has"
    assert ext_of(tpage, 1, "blockcypher") is None
    d = details(tpage)
    assert tpage.inner_text("#btnBlockchaincom") == "Ask Blockchain.com again"
    assert tpage.locator("#inspBody .extcard h4", has_text="Blockchain.com").count() == 1 and "3 min 17 s" in d and "peer that passed it on" not in d and "0.0.0.0" not in d, "a time, how long before its block, and no peer"


def test_no_record_is_not_a_time_and_an_unknown_transaction_is_said_to_be_unknown(tpage, mock, bc, bi):
    both(tpage, mock, bc, bi)
    select(tpage, "tx:" + tid(2))
    press(tpage, "#btnBlockchaincom", ok="#chkBlockchaincom")
    e = ext_of(tpage, 2, "blockchaincom")
    assert e["found"] is True and e["seen"] is False and e["received"] is None, "its time is the time of the block: no record from before it"
    card = tpage.locator("#inspBody .extcard").inner_text().lower()
    assert "no record from before the block" in card and "utc" not in card, "the card says so and shows no time"
    del bi.replies[tid(2)]
    press(tpage, "#btnBlockchaincom", ok="#chkBlockchaincom")
    e = ext_of(tpage, 2, "blockchaincom")
    assert e["found"] is False and e["seen"] is False
    assert "does not know this transaction" in details(tpage)
    assert len(bi.requests) == 2 and bc.requests == []


def test_a_selection_has_a_button_for_each_service_and_each_stops_at_its_own_limit(tpage, mock, bc, bi):
    both(tpage, mock, bc, bi)
    select(tpage, "tx:" + tid(1), "tx:" + tid(2))
    assert tpage.inner_text("#btnAskTimes") == "Ask BlockCypher about 2 transactions"
    assert tpage.inner_text("#btnAskTimesBlockchaincom") == "Ask Blockchain.com about 2 transactions"
    assert "send the 2 transaction ids to blockchain.com (blockchain.info)" in details(tpage)
    assert tpage.is_disabled("#btnAskTimesBlockchaincom")
    bi.limit_after = 1
    tpage.check("#chkAskTimesBlockchaincom"); tpage.click("#btnAskTimesBlockchaincom")
    tpage.wait_for_function("() => /limit/.test(document.getElementById('toast').textContent)", timeout=15000)
    tpage.wait_for_function("() => !window.__hopline.state.ext.busy", timeout=15000); idle(tpage); settle(tpage)
    assert "1 of 2 were answered" in toast_text(tpage) and re.search("Blockchain[.]com", toast_text(tpage))
    assert ext_of(tpage, 1, "blockchaincom") is not None and ext_of(tpage, 2, "blockchaincom") is None, "the one answered before the limit is kept"
    assert bc.requests == [] and ext_of(tpage, 1, "blockcypher") is None, "the other service was not asked"


def test_the_report_has_a_row_for_each_service_and_the_peer_only_where_one_was_named(tpage, mock, bc, bi, tmp_path):
    both(tpage, mock, bc, bi)
    select(tpage, "tx:" + tid(1))
    press(tpage, "#btnBlockcypher", ok="#chkBlockcypher")
    press(tpage, "#btnBlockchaincom", ok="#chkBlockchaincom")
    without = report_html(tpage, tmp_path, False)
    assert "<td>BlockCypher, " in without and "<td>Blockchain.com, " in without, "a row for each service"
    assert "BlockCypher - 1 transaction asked, 1 with a first-seen time" in without and "Blockchain.com - 1 transaction asked, 1 with a first-seen time" in without
    url = "https://blockchain.info/rawtx/" + tid(1)
    assert '<code class="url">' + url + "</code>" in without and without.count(url) == 2, "the address that was asked, in the table and in the data embedded in the file"
    assert PEER not in without, "the peer is left out"
    tpage.evaluate("() => { document.getElementById('exportMenu').open = false; }")
    with_ = report_html(tpage, tmp_path, True)
    assert PEER in with_ and with_.count(PEER) >= 2
    assert re.search(r"<td>Blockchain\.com, [^<]*<br><code class=\"url\">", with_) and "0.0.0.0" not in with_.split("<h2>When transactions were first seen</h2>")[1].split("</table>")[0], "no peer in the Blockchain.com row"


@pytest.mark.parametrize("bc_time, bi_time, earlier", [("2022-04-15T05:36:30.000Z", "2022-04-15T05:35:00Z", "2022-04-15 05:35:00 UTC"),
                                                         ("2022-04-15T05:34:10.000Z", "2022-04-15T05:35:00Z", "2022-04-15 05:34:10 UTC")])
def test_the_time_of_day_panel_uses_the_earlier_of_the_two_services(tpage, mock, bc, bi, bc_time, bi_time, earlier):
    money_scene(tpage, mock, unread=False, times=LATER)
    bc.replies[tid(2)] = {"hash": tid(2), "block_height": 700002, "confirmed": "2022-04-15T05:40:00Z", "received": bc_time, "relayed_by": "1.2.3.4:8333"}
    bi.replies[tid(2)] = reply(2, int(datetime.strptime(bi_time, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()))
    select(tpage, "tx:" + tid(2))
    press(tpage, "#btnBlockcypher", ok="#chkBlockcypher")
    press(tpage, "#btnBlockchaincom", ok="#chkBlockchaincom")
    show_findings(tpage); settle(tpage)
    after = findings(tpage)
    assert "Some times are when a service first saw the transaction" in after, after
    assert earlier in after, "the event is at the earlier of the two first-seen times"
    later = "2022-04-15 05:36:30 UTC" if earlier.endswith("05:35:00 UTC") else "2022-04-15 05:35:00 UTC"
    assert later not in after, "and not at the later one"


@pytest.mark.parametrize("bc_time, bi_time, earlier", [("2022-04-15T05:27:00.000Z", "2022-04-15T05:26:40Z", "2022-04-15 05:26:40"),
                                                         ("2022-04-15T05:26:10.000Z", "2022-04-15T05:26:40Z", "2022-04-15 05:26:10")])
def test_the_csv_of_payments_carries_the_earlier_first_seen_time_of_the_two_services(tpage, mock, bc, bi, bc_time, bi_time, earlier):
    losses_scene(tpage, mock)                                                              # transaction 1 is the test payment, in a block at 05:30:00
    bc.replies[tid(1)] = {"hash": tid(1), "block_height": 700001, "confirmed": "2022-04-15T05:30:00Z", "received": bc_time, "relayed_by": "1.2.3.4:8333"}
    bi.replies[tid(1)] = reply(1, int(datetime.strptime(bi_time, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()))
    select(tpage, "tx:" + tid(1))
    press(tpage, "#btnBlockcypher", ok="#chkBlockcypher")
    press(tpage, "#btnBlockchaincom", ok="#chkBlockchaincom")
    show_findings(tpage); settle(tpage)
    capture(tpage)
    tpage.click("#btnLossCopy")
    tpage.wait_for_function("() => window.__copied.length > 0")
    rows = list(csv.reader(io.StringIO(tpage.evaluate("() => window.__copied[0]"))))
    assert rows[0][9] == "first_seen_utc" and rows[1][1] == tid(1)
    assert rows[1][9] == earlier, "the earlier of the two first-seen times, not the block's and not the later one"
