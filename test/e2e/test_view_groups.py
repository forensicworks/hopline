"""'As one vertex' outside the Trace layout: neighbours the Focus view keeps off the screen, folded into one vertex beside their wallet."""
import json

import pytest

from chains import tid
from helpers import open_query, settle, toast_text
from test_grouping import busy_wallet
from test_wallet_panel import W, W_ID

GID = "grp:1"
EXCH_TXS = {"tx:" + tid(n) for n in range(100, 106)}             # the six payments to the same exchange


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def start(page, mock):
    """The wallet is on the screen (it is one hop from the focused transaction) and its other transactions are not (the Focus view stops at one hop)."""
    busy_wallet(mock)
    open_query(page, W)
    page.evaluate("(id) => window.__hopline.navigate(id)", "tx:" + tid(120)); settle(page)
    page.select_option("#depth", "1"); settle(page)
    page.evaluate("(id) => window.__hopline.setSel([id])", W_ID); settle(page)


def shown(page):
    return set(page.evaluate("() => [...window.__hopline.renderer.data.visible.nodes]"))


def vgroups(page):
    return page.evaluate("() => [...window.__hopline.state.vgroups.values()].map(g => ({ id: g.id, anchor: g.anchor, dir: g.dir, kind: g.kind, members: g.members.length }))")


def fold_exch(page):
    wrap = page.locator("#inspBody .walletsec .groupwrap").filter(has_text="6 transactions to")
    wrap.locator(".groupacts .showbtn >> text=as one").click(); settle(page)


def test_the_transactions_the_focus_view_keeps_off_the_screen_can_be_folded_into_one_vertex(fpage, mock):
    start(fpage, mock)
    n0, e0 = fpage.evaluate("() => window.__hopline.state.graph.nodes.size"), fpage.evaluate("() => window.__hopline.state.graph.edges.size")
    assert W_ID in shown(fpage) and not (EXCH_TXS & shown(fpage)), "the wallet is on the screen and the six payments are not"
    fold_exch(fpage)
    assert vgroups(fpage) == [{"id": GID, "anchor": W_ID, "dir": "next", "kind": "party", "members": 6}]
    assert GID in shown(fpage) and not (EXCH_TXS & shown(fpage)), "one vertex stands for the six"
    assert fpage.evaluate("() => window.__hopline.state.graph.nodes.size") == n0 and fpage.evaluate("() => window.__hopline.state.graph.edges.size") == e0, "nothing was added to the graph"
    assert not fpage.evaluate("(id) => window.__hopline.state.graph.nodes.has(id)", GID)
    assert fpage.evaluate("() => window.__hopline.renderer.data.graph.nodes.get('grp:1').groupText").startswith("6 transactions to")
    assert "Folded 6 vertices into one" in toast_text(fpage)
    assert fpage.evaluate("() => [...window.__hopline.state.selected]") == [GID], "the group is selected"


def test_the_details_of_the_group_say_what_it_stands_for_and_open_it_on_the_graph(fpage, mock):
    start(fpage, mock); fold_exch(fpage)
    t = fpage.inner_text("#inspBody").lower()
    assert "group" in t and "6 transactions to" in t and "6 transactions, not shown yet" in t and "in this group (6)" in t
    assert fpage.locator("#inspBody button:has-text('Show all 6 on the graph')").count() == 1
    assert fpage.locator("#inspBody button:has-text('Choose which')").count() == 0 and fpage.locator("#inspBody .groupmembers .showbtn").count() == 0, "a view group opens whole"
    fpage.click("#inspBody button:has-text('Show all 6 on the graph')"); settle(fpage)
    assert vgroups(fpage) == [] and EXCH_TXS <= shown(fpage), "the six are on the graph"
    assert fpage.evaluate("() => window.__hopline.state.focusOn") is False, "the Focus view was what kept them away, so it is off"


def test_removing_a_group_leaves_its_members_off_the_screen_as_the_focus_view_keeps_them(fpage, mock):
    start(fpage, mock); fold_exch(fpage)
    fpage.click("#inspBody button:has-text('Remove group')"); settle(fpage)
    assert vgroups(fpage) == [] and not (EXCH_TXS & shown(fpage)) and GID not in shown(fpage)
    assert fpage.evaluate("() => window.__hopline.state.focusOn") is True


def test_the_group_has_a_menu(fpage, mock):
    from helpers import xy
    start(fpage, mock); fold_exch(fpage)
    fpage.evaluate("() => window.__hopline.renderer.fit()"); settle(fpage)                 # the new vertex may sit outside the view
    p = xy(fpage, GID); fpage.mouse.click(p["x"], p["y"], button="right")
    fpage.wait_for_selector("#ctxMenu:not([hidden])", timeout=5000)
    menu = fpage.inner_text("#ctxMenu")
    assert "group · 6 transactions to" in menu.lower() and "Show all 6 on the graph" in menu and "Remove group" in menu and "Choose which" not in menu and "Show the largest" not in menu, menu


def test_a_double_click_on_the_group_opens_it(fpage, mock):
    from helpers import xy
    start(fpage, mock); fold_exch(fpage)
    fpage.evaluate("() => window.__hopline.renderer.fit()"); settle(fpage)
    p = xy(fpage, GID); fpage.mouse.dblclick(p["x"], p["y"]); settle(fpage)
    assert vgroups(fpage) == [] and EXCH_TXS <= shown(fpage)


def test_a_group_can_be_made_from_what_is_ticked_and_needs_two_that_are_off_the_screen(fpage, mock):
    start(fpage, mock)
    rows = fpage.locator("#inspBody .walletsec .tickable input.rowtick")
    assert rows.count() > 3
    fpage.locator("#inspBody .walletsec .groupwrap").filter(has_text="6 transactions to").locator("input.rowtick").first.check(); settle(fpage)
    btn = fpage.locator("#inspBody .walletsec button:has-text('As one vertex')")
    assert btn.count() == 1 and btn.is_enabled()
    btn.click(); settle(fpage)
    assert vgroups(fpage)[0]["kind"] == "picked" and vgroups(fpage)[0]["members"] == 6


def test_the_group_goes_with_the_focus_view_and_with_the_wallet_it_hangs_from(fpage, mock):
    start(fpage, mock); fold_exch(fpage)
    fpage.evaluate("(id) => window.__hopline.setSel([id])", W_ID); settle(fpage)
    fpage.keyboard.press("Delete"); settle(fpage)
    assert GID not in shown(fpage) and len(vgroups(fpage)) == 1, "hiding the wallet takes the group off the screen but keeps it"
    fpage.keyboard.press("Control+z"); settle(fpage)
    assert GID in shown(fpage), "and bringing the wallet back brings the group back"
    fpage.click("#focusOn"); settle(fpage)                                                   # the Focus view off: nothing is kept away, so there is nothing for a group to stand for
    assert vgroups(fpage) == [] and EXCH_TXS <= shown(fpage)


def test_a_group_survives_a_reload_and_a_file_and_is_not_in_the_graph_data(fpage, mock, tmp_path):
    start(fpage, mock); fold_exch(fpage)
    fpage.wait_for_timeout(1100)
    fpage.click("#exportMenu summary")
    with fpage.expect_download() as dl:
        fpage.click("[data-export=json]")
    p = tmp_path / "g.json"; dl.value.save_as(p)
    data = json.loads(p.read_text(encoding="utf-8"))
    assert not any(n["id"].startswith("grp:") for n in data["nodes"]) and not any(e["id"].startswith("grpe:") for e in data["edges"]), "the graph data holds only what is on the chain"
    vg = data["view"]["vgroups"]
    assert len(vg) == 1 and vg[0]["id"] == GID and vg[0]["anchor"] == W_ID and len(vg[0]["members"]) == 6
    fpage.reload(); fpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    fpage.click("#restoreYes"); fpage.wait_for_function("() => window.__hopline.state.graph.nodes.size > 0"); settle(fpage)
    assert vgroups(fpage) == [{"id": GID, "anchor": W_ID, "dir": "next", "kind": "party", "members": 6}] and GID in shown(fpage) and not (EXCH_TXS & shown(fpage))
    fpage.click("#btnClear"); fpage.click("#btnClear"); settle(fpage)
    assert vgroups(fpage) == []
    fpage.set_input_files("#fileImport", str(p)); fpage.wait_for_function("() => window.__hopline.state.graph.nodes.size > 0"); settle(fpage)
    assert GID in shown(fpage) and vgroups(fpage)[0]["members"] == 6
    bad = json.loads(p.read_text(encoding="utf-8"))                                           # a file edited by hand: what does not make sense is ignored, the good one kept
    bad["view"]["vgroups"] += [
        {"id": "grp:x", "anchor": W_ID, "dir": "next", "kind": "party", "members": ["tx:" + "a" * 64, "tx:" + "b" * 64]},
        {"id": "grp:8", "anchor": W_ID, "dir": "sideways", "kind": "party", "members": ["tx:" + "a" * 64, "tx:" + "b" * 64]},
        {"id": "grp:7", "anchor": W_ID, "dir": "next", "kind": "party", "members": ["<script>alert(1)</script>", "tx:" + "a" * 64]},
        {"id": "grp:6", "anchor": W_ID, "dir": "next", "kind": "party", "members": ["tx:" + "a" * 64]},
        {"id": "grp:9", "anchor": "addr:bc1qnotinthisworkspace", "dir": "next", "kind": "party", "members": ["tx:" + "a" * 64, "tx:" + "b" * 64]}, "not an object", None]
    q = tmp_path / "bad.json"; q.write_text(json.dumps(bad), encoding="utf-8")
    fpage.click("#btnClear"); fpage.click("#btnClear"); settle(fpage)
    fpage.set_input_files("#fileImport", str(q)); fpage.wait_for_function("() => window.__hopline.state.graph.nodes.size > 0"); settle(fpage)
    assert [g["id"] for g in vgroups(fpage)] == [GID], vgroups(fpage)


def test_every_other_layout_draws_the_group_and_the_trace_layout_leaves_it_alone(fpage, mock):
    start(fpage, mock); fold_exch(fpage)
    for layout in ("timeline", "force", "flow"):
        fpage.click("#layoutSeg [data-layout=%s]" % layout); settle(fpage)
        assert GID in shown(fpage) and not (EXCH_TXS & shown(fpage)), layout
        pos = fpage.evaluate("(id) => window.__hopline.renderer.positionOf(id)", GID)
        assert pos and pos["x"] == pos["x"] and pos["y"] == pos["y"], "the group has a place in " + layout
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    assert GID not in shown(fpage), "a view group is not part of a trace"
    fpage.click("#layoutSeg [data-layout=flow]"); settle(fpage)
    assert GID in shown(fpage) and len(vgroups(fpage)) == 1, "and it is still there when the trace is left"


def test_the_report_and_the_exports_hold_only_what_is_on_the_chain(fpage, mock, tmp_path):
    from test_report import make_report, verify
    start(fpage, mock); fold_exch(fpage)
    p = make_report(fpage, tmp_path)
    body = p.read_text(encoding="utf-8")
    ev = body.split('<script type="application/json"')[1]
    assert "grp:1" not in ev.split("</script>")[0].split('"nodes"')[1].split('"edges"')[0], "the group is not among the evidence's vertices"
    r = verify(p)
    assert r.returncode == 0 and "OK:" in r.stdout, r.stdout + r.stderr
