"""The rough edges of the group vertex: Undo folds shown vertices back, a group can be labelled and tagged, it is in the legend, and a visible-part export keeps it."""
import json

import pytest

from chains import tid
from helpers import idle, open_query, settle
from test_group_vertex import EXCH_TXS, GID, group_exch, groups, insp, start, undo
from test_trace import shown
from test_wallet_panel import W, W_ID


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def members(page):
    return page.evaluate("(id) => (window.__hopline.state.trace.groups.get(id) || { members: [] }).members.length", GID)


def drawn(page):
    return page.evaluate("""() => { const r = window.__hopline.renderer, ctx = r.ctx, orig = ctx.fillText.bind(ctx), seen = [];
        ctx.fillText = (t, ...a) => { seen.push(String(t)); return orig(t, ...a); }; r.draw(); ctx.fillText = orig; return seen; }""")


def select_group(page):
    page.evaluate("(id) => window.__hopline.setSel([id])", GID); settle(page)


def export_json(page, tmp_path, visible=True):
    page.evaluate("() => { document.getElementById('exportMenu').open = true; }")
    page.evaluate("(v) => { document.getElementById('exportVisible').checked = v; }", visible)
    with page.expect_download() as dl:
        page.click("[data-export=json]")
    p = tmp_path / ("ws-visible.json" if visible else "ws-full.json"); dl.value.save_as(p)
    return p


def clear_and_import(page, path):
    page.click("#btnClear"); page.click("#btnClear"); settle(page)
    page.set_input_files("#fileImport", str(path)); idle(page); settle(page)


# ---- Undo folds the vertices back into their group ---------------------------------------------------------------------------------------------

def test_undoing_an_auto_expand_that_showed_grouped_vertices_puts_them_back_in_the_group(fpage, mock):
    start(fpage, mock)
    group_exch(fpage)
    assert shown(fpage) == {W_ID, GID} and members(fpage) == 6
    fpage.evaluate("(id) => window.__hopline.autoExpand(id, { dir: 'next', hops: 1, follow: 'all', perTx: 50 })", W_ID); idle(fpage); settle(fpage)
    assert EXCH_TXS <= shown(fpage), "the six were shown as ordinary vertices"
    assert GID not in groups_ids(fpage), "so the group is gone"
    undo(fpage)
    assert shown(fpage) == {W_ID, GID}, "undone: the anchor and the group, none of the six"
    assert groups(fpage) == [{"id": GID, "anchor": W_ID, "dir": "next", "kind": "party", "members": 6}]


def groups_ids(page):
    return [g["id"] for g in groups(page)]


def test_opening_a_grouped_transaction_as_another_starting_point_and_undoing_it_folds_it_back(fpage, mock):
    start(fpage, mock)
    group_exch(fpage)
    member = sorted(EXCH_TXS)[0]
    open_query(fpage, member[3:]); idle(fpage); settle(fpage)
    assert member in shown(fpage) and members(fpage) == 5
    undo(fpage)
    assert member not in shown(fpage) and members(fpage) == 6


def test_redo_and_undo_go_round_again(fpage, mock):
    start(fpage, mock)
    group_exch(fpage)
    fpage.evaluate("(id) => window.__hopline.autoExpand(id, { dir: 'next', hops: 1, follow: 'all', perTx: 50 })", W_ID); idle(fpage); settle(fpage)
    after = set(shown(fpage))
    undo(fpage)
    assert members(fpage) == 6
    fpage.click("#traceRedo"); idle(fpage); settle(fpage)
    assert set(shown(fpage)) == after and GID not in groups_ids(fpage)
    undo(fpage)
    assert members(fpage) == 6 and shown(fpage) == {W_ID, GID}


# ---- a label, a tag and notes ---------------------------------------------------------------------------------------------------------------------

def test_a_group_can_be_labelled_and_the_canvas_shows_the_label(fpage, mock):
    start(fpage, mock)
    group_exch(fpage)
    select_group(fpage)
    assert fpage.is_visible("#inspBody #fLabel") and fpage.is_visible("#inspBody #fNote") and fpage.is_visible("#inspBody #fTag")
    assert any(t.startswith("6 transactions to") for t in drawn(fpage)), "before: what it stands for"
    fpage.fill("#fLabel", "Payments to the exchange")
    assert "Payments to the exchange" in drawn(fpage) and not any(t.startswith("6 transactions to") for t in drawn(fpage))
    assert fpage.evaluate("(id) => window.__hopline.state.trace.groups.get(id).label", GID) == "Payments to the exchange"
    assert "6 transactions" in insp(fpage), "the details still say what it stands for"
    fpage.fill("#fLabel", "")
    assert any(t.startswith("6 transactions to") for t in drawn(fpage)), "an empty label gives the description back"


def test_a_group_can_be_tagged_and_the_tag_is_drawn_and_chosen_from_the_legend(fpage, mock):
    start(fpage, mock)
    group_exch(fpage)
    select_group(fpage)
    fpage.select_option("#fTag", "EXCH"); settle(fpage)
    assert fpage.evaluate("(id) => window.__hopline.state.trace.groups.get(id).tag", GID) == "EXCH"
    assert "EXCH" in drawn(fpage), "the tag badge is on the vertex"
    legend = fpage.inner_text("#legend")
    assert "EXCH 1" in legend, "counted among the tags"
    fpage.evaluate("() => window.__hopline.setSel([])"); settle(fpage)
    fpage.click("#legend .tagitem >> text=EXCH"); settle(fpage)
    assert fpage.evaluate("() => [...window.__hopline.state.selected]") == [GID], "and chosen from it"


def test_a_note_and_the_colour_are_kept_too(fpage, mock):
    start(fpage, mock)
    group_exch(fpage)
    select_group(fpage)
    fpage.fill("#fNote", "all from the March batch")
    fpage.click("#inspBody .swatch >> nth=2"); settle(fpage)
    spec = fpage.evaluate("(id) => window.__hopline.state.trace.groups.get(id)", GID)
    assert spec["note"] == "all from the March batch" and spec["color"]


def test_what_you_wrote_on_a_group_survives_hide_and_undo_and_showing_some_members(fpage, mock):
    start(fpage, mock)
    group_exch(fpage)
    select_group(fpage)
    fpage.fill("#fLabel", "Exchange"); fpage.select_option("#fTag", "EXCH")
    fpage.click("#traceHide"); settle(fpage)
    assert GID not in groups_ids(fpage)
    undo(fpage)
    spec = fpage.evaluate("(id) => window.__hopline.state.trace.groups.get(id)", GID)
    assert spec["label"] == "Exchange" and spec["tag"] == "EXCH" and len(spec["members"]) == 6
    two = sorted(EXCH_TXS)[:2]
    fpage.evaluate("([gid, ids]) => window.__hopline.traceExpandGroup(gid, { ids: ids })", [GID, two]); idle(fpage); settle(fpage)
    assert fpage.evaluate("(id) => window.__hopline.state.trace.groups.get(id).label", GID) == "Exchange", "four are left in it, still called what you called it"
    undo(fpage)
    spec = fpage.evaluate("(id) => window.__hopline.state.trace.groups.get(id)", GID)
    assert spec["label"] == "Exchange" and spec["tag"] == "EXCH" and len(spec["members"]) == 6


def test_a_hostile_label_is_only_text(fpage, mock):
    start(fpage, mock)
    group_exch(fpage)
    select_group(fpage)
    fpage.fill("#fLabel", "<img src=x onerror=window.__pwned=1>")
    fpage.fill("#fNote", "<script>window.__pwned=2</script>")
    settle(fpage)
    assert fpage.evaluate("() => window.__pwned") is None and fpage.locator("#inspBody img, #inspBody script").count() == 0


def test_the_label_the_tag_and_the_note_travel_with_the_saved_workspace_and_are_checked_when_it_is_opened(fpage, mock, tmp_path):
    start(fpage, mock)
    group_exch(fpage)
    select_group(fpage)
    fpage.fill("#fLabel", "Exchange"); fpage.fill("#fNote", "a note"); fpage.select_option("#fTag", "EXCH"); settle(fpage)
    p = export_json(fpage, tmp_path, visible=False)
    saved = json.loads(p.read_text(encoding="utf-8"))
    g = saved["view"]["trace"]["groups"][0]
    assert g["label"] == "Exchange" and g["note"] == "a note" and g["tag"] == "EXCH"
    g["tag"] = "<b>" + "x" * 50; g["color"] = "javascript:alert(1)"; g["shape"] = "banana"; g["label"] = "<i>shown as text</i>"
    p.write_text(json.dumps(saved), encoding="utf-8")
    clear_and_import(fpage, p)
    spec = fpage.evaluate("(id) => window.__hopline.state.trace.groups.get(id)", GID)
    assert spec and spec["label"] == "<i>shown as text</i>" and spec["note"] == "a note"
    assert not spec.get("color") and not spec.get("shape"), "an invalid colour or shape is dropped"
    assert not spec.get("tag") or len(spec["tag"]) <= 20, "a tag is a short plain name"


def test_the_report_names_the_label_the_tag_and_the_note_of_a_group(fpage, mock, tmp_path):
    from test_report import make_report
    start(fpage, mock)
    group_exch(fpage)
    select_group(fpage)
    fpage.fill("#fLabel", "Exchange payments"); fpage.fill("#fNote", "to review with the team"); fpage.select_option("#fTag", "EXCH"); settle(fpage)
    html = make_report(fpage, tmp_path).read_text(encoding="utf-8")
    assert "Exchange payments (6 transactions to" in html and "to review with the team" in html and '<span class="chip">EXCH</span>' in html


# ---- the legend ---------------------------------------------------------------------------------------------------------------------------------------

def test_the_legend_explains_a_stack_only_while_there_is_a_group(fpage, mock):
    start(fpage, mock)
    assert "Stack" not in fpage.inner_text("#legend")
    group_exch(fpage)
    assert "Stack = several vertices folded into one group" in fpage.inner_text("#legend")
    undo(fpage)
    assert "Stack" not in fpage.inner_text("#legend")


# ---- the visible part of a saved workspace ------------------------------------------------------------------------------------------------------

def test_a_visible_part_export_keeps_what_a_group_stands_for_so_the_group_survives_the_file(fpage, mock, tmp_path):
    start(fpage, mock)
    group_exch(fpage)
    p = export_json(fpage, tmp_path, visible=True)
    saved = json.loads(p.read_text(encoding="utf-8"))
    ids = {n["id"] for n in saved["nodes"]}
    assert EXCH_TXS <= ids, "the six hidden members are in the file"
    assert len(saved["view"]["trace"]["groups"][0]["members"]) == 6
    clear_and_import(fpage, p)
    assert groups(fpage) == [{"id": GID, "anchor": W_ID, "dir": "next", "kind": "party", "members": 6}], "the group is still a group"
    assert fpage.evaluate("() => window.__hopline.state.layout") == "trace"


def test_a_visible_part_export_does_not_add_what_no_group_needs(fpage, mock, tmp_path):
    start(fpage, mock)
    group_exch(fpage)
    visible = json.loads(export_json(fpage, tmp_path, visible=True).read_text(encoding="utf-8"))
    full = json.loads(export_json(fpage, tmp_path, visible=False).read_text(encoding="utf-8"))
    assert len(visible["nodes"]) < len(full["nodes"]), "still only the visible part, plus the members of the group"
    unrelated = "tx:" + tid(120)
    assert unrelated not in {n["id"] for n in visible["nodes"]}


def test_without_a_group_a_visible_part_export_is_unchanged(fpage, mock, tmp_path):
    start(fpage, mock)
    visible = json.loads(export_json(fpage, tmp_path, visible=True).read_text(encoding="utf-8"))
    assert {n["id"] for n in visible["nodes"]} == {W_ID}
