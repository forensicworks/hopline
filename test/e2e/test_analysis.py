"""Analysis (patterns, likely change, address clusters) and Auto-expand (follow the money several transactions deep)."""
import csv
import io

import pytest

from chains import IN, OUT, addr, coinjoin, consolidation, peel_chain, reuse_change, tid, tx, unclear_change
from conftest import shot
from helpers import click_node, idle, open_query, settle, show_findings, toast_text, xy

AMBER = "#ff9f43"


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def drawn_texts(page):
    return page.evaluate("""() => { const r = window.__hopline.renderer, ctx = r.ctx, orig = ctx.fillText.bind(ctx), seen = [];
        ctx.fillText = (t, ...a) => { seen.push(String(t)); return orig(t, ...a); }; r.draw(); ctx.fillText = orig; return seen; }""")


def shown(page):
    return set(page.evaluate("() => [...window.__hopline.renderer.data.visible.nodes]"))


def pos(page, id_):
    return page.evaluate("(id) => { const p = window.__hopline.renderer.positionOf(id); return p ? [Math.round(p.x), Math.round(p.y)] : null; }", id_)


def loaded(page):
    return set(page.evaluate("() => [...window.__hopline.state.graph.nodes.values()].filter(n => n.type === 'tx' && n.loaded).map(n => n.id)"))


def an(page):
    return page.evaluate("""() => { const a = window.__hopline.analysis();
        return { flags: Object.fromEntries([...a.tx].map(([id, r]) => [id, r.flags.map(f => f.short)])), change: Object.fromEntries([...a.changeEdges].map(([id, c]) => [id, c.confidence])),
                 chains: a.chains.map(c => c.ids), clusters: a.clusters.list.map(c => ({ label: c.label, addrs: c.addrs, txs: c.txs })), skipped: a.clusters.skipped }; }""")


def low(page, sel):
    """The text of an element, lower-cased: headings are drawn in capitals by the style sheet."""
    return page.inner_text(sel).lower()


def open_section(page, id_):
    page.evaluate("(id) => { document.getElementById(id).open = true; }", id_)


def auto(page, **kw):
    """Set the Auto-expand panel's fields, then press its button."""
    open_section(page, "autoSection")
    for key, field in (("hops", "#autoHops"), ("max_tx", "#autoMaxTx"), ("max_req", "#autoMaxReq"), ("per_tx", "#autoPerTx"), ("min_sats", "#autoMin")):
        if key in kw:
            page.fill(field, str(kw[key]))
            page.dispatch_event(field, "change")
    if "follow" in kw:
        page.select_option("#autoFollow", kw["follow"])
    if "dir" in kw:
        page.click("#autoDirSeg [data-dir=%s]" % kw["dir"])
    for key, field in (("stop_label", "#autoStopLabel"), ("stop_mix", "#autoStopMix")):
        if key in kw:
            page.set_checked(field, kw[key])
    page.click("#autoGo")
    idle(page)
    settle(page)


def go_trace(page):
    page.click("#layoutSeg [data-layout=trace]"); page.select_option("#traceArrange", "columns")
    settle(page)


# ---------------------------------------------------------------- patterns
def test_a_consolidation_is_flagged_on_the_canvas_in_the_details_and_in_the_findings(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30))
    assert "CONSOL 6→1" in drawn_texts(fpage)
    insp = low(fpage, "#inspBody")
    assert "consolidation: 6 inputs gathered into 1 output" in insp
    assert "consol" in low(fpage, "#anFindings")
    fpage.uncheck("#anFlags")
    assert "CONSOL 6→1" not in drawn_texts(fpage), "the badge goes with its switch"
    fpage.check("#anFlags")
    assert "CONSOL 6→1" in drawn_texts(fpage)


def test_the_flag_names_itself_in_the_hover_tooltip(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30))
    p = xy(fpage, "tx:" + tid(30)); fpage.mouse.move(p["x"], p["y"])
    fpage.wait_for_function("() => !document.getElementById('tooltip').hidden")
    assert "consol 6→1" in low(fpage, "#tooltip")


def test_a_coinjoin_like_transaction_is_flagged_and_does_not_link_its_inputs(fpage, mock):
    coinjoin(mock)
    open_query(fpage, tid(50))
    a = an(fpage)
    assert a["flags"]["tx:" + tid(50)] == ["COINJOIN?"]
    assert a["clusters"] == [] and a["skipped"]["coinjoin"] == 1
    assert "COINJOIN?" in drawn_texts(fpage)
    assert "not linked: it looks like a coinjoin" in low(fpage, "#inspBody")
    assert "1 coinjoin-like transaction" in low(fpage, "#anFindings")


def test_an_ordinary_payment_shows_no_flag_and_the_findings_say_so(fpage):
    open_query(fpage, "0f58c9a7aee48bd72ffd929fd3ac80bf95db5be13a6493b2f954de9ae659710d")
    assert not [t for t in drawn_texts(fpage) if t.split(" ")[0] in ("CONSOL", "BATCH", "PEEL", "COINJOIN?")]
    assert "nothing notable" in low(fpage, "#anFindings")


# ---------------------------------------------------------------- change
def test_the_likely_change_is_named_with_its_reasons_and_its_edge_is_marked(fpage, mock):
    reuse_change(mock)
    open_query(fpage, tid(40))
    edge = "out:%s:1" % tid(40)
    a = an(fpage)
    assert a["change"] == {edge: "high"}
    insp = low(fpage, "#inspBody")
    assert "likely change" in insp and "output 1" in insp and "high confidence" in insp
    assert "also one of the inputs" in insp and "not a certainty" in insp
    assert fpage.evaluate("(id) => window.__hopline.renderer.data.edgeMark(window.__hopline.state.graph.edges.get(id))", edge) == AMBER
    assert fpage.evaluate("(id) => window.__hopline.renderer.data.edgeMark(window.__hopline.state.graph.edges.get(id))", "out:%s:0" % tid(40)) is None
    assert "likely change" in fpage.evaluate("(id) => window.__hopline.renderer.data.edgeLabel(window.__hopline.state.graph.edges.get(id))", edge)
    assert "amber edge" in low(fpage, "#legend")
    fpage.uncheck("#anChange")
    assert fpage.evaluate("(id) => window.__hopline.renderer.data.edgeMark", edge) is None, "switched off: the canvas is not even asked"
    assert "amber edge" not in low(fpage, "#legend")


def test_when_the_evidence_does_not_single_out_an_output_nothing_is_marked(fpage, mock):
    unclear_change(mock)
    open_query(fpage, tid(60))
    assert an(fpage)["change"] == {}
    assert "none named" in low(fpage, "#inspBody")


def test_select_the_change_output_from_the_details(fpage, mock):
    reuse_change(mock)
    open_query(fpage, tid(40))
    fpage.click("#inspBody button:has-text('Select that output')"); settle(fpage)
    assert fpage.evaluate("() => [...window.__hopline.state.selected]") == ["addr:" + addr("me")]


# ---------------------------------------------------------------- clusters
def test_addresses_spent_together_form_a_cluster_with_rings_a_list_and_details(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30))
    members = ["addr:" + addr("k%d" % i) for i in range(6)]
    a = an(fpage)
    assert len(a["clusters"]) == 1 and sorted(a["clusters"][0]["addrs"]) == sorted(members) and a["clusters"][0]["txs"] == [tid(30)]
    colours = {fpage.evaluate("(id) => window.__hopline.renderer.data.clusterColor(id)", m) for m in members}
    assert len(colours) == 1 and None not in colours, "one colour for the whole cluster"
    assert fpage.evaluate("(id) => window.__hopline.renderer.data.clusterColor(id)", "addr:" + addr("sink")) is None
    show_findings(fpage)
    assert "c1 · 6 addresses" in low(fpage, "#anFindings")
    fpage.click("#anFindings button:has-text('C1')"); settle(fpage)
    assert set(fpage.evaluate("() => [...window.__hopline.state.selected]")) == set(members)
    click_node(fpage, members[2]); settle(fpage)
    insp = low(fpage, "#inspBody")
    assert "cluster c1" in insp and "6 addresses were spent together in 1 transaction" in insp
    shot(fpage, "analysis_cluster.png")
    fpage.uncheck("#anClusters")
    assert fpage.evaluate("() => window.__hopline.renderer.data.clusterColor") is None


def test_right_click_selects_the_whole_cluster(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30))
    p = xy(fpage, "addr:" + addr("k1")); fpage.mouse.click(p["x"], p["y"], button="right")
    fpage.click("#ctxMenu >> text=Select its cluster (6)"); settle(fpage)
    assert len(fpage.evaluate("() => [...window.__hopline.state.selected]")) == 6


def test_a_transaction_can_be_excluded_from_clustering_and_it_is_remembered(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30))
    assert "treated as one owner" in low(fpage, "#inspBody")
    fpage.click("#inspBody button:has-text('Not the same owner')"); settle(fpage)
    a = an(fpage)
    assert a["clusters"] == [] and a["skipped"]["excluded"] == 1
    assert "not linked: you excluded" in low(fpage, "#inspBody")
    assert "1 you excluded" in low(fpage, "#anFindings")
    assert '"noCluster": true' in fpage.evaluate("() => HoplineIO.toJson(window.__hopline.state.graph)"), "kept in the saved session and the export"
    fpage.click("#inspBody button:has-text('Link them again')"); settle(fpage)
    assert len(an(fpage)["clusters"]) == 1


def test_the_exclusion_survives_a_reload_of_the_saved_session(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30))
    fpage.click("#inspBody button:has-text('Not the same owner')"); settle(fpage)
    fpage.wait_for_timeout(1100)
    fpage.reload(); fpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    fpage.click("#restoreYes"); fpage.wait_for_function("() => window.__hopline.state.graph.nodes.size > 0"); settle(fpage)
    assert an(fpage)["clusters"] == []
    assert fpage.evaluate("(id) => window.__hopline.state.graph.nodes.get(id).noCluster", "tx:" + tid(30)) is True


def test_a_cluster_can_be_tagged_all_at_once(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30))
    click_node(fpage, "addr:" + addr("k0")); settle(fpage)
    fpage.click("#inspBody button:has-text('Tag the cluster')"); settle(fpage)
    assert fpage.evaluate("() => window.__hopline.state.selected.size") == 6
    fpage.select_option("#fTag", "EXCH"); settle(fpage)
    tags = fpage.evaluate("() => [...window.__hopline.state.graph.nodes.values()].filter(n => n.tag).map(n => n.id)")
    assert sorted(tags) == sorted("addr:" + addr("k%d" % i) for i in range(6))


# ---------------------------------------------------------------- peel chains
def test_a_run_of_single_coin_payments_is_a_possible_peel_chain(fpage, mock):
    peel_chain(mock, 6)
    open_query(fpage, tid(10))
    auto(fpage, hops=5, follow="largest")
    a = an(fpage)
    assert a["chains"] == [["tx:" + tid(10 + i) for i in range(6)]]
    assert a["flags"]["tx:" + tid(12)] == ["PEEL 3/6"]
    assert "p-%s · 6 transactions" % tid(10)[:4] in low(fpage, "#anFindings") and "peel" in low(fpage, "#anFindings")
    assert "possible peel chains" in low(fpage, "#anFindings")
    fpage.evaluate("(id) => window.__hopline.navigate(id)", "tx:" + tid(12)); idle(fpage); settle(fpage)
    assert "step 3 of 6 in a possible peel chain (p-%s)" % tid(10)[:4] in low(fpage, "#inspBody")


# ---------------------------------------------------------------- auto-expand
def test_the_auto_expand_panel_needs_something_selected(fpage, mock):
    open_section(fpage, "autoSection")
    assert fpage.is_disabled("#autoGo") and "select a transaction" in low(fpage, "#autoHint")
    peel_chain(mock, 3)
    open_query(fpage, tid(10))
    assert fpage.is_enabled("#autoGo") and "auto-expand from" in low(fpage, "#autoGo")


def test_auto_expand_forward_loads_the_chain_level_by_level_within_the_limits(fpage, mock):
    peel_chain(mock, 8)
    open_query(fpage, tid(10))
    n = len(mock.requests)
    auto(fpage, hops=3, follow="largest")
    got = [p for _, p in mock.requests[n:]]
    assert set(got) == {"/tx/" + tid(11), "/tx/" + tid(11) + "/outspends", "/tx/" + tid(12), "/tx/" + tid(12) + "/outspends", "/tx/" + tid(13)}, got
    assert loaded(fpage) == {"tx:" + tid(i) for i in (10, 11, 12, 13)}
    t = toast_text(fpage)
    assert "Followed forward 3 hops: 3 new transactions loaded, 5 requests." in t
    assert not fpage.is_checked("#focusOn") and "Focus view was switched off" in t, "the whole path is shown"
    assert {"tx:" + tid(i) for i in (10, 11, 12, 13)} <= shown(fpage)


def test_auto_expand_stops_at_the_transaction_limit_and_says_so(fpage, mock):
    peel_chain(mock, 8)
    open_query(fpage, tid(10))
    auto(fpage, hops=6, follow="largest", max_tx=2)
    assert loaded(fpage) == {"tx:" + tid(i) for i in (10, 11, 12)}
    assert "Stopped at the limit of 2 transactions" in toast_text(fpage)


def test_auto_expand_stops_at_the_request_limit_and_keeps_what_it_loaded(fpage, mock):
    peel_chain(mock, 8)
    open_query(fpage, tid(10))
    auto(fpage, hops=6, follow="largest", max_req=3)
    t = toast_text(fpage)
    assert "Stopped at the limit of 3 requests" in t, t
    assert "tx:" + tid(11) in loaded(fpage)
    assert len(loaded(fpage)) < 8


def test_auto_expand_backward_follows_the_funding_transactions(fpage, mock):
    peel_chain(mock, 6)
    open_query(fpage, tid(15))
    auto(fpage, hops=2, dir="prev", follow="largest")
    assert {"tx:" + tid(14), "tx:" + tid(13)} <= loaded(fpage)
    assert "Followed backward 2 hops" in toast_text(fpage)


def test_follow_a_peel_chain_stops_when_the_shape_ends(fpage, mock):
    ids = peel_chain(mock, 4)
    tx(mock, 14, [IN(13, 1, "c13", 900000), IN(70, 0, "x1", 5000)], [OUT("big", 800000), OUT("big2", 100000), OUT("big3", 3000)])      # no longer a peel step
    mock.routes["/tx/" + tid(13) + "/outspends"] = [{"spent": False}, {"spent": True, "txid": tid(14), "vin": 0, "status": {"confirmed": True, "block_time": 1650000000 + 14 * 600}}]
    open_query(fpage, tid(10))
    auto(fpage, hops=9, follow="peel")
    assert {"tx:" + tid(i) for i in (10, 11, 12, 13, 14)} <= loaded(fpage)
    assert "was not a peel step" in toast_text(fpage)


def test_follow_the_change_stops_instead_of_guessing(fpage, mock):
    unclear_change(mock)
    open_query(fpage, tid(60))
    n = len(mock.requests)
    auto(fpage, follow="change")
    assert "had no clear change output" in toast_text(fpage)
    assert not [p for _, p in mock.requests[n:] if p.startswith("/tx/" + tid(61)) or p.startswith("/tx/" + tid(62))], "nothing was loaded past the unclear transaction"


def test_follow_the_change_goes_the_way_the_evidence_points(fpage, mock):
    reuse_change(mock)
    tx(mock, 41, [IN(40, 1, "me", 39000, "p2pkh")], [OUT("elsewhere", 38000, "p2pkh")])
    mock.routes["/tx/" + tid(40) + "/outspends"] = [{"spent": False}, {"spent": True, "txid": tid(41), "vin": 0, "status": {"confirmed": True, "block_time": 1650000000 + 41 * 600}}]
    open_query(fpage, tid(40))
    auto(fpage, follow="change", hops=2)
    assert "tx:" + tid(41) in loaded(fpage)


def test_auto_expand_stops_at_a_labelled_wallet_unless_told_not_to(fpage, mock):
    peel_chain(mock, 6)
    open_query(fpage, tid(10))
    auto(fpage, hops=2, follow="largest")                                  # loads transactions 11 and 12, so the wallet 12 passes the rest to exists
    fpage.evaluate("(id) => { const n = window.__hopline.state.graph.nodes.get(id); n.tag = 'EXCH'; n.label = 'Some exchange'; }", "addr:" + addr("c12"))
    fpage.evaluate("() => window.__hopline.refresh()")
    auto(fpage, hops=6, follow="largest")
    assert "tx:" + tid(12) in loaded(fpage) and "tx:" + tid(13) not in loaded(fpage), "it went on to the labelled wallet and stopped there"
    assert "reached a labelled wallet (Some exchange)" in toast_text(fpage)
    auto(fpage, hops=6, follow="largest", stop_label=False)
    assert "tx:" + tid(15) in loaded(fpage), "with the stop switched off it carries on"


def test_auto_expand_stops_at_a_coinjoin_like_transaction(fpage, mock):
    coinjoin(mock)
    mock.routes["/tx/" + tid(50) + "/outspends"] = [{"spent": True, "txid": tid(20 + i), "vin": 0} for i in range(7)]      # none of these is served: the walk must not ask
    open_query(fpage, tid(50))
    n = len(mock.requests)
    auto(fpage, hops=2)
    assert "looked like a CoinJoin" in toast_text(fpage)
    assert len(mock.requests) == n, "nothing was fetched beyond it"


def test_the_settings_are_remembered(fpage, mock):
    peel_chain(mock, 3)
    open_section(fpage, "autoSection")
    fpage.fill("#autoHops", "7"); fpage.dispatch_event("#autoHops", "change")
    fpage.select_option("#autoFollow", "peel")
    fpage.click("#autoDirSeg [data-dir=prev]")
    fpage.uncheck("#autoStopMix")
    fpage.uncheck("#anClusters")
    fpage.reload(); fpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    open_section(fpage, "autoSection")
    assert fpage.input_value("#autoHops") == "7" and fpage.input_value("#autoFollow") == "peel"
    assert fpage.get_attribute("#autoDirSeg [data-dir=prev]", "aria-checked") == "true" and not fpage.is_checked("#autoStopMix")
    assert not fpage.is_checked("#anClusters") and fpage.is_checked("#anFlags")


def test_nonsense_in_the_fields_is_clamped(fpage):
    open_section(fpage, "autoSection")
    fpage.fill("#autoHops", "999"); fpage.dispatch_event("#autoHops", "change")
    fpage.fill("#autoMaxTx", "-5"); fpage.dispatch_event("#autoMaxTx", "change")
    assert fpage.input_value("#autoHops") == "12" and fpage.input_value("#autoMaxTx") == "1"
    fpage.fill("#autoMin", ""); fpage.dispatch_event("#autoMin", "change")
    assert fpage.input_value("#autoMin") == "0"


def test_auto_expand_from_the_details_and_from_the_menu(fpage, mock):
    peel_chain(mock, 5)
    open_query(fpage, tid(10))
    fpage.click("#inspBody button:has-text('Auto-expand ▶▶')"); idle(fpage); settle(fpage)
    assert "tx:" + tid(11) in loaded(fpage) and "tx:" + tid(13) in loaded(fpage), "three hops with the panel's settings"
    p = xy(fpage, "tx:" + tid(12)); fpage.mouse.click(p["x"], p["y"], button="right")
    menu = low(fpage, "#ctxMenu")
    assert "auto-expand forward" in menu and "auto-expand backward" in menu and "follow a peel chain" in menu
    fpage.click("#ctxMenu >> text=Follow a peel chain"); idle(fpage); settle(fpage)
    assert "tx:" + tid(14) in loaded(fpage)


def test_a_wallet_can_be_the_start_and_its_history_is_loaded_when_nothing_is_known_about_it(fpage, mock):
    wallet = addr("solo")
    tx(mock, 71, [IN(5, 0, "origin", 100000)], [OUT("solo", 99000)])                         # pays the wallet; nothing is known yet about what the wallet did
    spender = tx(mock, 72, [IN(71, 0, "solo", 99000)], [OUT("next1", 98000)], spent={0: 73})
    tx(mock, 73, [IN(72, 0, "next1", 98000)], [OUT("next2", 97000)])
    mock.routes["/address/" + wallet] = {"address": wallet, "chain_stats": {"tx_count": 1}, "mempool_stats": {"tx_count": 0}}
    mock.routes["/address/" + wallet + "/txs"] = [mock.routes["/tx/" + tid(72)]]
    open_query(fpage, tid(71))
    n = len(mock.requests)
    fpage.evaluate("(id) => window.__hopline.autoExpand(id, { dir: 'next', hops: 1, follow: 'largest' })", "addr:" + wallet)
    idle(fpage); settle(fpage)
    got = [p for _, p in mock.requests[n:]]
    assert "/address/" + wallet in got and "/address/" + wallet + "/txs" in got, "its history was asked for"
    assert spender in loaded(fpage) and "tx:" + tid(73) in loaded(fpage)


# ---------------------------------------------------------------- auto-expand in the trace layout
def test_in_a_trace_auto_expand_shows_what_it_loaded_in_columns_and_one_undo_takes_it_back(fpage, mock):
    peel_chain(mock, 8)
    open_query(fpage, tid(10))
    go_trace(fpage)
    assert shown(fpage) == {"tx:" + tid(10)}
    auto(fpage, hops=3, follow="largest")
    now = shown(fpage)
    want = {"tx:" + tid(i) for i in (10, 11, 12, 13)} | {"addr:" + addr("peel%d" % i) for i in (10, 11, 12)} | {"addr:" + addr("c%d" % i) for i in (10, 11, 12)}
    assert now == want, (now ^ want)
    xs = [pos(fpage, i)[0] for i in ("tx:" + tid(10), "addr:" + addr("c10"), "tx:" + tid(11), "addr:" + addr("c11"), "tx:" + tid(12), "addr:" + addr("c12"), "tx:" + tid(13))]
    assert xs == sorted(xs) and len(set(xs)) == len(xs), "one column per step, left to right: %s" % xs
    assert len({tuple(pos(fpage, i)) for i in now}) == len(now), "nothing lands on anything"
    assert "9 vertices shown" in toast_text(fpage)
    shot(fpage, "analysis_auto_trace.png")
    fpage.keyboard.press("Control+z"); settle(fpage)
    assert shown(fpage) == {"tx:" + tid(10)}, "one step back removes everything it showed"
    assert len(loaded(fpage)) == 4, "the data stays loaded, only the view changes"


def test_a_trace_auto_expand_keeps_what_was_already_shown_where_it_was(fpage, mock):
    peel_chain(mock, 6)
    open_query(fpage, tid(10))
    go_trace(fpage)
    fpage.evaluate("(id) => window.__hopline.traceExpand(id, 'next')", "tx:" + tid(10)); idle(fpage); settle(fpage)
    before = {i: pos(fpage, i) for i in shown(fpage)}
    assert len(before) == 3
    fpage.evaluate("(id) => window.__hopline.autoExpand(id, { dir: 'next', hops: 2, follow: 'largest' })", "addr:" + addr("c10")); idle(fpage); settle(fpage)
    assert {i: pos(fpage, i) for i in before} == before
    assert "tx:" + tid(11) in shown(fpage) and "tx:" + tid(12) in shown(fpage)


def test_auto_expand_in_a_trace_needs_the_vertex_to_be_on_screen(fpage, mock):
    peel_chain(mock, 4)
    open_query(fpage, tid(10))
    go_trace(fpage)
    fpage.evaluate("(id) => window.__hopline.autoExpand(id)", "tx:" + tid(11))
    idle(fpage)
    assert "not on screen" in toast_text(fpage)


# ---------------------------------------------------------------- export
def test_exports_carry_patterns_clusters_and_the_change_guess(fpage, mock, tmp_path):
    consolidation(mock)
    reuse_change(mock)
    open_query(fpage, tid(30)); open_query(fpage, tid(40))
    fpage.uncheck("#focusOn"); settle(fpage)

    def export(kind, name):
        fpage.click("#exportMenu summary")
        with fpage.expect_download() as dl:
            fpage.click("[data-export=%s]" % kind)
        p = tmp_path / name; dl.value.save_as(p); return p

    rows = list(csv.reader(io.StringIO(export("csv-nodes", "n.csv").read_text(encoding="utf-8-sig"), newline="")))
    h = rows[0]
    assert {"patterns", "cluster", "cluster_size", "excluded_from_clustering"} <= set(h)
    by_id = {r[0]: r for r in rows[1:]}
    assert by_id["tx:" + tid(30)][h.index("patterns")] == "CONSOL 6→1"
    assert by_id["addr:" + addr("k0")][h.index("cluster")] == "C1" and by_id["addr:" + addr("k0")][h.index("cluster_size")] == "6"
    assert by_id["addr:" + addr("sink")][h.index("cluster")] == ""
    rows = list(csv.reader(io.StringIO(export("csv-edges", "e.csv").read_text(encoding="utf-8-sig"), newline="")))
    h = rows[0]
    assert "likely_change" in h
    flagged = {r[0]: r[h.index("likely_change")] for r in rows[1:] if r[h.index("likely_change")]}
    assert flagged == {"out:%s:1" % tid(40): "high"}


def test_an_even_split_is_not_called_change(fpage, mock):
    """Two halves of 203.7 BTC to two kinds of address: one matches the inputs' type, but that says nothing about change."""
    tx(mock, 70, [IN(95, 0, "src", 20371000)], [OUT("half1", 10185490, "p2pkh"), OUT("half2", 10185479)])
    open_query(fpage, tid(70))
    assert an(fpage)["change"] == {}
    assert "none named" in low(fpage, "#inspBody")


def test_a_guess_on_one_sign_is_called_possible_and_says_to_follow_both_outputs(fpage, mock):
    tx(mock, 71, [IN(96, 0, "src2", 100000)], [OUT("legacy", 61234, "p2pkh"), OUT("mine", 38000)])
    open_query(fpage, tid(71))
    edge = "out:%s:1" % tid(71)
    assert an(fpage)["change"] == {edge: "medium"}
    insp = low(fpage, "#inspBody")
    assert "possible change" in insp and "likely change" not in insp and "medium confidence" in insp
    assert "only one sign points to this output" in insp and "follow both outputs" in insp
    label = fpage.evaluate("(id) => window.__hopline.renderer.data.edgeLabel(window.__hopline.state.graph.edges.get(id))", edge)
    assert "change?" in label and "likely" not in label
    assert "possible or likely change" in low(fpage, "#legend")
