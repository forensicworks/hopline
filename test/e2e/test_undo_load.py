"""Undo load: take back the last load, import, removal or Clear, e.g. when a very large wallet or transaction was opened by mistake."""
import json

import pytest

from chains import peel_chain, tid
from conftest import COINBASE, NORMAL, SPENDERS
from helpers import idle, open_query, settle, toast_text

NORMAL_ID = "tx:" + NORMAL["txid"]


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def graph_text(page):
    """The graph as text with the keys of every object in a fixed order (what is compared is the content, not the order fields were set in)."""
    return json.dumps(json.loads(page.evaluate("() => JSON.stringify(window.__hopline.state.graph.toData())")), sort_keys=True)


def n_nodes(page):
    return page.evaluate("() => window.__hopline.state.graph.nodes.size")


def undo(page):
    page.click("#btnUndoLoad"); idle(page); settle(page)


def many_outputs(mock, n):
    txid = "ef" * 32
    outs = [{"scriptpubkey_address": "bc1qbig%04d" % i, "scriptpubkey_type": "v0_p2wpkh", "value": 100000 - i} for i in range(n)]
    mock.routes["/tx/" + txid] = {"txid": txid, "fee": 100, "weight": 800, "status": {"confirmed": True, "block_height": 1, "block_time": 1650000000},
                                  "vin": [{"txid": "cd" * 32, "vout": 0, "is_coinbase": False, "prevout": {"scriptpubkey_address": "bc1qsrc", "scriptpubkey_type": "v0_p2wpkh", "value": 90000000}}], "vout": outs}
    mock.routes["/tx/" + txid + "/outspends"] = [{"spent": False} for _ in outs]
    return txid


def test_the_button_starts_disabled_and_undoing_an_open_empties_the_workspace(fpage):
    assert fpage.is_disabled("#btnUndoLoad")
    open_query(fpage, NORMAL["txid"])
    assert fpage.is_enabled("#btnUndoLoad")
    title = fpage.get_attribute("#btnUndoLoad", "title")
    assert "Undo: Open 0f58c9a7" in title and "back to 0 vertices" in title, title
    undo(fpage)
    assert n_nodes(fpage) == 0 and fpage.evaluate("() => window.__hopline.state.focus") is None
    assert fpage.is_visible("#empty") and fpage.is_disabled("#btnUndoLoad")
    assert "Undid: Open" in toast_text(fpage)


def test_undoing_an_expansion_restores_the_graph_exactly(fpage):
    open_query(fpage, NORMAL["txid"])
    before = graph_text(fpage)
    fpage.uncheck("#focusOn"); settle(fpage)
    fpage.evaluate("(id) => window.__hopline.setSel([id])", NORMAL_ID); settle(fpage)
    fpage.click("#inspBody button:has-text('Spenders →')"); idle(fpage); settle(fpage)
    assert graph_text(fpage) != before and n_nodes(fpage) > 7
    undo(fpage)
    assert graph_text(fpage) == before, "every vertex, edge and flag is as it was, including what the expansion had only marked"
    assert fpage.evaluate("() => window.__hopline.renderer.data.visible.nodes.size") == 7


def test_changes_are_undone_one_at_a_time_and_the_button_counts_them(fpage):
    open_query(fpage, NORMAL["txid"])
    first = graph_text(fpage)
    open_query(fpage, COINBASE["txid"])
    assert "(2)" in fpage.inner_text("#btnUndoLoad")
    assert fpage.evaluate("() => window.__hopline.state.focus") == "tx:" + COINBASE["txid"]
    undo(fpage)
    assert graph_text(fpage) == first and fpage.evaluate("() => window.__hopline.state.focus") == NORMAL_ID, "focus goes back with it"
    assert "(" not in fpage.inner_text("#btnUndoLoad")
    undo(fpage)
    assert n_nodes(fpage) == 0 and fpage.is_disabled("#btnUndoLoad")


def test_a_very_large_load_offers_undo_in_the_toast_and_it_takes_it_back(fpage, mock):
    open_query(fpage, NORMAL["txid"])
    small = graph_text(fpage)
    big = many_outputs(mock, 200)
    open_query(fpage, big)
    assert n_nodes(fpage) > 200
    t = toast_text(fpage)
    assert "That is a lot: Undo load takes it back." in t, t
    assert fpage.locator("#toast button:has-text('Undo load')").count() == 1
    fpage.click("#toast button:has-text('Undo load')"); idle(fpage); settle(fpage)
    assert graph_text(fpage) == small and "Undid: Open" in toast_text(fpage)


def test_a_small_load_gets_no_big_load_nag(fpage):
    open_query(fpage, NORMAL["txid"])
    assert "That is a lot" not in toast_text(fpage) and fpage.locator("#toast button").count() == 0


def test_an_action_that_added_nothing_leaves_nothing_to_undo(fpage):
    open_query(fpage, NORMAL["txid"])
    fpage.uncheck("#focusOn"); settle(fpage)
    fpage.evaluate("(id) => window.__hopline.setSel([id])", NORMAL_ID); settle(fpage)
    fpage.click("#inspBody button:has-text('Spenders →')"); idle(fpage); settle(fpage)
    count = fpage.evaluate("() => window.__hopline.state.undoLoads.length")
    fpage.click("#inspBody button:has-text('Spenders →')"); idle(fpage); settle(fpage)
    assert fpage.evaluate("() => window.__hopline.state.undoLoads.length") == count, "the second expansion found nothing new: no entry"


def shown(page):
    return set(page.evaluate("() => [...window.__hopline.renderer.data.visible.nodes]"))


def test_in_a_trace_undo_takes_back_the_load_and_the_reveal_together(fpage):
    from test_trace import BIG_ADDR
    open_query(fpage, NORMAL["txid"])
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    fpage.evaluate("(id) => window.__hopline.traceExpand(id, 'next')", NORMAL_ID); idle(fpage); settle(fpage)
    before = shown(fpage)
    assert len(before) == 3 and fpage.is_enabled("#traceUndo")
    fpage.evaluate("(id) => window.__hopline.traceExpand(id, 'next')", BIG_ADDR); idle(fpage); settle(fpage)          # this one has to load the spending transaction
    assert shown(fpage) > before
    undo(fpage)
    assert shown(fpage) == before, "back to what was on screen before that click, and what it loaded is gone"
    assert fpage.evaluate("() => window.__hopline.state.layout") == "trace"
    assert fpage.is_enabled("#traceUndo"), "the earlier reveal can still be undone with the trace's own undo"


def test_a_reveal_that_loads_nothing_is_not_a_load_and_stays_with_the_traces_own_undo(fpage):
    open_query(fpage, NORMAL["txid"])
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    count = fpage.evaluate("() => window.__hopline.state.undoLoads.length")
    fpage.evaluate("(id) => window.__hopline.traceExpand(id, 'next')", NORMAL_ID); idle(fpage); settle(fpage)
    assert fpage.evaluate("() => window.__hopline.state.undoLoads.length") == count and fpage.is_enabled("#traceUndo")


def test_a_trace_started_by_the_undone_open_does_not_outlive_it(fpage):
    open_query(fpage, NORMAL["txid"])
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    undo(fpage)                                                             # the open that the trace was built from
    assert n_nodes(fpage) == 0 and fpage.evaluate("() => window.__hopline.state.trace.shown.size") == 0, "no trace without a starting vertex"
    assert fpage.evaluate("() => window.__hopline.state.trace.seed") is None, "and no stale starting point"
    assert fpage.evaluate("() => window.__hopline.state.layout") == "trace" and fpage.is_visible("#empty"), "still in Trace (the layout a visitor starts in), on the empty screen"
    open_query(fpage, NORMAL["txid"])
    assert fpage.evaluate("() => window.__hopline.state.trace.seed") == "tx:" + NORMAL["txid"], "what is opened next starts a fresh trace"


def test_removal_clear_and_import_can_all_be_undone(fpage):
    open_query(fpage, NORMAL["txid"])
    fpage.uncheck("#focusOn"); settle(fpage)
    full = graph_text(fpage)
    fpage.evaluate("(id) => window.__hopline.setSel([id])", NORMAL_ID); settle(fpage)
    fpage.locator("#cv").focus(); fpage.keyboard.press("Shift+Delete"); settle(fpage)
    assert n_nodes(fpage) < 7 and "Remove 1 vertex" in fpage.get_attribute("#btnUndoLoad", "title")
    undo(fpage)
    assert graph_text(fpage) == full, "a removed vertex comes back with its edges"
    exported = fpage.evaluate("() => HoplineIO.toJson(window.__hopline.state.graph, { view: {} })")
    fpage.click("#btnClear"); fpage.click("#btnClear"); settle(fpage)
    assert n_nodes(fpage) == 0 and "Undo: Clear" in fpage.get_attribute("#btnUndoLoad", "title")
    undo(fpage)
    assert graph_text(fpage) == full
    fpage.click("#btnClear"); fpage.click("#btnClear"); settle(fpage)
    fpage.evaluate("(text) => { const f = new File([text], 'w.json'); const dt = new DataTransfer(); dt.items.add(f); const i = document.getElementById('fileImport'); i.files = dt.files; i.dispatchEvent(new Event('change')); }", exported)
    fpage.wait_for_function("() => window.__hopline.state.graph.nodes.size > 0"); settle(fpage)
    assert "Undo: Import" in fpage.get_attribute("#btnUndoLoad", "title")
    undo(fpage)
    assert n_nodes(fpage) == 0, "back to the empty workspace the import was made into"


def test_the_last_ten_changes_are_kept(fpage, mock):
    peel_chain(mock, 16)
    open_query(fpage, tid(10))
    for i in range(10, 21):                                                 # eleven expansions, each loading the next transaction, after the first open: twelve changes
        fpage.evaluate("(id) => window.__hopline.autoExpand(id, { dir: 'next', hops: 1, follow: 'largest' })", "tx:" + tid(i)); idle(fpage)
    count = fpage.evaluate("() => window.__hopline.state.undoLoads.length")
    assert count == 10 and "(10)" in fpage.inner_text("#btnUndoLoad"), count


def test_undo_waits_for_a_running_action(fpage):
    open_query(fpage, NORMAL["txid"])
    fpage.evaluate("() => { window.__hopline.state.busy = true; }")
    fpage.evaluate("() => window.__hopline.undoLoad()")
    assert "Wait for the current action" in toast_text(fpage) and n_nodes(fpage) > 0
    assert fpage.evaluate("() => window.__hopline.state.undoLoads.length") == 1, "nothing was taken off the stack"
    fpage.evaluate("() => { window.__hopline.state.busy = false; }")


def test_filters_and_the_view_are_not_rolled_back_with_the_graph(fpage):
    open_query(fpage, NORMAL["txid"])
    fpage.uncheck("#focusOn"); settle(fpage)
    open_query(fpage, COINBASE["txid"])
    fpage.click("#layoutSeg [data-layout=force]"); settle(fpage)
    fpage.click("[data-min='100000']"); settle(fpage)
    undo(fpage)
    assert fpage.evaluate("() => window.__hopline.state.layout") == "force" and fpage.evaluate("() => window.__hopline.state.filter.minAmount") == 100000
