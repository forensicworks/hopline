"""A new visitor starts in the Trace layout (they come with one wallet or transaction to follow); Flow stays one click away,
and is also an arrangement of the trace itself (Arrange > Flow), so a trace can be tidied without leaving it."""
import json

import pytest

from conftest import ADDRESS, NORMAL, PAGE_URL
from helpers import counts, idle, open_query, settle
from test_trace import click_handle, handle, shown

NORMAL_ID = "tx:" + NORMAL["txid"]
ROBINHOOD = "addr:bc1qprdf80adfz7aekh5nejjfrp3jksc8r929svpxk"          # on the built-in list; an output of the first fixture transaction


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def look(page):
    return page.evaluate("""() => { const s = window.__hopline.state;
        return { layout: s.layout, arrange: s.arrange, seed: s.trace.seed, shown: s.trace.shown.size, loaded: s.graph.nodes.size,
                 seg: document.querySelector('#layoutSeg [aria-checked=true]').dataset.layout, traceOn: document.body.classList.contains('trace-on'),
                 barHidden: document.getElementById('traceBar').hidden, emptyShown: !document.getElementById('empty').hidden,
                 focusDisabled: document.getElementById('focusOn').disabled }; }""")


def positions(page):
    return page.evaluate("""() => Object.fromEntries([...window.__hopline.state.trace.shown].map((id) => { const q = window.__hopline.renderer.positionOf(id); return [id, [Math.round(q.x), Math.round(q.y)]]; }))""")


def build_scene(page):
    """The scene of the README screenshot: the first transaction traced forward, then the wallets it pays and funds."""
    open_query(page, NORMAL["txid"])
    click_handle(page, NORMAL_ID, "right")
    click_handle(page, ROBINHOOD, "right")
    click_handle(page, "addr:" + ADDRESS, "right")


# ---- the new default ------------------------------------------------------------------------------------------------------

def test_a_new_visitor_starts_in_the_trace_layout_with_the_empty_screen(tpage):
    s = look(tpage)
    assert (s["layout"], s["seg"], s["traceOn"]) == ("trace", "trace", True), "the Layout buttons agree with the state"
    assert s["emptyShown"] and s["barHidden"] and s["loaded"] == 0 and s["seed"] is None, "nothing to show yet, and no empty trace bar over the invitation"
    assert tpage.is_visible("#sample") and s["focusDisabled"], "Focus belongs to the other layouts"


def test_the_sample_starts_a_trace_at_the_transaction(tpage):
    tpage.click("#sample"); idle(tpage); settle(tpage)
    s = look(tpage)
    assert s["seed"] == NORMAL_ID and s["shown"] == 1 and s["layout"] == "trace" and not s["barHidden"] and not s["emptyShown"]
    assert "Click ◀ or ▶ beside the vertex" in tpage.inner_text("#traceInfo")
    assert handle(tpage, NORMAL_ID, "left") and handle(tpage, NORMAL_ID, "right"), "the arrows to follow the money are drawn"


def test_typing_an_address_starts_the_trace_at_the_wallet(tpage):
    open_query(tpage, ADDRESS)
    s = look(tpage)
    assert s["seed"] == "addr:" + ADDRESS and s["shown"] == 1 and s["layout"] == "trace"


@pytest.mark.parametrize("suffix", ["?q=" + NORMAL["txid"], "#f0/" + NORMAL_ID])
def test_a_link_that_names_a_vertex_opens_it_as_a_trace(ctx, errors, suffix):
    p = ctx.new_page(); p.on("pageerror", lambda e: errors.append(str(e)))
    p.goto(PAGE_URL + suffix)
    p.wait_for_function("() => window.__hopline && window.__hopline.state.trace.seed"); idle(p)
    s = look(p)
    assert s["seed"] == NORMAL_ID and s["layout"] == "trace" and s["shown"] == 1
    p.close()


def test_flow_is_one_click_away_on_an_empty_workspace_and_trace_can_be_chosen_again(tpage):
    tpage.click("#layoutSeg [data-layout=flow]"); settle(tpage)
    assert look(tpage)["layout"] == "flow" and not look(tpage)["traceOn"]
    tpage.click("#layoutSeg [data-layout=trace]"); settle(tpage)
    s = look(tpage)
    assert s["layout"] == "trace" and s["traceOn"] and s["seg"] == "trace", "no 'open something first' refusal with nothing loaded"
    assert tpage.is_hidden("#toast"), "and no message"
    open_query(tpage, NORMAL["txid"])
    assert look(tpage)["seed"] == NORMAL_ID, "what is opened next starts the trace"


def test_undoing_the_first_load_keeps_the_trace_layout(tpage):
    open_query(tpage, NORMAL["txid"])
    tpage.click("#btnUndoLoad"); tpage.wait_for_function("() => window.__hopline.state.graph.nodes.size === 0"); idle(tpage); settle(tpage)
    s = look(tpage)
    assert s["layout"] == "trace" and s["seg"] == "trace" and s["emptyShown"], "back to the empty screen, still in Trace"
    open_query(tpage, NORMAL["txid"])
    assert look(tpage)["seed"] == NORMAL_ID and look(tpage)["shown"] == 1


def test_a_file_with_no_view_still_opens_everything_in_flow(tpage, tmp_path):
    """Without a trace to show, a bare graph (from another tool, or an old export) must not open as an empty Trace."""
    doc = {"format": "hopline-workspace", "version": 1,
           "nodes": [{"id": "addr:a", "type": "addr", "address": "a"}, {"id": "tx:" + "a" * 64, "type": "tx", "txid": "a" * 64, "loaded": False}],
           "edges": [{"id": "in:" + "a" * 64 + ":0", "source": "addr:a", "target": "tx:" + "a" * 64, "kind": "in", "amount": 5, "txid": "a" * 64}]}
    f = tmp_path / "bare.json"; f.write_text(json.dumps(doc), encoding="utf-8")
    tpage.set_input_files("#fileImport", str(f))
    tpage.wait_for_function("() => window.__hopline.state.graph.nodes.size === 2"); idle(tpage); settle(tpage)
    s = look(tpage)
    assert s["layout"] == "flow" and s["seg"] == "flow" and not s["traceOn"]
    assert counts(tpage)["vnodes"] == 2, "both vertices are on screen"


# ---- Flow as an arrangement of the trace ---------------------------------------------------------------------------------------

def test_arrange_flow_lays_out_exactly_the_traced_vertices_left_to_right_and_columns_gets_them_back(tpage):
    build_scene(tpage)
    click_handle(tpage, NORMAL_ID, "left")                                           # and what funded it, so both sides of the transaction are on screen
    before_ids, before_pos = set(shown(tpage)), positions(tpage)
    assert len(before_ids) == 7
    tpage.select_option("#traceArrange", "flow"); settle(tpage)
    assert look(tpage)["arrange"] == "flow" and look(tpage)["layout"] == "trace", "still the trace: its arrows, undo and bar are all there"
    assert set(shown(tpage)) == before_ids, "only the arrangement changed, not what is shown"
    # money runs left to right around the first transaction: what funds it sits left of it, what it pays sits right of it
    flow = tpage.evaluate("""(txid) => { const g = window.__hopline.state.graph, r = window.__hopline.renderer, x = (id) => r.positionOf(id).x;
        const es = [...r.data.visible.edges].map((id) => g.edges.get(id)).filter((e) => r.data.visible.nodes.has(e.source) && r.data.visible.nodes.has(e.target));
        return { ins: es.filter((e) => e.target === txid).map((e) => x(e.source) < x(txid)), outs: es.filter((e) => e.source === txid).map((e) => x(e.target) > x(txid)) }; }""", NORMAL_ID)
    assert flow["ins"] and flow["outs"] and all(flow["ins"]) and all(flow["outs"]), flow
    assert handle(tpage, ROBINHOOD, "right") and handle(tpage, "addr:" + ADDRESS, "left"), "the arrows are still drawn in this arrangement"
    click_handle(tpage, "addr:" + ADDRESS, "left")                                  # keep tracing while it is arranged as Flow
    assert len(shown(tpage)) >= 7 and look(tpage)["arrange"] == "flow"
    tpage.select_option("#traceArrange", "columns"); settle(tpage)
    after = positions(tpage)
    assert all(after[i] == before_pos[i] for i in before_pos), "Columns keeps the places you gave the vertices"


def test_the_flow_arrangement_is_saved_with_the_session(ctx, errors):
    p = ctx.new_page(); p.on("pageerror", lambda e: errors.append(str(e)))
    p.goto(PAGE_URL); p.wait_for_function("window.__hopline && window.__hopline.renderer")
    build_scene(p)
    p.select_option("#traceArrange", "flow"); settle(p); p.wait_for_timeout(1200)                  # autosave is debounced
    p.reload(); p.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert look(p)["layout"] == "trace" and look(p)["loaded"] == 0, "a reload starts clean until the session is restored"
    p.click("#restoreYes"); p.wait_for_function("() => window.__hopline.state.graph.nodes.size > 0"); idle(p); settle(p)
    s = look(p)
    assert (s["layout"], s["arrange"], s["shown"]) == ("trace", "flow", 6)  # the first scene: six vertices
    assert p.input_value("#traceArrange") == "flow"
    p.close()
