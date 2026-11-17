"""The time window: "Narrow the time from block data" in a transaction's details and for several selected, the card, the file, the report.

The time on a transaction is the time of its block. The blocks before it say how much earlier it can have been sent. Here transaction 1 pays 5 sat/vB and has locktime 700000, the height of
the block before its own (700001), which had room; transaction 2 pays 0.5 sat/vB, under what nodes relay, so no block can help. The blocks are served by the test, like everything else.
"""
import json
from datetime import datetime, timezone

import pytest

from chains import IN, OUT, addr, tid, tx
from helpers import idle, open_query, settle, toast_text, xy
from test_time_evidence import BLOCK1, BLOCK2, bc, dialogs_of, details, press, report_html, select  # noqa: F401 (bc is a fixture)

HEIGHT1 = 700001


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def utc(sec):
    return datetime.fromtimestamp(sec, timezone.utc).strftime("%Y-%m-%d %H:%M:%S") + " UTC"


def bhash(h):
    return ("%016x" % h) * 4


def add_block(mock, h, time, weight=2000000, count=1500, p25=None):
    """Serve block h: its hash, its time, weight and size and, with p25, the fee percentiles only mempool.space has."""
    mock.routes["/block-height/%d" % h] = bhash(h)
    mock.routes["/block/" + bhash(h)] = {"id": bhash(h), "height": h, "timestamp": time, "weight": weight, "tx_count": count}
    if p25 is not None:
        mock.routes["/v1/block/" + bhash(h)] = {"extras": {"feeRange": [0, 1, p25, p25 + 1, p25 + 2, p25 + 3, 90]}}


def tune(mock, n, fee, locktime):
    r = mock.routes["/tx/" + tid(n)]
    r["fee"], r["version"], r["locktime"] = fee, 2, locktime
    for v in r["vin"]:
        v["sequence"] = 4294967293


def scene(page, mock, bc, blocks=None):
    tx(mock, 1, [IN(90, 0, "src", 200000)], [OUT("a", 150000), OUT("b", 49000)], spent={0: 2})
    tx(mock, 2, [IN(1, 0, "a", 150000)], [OUT("c", 140000)])
    tune(mock, 1, fee=1000, locktime=HEIGHT1 - 1)
    tune(mock, 2, fee=100, locktime=0)
    for h, kw in (blocks or [(HEIGHT1 - 1, {"time": BLOCK1 - 600})]):
        add_block(mock, h, **kw)
    bc.replies[tid(1)] = {"hash": tid(1), "block_height": HEIGHT1, "confirmed": "2022-04-15T05:30:00Z", "received": "2022-04-15T05:26:40.652Z", "relayed_by": "203.0.113.9:8333"}
    open_query(page, tid(1)); settle(page)
    page.evaluate("() => window.__hopline.traceExpand('tx:' + '%s', 'next')" % tid(1)); idle(page); settle(page)
    page.evaluate("() => window.__hopline.traceExpand('addr:' + '%s', 'next')" % addr("a")); idle(page); settle(page)


def window(page, n):
    return page.evaluate("(id) => { const x = window.__hopline.state.graph.nodes.get(id); return x && x.ext ? x.ext.chainwindow || null : null; }", "tx:" + tid(n))


def block_requests(mock):
    return [p for _, p in mock.requests if p.startswith("/block") or p.startswith("/v1/block")]


def narrow_one(page, n=1):
    select(page, "tx:" + tid(n))
    press(page, "#btnChainwindow")


def test_a_transaction_is_narrowed_from_block_data_without_anyone_being_asked(tpage, mock, bc):
    scene(tpage, mock, bc)
    select(tpage, "tx:" + tid(1))
    said = dialogs_of(tpage, True)
    assert tpage.inner_text("#btnChainwindow") == "Narrow the time from block data"
    assert "Nothing goes to another service" in tpage.get_attribute("#btnChainwindow", "title")
    mock.requests.clear()
    press(tpage, "#btnChainwindow")
    assert said == [] and bc.requests == [], "no dialog and no other service"
    assert block_requests(mock) == ["/block-height/%d" % (HEIGHT1 - 1), "/block/" + bhash(HEIGHT1 - 1)], "the block before is also the block its locktime names: asked for once, and it had room"
    card = tpage.inner_text("#inspBody .extcard")
    assert "about " + utc(BLOCK1 - 600 - 180) in card and utc(BLOCK1) + " (its block)" in card and "13 min 0 s" in card, card
    assert "had room left, so a miner building it would have taken this transaction" in card
    assert "Signed after block %d (%s), if its wallet sets the locktime" % (HEIGHT1 - 1, utc(BLOCK1 - 600)) in card
    assert "not a measurement" in card
    assert tpage.inner_text("#btnChainwindow") == "Narrow it again"
    assert "1 transaction answered, 1 with a window and 0 with nothing to narrow it." in toast_text(tpage)


def test_only_the_facts_are_kept_on_the_transaction_and_never_the_reading_of_them(tpage, mock, bc):
    scene(tpage, mock, bc)
    narrow_one(tpage)
    e = window(tpage, 1)
    assert set(e) == {"found", "at", "source", "height", "blockTime", "vsize", "fee", "locktime", "seqFinal", "prev", "lock"}, sorted(e)
    assert e["prev"] == [{"height": HEIGHT1 - 1, "time": BLOCK1 - 600, "weight": 2000000, "txCount": 1500, "p25": None}]
    assert e["lock"] == {"height": HEIGHT1 - 1, "time": BLOCK1 - 600}
    assert (e["height"], e["blockTime"], e["fee"], e["vsize"], e["locktime"], e["seqFinal"]) == (HEIGHT1, BLOCK1, 1000, 200, HEIGHT1 - 1, False)
    assert e["source"] and e["found"] is True


def test_a_full_block_counts_when_the_fee_percentiles_show_the_transaction_paid_well_above_them(tpage, mock, bc):
    scene(tpage, mock, bc, blocks=[(HEIGHT1 - 1, {"time": BLOCK1 - 600, "weight": 3990000, "p25": 2})])
    mock.requests.clear()
    narrow_one(tpage)
    assert block_requests(mock) == ["/block-height/%d" % (HEIGHT1 - 1), "/block/" + bhash(HEIGHT1 - 1), "/v1/block/" + bhash(HEIGHT1 - 1)]
    card = tpage.inner_text("#inspBody .extcard")
    assert "was full, but this transaction paid 5 sat/vB, well above the 2 sat/vB that a quarter of that block's transactions paid" in card, card
    assert window(tpage, 1)["prev"][0]["p25"] == 2


def test_a_source_without_percentiles_carries_on_to_the_block_before_that_had_room(tpage, mock, bc):
    scene(tpage, mock, bc, blocks=[(HEIGHT1 - 1, {"time": BLOCK1 - 600, "weight": 3990000}), (HEIGHT1 - 2, {"time": BLOCK1 - 1200})])
    narrow_one(tpage)
    card = tpage.inner_text("#inspBody .extcard")
    assert "about " + utc(BLOCK1 - 600 - 180) + " (the later of the two readings below)" in card, "the locktime says later than the block two back, so it counts"
    assert "about " + utc(BLOCK1 - 1200 - 180) + ". Block %d (%s) had room left" % (HEIGHT1 - 2, utc(BLOCK1 - 1200)) in card, card
    assert "about " + utc(BLOCK1 - 600 - 180) + ". Signed after block %d" % (HEIGHT1 - 1) in card, card
    assert [b["height"] for b in window(tpage, 1)["prev"]] == [HEIGHT1 - 1, HEIGHT1 - 2]


def test_a_transaction_that_pays_under_what_nodes_relay_says_so_and_asks_for_no_block(tpage, mock, bc):
    scene(tpage, mock, bc)
    mock.requests.clear()
    narrow_one(tpage, 2)
    assert block_requests(mock) == []
    assert "This transaction paid 0.5 sat/vB, under what nodes relay by default" in tpage.inner_text("#inspBody .extcard")
    e = window(tpage, 2)
    assert e["found"] is True and e["prev"] == [] and e["lock"] is None
    assert "1 transaction answered, 0 with a window and 1 with nothing to narrow it." in toast_text(tpage)


def test_a_transaction_that_is_not_loaded_cannot_be_narrowed_and_says_how_to_fix_that(tpage, mock, bc):
    scene(tpage, mock, bc)
    mock.requests.clear()
    select(tpage, "tx:" + tid(90))
    press(tpage, "#btnChainwindow")
    assert "Only a loaded transaction that is in a block can be narrowed" in toast_text(tpage)
    assert window(tpage, 90) is None and block_requests(mock) == []


def test_several_selected_are_narrowed_together_beside_the_first_seen_section_and_nothing_goes_to_another_service(tpage, mock, bc):
    scene(tpage, mock, bc)
    select(tpage, "tx:" + tid(1), "tx:" + tid(2))
    text = details(tpage)
    assert "when first seen (2 transactions)" in text and "time window from block data (2 transactions)" in text
    assert tpage.inner_text("#btnAskWindow") == "Narrow the time of 2 transactions"
    said = dialogs_of(tpage, True)
    tpage.click("#btnAskWindow"); tpage.wait_for_function("() => /answered, /.test(document.getElementById('toast').textContent)", timeout=15000); idle(tpage); settle(tpage)
    assert said == [] and bc.requests == []
    assert "Block data: 2 transactions answered, 1 with a window and 1 with nothing to narrow it." in toast_text(tpage)
    select(tpage, "tx:" + tid(1), "tx:" + tid(2))
    assert "block data was asked about 2: 1 with a window, 1 with nothing to narrow it." in details(tpage)
    assert tpage.locator("#btnAskWindow").count() == 0 and tpage.locator("#btnAskTimes").count() == 1, "BlockCypher was not asked: its button is still there"


def test_both_sources_sit_side_by_side_on_one_transaction_under_time_evidence(tpage, mock, bc):
    scene(tpage, mock, bc)
    select(tpage, "tx:" + tid(1))
    assert "time evidence" in details(tpage)
    assert tpage.locator("#btnBlockcypher").count() == 1 and tpage.locator("#btnChainwindow").count() == 1
    press(tpage, "#btnBlockcypher", ok="#chkBlockcypher")
    press(tpage, "#btnChainwindow")
    cards = tpage.locator("#inspBody .extcard").all_inner_texts()
    assert len(cards) == 2 and "203.0.113.9:8333" in cards[0] and "Not before" in cards[1], cards
    assert "block time" in details(tpage), "and the time of the block is still named for what it is"


def test_a_wallet_has_no_such_button_and_the_menu_of_a_transaction_has_it(tpage, mock, bc):
    scene(tpage, mock, bc)
    select(tpage, "addr:" + addr("a"))
    assert tpage.locator("#btnChainwindow").count() == 0
    p = xy(tpage, "tx:" + tid(1))
    tpage.mouse.click(p["x"], p["y"], button="right")
    items = tpage.locator("#ctxMenu [role=menuitem]").all_inner_texts()
    assert any("Narrow the time from block data" in t for t in items), items


def test_the_facts_survive_a_file_and_the_reading_is_worked_out_again(tpage, mock, bc, tmp_path):
    scene(tpage, mock, bc)
    narrow_one(tpage)
    before = tpage.inner_text("#inspBody .extcard")
    tpage.click("summary:has-text('Export')")
    with tpage.expect_download() as d:
        tpage.click("[data-export=json]")
    f = tmp_path / "w.json"; d.value.save_as(str(f))
    data = json.loads(f.read_text(encoding="utf-8"))
    kept = {n["id"]: n for n in data["nodes"]}["tx:" + tid(1)]["ext"]["chainwindow"]
    assert "notBefore" not in kept and kept["prev"][0]["height"] == HEIGHT1 - 1
    tpage.evaluate("() => { const m = document.getElementById('exportMenu'); if (m) m.open = false; }")
    tpage.click("#btnClear"); tpage.click("#btnClear"); settle(tpage)
    tpage.set_input_files("#fileImport", str(f)); tpage.wait_for_timeout(900); idle(tpage); settle(tpage)
    select(tpage, "tx:" + tid(1))
    assert tpage.inner_text("#inspBody .extcard") == before, "the same words from the same facts"


def test_the_nodes_csv_says_it_in_one_line_and_the_report_has_the_table_and_the_limits(tpage, mock, bc, tmp_path):
    scene(tpage, mock, bc)
    select(tpage, "tx:" + tid(1), "tx:" + tid(2))
    tpage.click("#btnAskWindow"); tpage.wait_for_function("() => /answered, /.test(document.getElementById('toast').textContent)", timeout=15000); idle(tpage)
    tpage.click("summary:has-text('Export')")
    with tpage.expect_download() as d:
        tpage.click("[data-export=csv-nodes]")
    f = tmp_path / "n.csv"; d.value.save_as(str(f))
    assert "Block data: not before about %s (Time window)" % utc(BLOCK1 - 600 - 180) in f.read_text(encoding="utf-8")
    tpage.evaluate("() => { document.getElementById('exportMenu').open = false; }")
    html = report_html(tpage, tmp_path, False)
    assert "<h2>Time window from block data</h2>" in html and "not a measurement and not part of the blockchain" in html
    assert utc(BLOCK1 - 780) in html and "13 min 0 s" in html and ", after block %d, if its wallet sets the locktime" % (HEIGHT1 - 1) in html and '<span class="hint">no window</span>' in html
    assert "under what nodes relay" in html and "had room left" in html
    assert "A time window is Hopline's reading of the blocks before the transaction's block" in html
    assert '"notBefore"' not in html, "the embedded data holds the facts, not the reading"
    assert "When transactions were first seen" not in html, "BlockCypher was not asked: no such table"


def test_without_a_narrowing_the_report_has_no_window_table(tpage, mock, bc, tmp_path):
    scene(tpage, mock, bc)
    html = report_html(tpage, tmp_path, False)
    assert "Time window from block data" not in html and "A time window is Hopline" not in html
