"""Arranging a trace over time / by force / by time and amount, and selecting and hiding vertices in every layout."""
import json

import pytest

from chains import peel_chain, tid
from conftest import NORMAL
from helpers import click_node, idle, open_query, settle, toast_text, xy

NORMAL_ID = "tx:" + NORMAL["txid"]
BIG = max(range(len(NORMAL["vout"])), key=lambda i: NORMAL["vout"][i]["value"])
BIG_ADDR = "addr:" + NORMAL["vout"][BIG]["scriptpubkey_address"]
SMALL_ADDR = "addr:" + NORMAL["vout"][1 - BIG]["scriptpubkey_address"]
INPUT_ADDR = "addr:" + NORMAL["vin"][0]["prevout"]["scriptpubkey_address"]


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def shown(page):
    return set(page.evaluate("() => [...window.__orion.renderer.data.visible.nodes]"))


def pos(page, id_):
    return page.evaluate("(id) => { const p = window.__orion.renderer.positionOf(id); return p ? [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10] : null; }", id_)


def selected(page):
    return set(page.evaluate("() => [...window.__orion.state.selected]"))


def hidden(page):
    return set(page.evaluate("() => [...window.__orion.state.hidden]"))


def in_graph(page, id_):
    return page.evaluate("(id) => window.__orion.state.graph.nodes.has(id)", id_)


def drawn_texts(page):
    return page.evaluate("""() => { const r = window.__orion.renderer, ctx = r.ctx, orig = ctx.fillText.bind(ctx), seen = [];
        ctx.fillText = (t, ...a) => { seen.push(String(t)); return orig(t, ...a); }; r.draw(); ctx.fillText = orig; return seen; }""")


def kind(id_):
    return id_.split(":")[0]


def traced(fpage, mock, length=8, hops=4):
    """A trace of a peel chain: transactions 10.. with the wallets they paid, shown."""
    peel_chain(mock, length)
    open_query(fpage, tid(10))
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    fpage.evaluate("(id) => window.__orion.autoExpand(id, { dir: 'next', hops: %d, follow: 'all' })" % hops, "tx:" + tid(10)); idle(fpage); settle(fpage)
    return sorted(shown(fpage))


def arrange(page, name):
    page.select_option("#traceArrange", name); idle(page); settle(page)


def screen_positions(page):
    return page.evaluate("""() => { const r = window.__orion.renderer, b = r.canvas.getBoundingClientRect(), v = r.view, out = {};
        r.data.visible.nodes.forEach(id => { const p = r.positionOf(id); out[id] = [b.left + p.x * v.k + v.x, b.top + p.y * v.k + v.y]; }); return out; }""")


def drag(page, a, b, shift=False, steps=8):
    if shift:
        page.keyboard.down("Shift")
    page.mouse.move(a[0], a[1]); page.mouse.down(); page.mouse.move(b[0], b[1], steps=steps); page.mouse.up()
    if shift:
        page.keyboard.up("Shift")
    settle(page)


def box_for(page, take):
    """A box from clear background to the middle of the vertices, and the ids in it by an independent count."""
    sp = screen_positions(page)
    xs = [p[0] for p in sp.values()]; ys = [p[1] for p in sp.values()]
    start = (min(xs) - 40, min(ys) - 40)
    end = (min(xs) + (max(xs) - min(xs)) * take, min(ys) + (max(ys) - min(ys)) * take)
    inside = {i for i, p in sp.items() if start[0] <= p[0] <= end[0] and start[1] <= p[1] <= end[1]}
    return start, end, inside


# ---------------------------------------------------------------- arranging a trace
def test_the_arrange_menu_belongs_to_a_trace_and_columns_is_where_it_starts(fpage):
    open_query(fpage, NORMAL["txid"])
    assert fpage.is_hidden("#traceArrange") and fpage.is_hidden("#traceReset")
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    assert fpage.is_visible("#traceArrange") and fpage.input_value("#traceArrange") == "columns"
    assert fpage.is_hidden("#scaleRow"), "the time scale choice only matters once time is on an axis"
    assert fpage.evaluate("() => window.__orion.renderer.data.axis.mode") == "marks", "Columns is not a time scale, but its transactions carry timestamps along the top"


def test_timeline_places_the_traced_vertices_by_time_and_nothing_is_added_or_lost(fpage, mock):
    ids = traced(fpage, mock)
    columns = {i: pos(fpage, i) for i in ids}
    arrange(fpage, "timeline")
    assert sorted(shown(fpage)) == ids, "arranging changes where, never what"
    txs = [i for i in ids if kind(i) == "tx"]
    assert txs == sorted(txs), "ids sort by time here (10, 11, ...)"
    xs = [pos(fpage, t)[0] for t in sorted(txs)]
    assert xs == sorted(xs) and len(set(xs)) == len(xs), "left to right in time: %s" % xs
    assert fpage.evaluate("() => window.__orion.renderer.data.axis !== null") and fpage.is_visible("#scaleRow")
    assert any(t.startswith("04-15") or t.startswith("2022") for t in drawn_texts(fpage)), "the time axis is drawn"
    assert len({tuple(pos(fpage, i)) for i in ids}) == len(ids), "no two on the same spot"
    arrange(fpage, "columns")
    assert {i: pos(fpage, i) for i in ids} == columns, "back to Columns: exactly where you had them"
    assert fpage.evaluate("() => window.__orion.renderer.data.axis.mode") == "marks" and fpage.is_hidden("#scaleRow")


def test_force_places_every_traced_vertex_apart(fpage, mock):
    ids = traced(fpage, mock)
    arrange(fpage, "force")
    assert sorted(shown(fpage)) == ids
    pts = [pos(fpage, i) for i in ids]
    assert all(p is not None and abs(p[0]) < 1e6 and abs(p[1]) < 1e6 for p in pts)
    assert all(((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5 > 8 for n, a in enumerate(pts) for b in pts[n + 1:]), "nothing on top of anything"
    assert fpage.evaluate("() => window.__orion.renderer.data.axis") is None and fpage.is_hidden("#scaleRow")


def test_time_by_amount_puts_the_big_amounts_high_and_draws_an_amount_scale(fpage, mock):
    ids = traced(fpage, mock)
    arrange(fpage, "timeline")
    tl_x = {i: pos(fpage, i)[0] for i in ids}
    arrange(fpage, "timeamount")
    assert {i: pos(fpage, i)[0] for i in ids} == tl_x, "time runs along x exactly as in the timeline"
    big, small = "addr:" + "bc1q" + "c10".ljust(20, "x"), "addr:" + "bc1q" + "peel10".ljust(20, "x")
    assert pos(fpage, big)[1] < pos(fpage, small)[1], "the wallet that received 0.0099 BTC is above the one that received 1,000 sat"
    ticks = fpage.evaluate("() => window.__orion.renderer.data.axis.yTicks.map(t => t.label)")
    assert len(ticks) >= 2 and all(t.endswith(" BTC") or t.endswith(" sat") for t in ticks), ticks
    texts = drawn_texts(fpage)
    assert any(t in texts for t in ticks), "the amount scale is drawn on the canvas"
    assert len({tuple(pos(fpage, i)) for i in ids}) == len(ids)
    ys = [pos(fpage, "tx:" + tid(10 + k))[1] for k in range(4)]
    assert max(ys) - min(ys) < 150, "transactions of similar size sit at similar heights"


def test_adding_to_a_timeline_trace_keeps_it_in_time_order(fpage, mock):
    traced(fpage, mock, hops=2)
    arrange(fpage, "timeline")
    before = shown(fpage)
    fpage.evaluate("(id) => window.__orion.traceExpand(id, 'next')", "tx:" + tid(12)); idle(fpage); settle(fpage)
    now = shown(fpage)
    assert before < now and "addr:" + "bc1q" + "c12".ljust(20, "x") in now, "the wallets the last transaction paid are added"
    txs = ["tx:" + tid(i) for i in range(10, 13)]
    xs = [pos(fpage, t)[0] for t in txs]
    assert xs == sorted(xs) and len(set(xs)) == 3, xs
    assert len({tuple(pos(fpage, i)) for i in now}) == len(now), "and nothing is on top of anything"


def test_dragging_in_another_arrangement_does_not_spoil_the_columns_you_built(fpage, mock):
    ids = traced(fpage, mock, hops=3)
    columns = {i: pos(fpage, i) for i in ids}
    arrange(fpage, "timeline")
    p = xy(fpage, "tx:" + tid(11)); fpage.mouse.move(p["x"], p["y"]); fpage.mouse.down(); fpage.mouse.move(p["x"] + 40, p["y"] + 90, steps=6); fpage.mouse.up(); settle(fpage)
    assert pos(fpage, "tx:" + tid(11)) != [round(columns["tx:" + tid(11)][0], 1), round(columns["tx:" + tid(11)][1], 1)]
    arrange(fpage, "columns")
    assert {i: pos(fpage, i) for i in ids} == columns


def test_re_layout_releases_a_dragged_vertex_in_a_time_arrangement(fpage, mock):
    traced(fpage, mock, hops=3)
    arrange(fpage, "timeline")
    home = pos(fpage, "tx:" + tid(11))
    p = xy(fpage, "tx:" + tid(11)); fpage.mouse.move(p["x"], p["y"]); fpage.mouse.down(); fpage.mouse.move(p["x"] + 30, p["y"] + 120, steps=6); fpage.mouse.up(); settle(fpage)
    assert pos(fpage, "tx:" + tid(11)) != home
    fpage.click("#btnRelayout"); idle(fpage); settle(fpage)
    assert pos(fpage, "tx:" + tid(11)) == home


def test_the_arrangement_is_saved_with_the_session(fpage, mock):
    ids = traced(fpage, mock, hops=3)
    arrange(fpage, "timeamount")
    fpage.wait_for_timeout(1100)
    fpage.reload(); fpage.wait_for_function("window.__orion && window.__orion.renderer")
    fpage.click("#restoreYes"); fpage.wait_for_function("() => window.__orion.state.graph.nodes.size > 0"); settle(fpage)
    assert fpage.evaluate("() => window.__orion.state.arrange") == "timeamount" and fpage.input_value("#traceArrange") == "timeamount"
    assert sorted(shown(fpage)) == ids and fpage.evaluate("() => window.__orion.renderer.data.axis.yTicks.length") >= 2


# ---------------------------------------------------------------- box selection
def test_shift_drag_selects_what_the_box_covers_and_adds_to_the_selection(fpage):
    open_query(fpage, NORMAL["txid"])
    fpage.click("#inspClose"); settle(fpage)
    start, end, inside = box_for(fpage, 0.55)
    assert len(inside) >= 2, "the box covers several vertices"
    drag(fpage, start, end, shift=True)
    assert selected(fpage) == inside
    assert "selected" in fpage.inner_text("#traceInfo") and str(len(inside)) in fpage.inner_text("#traceInfo")
    start2, end2, inside2 = box_for(fpage, 1.0)
    fpage.keyboard.press("Escape"); settle(fpage)
    drag(fpage, start, end, shift=True)
    drag(fpage, (end[0] + 3, end[1] + 3), (end2[0] + 40, end2[1] + 40), shift=True)
    got = selected(fpage)
    assert inside < got, "the second box was added to the first"


def test_box_mode_makes_a_plain_drag_a_box_and_escape_leaves_it(fpage):
    open_query(fpage, NORMAL["txid"])
    fpage.click("#inspClose"); settle(fpage)
    fpage.locator("#cv").focus()
    fpage.keyboard.press("b")
    assert fpage.get_attribute("#boxSel", "aria-pressed") == "true" and fpage.evaluate("() => window.__orion.renderer.boxMode")
    start, end, inside = box_for(fpage, 0.55)
    drag(fpage, start, end)
    assert selected(fpage) == inside
    start2, end2, inside2 = box_for(fpage, 0.3)
    drag(fpage, start2, end2)
    assert selected(fpage) == inside2, "without Shift a new box replaces the selection"
    fpage.mouse.click(start[0], start[1]); settle(fpage)
    assert selected(fpage) == set(), "a click on the background still clears it"
    fpage.keyboard.press("Escape")
    assert fpage.get_attribute("#boxSel", "aria-pressed") == "false" and not fpage.evaluate("() => window.__orion.renderer.boxMode")
    fpage.click("#boxSel")
    assert fpage.evaluate("() => window.__orion.renderer.boxMode")
    fpage.click("#boxSel")
    assert not fpage.evaluate("() => window.__orion.renderer.boxMode")


def test_a_plain_drag_still_pans_when_box_mode_is_off(fpage):
    open_query(fpage, NORMAL["txid"])
    fpage.click("#inspClose"); settle(fpage)
    before = fpage.evaluate("() => ({ ...window.__orion.renderer.view })")
    start, end, _ = box_for(fpage, 0.55)
    drag(fpage, start, end)
    after = fpage.evaluate("() => ({ ...window.__orion.renderer.view })")
    assert after["x"] != before["x"] or after["y"] != before["y"], "the view panned"


# ---------------------------------------------------------------- the Select menu
def test_the_select_menu_picks_all_wallets_all_transactions_invert_and_none(fpage):
    open_query(fpage, NORMAL["txid"])
    fpage.click("#inspClose"); settle(fpage)
    vis = shown(fpage)
    wallets = {i for i in vis if kind(i) == "addr"}; txs = {i for i in vis if kind(i) == "tx"}
    assert wallets and txs
    fpage.click("#selMenu"); fpage.click("#ctxMenu >> text=All wallets"); settle(fpage)
    assert selected(fpage) == wallets
    fpage.click("#selMenu"); fpage.click("#ctxMenu >> text=All transactions"); settle(fpage)
    assert selected(fpage) == txs
    fpage.click("#selMenu"); fpage.click("#ctxMenu >> text=Invert"); settle(fpage)
    assert selected(fpage) == vis - txs
    fpage.click("#selMenu"); fpage.click("#ctxMenu >> text=None"); settle(fpage)
    assert selected(fpage) == set()
    fpage.click("#selMenu"); fpage.click("#ctxMenu >> text=All"); settle(fpage)
    assert selected(fpage) == vis


def test_select_by_amount_uses_the_largest_movement_of_each_vertex(fpage, mock):
    ids = traced(fpage, mock, hops=3)
    amounts = fpage.evaluate("""() => { const o = window.__orion, g = o.state.graph, vs = o.renderer.data.visible, out = {};
        vs.nodes.forEach(id => { out[id] = OrionLayout.vertexAmount(g, vs, id); }); return out; }""")
    limit = 0.005
    want_both = {i for i, a in amounts.items() if a >= limit * 1e8}
    want_wallets = {i for i in want_both if kind(i) == "addr"}
    assert want_wallets and want_both - want_wallets and len(want_both) < len(ids), "the threshold separates big from small"
    fpage.click("#selMenu")
    fpage.fill("#ctxMenu input[type=number]", str(limit))
    fpage.click("#ctxMenu button:text-is('Wallets')"); settle(fpage)
    assert selected(fpage) == want_wallets
    assert "0.005" in toast_text(fpage)
    fpage.click("#selMenu"); fpage.fill("#ctxMenu input[type=number]", str(limit)); fpage.click("#ctxMenu button:text-is('Both')"); settle(fpage)
    assert selected(fpage) == want_both


def test_ctrl_a_and_the_background_menu_select_everything_on_screen_in_any_layout(fpage):
    open_query(fpage, NORMAL["txid"])
    fpage.locator("#cv").focus()
    fpage.keyboard.press("Control+a"); settle(fpage)
    assert selected(fpage) == shown(fpage)
    fpage.keyboard.press("Escape"); settle(fpage)
    assert selected(fpage) == set()
    fpage.locator("#cv").click(button="right", position={"x": 15, "y": 420})
    fpage.click("#ctxMenu >> text=Select all"); settle(fpage)
    assert selected(fpage) == shown(fpage)


def test_a_selection_of_both_kinds_can_be_narrowed_to_wallets_or_transactions(fpage):
    open_query(fpage, NORMAL["txid"])
    fpage.keyboard.press("Control+a"); settle(fpage)
    vis = shown(fpage)
    wallets = {i for i in vis if kind(i) == "addr"}
    assert "selected" in fpage.inner_text("#inspBody").lower()
    fpage.click("#inspBody button:has-text('Wallets only')"); settle(fpage)
    assert selected(fpage) == wallets
    fpage.keyboard.press("Control+a"); settle(fpage)
    fpage.click("#inspBody button:has-text('Transactions only')"); settle(fpage)
    assert selected(fpage) == {i for i in vis if kind(i) == "tx"}


# ---------------------------------------------------------------- hiding in every layout
def two_wallets(page):
    open_query(page, NORMAL["txid"])
    page.evaluate("(ids) => window.__orion.setSel(ids)", [BIG_ADDR, SMALL_ADDR])
    settle(page)


def test_hide_selected_takes_them_off_the_screen_keeps_them_loaded_and_undo_brings_them_back(fpage):
    two_wallets(fpage)
    assert fpage.is_enabled("#traceHide") and fpage.is_visible("#traceBar")
    fpage.click("#traceHide"); settle(fpage)
    assert not ({BIG_ADDR, SMALL_ADDR} & shown(fpage)) and in_graph(fpage, BIG_ADDR) and in_graph(fpage, SMALL_ADDR)
    assert NORMAL_ID in shown(fpage), "the transaction between them stays"
    assert hidden(fpage) == {BIG_ADDR, SMALL_ADDR}
    assert fpage.is_visible("#hiddenBtn") and "Hidden (2)" in fpage.inner_text("#hiddenBtn")
    assert "Ctrl+Z" in toast_text(fpage) and selected(fpage) == set()
    fpage.keyboard.press("Control+z"); settle(fpage)
    assert {BIG_ADDR, SMALL_ADDR} <= shown(fpage) and hidden(fpage) == set() and fpage.is_hidden("#hiddenBtn")
    assert fpage.is_disabled("#traceUndo")


def test_hiding_a_transaction_leaves_its_wallets_on_screen(fpage):
    open_query(fpage, NORMAL["txid"])
    fpage.uncheck("#focusOn"); settle(fpage)
    wallets = {i for i in shown(fpage) if kind(i) == "addr"}
    fpage.evaluate("(ids) => window.__orion.hideIds(ids)", [NORMAL_ID]); settle(fpage)
    assert NORMAL_ID not in shown(fpage) and in_graph(fpage, NORMAL_ID)
    assert wallets <= shown(fpage), "hiding the hub does not make its neighbours vanish"


def test_keep_only_selected_hides_the_rest_and_undo_restores_all_of_it(fpage):
    two_wallets(fpage)
    fpage.uncheck("#focusOn"); settle(fpage)                                  # (with Focus on, the focused vertex always stays)
    fpage.evaluate("(ids) => window.__orion.setSel(ids)", [BIG_ADDR, SMALL_ADDR]); settle(fpage)
    before = shown(fpage)
    fpage.click("#traceKeep"); settle(fpage)
    assert shown(fpage) == {BIG_ADDR, SMALL_ADDR}
    assert hidden(fpage) == before - {BIG_ADDR, SMALL_ADDR} and "Kept 2" in toast_text(fpage)
    fpage.click("#traceUndo"); settle(fpage)
    assert shown(fpage) == before and hidden(fpage) == set()


def test_the_hidden_menu_shows_some_or_all_again_and_that_can_be_undone(fpage):
    open_query(fpage, NORMAL["txid"])
    fpage.uncheck("#focusOn"); settle(fpage)
    victims = [BIG_ADDR, SMALL_ADDR, INPUT_ADDR]
    fpage.evaluate("(ids) => window.__orion.hideIds(ids)", victims); settle(fpage)
    assert hidden(fpage) == set(victims) and "Hidden (3)" in fpage.inner_text("#hiddenBtn")
    fpage.click("#hiddenBtn")
    assert fpage.locator("#ctxMenu .chooser input[type=checkbox]").count() == 3
    fpage.locator("#ctxMenu .chooser input[type=checkbox]").first.check()
    fpage.click("#ctxMenu >> text=Show 1 selected"); settle(fpage)
    assert len(hidden(fpage)) == 2 and "Hidden (2)" in fpage.inner_text("#hiddenBtn")
    fpage.click("#hiddenBtn"); fpage.click("#ctxMenu >> text=Show all 2"); settle(fpage)
    assert hidden(fpage) == set() and set(victims) <= shown(fpage)
    fpage.keyboard.press("Control+z"); settle(fpage)
    assert len(hidden(fpage)) == 2, "showing them all again was one undoable step"


def test_delete_hides_and_shift_delete_removes_from_the_workspace(fpage):
    two_wallets(fpage)
    fpage.keyboard.press("Delete"); settle(fpage)
    assert hidden(fpage) == {BIG_ADDR, SMALL_ADDR} and in_graph(fpage, BIG_ADDR)
    fpage.keyboard.press("Control+z"); settle(fpage)
    fpage.evaluate("(ids) => window.__orion.setSel(ids)", [SMALL_ADDR]); settle(fpage)
    fpage.keyboard.press("Shift+Delete"); settle(fpage)
    assert not in_graph(fpage, SMALL_ADDR) and hidden(fpage) == set(), "Shift+Delete really deletes it"
    assert in_graph(fpage, BIG_ADDR)


def test_the_focused_vertex_is_not_hidden_while_the_focus_view_is_on(fpage):
    open_query(fpage, NORMAL["txid"])
    fpage.evaluate("(ids) => window.__orion.setSel(ids)", [NORMAL_ID]); settle(fpage)
    fpage.click("#traceHide"); settle(fpage)
    assert hidden(fpage) == set() and NORMAL_ID in shown(fpage)
    assert "focused vertex" in toast_text(fpage)


def test_hidden_vertices_are_saved_with_the_session_and_the_export(fpage):
    two_wallets(fpage)
    fpage.click("#traceHide"); settle(fpage)
    fpage.wait_for_timeout(1100)
    text = fpage.evaluate("() => OrionIO.toJson(window.__orion.state.graph, { view: { hidden: [...window.__orion.state.hidden] } })")
    assert set(json.loads(text)["view"]["hidden"]) == {BIG_ADDR, SMALL_ADDR}
    fpage.reload(); fpage.wait_for_function("window.__orion && window.__orion.renderer")
    fpage.click("#restoreYes"); fpage.wait_for_function("() => window.__orion.state.graph.nodes.size > 0"); settle(fpage)
    assert hidden(fpage) == {BIG_ADDR, SMALL_ADDR} and not ({BIG_ADDR, SMALL_ADDR} & shown(fpage))
    assert "Hidden (2)" in fpage.inner_text("#hiddenBtn")


def test_import_ignores_hidden_entries_that_are_not_vertex_ids(fpage):
    open_query(fpage, NORMAL["txid"])
    doc = json.loads(fpage.evaluate("() => OrionIO.toJson(window.__orion.state.graph, { view: { hidden: [] } })"))
    doc["view"]["hidden"] = [BIG_ADDR, "<script>alert(1)</script>", 5, None, "x" * 5000]
    fpage.click("#btnClear"); fpage.click("#btnClear"); settle(fpage)
    fpage.evaluate("(text) => { const f = new File([text], 'w.json'); const dt = new DataTransfer(); dt.items.add(f); const i = document.getElementById('fileImport'); i.files = dt.files; i.dispatchEvent(new Event('change')); }", json.dumps(doc))
    fpage.wait_for_function("() => window.__orion.state.graph.nodes.size > 0"); settle(fpage)
    assert hidden(fpage) == {BIG_ADDR}


def test_the_right_click_menu_hides_one_or_several(fpage):
    open_query(fpage, NORMAL["txid"])
    fpage.uncheck("#focusOn"); settle(fpage)
    p = xy(fpage, BIG_ADDR); fpage.mouse.click(p["x"], p["y"], button="right")
    menu = fpage.inner_text("#ctxMenu")
    assert "Hide this vertex" in menu and "Remove from view" in menu
    fpage.click("#ctxMenu >> text=Hide this vertex"); settle(fpage)
    assert hidden(fpage) == {BIG_ADDR}
    fpage.evaluate("(ids) => window.__orion.setSel(ids)", [SMALL_ADDR, INPUT_ADDR]); settle(fpage)
    p = xy(fpage, SMALL_ADDR); fpage.mouse.click(p["x"], p["y"], button="right")
    menu = fpage.inner_text("#ctxMenu")
    assert "Hide 2" in menu and "Keep only these 2" in menu and "Remove 2 from view" in menu
    fpage.click("#ctxMenu >> text=Keep only these 2"); settle(fpage)
    assert shown(fpage) == {SMALL_ADDR, INPUT_ADDR}


def test_the_details_of_several_selected_vertices_offer_hide_and_keep(fpage):
    open_query(fpage, NORMAL["txid"])
    fpage.uncheck("#focusOn"); settle(fpage)
    fpage.locator("#cv").focus(); fpage.keyboard.press("Control+a"); settle(fpage)
    n = len(selected(fpage))
    assert fpage.is_disabled("#inspBody button:has-text('Keep only these')"), "everything is selected: nothing to hide"
    fpage.evaluate("(ids) => window.__orion.setSel(ids)", [BIG_ADDR, SMALL_ADDR]); settle(fpage)
    fpage.click("#inspBody button:has-text('Hide 2')"); settle(fpage)
    assert hidden(fpage) == {BIG_ADDR, SMALL_ADDR} and n > 2


def test_the_bar_is_there_in_every_layout_and_its_trace_parts_only_in_a_trace(fpage):
    assert fpage.is_hidden("#traceBar"), "nothing loaded yet"
    open_query(fpage, NORMAL["txid"])
    for layout in ("flow", "timeline", "force"):
        fpage.click("#layoutSeg [data-layout=%s]" % layout); settle(fpage)
        assert fpage.is_visible("#traceBar") and fpage.is_visible("#selMenu") and fpage.is_visible("#boxSel"), layout
        assert fpage.is_hidden("#traceArrange") and fpage.is_hidden("#traceReset"), layout
        assert "Selection" in fpage.inner_text("#barTitle")
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    assert fpage.is_visible("#traceArrange") and fpage.is_visible("#traceReset") and "Trace" in fpage.inner_text("#barTitle")
    fpage.click("#layoutSeg [data-layout=timeline]"); settle(fpage)
    assert fpage.evaluate("() => document.body.classList.contains('axis-on')"), "the bar steps down below the time axis"
    box = fpage.locator("#traceBar").bounding_box()
    assert box["y"] > 30


def test_hiding_works_in_the_timeline_and_force_layouts_too(fpage):
    open_query(fpage, NORMAL["txid"])
    fpage.uncheck("#focusOn"); settle(fpage)
    for layout in ("timeline", "force"):
        fpage.click("#layoutSeg [data-layout=%s]" % layout); settle(fpage)
        fpage.evaluate("(ids) => window.__orion.setSel(ids)", [BIG_ADDR]); settle(fpage)
        fpage.click("#traceHide"); settle(fpage)
        assert BIG_ADDR not in shown(fpage) and NORMAL_ID in shown(fpage), layout
        fpage.click("#traceUndo"); settle(fpage)
        assert BIG_ADDR in shown(fpage), layout


def test_the_time_slider_and_hiding_work_together(fpage):
    open_query(fpage, NORMAL["txid"])
    fpage.uncheck("#focusOn"); settle(fpage)
    fpage.evaluate("(ids) => window.__orion.hideIds(ids)", [BIG_ADDR]); settle(fpage)
    fpage.evaluate("() => { const el = document.getElementById('tTo'); el.value = 1000; el.dispatchEvent(new Event('input', { bubbles: true })); }")
    settle(fpage)
    assert BIG_ADDR not in shown(fpage) and hidden(fpage) == {BIG_ADDR}


# ---------------------------------------------------------------- timeline + force
def test_timeline_plus_force_keeps_time_along_x_and_lays_the_rest_out_by_force(fpage, mock):
    ids = traced(fpage, mock, hops=5)
    columns = {i: pos(fpage, i) for i in ids}
    arrange(fpage, "timeline")
    tl_x = {i: pos(fpage, i)[0] for i in ids}
    arrange(fpage, "timeforce")
    assert fpage.input_value("#traceArrange") == "timeforce" and sorted(shown(fpage)) == ids, "only where changes, never what"
    assert {i: pos(fpage, i)[0] for i in ids} == tl_x, "time runs along x exactly as in the timeline"
    assert fpage.evaluate("() => window.__orion.renderer.data.axis !== null") and fpage.is_visible("#scaleRow"), "with the time axis and its scale choice"
    assert any(t.startswith("04-15") or t.startswith("2022") for t in drawn_texts(fpage))
    radii = fpage.evaluate("""() => { const o = window.__orion, g = o.state.graph, st = o.renderer.data.style, out = {};
        o.renderer.data.visible.nodes.forEach(id => { out[id] = st.nodeRadius(g.nodes.get(id)); }); return out; }""")
    for n, a in enumerate(ids):
        for b in ids[n + 1:]:
            pa, pb = pos(fpage, a), pos(fpage, b)
            assert ((pa[0] - pb[0]) ** 2 + (pa[1] - pb[1]) ** 2) ** 0.5 >= radii[a] + radii[b] + 7, (a, b)
    spine = [pos(fpage, "tx:" + tid(10 + k))[1] for k in range(6)]
    assert max(spine) - min(spine) < 160, "the chain of transactions runs roughly level across: %s" % spine
    arrange(fpage, "columns")
    assert {i: pos(fpage, i) for i in ids} == columns, "back to Columns: exactly where you had them"


def test_timeline_plus_force_uses_proportional_sizes_under_auto_and_is_saved(fpage, mock):
    traced(fpage, mock, hops=3)
    assert "compact scale" in fpage.inner_text("#legend").lower()
    arrange(fpage, "timeforce")
    assert "area proportional" in fpage.inner_text("#legend").lower(), "position says nothing about amounts here, so size does"
    fpage.wait_for_timeout(1100)
    fpage.reload(); fpage.wait_for_function("window.__orion && window.__orion.renderer")
    fpage.click("#restoreYes"); fpage.wait_for_function("() => window.__orion.state.graph.nodes.size > 0"); settle(fpage)
    assert fpage.evaluate("() => window.__orion.state.arrange") == "timeforce" and fpage.input_value("#traceArrange") == "timeforce"


def test_adding_to_a_timeline_plus_force_trace_keeps_the_picture_steady(fpage, mock):
    traced(fpage, mock, hops=2)
    arrange(fpage, "timeforce")
    before = {i: pos(fpage, i) for i in shown(fpage)}
    fpage.evaluate("(id) => window.__orion.traceExpand(id, 'next')", "tx:" + tid(12)); idle(fpage); settle(fpage)
    now = shown(fpage)
    assert set(before) < now
    moved = max(abs(pos(fpage, i)[1] - before[i][1]) for i in before)
    assert moved < 120, "what was there stays roughly where it was in height (largest move %s)" % moved
    assert len({tuple(pos(fpage, i)) for i in now}) == len(now), "and nothing is on top of anything"
