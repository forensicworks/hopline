"""The Trace layout: start from one wallet or transaction and build the chain by clicking handles."""
import json

import pytest

from conftest import ADDRESS, ADDR_TXS, COINBASE, NORMAL, OUTSPENDS, PAGE_URL, SPENDERS, shot
from helpers import click_node, counts, idle, open_query, settle, toast_text, xy

NORMAL_ID = "tx:" + NORMAL["txid"]
BIG = max(range(len(NORMAL["vout"])), key=lambda i: NORMAL["vout"][i]["value"])
SMALL = 1 - BIG
BIG_ADDR = "addr:" + NORMAL["vout"][BIG]["scriptpubkey_address"]
SMALL_ADDR = "addr:" + NORMAL["vout"][SMALL]["scriptpubkey_address"]
INPUT_ADDR = "addr:" + NORMAL["vin"][0]["prevout"]["scriptpubkey_address"]
SMALL_SPENDER = "tx:" + OUTSPENDS[SMALL]["txid"]
BIG_SPENDER = "tx:" + OUTSPENDS[BIG]["txid"]
SMALL_SPENDER_JSON = next(t for t in SPENDERS if "tx:" + t["txid"] == SMALL_SPENDER)
# the wallet the small output's spender pays that is not already on screen
NEXT_WALLET = next("addr:" + o["scriptpubkey_address"] for o in SMALL_SPENDER_JSON["vout"]
                   if "addr:" + o["scriptpubkey_address"] not in (BIG_ADDR, SMALL_ADDR))


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def shown(page):
    return set(page.evaluate("() => [...window.__orion.renderer.data.visible.nodes]"))


def pos(page, id_):
    return page.evaluate("(id) => { const p = window.__orion.renderer.positionOf(id); return p ? [Math.round(p.x), Math.round(p.y)] : null; }", id_)


def handle(page, id_, dir_):
    return page.evaluate("([id, d]) => { const r = window.__orion.renderer.data.handles(id); return r && r[d] ? r[d] : null; }", [id_, dir_])


def click_handle(page, id_, dir_, shift=False):
    """A real mouse click on the handle drawn on the canvas (Shift-click = choose what to show)."""
    settle(page)
    p = page.evaluate("""([id, d]) => { const r = window.__orion.renderer, h = r.handleRects.find(x => x.id === id && x.dir === d);
        if (!h) return null; const b = r.canvas.getBoundingClientRect(); return { x: b.left + h.x + h.w / 2, y: b.top + h.y + h.h / 2 }; }""", [id_, dir_])
    assert p, "no %s handle is drawn for %s" % (dir_, id_)
    if shift:
        page.keyboard.down("Shift")
    page.mouse.click(p["x"], p["y"])
    if shift:
        page.keyboard.up("Shift")
    settle(page)


def start_trace(page, query=NORMAL["txid"]):
    open_query(page, query)
    page.click("#layoutSeg [data-layout=trace]")
    settle(page)


def drawn_texts(page):
    return page.evaluate("""() => { const r = window.__orion.renderer, ctx = r.ctx, orig = ctx.fillText.bind(ctx), seen = [];
        ctx.fillText = (t, ...a) => { seen.push(String(t)); return orig(t, ...a); }; r.draw(); ctx.fillText = orig; return seen; }""")


def test_a_trace_starts_with_only_the_one_vertex_and_its_handles(fpage):
    start_trace(fpage)
    assert shown(fpage) == {NORMAL_ID}
    assert fpage.evaluate("() => window.__orion.state.graph.nodes.size") > 1, "the rest is loaded, just not shown"
    assert fpage.is_visible("#traceBar") and fpage.is_hidden("#stepbar")
    assert "Click" in fpage.inner_text("#traceInfo")
    assert fpage.is_disabled("#focusOn") and fpage.is_disabled("#depth")
    assert handle(fpage, NORMAL_ID, "right")["label"] == "2" and handle(fpage, NORMAL_ID, "left")["label"] == "1"
    assert "START" in drawn_texts(fpage)
    assert any("▶" in t for t in drawn_texts(fpage)) and any("◀" in t for t in drawn_texts(fpage)), "the handles are drawn"
    assert "Trace from" in fpage.inner_text("#counts")
    shot(fpage, "trace_start.png")


def test_clicking_the_right_handle_shows_the_wallets_to_the_right_and_nothing_else_moves(fpage):
    start_trace(fpage)
    seed_before = pos(fpage, NORMAL_ID)
    click_handle(fpage, NORMAL_ID, "right")
    idle(fpage)
    assert shown(fpage) == {NORMAL_ID, BIG_ADDR, SMALL_ADDR}
    assert pos(fpage, NORMAL_ID) == seed_before, "the vertex that was clicked stays where it was"
    xs = {pos(fpage, i)[0] for i in (BIG_ADDR, SMALL_ADDR)}
    assert len(xs) == 1 and next(iter(xs)) > seed_before[0], "the new wallets are in the next column to the right"
    assert pos(fpage, BIG_ADDR)[1] < pos(fpage, SMALL_ADDR)[1], "largest first, top to bottom"
    assert handle(fpage, NORMAL_ID, "right") is None, "everything that way is shown"
    h = handle(fpage, BIG_ADDR, "right")
    assert h["known"] == 1 and h["label"] == "1+", "its spender is known; '+' says more may exist because the wallet's history is not loaded"
    assert "history is not fully loaded" in h["tip"]
    assert handle(fpage, BIG_ADDR, "left") is None, "no bare '?' on the side the trace came from"
    assert "2 requests" not in toast_text(fpage) and "+2 vertices" in toast_text(fpage)


def test_a_wallet_click_shows_the_spending_transaction_and_the_wallets_it_paid(fpage, mock):
    start_trace(fpage)
    click_handle(fpage, NORMAL_ID, "right")
    idle(fpage)
    before = {i: pos(fpage, i) for i in shown(fpage)}
    n_requests = len(mock.requests)
    click_handle(fpage, SMALL_ADDR, "right")
    idle(fpage)
    assert shown(fpage) == set(before) | {SMALL_SPENDER, NEXT_WALLET}
    assert pos(fpage, SMALL_SPENDER)[0] > before[SMALL_ADDR][0], "the transaction is one column on"
    assert pos(fpage, NEXT_WALLET)[0] > pos(fpage, SMALL_SPENDER)[0], "and the wallet it paid another column on"
    assert {i: pos(fpage, i) for i in before} == before, "nothing that was on screen moved"
    new = [p for _, p in mock.requests[n_requests:]]
    assert "/tx/" + SMALL_SPENDER[3:] in new, "the transaction was fetched to see the wallets beyond it"
    assert fpage.evaluate("(id) => window.__orion.state.graph.nodes.get(id).loaded", SMALL_SPENDER)


def test_the_left_handle_goes_back_along_the_chain(fpage):
    start_trace(fpage)
    click_handle(fpage, NORMAL_ID, "left")
    idle(fpage)
    assert shown(fpage) == {NORMAL_ID, INPUT_ADDR}
    assert pos(fpage, INPUT_ADDR)[0] < pos(fpage, NORMAL_ID)[0]
    assert handle(fpage, INPUT_ADDR, "left")["known"] == 1, "the transaction that funded the wallet is known and can be shown next"


def test_double_click_goes_forward_and_the_keys_go_either_way(fpage):
    start_trace(fpage)
    click_node(fpage, NORMAL_ID, dbl=True); idle(fpage)
    assert {BIG_ADDR, SMALL_ADDR} <= shown(fpage)
    fpage.locator("#cv").focus()
    click_node(fpage, NORMAL_ID); settle(fpage)
    fpage.keyboard.press("[")
    fpage.wait_for_function("(id) => window.__orion.renderer.data.visible.nodes.has(id)", arg=INPUT_ADDR); idle(fpage)
    click_node(fpage, SMALL_ADDR); settle(fpage)
    fpage.keyboard.press("]")
    fpage.wait_for_function("(id) => window.__orion.renderer.data.visible.nodes.has(id)", arg=SMALL_SPENDER); idle(fpage)


def test_undo_takes_back_one_step_at_a_time_and_reset_returns_to_the_start(fpage):
    start_trace(fpage)
    assert fpage.is_disabled("#traceUndo")
    click_handle(fpage, NORMAL_ID, "right"); idle(fpage)
    click_handle(fpage, SMALL_ADDR, "right"); idle(fpage)
    assert len(shown(fpage)) == 5 and fpage.is_enabled("#traceUndo")
    fpage.click("#traceUndo"); idle(fpage)
    assert shown(fpage) == {NORMAL_ID, BIG_ADDR, SMALL_ADDR}
    fpage.keyboard.press("Control+z"); settle(fpage)
    assert shown(fpage) == {NORMAL_ID} and fpage.is_disabled("#traceUndo")
    click_handle(fpage, NORMAL_ID, "right"); idle(fpage)
    click_handle(fpage, NORMAL_ID, "left"); idle(fpage)
    assert len(shown(fpage)) == 4
    fpage.click("#traceReset"); settle(fpage)
    assert shown(fpage) == {NORMAL_ID}


def test_hide_this_branch_removes_what_it_revealed_and_leaves_the_rest(fpage):
    start_trace(fpage)
    click_handle(fpage, NORMAL_ID, "right"); idle(fpage)
    click_handle(fpage, SMALL_ADDR, "right"); idle(fpage)
    p = xy(fpage, SMALL_ADDR); fpage.mouse.click(p["x"], p["y"], button="right")
    fpage.click("#ctxMenu >> text=Hide this branch")
    settle(fpage)
    assert shown(fpage) == {NORMAL_ID, BIG_ADDR, SMALL_ADDR} - {SMALL_ADDR}, "the wallet and the branch it revealed are gone"
    p = xy(fpage, NORMAL_ID); fpage.mouse.click(p["x"], p["y"], button="right")
    assert fpage.is_disabled("#ctxMenu >> text=Hide this branch"), "the start cannot be hidden"
    fpage.keyboard.press("Escape")


def test_dragging_a_vertex_keeps_it_where_you_put_it_through_later_clicks(fpage):
    start_trace(fpage)
    click_handle(fpage, NORMAL_ID, "right"); idle(fpage)
    a = xy(fpage, SMALL_ADDR)
    fpage.mouse.move(a["x"], a["y"]); fpage.mouse.down(); fpage.mouse.move(a["x"] + 40, a["y"] + 90, steps=6); fpage.mouse.up()
    settle(fpage)
    moved = pos(fpage, SMALL_ADDR)
    click_handle(fpage, BIG_ADDR, "right"); idle(fpage)
    assert pos(fpage, SMALL_ADDR) == moved


def test_a_long_list_is_shown_in_batches_with_a_counter(fpage, mock):
    txid = "ab" * 32
    outs = [{"scriptpubkey_address": "bc1qbatchwallet%02d" % i, "scriptpubkey_type": "v0_p2wpkh", "value": 1000 + i} for i in range(40)]
    mock.routes["/tx/" + txid] = {"txid": txid, "fee": 100, "weight": 800, "status": {"confirmed": True, "block_height": 1, "block_time": 1650000000},
                                  "vin": [{"txid": "cd" * 32, "vout": 0, "is_coinbase": False, "prevout": {"scriptpubkey_address": "bc1qsource", "scriptpubkey_type": "v0_p2wpkh", "value": 100000}}], "vout": outs}
    mock.routes["/tx/" + txid + "/outspends"] = [{"spent": False} for _ in outs]
    open_query(fpage, txid)
    fpage.evaluate("() => { window.__orion.state.capTx = 10; }")
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    assert handle(fpage, "tx:" + txid, "right")["label"] == "40"
    click_handle(fpage, "tx:" + txid, "right"); idle(fpage)
    assert len(shown(fpage)) == 11 and handle(fpage, "tx:" + txid, "right")["label"] == "30"
    first = shown(fpage)
    click_handle(fpage, "tx:" + txid, "right"); idle(fpage)
    assert len(shown(fpage)) == 21 and handle(fpage, "tx:" + txid, "right")["label"] == "20"
    assert first <= shown(fpage)
    ys = sorted(pos(fpage, i)[1] for i in shown(fpage) if i.startswith("addr:"))
    assert all(b - a >= 50 for a, b in zip(ys, ys[1:])), "the new wallets never sit on top of each other or of the old ones"


def test_starting_from_a_wallet_shows_counts_taken_from_its_history(fpage):
    open_query(fpage, ADDRESS)
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    me = "addr:" + ADDRESS
    assert shown(fpage) == {me}
    left, right = handle(fpage, me, "left"), handle(fpage, me, "right")
    assert left["known"] >= 1 and right["known"] >= 1 and not left["label"].endswith("+"), "history is complete, so the counts are exact"
    click_handle(fpage, me, "left"); idle(fpage)
    assert len(shown(fpage)) > 2
    txs = [i for i in shown(fpage) if i.startswith("tx:")]
    assert txs and all(pos(fpage, t)[0] < pos(fpage, me)[0] for t in txs), "the transactions that paid the wallet are on its left"


def test_nothing_further_is_explained_not_ignored(fpage, mock):
    open_query(fpage, COINBASE["txid"])
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    cb = "cb:" + COINBASE["txid"]
    click_handle(fpage, "tx:" + COINBASE["txid"], "left"); idle(fpage)
    assert cb in shown(fpage)
    assert handle(fpage, cb, "left") is None and handle(fpage, cb, "right") is None, "a coinbase has nothing before it"
    fpage.evaluate("(id) => window.__orion.traceExpand(id, 'next')", cb)
    assert "coinbase" in toast_text(fpage).lower()
    wallet = next(o["scriptpubkey_address"] for o in COINBASE["vout"] if o.get("scriptpubkey_address"))
    mock.routes["/address/" + wallet] = {"address": wallet, "chain_stats": {"tx_count": 1}, "mempool_stats": {"tx_count": 0}}
    mock.routes["/address/" + wallet + "/txs"] = []
    click_handle(fpage, "tx:" + COINBASE["txid"], "right"); idle(fpage)
    click_handle(fpage, "addr:" + wallet, "right"); idle(fpage)
    assert "nspent" in toast_text(fpage), toast_text(fpage)


def test_opening_something_new_is_added_and_nothing_already_shown_is_removed_or_moved(fpage):
    start_trace(fpage)
    click_handle(fpage, NORMAL_ID, "right"); idle(fpage)
    before = {i: pos(fpage, i) for i in shown(fpage)}
    assert len(before) == 3
    new = "tx:" + COINBASE["txid"]
    open_query(fpage, COINBASE["txid"]); settle(fpage)
    now = shown(fpage)
    assert set(before) | {new} == now, "the new transaction is added to what was there"
    assert {i: pos(fpage, i) for i in before} == before, "and nothing moved"
    ys = [pos(fpage, i)[1] for i in before]
    assert pos(fpage, new)[1] > max(ys), "placed clear of the existing trace"
    assert sorted(fpage.evaluate("() => window.__orion.state.trace.seeds")) == sorted([NORMAL_ID, new]), "two starting points"
    assert drawn_texts(fpage).count("START") == 2
    assert handle(fpage, new, "left") is not None, "and it can be expanded like any other"
    open_query(fpage, NORMAL["txid"]); settle(fpage)
    assert shown(fpage) == now, "opening something that is already shown just selects it"


def test_the_trace_survives_a_reload_and_an_export(fpage, tmp_path):
    start_trace(fpage)
    click_handle(fpage, NORMAL_ID, "right"); idle(fpage)
    click_handle(fpage, SMALL_ADDR, "right"); idle(fpage)
    want = {i: pos(fpage, i) for i in shown(fpage)}
    fpage.wait_for_timeout(1100)
    fpage.click("#exportMenu summary")
    with fpage.expect_download() as dl:
        fpage.click("[data-export=json]")
    p = tmp_path / "t.json"; dl.value.save_as(p)
    view = json.loads(p.read_text(encoding="utf-8"))["view"]
    assert view["layout"] == "trace" and view["trace"]["seed"] == NORMAL_ID and set(view["trace"]["shown"]) == set(want)
    fpage.reload(); fpage.wait_for_function("window.__orion && window.__orion.renderer")
    fpage.click("#restoreYes"); fpage.wait_for_function("() => window.__orion.state.graph.nodes.size > 0"); settle(fpage)
    assert fpage.evaluate("() => window.__orion.state.layout") == "trace"
    assert shown(fpage) == set(want)
    assert {i: pos(fpage, i) for i in shown(fpage)} == want, "every vertex is where it was"
    fpage.click("#btnClear"); fpage.click("#btnClear")
    fpage.set_input_files("#fileImport", str(p)); fpage.wait_for_function("() => window.__orion.state.graph.nodes.size > 0"); settle(fpage)
    assert shown(fpage) == set(want) and fpage.is_visible("#traceBar")


def test_switching_layouts_keeps_the_trace_and_shows_everything_in_the_others(fpage):
    start_trace(fpage)
    click_handle(fpage, NORMAL_ID, "right"); idle(fpage)
    traced = shown(fpage)
    fpage.click("#layoutSeg [data-layout=flow]"); settle(fpage)
    assert len(shown(fpage)) > len(traced) and fpage.is_hidden("#traceBar")
    assert fpage.is_enabled("#focusOn")
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    assert shown(fpage) == traced


def test_filters_still_apply_to_what_is_shown(fpage):
    start_trace(fpage)
    click_handle(fpage, NORMAL_ID, "right"); idle(fpage)
    fpage.click("[data-min='100000']"); settle(fpage)                       # hides the small output (about 10,470 sat)
    assert SMALL_ADDR not in shown(fpage) and BIG_ADDR in shown(fpage)
    assert SMALL_ADDR in fpage.evaluate("() => [...window.__orion.state.trace.shown]"), "hidden by a filter, not removed from the trace"
    fpage.click("[data-min='0']"); settle(fpage)
    assert SMALL_ADDR in shown(fpage)


def test_trace_needs_something_to_start_from(fpage):
    fpage.click("#layoutSeg [data-layout=trace]")
    assert "Open a transaction or a wallet first" in toast_text(fpage)
    assert fpage.evaluate("() => window.__orion.state.layout") == "flow"


def test_the_details_panel_offers_the_same_steps(fpage):
    start_trace(fpage)
    select = lambda i: (click_node(fpage, i), settle(fpage))
    select(NORMAL_ID)
    assert "Show forward" in fpage.inner_text("#inspBody") and fpage.is_disabled("#inspBody button:has-text('Hide branch')")
    fpage.click("#inspBody button:has-text('Show forward')"); idle(fpage)
    assert {BIG_ADDR, SMALL_ADDR} <= shown(fpage)
    select(SMALL_ADDR)
    body = fpage.inner_text("#inspBody")
    assert "Add as a starting point" in body and "Start over from here" in body and "Hide vertex" in body
    fpage.click("#inspBody button:has-text('Hide branch')"); settle(fpage)
    assert SMALL_ADDR not in shown(fpage)


def test_a_cancelled_or_failed_step_changes_nothing(fpage, mock):
    start_trace(fpage)
    click_handle(fpage, NORMAL_ID, "right"); idle(fpage)
    mock.fail["/tx/" + SMALL_SPENDER[3:]] = 500
    fpage.evaluate("() => { window.__orion.state.client.backoffMs = 5; }")
    before = shown(fpage)
    click_handle(fpage, SMALL_ADDR, "right"); idle(fpage)
    assert shown(fpage) == before or SMALL_SPENDER in shown(fpage)
    assert "failed" in toast_text(fpage) or SMALL_SPENDER in shown(fpage)


def test_the_handles_of_the_outermost_vertices_are_never_cut_off(fpage):
    start_trace(fpage)
    click_handle(fpage, NORMAL_ID, "right"); idle(fpage)
    click_handle(fpage, SMALL_ADDR, "right"); idle(fpage)
    click_handle(fpage, NORMAL_ID, "left"); idle(fpage)
    settle(fpage)
    inside = fpage.evaluate("() => { const r = window.__orion.renderer; return r.handleRects.length > 0 && r.handleRects.every(h => h.x >= 0 && h.y >= 0 && h.x + h.w <= r.w && h.y + h.h <= r.h); }")
    assert inside, "every handle is fully on the canvas"


# ---------------------------------------------------------------- keeping what is shown, and choosing what goes
def select_many(page, ids):
    click_node(page, ids[0]); settle(page)
    for i in ids[1:]:
        page.keyboard.down("Shift"); click_node(page, i); page.keyboard.up("Shift"); settle(page)


def test_clicking_never_removes_or_moves_anything_that_is_shown(fpage):
    start_trace(fpage)
    seen, where = set(), {}
    steps = [(NORMAL_ID, "right"), (NORMAL_ID, "left"), (SMALL_ADDR, "right"), (BIG_ADDR, "right")]
    for vid, d in steps:
        click_handle(fpage, vid, d); idle(fpage)
        now = shown(fpage)
        assert seen <= now, "a click removed: %s" % (seen - now)
        for i in seen:
            assert pos(fpage, i) == where[i], "%s moved" % i
        seen = now; where = {i: pos(fpage, i) for i in now}
    assert len(seen) >= 7


def test_hide_one_vertex_keeps_what_it_revealed_and_undo_puts_it_back_in_place(fpage):
    start_trace(fpage)
    click_handle(fpage, NORMAL_ID, "right"); idle(fpage)
    click_handle(fpage, SMALL_ADDR, "right"); idle(fpage)
    spot = pos(fpage, SMALL_ADDR)
    p = xy(fpage, SMALL_ADDR); fpage.mouse.click(p["x"], p["y"], button="right")
    fpage.click("#ctxMenu >> text=Hide this vertex"); settle(fpage)
    now = shown(fpage)
    assert SMALL_ADDR not in now and SMALL_SPENDER in now and NEXT_WALLET in now, "only that vertex went; the transaction and wallet beyond it stay"
    assert handle(fpage, NORMAL_ID, "right")["known"] == 1, "the transaction's handle counts the hidden wallet again, so it can be shown again"
    assert fpage.evaluate("(id) => window.__orion.state.graph.nodes.has(id)", SMALL_ADDR), "hidden, not deleted: it stays loaded"
    fpage.keyboard.press("Control+z"); settle(fpage)
    assert SMALL_ADDR in shown(fpage) and pos(fpage, SMALL_ADDR) == spot, "undo brings it back exactly where it was"


def test_select_several_then_hide_them_or_keep_only_them(fpage):
    start_trace(fpage)
    click_handle(fpage, NORMAL_ID, "right"); idle(fpage)
    click_handle(fpage, NORMAL_ID, "left"); idle(fpage)
    assert len(shown(fpage)) == 4
    select_many(fpage, [BIG_ADDR, SMALL_ADDR])
    assert fpage.is_enabled("#traceHide") and fpage.is_enabled("#traceKeep") and "2 selected" in fpage.inner_text("#traceInfo")
    fpage.click("#traceKeep"); settle(fpage)
    assert shown(fpage) == {BIG_ADDR, SMALL_ADDR}
    assert "Kept 2" in toast_text(fpage)
    fpage.click("#traceUndo"); settle(fpage)
    assert len(shown(fpage)) == 4
    select_many(fpage, [BIG_ADDR, SMALL_ADDR])
    fpage.click("#traceHide"); settle(fpage)
    assert shown(fpage) == {NORMAL_ID, INPUT_ADDR}
    fpage.keyboard.press("Control+z"); settle(fpage)
    assert len(shown(fpage)) == 4


def test_delete_hides_in_a_trace_but_never_deletes_the_loaded_data(fpage):
    start_trace(fpage)
    click_handle(fpage, NORMAL_ID, "right"); idle(fpage)
    nodes_before = fpage.evaluate("() => window.__orion.state.graph.nodes.size")
    click_node(fpage, SMALL_ADDR); settle(fpage)
    fpage.keyboard.press("Delete"); settle(fpage)
    assert SMALL_ADDR not in shown(fpage)
    assert fpage.evaluate("() => window.__orion.state.graph.nodes.size") == nodes_before, "nothing was deleted from the workspace"
    fpage.keyboard.press("Control+z"); settle(fpage)
    assert SMALL_ADDR in shown(fpage)


def test_select_all_and_select_branch(fpage):
    start_trace(fpage)
    click_handle(fpage, NORMAL_ID, "right"); idle(fpage)
    click_handle(fpage, SMALL_ADDR, "right"); idle(fpage)
    fpage.locator("#cv").focus()
    fpage.keyboard.press("Control+a"); settle(fpage)
    assert set(fpage.evaluate("() => [...window.__orion.state.selected]")) == shown(fpage)
    fpage.keyboard.press("Delete"); settle(fpage)
    assert "at least one" in toast_text(fpage) and len(shown(fpage)) == 5, "the last vertices cannot all be hidden at once"
    fpage.keyboard.press("Escape"); settle(fpage)                              # clear the selection: a right-click on a selected group opens the group menu
    p = xy(fpage, SMALL_ADDR); fpage.mouse.click(p["x"], p["y"], button="right")
    fpage.click("#ctxMenu >> text=Select this branch"); settle(fpage)
    assert set(fpage.evaluate("() => [...window.__orion.state.selected]")) == {SMALL_ADDR, SMALL_SPENDER, NEXT_WALLET}
    fpage.click("#traceHide"); settle(fpage)
    assert shown(fpage) == {NORMAL_ID, BIG_ADDR}


def test_hiding_every_starting_point_makes_another_vertex_the_start_and_the_last_cannot_go(fpage):
    start_trace(fpage)
    click_handle(fpage, NORMAL_ID, "right"); idle(fpage)
    fpage.evaluate("(id) => window.__orion.traceHideIds([id])", NORMAL_ID); settle(fpage)
    assert NORMAL_ID not in shown(fpage)
    seeds = fpage.evaluate("() => window.__orion.state.trace.seeds")
    assert len(seeds) == 1 and seeds[0] in shown(fpage), "a remaining vertex is the start now"
    assert drawn_texts(fpage).count("START") == 1
    fpage.evaluate("(id) => window.__orion.traceHideIds([id])", seeds[0]); settle(fpage)
    assert len(shown(fpage)) == 1, "one vertex always stays"
    only = next(iter(shown(fpage)))
    p = xy(fpage, only); fpage.mouse.click(p["x"], p["y"], button="right")
    assert fpage.is_disabled("#ctxMenu >> text=Hide this vertex")


def test_start_over_from_here_replaces_the_trace(fpage):
    start_trace(fpage)
    click_handle(fpage, NORMAL_ID, "right"); idle(fpage)
    p = xy(fpage, BIG_ADDR); fpage.mouse.click(p["x"], p["y"], button="right")
    fpage.click("#ctxMenu >> text=Start over from here"); idle(fpage); settle(fpage)
    assert shown(fpage) == {BIG_ADDR}
    assert fpage.evaluate("() => window.__orion.state.trace.seeds") == [BIG_ADDR]
    assert fpage.is_disabled("#traceUndo"), "a fresh start has nothing to undo"


def test_add_an_already_shown_vertex_as_another_starting_point(fpage):
    start_trace(fpage)
    click_handle(fpage, NORMAL_ID, "right"); idle(fpage)
    click_node(fpage, BIG_ADDR); settle(fpage)
    fpage.click("#inspBody button:has-text('Add as a starting point')"); settle(fpage)
    assert drawn_texts(fpage).count("START") == 2 and len(shown(fpage)) == 3
    fpage.keyboard.press("Control+z"); settle(fpage)
    assert drawn_texts(fpage).count("START") == 1 and len(shown(fpage)) == 3


def many_outputs(mock, n=40):
    txid = "ef" * 32
    outs = [{"scriptpubkey_address": "bc1qchoose%03d" % i, "scriptpubkey_type": "v0_p2wpkh", "value": 100000 - i * 7} for i in range(n)]
    mock.routes["/tx/" + txid] = {"txid": txid, "fee": 100, "weight": 800, "status": {"confirmed": True, "block_height": 1, "block_time": 1650000000},
                                  "vin": [{"txid": "cd" * 32, "vout": 0, "is_coinbase": False, "prevout": {"scriptpubkey_address": "bc1qsrc", "scriptpubkey_type": "v0_p2wpkh", "value": 9000000}}], "vout": outs}
    mock.routes["/tx/" + txid + "/outspends"] = [{"spent": False} for _ in outs]
    return "tx:" + txid, outs


def test_shift_click_on_a_handle_lets_you_choose_which_to_show(fpage, mock):
    tx, outs = many_outputs(mock)
    open_query(fpage, tx[3:])
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    click_handle(fpage, tx, "right", shift=True)
    assert fpage.is_visible("#ctxMenu .chooser")
    boxes = fpage.locator("#ctxMenu .chooser input[type=checkbox]")
    assert boxes.count() == 40 and "40 hidden" in fpage.inner_text("#ctxMenu").lower()
    assert sum(1 for i in range(40) if boxes.nth(i).is_checked()) == 10, "the ten largest are ticked to start with"
    fpage.click("#ctxMenu >> text=None")
    assert fpage.is_disabled("#ctxMenu >> text=Show 0 selected")
    for i in (3, 17):
        boxes.nth(i).check()
    fpage.click("#ctxMenu >> text=Show 2 selected"); idle(fpage); settle(fpage)
    got = shown(fpage) - {tx}
    assert got == {"addr:bc1qchoose003", "addr:bc1qchoose017"}, got
    assert handle(fpage, tx, "right")["known"] == 38, "the other 38 are still counted on the handle"
    assert fpage.is_hidden("#ctxMenu")


def test_the_chooser_works_from_the_menu_and_can_be_cancelled(fpage, mock):
    tx, outs = many_outputs(mock, 12)
    open_query(fpage, tx[3:])
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    p = xy(fpage, tx); fpage.mouse.click(p["x"], p["y"], button="right")
    fpage.click("#ctxMenu >> text=Choose what to show ▶…")
    assert fpage.is_visible("#ctxMenu .chooser")
    fpage.click("#ctxMenu >> text=Cancel")
    assert fpage.is_hidden("#ctxMenu") and shown(fpage) == {tx}
    p = xy(fpage, tx); fpage.mouse.click(p["x"], p["y"], button="right")
    fpage.click("#ctxMenu >> text=Choose what to show ▶…")
    fpage.click("#ctxMenu >> text=All"); fpage.click("#ctxMenu >> text=Show 12 selected"); idle(fpage)
    assert len(shown(fpage)) == 13


def test_starting_points_hidden_vertices_and_positions_survive_a_reload(fpage):
    start_trace(fpage)
    click_handle(fpage, NORMAL_ID, "right"); idle(fpage)
    open_query(fpage, COINBASE["txid"]); settle(fpage)
    click_node(fpage, SMALL_ADDR); settle(fpage)
    fpage.keyboard.press("Delete"); settle(fpage)
    want = {i: pos(fpage, i) for i in shown(fpage)}
    seeds = sorted(fpage.evaluate("() => window.__orion.state.trace.seeds"))
    assert len(seeds) == 2 and SMALL_ADDR not in want
    fpage.wait_for_timeout(1100)
    fpage.reload(); fpage.wait_for_function("window.__orion && window.__orion.renderer")
    fpage.click("#restoreYes"); fpage.wait_for_function("() => window.__orion.state.graph.nodes.size > 0"); settle(fpage)
    assert shown(fpage) == set(want) and {i: pos(fpage, i) for i in shown(fpage)} == want
    assert sorted(fpage.evaluate("() => window.__orion.state.trace.seeds")) == seeds
    assert drawn_texts(fpage).count("START") == 2
