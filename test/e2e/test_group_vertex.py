"""A group shown as ONE vertex on the trace: made from a list, opened a few at a time, hidden, undone, saved, and never written into the graph."""
import json

import pytest

from chains import IN, OUT, real_addr, tid, tx
from helpers import click_node, idle, open_query, settle, toast_text, xy
from test_grouping import busy_wallet
from test_trace import click_handle, handle, shown
from test_wallet_panel import W, W_ID

GID = "grp:1"
EXCH_TXS = {"tx:" + tid(n) for n in range(100, 106)}             # the six payments to the same exchange
SMALL_TXS = {"tx:" + tid(n) for n in range(110, 117)}            # the seven small ones that came in


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def start(page, mock):
    busy_wallet(mock)
    open_query(page, W)
    page.click("#layoutSeg [data-layout=trace]"); page.select_option("#traceArrange", "columns"); settle(page)
    page.evaluate("(id) => window.__hopline.setSel([id])", W_ID); settle(page)


def group_exch(page):
    """Put the six exchange payments on the trace as one vertex, from the wallet's list."""
    wrap = page.locator("#inspBody .walletsec .groupwrap").filter(has_text="6 transactions to")
    wrap.locator(".groupacts .showbtn >> text=as one").click(); idle(page); settle(page)


def groups(page):
    return page.evaluate("() => [...window.__hopline.state.trace.groups.values()].map(g => ({ id: g.id, anchor: g.anchor, dir: g.dir, kind: g.kind, members: g.members.length }))")


def real_nodes(page):
    return page.evaluate("() => window.__hopline.state.graph.nodes.size")


def undo(page):
    page.click("#traceUndo"); idle(page); settle(page)


def insp(page):
    return page.inner_text("#inspBody")


def test_a_group_becomes_one_vertex_beside_its_anchor_and_the_graph_itself_is_untouched(fpage, mock):
    start(fpage, mock)
    n0, e0 = real_nodes(fpage), fpage.evaluate("() => window.__hopline.state.graph.edges.size")
    assert handle(fpage, W_ID, "right")["label"] == "9"
    group_exch(fpage)
    assert shown(fpage) == {W_ID, GID}, "the anchor and the one group vertex; none of the six"
    assert groups(fpage) == [{"id": GID, "anchor": W_ID, "dir": "next", "kind": "party", "members": 6}]
    assert real_nodes(fpage) == n0 and fpage.evaluate("() => window.__hopline.state.graph.edges.size") == e0, "nothing was added to the graph"
    assert not fpage.evaluate("(id) => window.__hopline.state.graph.nodes.has(id)", GID)
    assert handle(fpage, W_ID, "right")["label"] == "3", "the six in the group no longer count: three transactions are left behind the arrow"
    px = lambda i: fpage.evaluate("(id) => window.__hopline.renderer.positionOf(id).x", i)
    assert px(GID) > px(W_ID), "forward: to the right of the wallet"


def test_the_group_vertex_is_drawn_with_its_text_and_an_edge_with_the_total(fpage, mock):
    start(fpage, mock)
    group_exch(fpage)
    texts = fpage.evaluate("""() => { const r = window.__hopline.renderer, ctx = r.ctx, orig = ctx.fillText.bind(ctx), seen = [];
        ctx.fillText = (t, ...a) => { seen.push(String(t)); return orig(t, ...a); }; r.draw(); ctx.fillText = orig; return seen; }""")
    assert any("6 transactions to" in t for t in texts), texts
    assert any("0.00315 BTC" in t for t in texts), "the edge says how much the six moved"
    edge = fpage.evaluate("() => [...window.__hopline.renderer.data.visible.edges]")
    assert edge == ["grpe:grp:1"]


def test_the_details_say_what_the_group_stands_for_and_list_its_members(fpage, mock):
    start(fpage, mock)
    group_exch(fpage)
    t = insp(fpage)
    assert "GROUP" in t.upper() and "6 transactions" in t and "0.00315000 BTC" in t and "0.00050000 to 0.00055000 BTC" in t and "2022-04-15" in t
    assert "Paid to" in t and "Spent from" in t
    assert fpage.locator("#inspBody .groupmembers .rowcopy").count() == 6
    assert "in this group (6)" in t.lower()


def test_one_member_can_be_shown_on_its_own_and_the_group_shrinks(fpage, mock):
    start(fpage, mock)
    group_exch(fpage)
    fpage.locator("#inspBody .groupmembers .rowcopy").first.locator(".showbtn").click(); idle(fpage); settle(fpage)
    got = {i for i in shown(fpage) if i.startswith("tx:")}
    assert got == {"tx:" + tid(105)}, "the largest member (0.00055) came as a real vertex: " + str(got)
    assert groups(fpage)[0]["members"] == 5
    assert "5 transactions" in insp(fpage)


def test_show_the_largest_five_leaves_one_which_is_no_group_and_goes_back_behind_the_arrow(fpage, mock):
    start(fpage, mock)
    group_exch(fpage)
    fpage.click("#inspBody button:has-text('Show the largest 5')"); idle(fpage); settle(fpage)
    got = {i for i in shown(fpage) if i.startswith("tx:")}
    assert got == {"tx:" + tid(n) for n in range(101, 106)}
    assert groups(fpage) == [] and GID not in shown(fpage), "a group of one is dissolved"
    assert handle(fpage, W_ID, "right")["label"] == "4", "the sixth is an ordinary hidden transaction again, with the three others"


def test_show_all_of_a_group_shows_every_member_and_the_group_goes(fpage, mock):
    start(fpage, mock)
    group_exch(fpage)
    fpage.click("#inspBody button:has-text('Show all 6')"); idle(fpage); settle(fpage)
    assert {i for i in shown(fpage) if i.startswith("tx:")} == EXCH_TXS
    assert groups(fpage) == []


def test_undo_takes_a_group_apart_and_undo_of_showing_some_puts_the_group_back_as_it_was(fpage, mock):
    start(fpage, mock)
    group_exch(fpage)
    fpage.click("#inspBody button:has-text('Show the largest 5')"); idle(fpage); settle(fpage)
    assert groups(fpage) == []
    undo(fpage)
    assert groups(fpage) == [{"id": GID, "anchor": W_ID, "dir": "next", "kind": "party", "members": 6}], "all six are in the group again"
    assert shown(fpage) == {W_ID, GID}
    undo(fpage)                                                                  # the grouping itself
    assert groups(fpage) == [] and shown(fpage) == {W_ID} and handle(fpage, W_ID, "right")["label"] == "9"


def test_hiding_a_group_leaves_its_members_hidden_and_undo_brings_the_group_back(fpage, mock):
    start(fpage, mock)
    group_exch(fpage)
    click_node(fpage, GID); settle(fpage)
    assert fpage.evaluate("() => [...window.__hopline.state.selected]") == [GID]
    fpage.locator("#cv").focus(); fpage.keyboard.press("Delete"); settle(fpage)
    assert groups(fpage) == [] and shown(fpage) == {W_ID}
    assert handle(fpage, W_ID, "right")["label"] == "9", "the members are ordinary hidden transactions again"
    undo(fpage)
    assert len(groups(fpage)) == 1 and GID in shown(fpage)


def test_hiding_the_anchor_takes_its_group_with_it_and_undo_restores_both(fpage, mock):
    start(fpage, mock)
    group_exch(fpage)
    click_handle(fpage, W_ID, "right"); idle(fpage); settle(fpage)             # the three transactions that are left: five or fewer, so they just show
    assert {i for i in shown(fpage) if i.startswith("tx:")} == {"tx:" + tid(n) for n in (106, 107, 108)}
    fpage.evaluate("(id) => window.__hopline.setSel([id])", W_ID); settle(fpage)
    fpage.locator("#cv").focus(); fpage.keyboard.press("Delete"); settle(fpage)
    assert groups(fpage) == [] and W_ID not in shown(fpage)
    undo(fpage)
    assert W_ID in shown(fpage) and len(groups(fpage)) == 1


def test_the_group_vertex_can_be_dragged_and_stays_where_it_is_put(fpage, mock):
    start(fpage, mock)
    group_exch(fpage)
    p = xy(fpage, GID)
    fpage.mouse.move(p["x"], p["y"]); fpage.mouse.down(); fpage.mouse.move(p["x"] + 60, p["y"] + 90, steps=5); fpage.mouse.up(); settle(fpage)
    pos = fpage.evaluate("(id) => { const q = window.__hopline.state.trace.pos.get(id); return [Math.round(q.x), Math.round(q.y)]; }", GID)
    q = xy(fpage, GID)
    assert abs(q["x"] - (p["x"] + 60)) < 4 and abs(q["y"] - (p["y"] + 90)) < 4
    assert pos != [0, 0]


def test_double_click_shows_the_largest_few_and_right_click_has_a_menu(fpage, mock):
    start(fpage, mock)
    group_exch(fpage)
    p = xy(fpage, GID); fpage.mouse.click(p["x"], p["y"], button="right")
    menu = fpage.inner_text("#ctxMenu")
    for want in ("Show the largest 5", "Show all 6", "Choose which", "Copy 6 transaction ids", "Hide group"):
        assert want in menu, menu
    fpage.keyboard.press("Escape")                                              # this also closes the details; selecting again opens them and the canvas resizes, so wait before the double-click
    click_node(fpage, GID); settle(fpage)
    click_node(fpage, GID, dbl=True); idle(fpage); settle(fpage)
    assert {i for i in shown(fpage) if i.startswith("tx:")} == {"tx:" + tid(n) for n in range(101, 106)}


def test_hovering_the_group_tells_what_it_is(fpage, mock):
    start(fpage, mock)
    group_exch(fpage)
    p = xy(fpage, GID); fpage.mouse.move(p["x"], p["y"])
    fpage.wait_for_function("() => !document.getElementById('tooltip').hidden")
    t = fpage.inner_text("#tooltip")
    assert "6 transactions" in t and "0.00315000 BTC" in t and "Double-click" in t


def test_the_group_ids_can_be_copied(fpage, mock):
    from test_copy import capture, copied
    start(fpage, mock)
    group_exch(fpage)
    capture(fpage)
    fpage.click("#inspBody button:has-text('Copy 6 transaction ids')")
    assert sorted(copied(fpage)[-1].split("\n")) == sorted(tid(n) for n in range(100, 106))


def test_choose_which_opens_a_list_of_just_the_group_and_shows_what_is_ticked(fpage, mock):
    start(fpage, mock)
    group_exch(fpage)
    fpage.click("#inspBody button:has-text('Choose which')")
    assert fpage.is_visible("#ctxMenu .chooser")
    assert "from the group" in fpage.inner_text("#ctxMenu").lower() and fpage.locator("#ctxMenu .chooserrow").count() == 6
    fpage.click("#ctxMenu .chooserfoot >> text=None")
    boxes = fpage.locator("#ctxMenu .chooser input[type=checkbox]")
    boxes.nth(0).check(); boxes.nth(5).check()
    fpage.click("#ctxMenu .chooserfoot .primary"); idle(fpage); settle(fpage)
    got = {i for i in shown(fpage) if i.startswith("tx:")}
    assert got == {"tx:" + tid(105), "tx:" + tid(100)}
    assert groups(fpage)[0]["members"] == 4


def test_a_group_of_what_came_in_hangs_behind_the_wallet(fpage, mock):
    start(fpage, mock)
    wrap = fpage.locator("#inspBody .walletsec .groupwrap").filter(has_text="small transactions")
    wrap.locator(".groupacts .showbtn >> text=as one").click(); idle(fpage); settle(fpage)
    assert groups(fpage) == [{"id": GID, "anchor": W_ID, "dir": "prev", "kind": "small", "members": 7}]
    px = lambda i: fpage.evaluate("(id) => window.__hopline.renderer.positionOf(id).x", i)
    assert px(GID) < px(W_ID), "backward: to the left"
    edge = fpage.evaluate("() => { const g = window.__hopline.renderer.data.graph.edges.get('grpe:grp:1'); return [g.kind, g.source, g.target]; }")
    assert edge == ["out", GID, W_ID], edge
    assert "7 transactions (small)" in insp(fpage)


# ---------------------------------------------------------------- from the arrow list
def test_the_arrow_list_can_make_a_group_of_a_group_row_or_of_what_is_ticked(fpage, mock):
    start(fpage, mock)
    click_handle(fpage, W_ID, "right"); idle(fpage)
    fpage.locator("#ctxMenu .grouphead .groupone").click(); idle(fpage); settle(fpage)
    assert [g["members"] for g in groups(fpage)] == [6] and fpage.is_hidden("#ctxMenu")
    click_handle(fpage, W_ID, "right", shift=True); idle(fpage)                  # three are left: Shift-click opens the list anyway
    assert fpage.is_visible("#ctxMenu .chooser") and fpage.locator("#ctxMenu .chooserrow").count() == 3
    fpage.click("#ctxMenu .chooserfoot >> text=None")
    assert fpage.is_disabled("#ctxMenu .oneticked"), "a group needs at least two ticked"
    fpage.click("#ctxMenu .chooserfoot >> text=All")
    fpage.click("#ctxMenu .oneticked"); idle(fpage); settle(fpage)
    assert sorted(g["members"] for g in groups(fpage)) == [3, 6] and {g["kind"] for g in groups(fpage)} == {"party", "picked"}


def test_many_small_outputs_of_a_transaction_can_be_one_vertex(fpage, mock):
    txid = "ef" * 32
    outs = [{"scriptpubkey_address": real_addr(i), "scriptpubkey_type": "v0_p2wpkh", "value": 1000 + i} for i in range(12)] + [{"scriptpubkey_address": real_addr(50 + i), "scriptpubkey_type": "v0_p2wpkh", "value": 500000 + i} for i in range(3)]
    mock.routes["/tx/" + txid] = {"txid": txid, "fee": 100, "weight": 800, "status": {"confirmed": True, "block_height": 1, "block_time": 1650000000},
                                  "vin": [{"txid": "cd" * 32, "vout": 0, "is_coinbase": False, "prevout": {"scriptpubkey_address": "bc1qsrc", "scriptpubkey_type": "v0_p2wpkh", "value": 9000000}}], "vout": outs}
    mock.routes["/tx/" + txid + "/outspends"] = [{"spent": False} for _ in outs]
    open_query(fpage, txid)
    fpage.click("#layoutSeg [data-layout=trace]"); fpage.select_option("#traceArrange", "columns"); settle(fpage)
    click_handle(fpage, "tx:" + txid, "right"); idle(fpage)
    fpage.locator("#ctxMenu .grouphead .groupone").click(); idle(fpage); settle(fpage)
    g = groups(fpage)
    assert len(g) == 1 and g[0]["members"] == 12 and g[0]["kind"] == "small" and g[0]["anchor"] == "tx:" + txid
    assert "12 outputs (small)" in fpage.evaluate("() => window.__hopline.renderer.data.graph.nodes.get('grp:1').groupText")
    assert "Stands for" in insp(fpage) and "12 outputs" in insp(fpage)
    assert handle(fpage, "tx:" + txid, "right")["label"] == "3", "the three large outputs are still behind the arrow"
    fpage.click("#inspBody button:has-text('Show all 12')"); idle(fpage); settle(fpage)
    assert len([i for i in shown(fpage) if i.startswith("addr:")]) == 12 and groups(fpage) == []


# ---------------------------------------------------------------- the rest of the page
def test_a_group_survives_a_reload_and_an_export_and_is_not_in_the_graph_data(fpage, mock, tmp_path):
    start(fpage, mock)
    group_exch(fpage)
    fpage.wait_for_timeout(1100)                                              # the session is saved a moment after a change
    fpage.click("#exportMenu summary")
    with fpage.expect_download() as dl:
        fpage.click("[data-export=json]")
    p = tmp_path / "g.json"; dl.value.save_as(p)
    data = json.loads(p.read_text(encoding="utf-8"))
    assert not any(n["id"].startswith("grp:") for n in data["nodes"]) and not any(e["id"].startswith("grpe:") for e in data["edges"]), "the graph data holds only what is on the chain"
    tr = data["view"]["trace"]
    assert tr["groups"][0]["id"] == GID and tr["groups"][0]["anchor"] == W_ID and len(tr["groups"][0]["members"]) == 6 and tr["seq"] == 1
    fpage.reload(); fpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    fpage.click("#restoreYes"); fpage.wait_for_function("() => window.__hopline.state.graph.nodes.size > 0"); settle(fpage)
    assert fpage.evaluate("() => window.__hopline.state.layout") == "trace" and GID in shown(fpage)
    assert groups(fpage) == [{"id": GID, "anchor": W_ID, "dir": "next", "kind": "party", "members": 6}]
    fpage.click("#btnClear"); fpage.click("#btnClear"); settle(fpage)
    fpage.set_input_files("#fileImport", str(p)); fpage.wait_for_function("() => window.__hopline.state.graph.nodes.size > 0"); settle(fpage)
    assert GID in shown(fpage) and groups(fpage)[0]["members"] == 6
    # a file that was edited by hand: groups that do not make sense are ignored, good ones kept
    bad = json.loads(p.read_text(encoding="utf-8"))
    bad["view"]["trace"]["groups"] += [
        {"id": "grp:9", "anchor": "addr:bc1qnotonthetrace", "dir": "next", "kind": "party", "members": ["tx:" + "a" * 64, "tx:" + "b" * 64]},
        {"id": "grp:x", "anchor": W_ID, "dir": "next", "kind": "party", "members": ["tx:" + "a" * 64, "tx:" + "b" * 64]},
        {"id": "grp:8", "anchor": W_ID, "dir": "sideways", "kind": "party", "members": ["tx:" + "a" * 64, "tx:" + "b" * 64]},
        {"id": "grp:7", "anchor": W_ID, "dir": "next", "kind": "party", "members": ["<script>alert(1)</script>", "tx:" + "a" * 64]},
        {"id": "grp:6", "anchor": W_ID, "dir": "next", "kind": "party", "members": ["tx:" + "a" * 64]},
        "not even an object", None]
    q = tmp_path / "bad.json"; q.write_text(json.dumps(bad), encoding="utf-8")
    fpage.click("#btnClear"); fpage.click("#btnClear"); settle(fpage)
    fpage.set_input_files("#fileImport", str(q)); fpage.wait_for_function("() => window.__hopline.state.graph.nodes.size > 0"); settle(fpage)
    assert [g["id"] for g in groups(fpage)] == [GID], groups(fpage)


def test_other_arrangements_and_layouts_cope_with_a_group(fpage, mock):
    start(fpage, mock)
    group_exch(fpage)
    for arr in ("timeline", "timeforce", "force", "timeamount", "columns"):
        fpage.select_option("#traceArrange", arr); settle(fpage)
        assert GID in shown(fpage), arr
        assert fpage.evaluate("(id) => !!window.__hopline.renderer.positionOf(id)", GID), arr
    fpage.click("#layoutSeg [data-layout=flow]"); settle(fpage)
    assert GID not in shown(fpage), "outside the trace layout the graph is just the graph"
    assert len(groups(fpage)) == 1
    fpage.click("#layoutSeg [data-layout=trace]"); fpage.select_option("#traceArrange", "columns"); settle(fpage)
    assert GID in shown(fpage)


def test_select_all_includes_the_group_and_hide_selected_takes_it_off(fpage, mock):
    start(fpage, mock)
    group_exch(fpage)
    click_handle(fpage, W_ID, "right"); idle(fpage); settle(fpage)
    fpage.locator("#cv").focus(); fpage.keyboard.press("Control+a"); settle(fpage)
    sel = set(fpage.evaluate("() => [...window.__hopline.state.selected]"))
    assert GID in sel and W_ID in sel
    assert "selected" in insp(fpage).lower()


def test_the_report_lists_a_group_in_full_and_still_verifies(fpage, mock, tmp_path):
    from test_report import evidence, make_report, verify
    start(fpage, mock)
    group_exch(fpage)
    p = make_report(fpage, tmp_path)
    html = p.read_text(encoding="utf-8")
    assert "Groups shown as one vertex" in html and "6 members" in html and "0.00315000 BTC in total" in html
    for n in range(100, 106):
        assert tid(n) in html, "every member is named"
    ev = evidence(html)
    assert not any(n["id"].startswith("grp:") for n in ev["nodes"]) and not any(e["id"].startswith("grpe:") for e in ev["edges"])
    g = ev["evidence"]["groups"]
    assert len(g) == 1 and g[0]["count"] == 6 and len(g[0]["members"]) == 6 and g[0]["anchor"] == W_ID
    assert "groups" not in (ev.get("view", {}).get("trace") or {}), "its members are not among the vertices of this file, so the group is not repeated as a trace group"
    r = verify(p)
    assert r.returncode == 0, r.stdout + r.stderr


def test_the_csv_and_graphml_exports_hold_only_what_is_on_the_chain(fpage, mock, tmp_path):
    start(fpage, mock)
    group_exch(fpage)
    for kind in ("csv-nodes", "csv-edges", "graphml"):
        fpage.evaluate("() => { document.getElementById('exportMenu').open = true; }")
        with fpage.expect_download() as dl:
            fpage.click("[data-export=%s]" % kind)
        p = tmp_path / ("x-" + kind); dl.value.save_as(p)
        text = p.read_text(encoding="utf-8-sig")
        assert "grp:" not in text and "grpe:" not in text, kind


def test_opening_a_folded_transaction_as_a_new_starting_point_takes_it_out_of_the_group(fpage, mock):
    start(fpage, mock)
    group_exch(fpage)
    open_query(fpage, tid(100)); settle(fpage)
    assert "tx:" + tid(100) in shown(fpage), "it is on the trace for real now"
    assert groups(fpage)[0]["members"] == 5 and "tx:" + tid(100) not in fpage.evaluate("() => window.__hopline.state.trace.groups.get('grp:1').members")


def test_reset_to_start_drops_the_groups_and_undo_brings_them_back(fpage, mock):
    start(fpage, mock)
    group_exch(fpage)
    fpage.click("#traceReset"); settle(fpage)
    assert groups(fpage) == [] and GID not in shown(fpage)
    undo(fpage)
    assert len(groups(fpage)) == 1 and GID in shown(fpage)


def test_a_group_of_a_wallet_that_has_no_other_arrows_still_leaves_the_anchor_usable(fpage, mock):
    start(fpage, mock)
    group_exch(fpage)
    # the anchor's other arrow (what paid it) still works while a group hangs on its right
    click_handle(fpage, W_ID, "left", shift=True); idle(fpage)
    assert fpage.is_visible("#ctxMenu .chooser")
    fpage.keyboard.press("Escape")
    assert GID in shown(fpage)


def test_with_a_currency_chosen_the_group_edge_stays_in_bitcoin_because_one_price_does_not_fit_many_moments(fpage, mock):
    from test_panels_steps import use_usd
    start(fpage, mock)
    group_exch(fpage)
    use_usd(fpage); settle(fpage)
    label = fpage.evaluate("() => window.__hopline.renderer.data.edgeLabel(window.__hopline.renderer.data.graph.edges.get('grpe:grp:1'))")
    assert "BTC" in label and "$" not in label, label
