"""Routes and open ends: how a known wallet in the Findings relates to the start of the trace, the route lit on the canvas, the offer when such a wallet is added, and where the trail is still open."""
import json
import re

import pytest

from chains import OUT, addr, peel_chain, real_addr, tid, tx
from conftest import shot
from helpers import idle, open_query, settle
from test_assistant import capture, copied, evidence as assist_evidence, open_ai
from test_every_name import load_json
from test_report import evidence as report_evidence, make_report, verify as verify_report
from test_trace import shown

EX = real_addr(501)                                    # an exchange wallet that a label list names
Q2 = real_addr(503)                                    # a wallet ran pays that a ransomware list can name
K2 = real_addr(502)                                    # another named wallet: it only shares an address with the flow
STEPS = ["tx:" + tid(n) for n in (1, 2, 3)]


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def RIN(txn, vout, address, value):
    return {"txid": tid(txn), "vout": vout, "is_coinbase": False, "prevout": {"scriptpubkey_address": address, "scriptpubkey_type": "v0_p2wpkh", "value": value}}


def ROUT(address, value):
    return {"scriptpubkey_address": address, "scriptpubkey_type": "v0_p2wpkh", "value": value}


def case(mock):
    """EX pays a victim (vic) in tx 1; vic pays the ransom wallet (ran) in tx 2; ran pays three wallets in tx 3. Beside it: z, used again by tx 6 after it paid ran in tx 5."""
    tx(mock, 1, [RIN(90, 0, EX, 900)], [ROUT(addr("vic"), 500), ROUT(EX, 390)], spent={0: 2})
    tx(mock, 2, [RIN(1, 0, addr("vic"), 500)], [ROUT(addr("ran"), 490)], spent={0: 3})
    tx(mock, 3, [RIN(2, 0, addr("ran"), 490)], [ROUT(addr("q1"), 300), ROUT(Q2, 100), ROUT(addr("q3"), 80)])
    tx(mock, 5, [RIN(91, 0, addr("z"), 200)], [ROUT(addr("ran"), 190)])
    tx(mock, 6, [RIN(92, 0, K2, 500)], [ROUT(addr("z"), 490)])
    mock.routes["/address/" + EX] = {"address": EX, "chain_stats": {"tx_count": 1, "funded_txo_sum": 390, "spent_txo_sum": 900}, "mempool_stats": {"tx_count": 0}}
    mock.routes["/address/" + EX + "/txs"] = [mock.routes["/tx/" + tid(1)]]               # what adding it loads: its history
    return "tx:" + tid(3)


def named_list(extra=()):
    return json.dumps({"format": "hopline-labels", "version": 1, "name": "Test list", "source": "a test",
                       "labels": [{"address": EX, "label": "Test exchange", "category": "exchange"}, {"address": K2, "label": "Other wallet", "category": "service"}] + list(extra)})


def trace_case(tpage, mock, extra=()):
    """The ransom payment as the starting point, what funded it loaded two steps back, and a list that names EX (and the wallets in `extra`)."""
    case(mock)
    open_query(tpage, tid(3))
    tpage.evaluate("(id) => window.__hopline.autoExpand(id, { dir: 'prev', hops: 2, follow: 'largest' })", "tx:" + tid(3)); idle(tpage); settle(tpage)
    open_query(tpage, tid(5)); open_query(tpage, tid(6))
    load_json(tpage, "list.json", named_list(extra))
    tpage.evaluate("() => window.__hopline.setSel([])"); settle(tpage)
    tpage.evaluate("() => window.__hopline.openFindings('known')"); settle(tpage)


def rel_buttons(page):
    return page.eval_on_selector_all("#anFindings .relbtn[data-rel]", "els => els.map((b) => [b.dataset.rel, b.textContent.trim()])")


def lit(page):
    return page.evaluate("() => { const c = window.__hopline.renderer.chain; return c ? { label: c.label, ids: [...c.ids], path: [...c.path] } : null; }")


def test_a_known_wallet_says_how_it_relates_to_the_start_of_the_trace_and_the_ones_with_a_route_come_first(tpage, mock):
    trace_case(tpage, mock)
    assert tpage.inner_text("#findStrip [data-key=known]").startswith("Known wallets")
    assert rel_buttons(tpage) == [["up", "◀ upstream · 3 tx · show route"]], rel_buttons(tpage)
    rows = tpage.eval_on_selector_all("#anFindings [data-group=known] ~ .relrow", r"els => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim())")
    assert rows[0].startswith("Test exchange") and "upstream" in rows[0], rows
    assert rows[1].startswith("Other wallet") and "No route to or from" in rows[1], "a wallet that only shares an address with the flow is not related to it: " + rows[1]
    assert "relative to" in tpage.inner_text("#anFindings").lower() and "START" in tpage.eval_on_selector("#anFindings .refsel", "s => s.options[s.selectedIndex].textContent")
    shot(tpage, "route_known_row.png")


def test_the_route_lights_up_on_the_canvas_and_is_listed_step_by_step_in_the_findings(tpage, mock):
    trace_case(tpage, mock)
    before = shown(tpage)
    tpage.click("#anFindings .relbtn[data-rel=up]"); idle(tpage); settle(tpage)
    c = lit(tpage)
    assert c["label"] == "Route" and c["ids"][0] == "addr:" + EX and c["ids"][-1] == "tx:" + tid(3)
    assert c["ids"][1:6:2] == STEPS, c["ids"]
    assert len(c["path"]) == 5, "the coins in the order they moved: into tx 1, out to vic, into tx 2, out to ran, into tx 3"
    assert set(c["ids"]) <= shown(tpage), "everything on the route is on screen now"
    assert shown(tpage) > before, "and the trace grew to show it"
    chip = tpage.inner_text("#chainChip")
    assert "Route" in chip and "3 transactions" in chip and "Test exchange" in chip
    rows = tpage.eval_on_selector_all("#anFindings [data-group=route] ~ .rowcopy .rowtext", "els => els.map((e) => e.textContent.replace(/\\s+/g, ' ').trim())")
    rows = [r for r in rows if re.match(r"\d\. tx ", r)]
    assert len(rows) == 3 and rows[0].startswith("1. tx 01010") and rows[2].startswith("3. tx 03030"), rows
    assert "Each step is the transaction that spent the coin before it" in tpage.inner_text("#anFindings")
    shot(tpage, "route_lit.png")
    tpage.click("#chainChipClear"); settle(tpage)
    assert lit(tpage) is None and tpage.is_hidden("#chainChip")
    assert tpage.locator("#anFindings [data-group=route]").count() == 0, "the list goes with the highlight"


def test_a_route_is_one_step_that_undo_takes_back(tpage, mock):
    trace_case(tpage, mock)
    n0 = len(shown(tpage))
    tpage.click("#anFindings .relbtn[data-rel=up]"); idle(tpage); settle(tpage)
    assert len(shown(tpage)) > n0
    tpage.click("#traceUndo"); idle(tpage); settle(tpage)
    assert len(shown(tpage)) <= n0 + 1, "what the route showed is taken back (the start it was added from may remain)"


def test_adding_the_known_wallet_offers_the_route_instead_of_leaving_it_a_separate_island(tpage, mock):
    trace_case(tpage, mock)
    assert "addr:" + EX not in shown(tpage)
    tpage.click("#anFindings .relrow > .linkrow"); idle(tpage); settle(tpage)
    toast = tpage.inner_text("#toast")
    assert "Added to the trace as another starting point" in toast and "Money from" in toast and "in 3 transactions" in toast, toast
    assert tpage.locator("#toast button", has_text="Show route").count() == 1
    assert lit(tpage) is None, "offered, not drawn"
    tpage.click("#toast button"); idle(tpage); settle(tpage)
    c = lit(tpage)
    assert c and c["ids"][0] == "addr:" + EX and set(c["ids"]) <= shown(tpage)


def test_the_details_of_a_wallet_with_a_route_show_it_and_a_wallet_without_one_shows_nothing(tpage, mock):
    trace_case(tpage, mock)
    tpage.evaluate("(id) => window.__hopline.setSel([id])", "addr:" + EX); settle(tpage)
    assert "route to" in tpage.inner_text("#inspBody").lower() and tpage.locator("#inspBody .relbtn[data-rel=up]").count() == 1
    tpage.evaluate("(id) => window.__hopline.setSel([id])", "addr:" + K2); settle(tpage)
    inner = tpage.inner_text("#inspBody").lower()
    assert "route to" in inner and "no route to or from" in inner, "a named wallet shows that it has no route, so it can be searched for"
    assert tpage.locator("#inspBody .relbtn[data-rel=up]").count() == 0 and tpage.locator("#inspBody .relbtn[data-search]").count() == 2, "k2 shares an address with the flow, not a coin"
    tpage.evaluate("(id) => window.__hopline.setSel([id])", "addr:" + addr("z")); settle(tpage)
    assert "route to" not in tpage.inner_text("#inspBody").lower(), "a wallet nobody named and with no route shows nothing"
    tpage.evaluate("(id) => window.__hopline.setSel([id])", "tx:" + tid(2)); settle(tpage)
    assert tpage.locator("#inspBody .relbtn[data-rel=up]").count() == 1, "a transaction on the way shows its route too"


def open_ends_case(tpage, mock):
    peel_chain(mock, 6)
    open_query(tpage, tid(10))
    tpage.evaluate("(id) => window.__hopline.autoExpand(id, { dir: 'next', hops: 3, follow: 'largest' })", "tx:" + tid(10)); idle(tpage); settle(tpage)
    tpage.evaluate("() => window.__hopline.setSel([])"); settle(tpage)


def test_open_ends_say_where_the_trail_stops_and_a_chip_counts_them_without_being_a_finding(tpage, mock):
    open_ends_case(tpage, mock)
    chip = tpage.inner_text("#findStrip [data-key=open]")
    assert chip.startswith("Open ends") and chip.endswith("2"), chip
    assert tpage.inner_text("#anCount") != "(2)", "an open end is not a finding"
    tpage.click("#findStrip [data-key=open]"); settle(tpage)
    text = tpage.inner_text("#anFindings [data-group=open] ~ .hint")
    assert "2 branches" in text and "never looked up" in text, text
    assert tpage.locator("#anFindings button[data-act=continue]").inner_text().startswith("Continue from these 2")
    shot(tpage, "open_ends.png")


def test_continuing_from_the_open_ends_follows_them_and_the_chip_goes_when_nothing_is_left_open(tpage, mock):
    open_ends_case(tpage, mock)
    tpage.click("#findStrip [data-key=open]"); settle(tpage)
    n0 = len(shown(tpage))
    tpage.click("#anFindings button[data-act=continue]"); idle(tpage); settle(tpage)
    assert len(shown(tpage)) > n0, "what it loaded is on screen"
    assert tpage.locator("#findStrip [data-key=open]").count() == 0, "the last transactions are unspent, so nothing is left open"
    assert "Nothing is left open" in tpage.inner_text("#anFindings") or tpage.locator("#anFindings [data-group=open]").count() == 0


def test_the_other_direction_lists_the_inputs_whose_funding_is_not_loaded(tpage, mock):
    open_ends_case(tpage, mock)
    tpage.click("#findStrip [data-key=open]"); settle(tpage)
    tpage.click("#anFindings [data-dir=prev]"); settle(tpage)
    text = tpage.inner_text("#anFindings")
    assert "whose funding transaction is not loaded" in text, text


def test_in_the_other_layouts_the_route_is_lit_where_it_is_and_nothing_is_added(fpage, mock):
    case(mock)
    open_query(fpage, tid(3))
    fpage.evaluate("(id) => window.__hopline.autoExpand(id, { dir: 'prev', hops: 2, follow: 'largest' })", "tx:" + tid(3)); idle(fpage); settle(fpage)
    load_json(fpage, "list.json", named_list())
    fpage.evaluate("(id) => window.__hopline.setSel([id])", "tx:" + tid(3)); settle(fpage)                    # no trace and no tag: the one selected vertex is the reference
    fpage.evaluate("() => window.__hopline.openFindings('known')"); settle(fpage)
    assert [r[0] for r in rel_buttons(fpage)] == ["up"], rel_buttons(fpage)
    n0 = fpage.evaluate("() => window.__hopline.renderer.data.visible.nodes.size")
    fpage.click("#anFindings .relbtn[data-rel=up]"); settle(fpage)
    c = lit(fpage)
    assert c and c["label"] == "Route" and c["ids"][0] == "addr:" + EX and c["ids"][-1] == "tx:" + tid(3)
    assert fpage.evaluate("() => window.__hopline.renderer.data.visible.nodes.size") == n0, "everything loaded was already drawn"
    assert "3 transactions" in fpage.inner_text("#chainChip")


def test_the_reference_can_be_changed_and_the_relations_follow(tpage, mock):
    trace_case(tpage, mock)
    assert len(rel_buttons(tpage)) == 1
    tpage.select_option("#anFindings .refsel", "tx:" + tid(5)); settle(tpage)
    assert rel_buttons(tpage) == [], "ex did not send money to tx 5 or receive from it"
    assert tpage.inner_text("#anFindings").count("No route to or from") == 2
    tpage.select_option("#anFindings .refsel", "tx:" + tid(3)); settle(tpage)
    assert len(rel_buttons(tpage)) == 1


K3 = real_addr(503)
HUB = real_addr(504)


def hub_case(mock):
    """k3 pays a service wallet (hub) in tx 8, and hub pays on in tx 9: the only way from k3 to the end of tx 9 is across hub."""
    tx(mock, 8, [RIN(93, 0, K3, 300)], [ROUT(HUB, 290)], spent={0: 9})
    tx(mock, 9, [RIN(8, 0, HUB, 290)], [ROUT(addr("sink"), 280)])
    return "tx:" + tid(9)


def test_a_route_that_only_exists_across_a_service_wallet_says_so_everywhere(tpage, mock):
    hub_case(mock)
    open_query(tpage, tid(9))
    tpage.evaluate("(id) => window.__hopline.autoExpand(id, { dir: 'prev', hops: 2, follow: 'largest' })", "tx:" + tid(9)); idle(tpage); settle(tpage)
    load_json(tpage, "list.json", json.dumps({"format": "hopline-labels", "version": 1, "name": "Test list", "labels": [
        {"address": K3, "label": "Customer", "category": "x"}, {"address": HUB, "label": "Service hub", "category": "exchange"}]}))
    tpage.evaluate("() => window.__hopline.setSel([])"); settle(tpage)
    tpage.evaluate("() => window.__hopline.openFindings('known')"); settle(tpage)
    texts = [t for _, t in rel_buttons(tpage)]
    assert any("via a service wallet" in t for t in texts), texts
    assert any("1 tx" in t and "service wallet" not in t for t in texts), "the service wallet itself is reached at the end of the route, with no warning: " + str(texts)
    tpage.click("#anFindings .relbtn:has-text('via a service wallet')"); idle(tpage); settle(tpage)
    assert "only across Service hub" in tpage.inner_text("#toast")
    assert "Only found across Service hub" in tpage.inner_text("#anFindings")


# ---- service hand-offs ----------------------------------------------------------------------------------------------------
def test_the_service_hand_offs_are_listed_downloaded_and_open_the_route(tpage, mock, tmp_path):
    trace_case(tpage, mock)
    chip = tpage.inner_text("#findStrip [data-key=handoff]")
    assert chip.startswith("Service hand-offs") and chip.endswith("1"), chip
    tpage.click("#findStrip [data-key=handoff]"); settle(tpage)
    row = tpage.locator("#anFindings [data-handoff=withdrawal]")
    text = row.inner_text()
    assert "Test exchange" in text and "withdrawal" in text and "tx 01010" in text and "0.00000900 BTC" in text, text
    assert "candidate for the customer" in tpage.inner_text("#anFindings")
    with tpage.expect_download() as dl:
        tpage.click("#anFindings button:has-text('Download CSV')")
    p = tmp_path / "handoffs.csv"
    dl.value.save_as(p)
    lines = p.read_text(encoding="utf-8-sig").splitlines()
    assert lines[0].startswith("direction,service,service_wallet,txid,")
    assert lines[1].startswith("withdrawal,Test exchange," + EX + "," + tid(1) + ","), lines[1]
    shot(tpage, "handoffs.png")
    row.locator(".linkrow").click(); idle(tpage); settle(tpage)
    c = lit(tpage)
    assert c and c["ids"][0] == "addr:" + EX and c["ids"][-1] == "tx:" + tid(3), "the row shows the route from the service to the reference"


RANSOM = {"address": Q2, "label": "Ransomware: Acme", "category": "ransomware"}


def test_a_wallet_a_list_names_that_is_not_a_service_is_a_hand_off_marked_named(tpage, mock, tmp_path):
    trace_case(tpage, mock, [RANSOM])
    chip = tpage.inner_text("#findStrip [data-key=handoff]")
    assert chip.startswith("Hand-offs") and not chip.startswith("Service") and chip.endswith("2"), chip
    tpage.click("#findStrip [data-key=handoff]"); settle(tpage)
    text = tpage.inner_text("#anFindings")
    assert "hand-offs" in text.lower() and "a wallet that a list names" in text, text
    named = tpage.locator("#anFindings [data-handoff=deposit][data-named]")
    assert named.count() == 1, "one row for the listed wallet"
    t = named.inner_text()
    assert "Ransomware: Acme" in t and "named wallet" in t and "went into it" in t and "0.00000100 BTC" in t, t
    service = tpage.locator("#anFindings [data-handoff=withdrawal]").inner_text()
    assert "Test exchange" in service and "withdrawal" in service and "named wallet" not in service, service
    with tpage.expect_download() as dl:
        tpage.click("#anFindings button:has-text('Download CSV')")
    p = tmp_path / "handoffs.csv"
    dl.value.save_as(p)
    lines = p.read_text(encoding="utf-8-sig").splitlines()
    assert lines[0].endswith(",kind") and any(l.startswith("deposit,Ransomware: Acme,") and l.endswith(",named") for l in lines), lines
    assert any(l.startswith("withdrawal,Test exchange,") and l.endswith(",service") for l in lines), lines
    shot(tpage, "handoffs_named.png")
    named.locator(".linkrow").click(); idle(tpage); settle(tpage)
    c = lit(tpage)
    assert c and c["ids"][0] == "tx:" + tid(3) and c["ids"][-1] == "addr:" + Q2, "the row shows the route from the reference to the listed wallet: " + str(c)
    p = make_report(tpage, tmp_path, "named.html")
    html = p.read_text(encoding="utf-8")
    assert "<h3>Hand-offs (1)</h3>" in html and "<i>named</i> Ransomware: Acme" in html and "into the wallet" in html, "only what is on screen is in the report"
    r = verify_report(p)
    assert r.returncode == 0 and "OK:" in r.stdout, r.stdout + r.stderr


def test_without_a_list_name_the_chip_still_says_service_hand_offs(tpage, mock):
    trace_case(tpage, mock)
    assert tpage.inner_text("#findStrip [data-key=handoff]").startswith("Service hand-offs")


def test_the_report_has_the_trail_cut_to_what_is_on_screen(tpage, mock, tmp_path):
    trace_case(tpage, mock)
    html = make_report(tpage, tmp_path, "before.html").read_text(encoding="utf-8")
    assert "How far the trace got" in html
    assert "Service hand-offs" not in html, "the exchange wallet was not on screen yet, so the report does not name it"
    assert EX not in html.split('<script type="application/json"')[0], "nor is its address in the readable report"
    tpage.click("#anFindings .relbtn[data-rel=up]"); idle(tpage); settle(tpage)
    p = make_report(tpage, tmp_path, "after.html")
    html = p.read_text(encoding="utf-8")
    assert "<h3>Service hand-offs (1)</h3>" in html and "withdrawal (out of the service)" in html
    assert "Route: Test exchange to tx 03030" in html and "(3 transactions)" in html
    r = verify_report(p)
    assert r.returncode == 0 and "OK:" in r.stdout, r.stdout + r.stderr
    tr = report_evidence(html)["evidence"]["trace"]
    assert tr["handoffs"][0]["service"] == "Test exchange" and tr["route"]["steps"][0]["txid"] == tid(1)


def test_the_assistant_gets_the_trail_with_its_names_marked_untrusted(tpage, mock):
    trace_case(tpage, mock)
    capture(tpage); open_ai(tpage); tpage.click("#aiCopy"); settle(tpage)
    ev = assist_evidence(copied(tpage)[-1])
    assert ev["trace"]["handoffs"][0][1:3] == ["withdrawal", "Test exchange"], ev["trace"]
    assert "trace.handoffs[].service" in ev["untrustedFields"]


# ---- names suggested by co-spending ---------------------------------------------------------------------------------------------
def sweep_case(mock):
    """The exchange's wallet is spent together with two addresses nobody named in tx 12: probably its deposit addresses."""
    tx(mock, 12, [RIN(90, 0, EX, 9000), RIN(91, 0, addr("dep1"), 4000), RIN(92, 0, addr("dep2"), 3000)], [ROUT(addr("cold"), 15500)])


def test_a_name_is_suggested_for_wallets_spent_with_a_named_one_and_only_given_when_you_say_so(tpage, mock):
    sweep_case(mock)
    open_query(tpage, tid(12))
    load_json(tpage, "list.json", named_list())
    tpage.evaluate("() => window.__hopline.setSel([])"); settle(tpage)
    tpage.evaluate("() => window.__hopline.openFindings('suggest')"); settle(tpage)
    sec = tpage.locator("#anFindings [data-suggest]")
    assert sec.count() == 1
    text = sec.inner_text()
    assert "Test exchange" in text and "2 addresses in C1" in text and "2 spent with it directly" in text and "Name them" in text, text
    assert "nothing is named until you choose Name them" in tpage.inner_text("#anFindings")
    labels = lambda: tpage.evaluate("(a) => a.map(x => (window.__hopline.state.graph.nodes.get('addr:' + x) || {}).label || '')", [addr("dep1"), addr("dep2")])
    assert labels() == ["", ""], "suggested, not applied"
    shot(tpage, "suggested_names.png")
    sec.locator(".relbtn").click(); settle(tpage)
    assert labels() == ["Test exchange (by co-spending)"] * 2
    note = tpage.evaluate("(a) => window.__hopline.state.graph.nodes.get('addr:' + a).note", addr("dep1"))
    assert "Spent together with " + EX in note and "tx " + tid(12) in note and "a guess" in note, note
    assert tpage.locator("#anFindings [data-suggest]").count() == 0, "once named there is nothing left to suggest"
    assert "Named 2 addresses" in tpage.inner_text("#toast")


def test_a_wallet_you_already_labelled_is_left_alone(tpage, mock):
    sweep_case(mock)
    open_query(tpage, tid(12))
    load_json(tpage, "list.json", named_list())
    tpage.evaluate("(a) => { window.__hopline.state.graph.annotate('addr:' + a, 'My own name', 'mine'); window.__hopline.refresh(); }", addr("dep1"))
    tpage.evaluate("() => window.__hopline.setSel([])"); settle(tpage)
    tpage.evaluate("() => window.__hopline.openFindings('suggest')"); settle(tpage)
    assert "1 address in C1" in tpage.locator("#anFindings [data-suggest]").inner_text()
    tpage.locator("#anFindings [data-suggest] .relbtn").click(); settle(tpage)
    assert tpage.evaluate("(a) => [window.__hopline.state.graph.nodes.get('addr:' + a).label, window.__hopline.state.graph.nodes.get('addr:' + a).note]", addr("dep1")) == ["My own name", "mine"]


def own_label(page, address, label):
    page.evaluate("([a, l]) => { window.__hopline.state.graph.annotate('addr:' + a, l, ''); window.__hopline.refresh(); }", [address, label])


def labels_of(page, *addresses):
    return page.evaluate("(a) => a.map(x => (window.__hopline.state.graph.nodes.get('addr:' + x) || {}).label || '')", list(addresses))


def test_a_label_you_gave_is_offered_the_same_way_and_the_note_says_it_is_yours(tpage, mock):
    sweep_case(mock)
    open_query(tpage, tid(12))
    own_label(tpage, EX, "Alice")
    tpage.evaluate("() => window.__hopline.setSel([])"); settle(tpage)
    tpage.evaluate("() => window.__hopline.openFindings('suggest')"); settle(tpage)
    sec = tpage.locator("#anFindings [data-suggest]")
    assert sec.count() == 1
    text = sec.inner_text()
    assert "Alice" in text and "your label" in text and "2 addresses in C1" in text, text
    assert "or a label you gave" in tpage.inner_text("#anFindings"), "the section says labels count"
    assert labels_of(tpage, addr("dep1"), addr("dep2")) == ["", ""], "suggested, not applied"
    sec.locator(".relbtn").click(); settle(tpage)
    assert labels_of(tpage, addr("dep1"), addr("dep2")) == ["Alice (by co-spending)"] * 2
    note = tpage.evaluate("(a) => window.__hopline.state.graph.nodes.get('addr:' + a).note", addr("dep1"))
    assert "Spent together with " + EX in note and '"Alice" is a label you gave' in note and "a guess" in note and "name from a list" not in note, note


def test_a_name_that_was_itself_a_suggestion_is_not_a_source_for_the_next(tpage, mock):
    sweep_case(mock)
    open_query(tpage, tid(12))
    own_label(tpage, EX, "Alice")
    tpage.evaluate("() => window.__hopline.setSel([])"); settle(tpage)
    tpage.evaluate("() => window.__hopline.openFindings('suggest')"); settle(tpage)
    tpage.locator("#anFindings [data-suggest] .relbtn").click(); settle(tpage)
    own_label(tpage, EX, "")                                                               # the label that started it is gone
    tx(mock, 13, [RIN(93, 0, addr("dep1"), 2000), RIN(94, 0, addr("dep9"), 1000)], [ROUT(addr("cold2"), 2800)])
    open_query(tpage, tid(13)); settle(tpage)
    tpage.evaluate("() => window.__hopline.setSel([])"); settle(tpage)
    tpage.evaluate("() => window.__hopline.openFindings('suggest')"); settle(tpage)
    assert tpage.locator("#anFindings [data-suggest]").count() == 0, "'Alice (by co-spending)' is a guess, and a guess is not a name to spread"
    assert labels_of(tpage, addr("dep9")) == [""]


def test_a_very_long_label_is_cut_before_the_suffix_so_the_result_still_says_it_is_a_guess(tpage, mock):
    sweep_case(mock)
    open_query(tpage, tid(12))
    own_label(tpage, EX, "A" * 130)
    tpage.evaluate("() => window.__hopline.setSel([])"); settle(tpage)
    tpage.evaluate("() => window.__hopline.openFindings('suggest')"); settle(tpage)
    tpage.locator("#anFindings [data-suggest] .relbtn").click(); settle(tpage)
    label = labels_of(tpage, addr("dep1"))[0]
    assert len(label) <= 120 and label.endswith(" (by co-spending)") and label.startswith("AAAA"), label


# ---- searching for a route --------------------------------------------------------------------------------------------------------
SRC = real_addr(510)


def far_chain(mock, n=6, first=31):
    """tx 31 .. 36: each pays a little out and passes the rest on; the first spends SRC. Nothing but the two ends is loaded by the test."""
    for i in range(n):
        t = first + i
        inp = RIN(95, 0, SRC, 10000) if i == 0 else RIN(t - 1, 1, addr("c%d" % (t - 1)), 10000 - 100 * i)
        tx(mock, t, [inp], [ROUT(addr("p%d" % t), 50), ROUT(addr("c%d" % t), 10000 - 100 * (i + 1))], spent={1: t + 1} if i < n - 1 else {})
    return "tx:" + tid(first + n - 1)


def test_searching_for_a_route_loads_from_both_ends_until_they_meet_and_lights_it(tpage, mock):
    last = far_chain(mock)
    open_query(tpage, tid(36)); open_query(tpage, tid(31))                                  # the end is the reference; the start is loaded too, with nothing between them
    load_json(tpage, "list.json", json.dumps({"format": "hopline-labels", "version": 1, "name": "Test list", "labels": [{"address": SRC, "label": "Start service", "category": "exchange"}]}))
    tpage.evaluate("() => window.__hopline.setSel([])"); settle(tpage)
    tpage.evaluate("() => window.__hopline.openFindings('known')"); settle(tpage)
    none = tpage.locator("#anFindings [data-rel=none]")
    assert none.count() == 1 and "No route to or from" in none.inner_text()
    assert none.locator(".relbtn[data-search=up]").count() == 1 and none.locator(".relbtn[data-search=down]").count() == 1
    loaded = lambda: tpage.evaluate("() => [...window.__hopline.state.graph.nodes.values()].filter((n) => n.type === 'tx' && n.loaded).length")
    assert loaded() == 2
    shot(tpage, "route_search_before.png")
    none.locator(".relbtn[data-search=up]").click(); idle(tpage); settle(tpage)
    assert loaded() == 6, "it loaded the four in between"
    c = lit(tpage)
    assert c and c["ids"][0] == "addr:" + SRC and c["ids"][-1] == last, c and c["ids"]
    assert "6 transactions" in tpage.inner_text("#chainChip") and "Start service" in tpage.inner_text("#chainChip")
    steps = tpage.eval_on_selector_all("#anFindings [data-group=route] ~ .rowcopy .rowtext", "els => els.map((e) => e.textContent.trim())")
    assert len([r for r in steps if re.match(r"\d\. tx ", r)]) == 6, steps
    shot(tpage, "route_search_after.png")


def coinbase_for_k2(mock):
    """What paid k2 in tx 6 was a coinbase: the search from k2's side can go back no further."""
    mock.routes["/tx/" + tid(92)] = {"txid": tid(92), "fee": 0, "weight": 800, "status": {"confirmed": True, "block_height": 1, "block_time": 1640000000},
                                    "vin": [{"is_coinbase": True, "txid": "00" * 32, "vout": 0, "prevout": None}], "vout": [ROUT(K2, 500)]}
    mock.routes["/tx/" + tid(92) + "/outspends"] = [{"spent": True, "txid": tid(6), "vin": 0, "status": {"confirmed": True, "block_height": 700006, "block_time": 1650003600}}]


def test_a_search_that_runs_out_of_road_says_they_are_not_connected_and_lights_nothing(tpage, mock):
    trace_case(tpage, mock)
    coinbase_for_k2(mock)
    tpage.click("#anFindings [data-group=known] ~ .relrow:has-text('Other wallet') .relbtn[data-search=down]"); idle(tpage); settle(tpage)
    t = tpage.inner_text("#toast")
    assert "No route from" in t and "Other wallet" in t and "not connected by money that can be followed" in t, t
    assert lit(tpage) is None


def test_a_search_that_cannot_get_what_it_asks_for_stops_and_says_what_failed(tpage, mock):
    trace_case(tpage, mock)                                                                    # transaction 92, which paid k2, is not served: the lookup fails
    tpage.click("#anFindings [data-group=known] ~ .relrow:has-text('Other wallet') .relbtn[data-search=down]"); idle(tpage); settle(tpage)
    t = tpage.inner_text("#toast")
    assert "Nothing more could be loaded" in t and "No route from" in t, t
    assert "failed" in tpage.text_content("#logList"), tpage.text_content("#logList")
    assert lit(tpage) is None


# ---- a wallet with a very long history ---------------------------------------------------------------------------------------------
def test_adding_a_wallet_with_a_huge_history_says_only_the_newest_are_loaded(tpage, mock):
    trace_case(tpage, mock)
    mock.routes["/address/" + EX]["chain_stats"]["tx_count"] = 394955
    tpage.click("#anFindings .relrow > .linkrow"); idle(tpage); settle(tpage)
    t = tpage.inner_text("#toast")
    assert "394,955 transactions, and only the newest are loaded" in t and "Added to the trace as another starting point" in t, t
    assert "Show route" in t, "the route is still offered"
    tpage.evaluate("(id) => window.__hopline.setSel([id])", "addr:" + EX); settle(tpage)
    assert "large wallet" in tpage.inner_text("#inspBody").lower()


# ---- the reference is kept ---------------------------------------------------------------------------------------------------------------
def test_the_reference_you_pick_is_kept_in_the_saved_session_and_in_an_export(tpage, mock, tmp_path):
    trace_case(tpage, mock)
    tpage.select_option("#anFindings .refsel", "tx:" + tid(5)); settle(tpage); tpage.wait_for_timeout(1200)
    saved = tpage.evaluate("() => localStorage.getItem('hopline.workspace.v1') || ''")
    assert re.search(r'"routeRef":\s*"tx:' + tid(5) + '"', saved), saved[:300]
    tpage.evaluate("() => { document.getElementById('exportMenu').open = true; }")
    with tpage.expect_download() as dl:
        tpage.click("[data-export=json]")
    p = tmp_path / "ws.json"
    dl.value.save_as(p)
    assert json.loads(p.read_text(encoding="utf-8"))["view"]["routeRef"] == "tx:" + tid(5)
    tpage.click("#btnClear"); tpage.click("#btnClear"); settle(tpage)                      # an import into an empty workspace brings its view with it
    assert tpage.evaluate("() => window.__hopline.state.graph.nodes.size") == 0
    tpage.set_input_files("#fileImport", files=[{"name": "ws.json", "mimeType": "application/json", "buffer": p.read_bytes()}])
    tpage.wait_for_function("(id) => window.__hopline.state.routeRef === id", arg="tx:" + tid(5)); settle(tpage)


def test_naming_many_wallets_asks_for_a_second_click_and_can_be_undone(tpage, mock):
    ins = [RIN(90, 0, EX, 9000)] + [RIN(100 + i, 0, addr("d%02d" % i), 1000) for i in range(30)]
    tx(mock, 13, ins, [ROUT(addr("cold"), 30000)])
    open_query(tpage, tid(13))
    load_json(tpage, "list.json", named_list())
    tpage.evaluate("() => window.__hopline.setSel([])"); settle(tpage)
    tpage.evaluate("() => window.__hopline.openFindings('suggest')"); settle(tpage)
    btn = tpage.locator("#anFindings [data-suggest] .relbtn")
    assert "30 addresses" in tpage.locator("#anFindings [data-suggest]").inner_text()
    named = lambda: tpage.evaluate("() => [...window.__hopline.state.graph.nodes.values()].filter((n) => n.type === 'addr' && n.label && /co-spending/.test(n.label)).length")
    btn.click(); settle(tpage)
    assert "Click again to name 30 addresses" in btn.inner_text() and named() == 0, "the first click only asks"
    btn.click(); settle(tpage)
    assert named() == 30
    assert tpage.locator("#toast button", has_text="Undo").count() == 1
    tpage.click("#toast button"); settle(tpage)
    assert named() == 0 and "Took the names back" in tpage.inner_text("#toast")
    assert tpage.locator("#anFindings [data-suggest]").count() == 1, "and the suggestion is back"


# ---- what is loaded but not on screen --------------------------------------------------------------------------------------------------
def more_loaded(page):
    return int(re.search(r"(\d+) more loaded", page.inner_text("#counts")).group(1))


def test_a_chip_says_how_much_is_loaded_but_not_on_screen_and_the_section_lists_what_is_among_it(tpage, mock):
    trace_case(tpage, mock)
    chip = tpage.inner_text("#findStrip [data-key=offscreen]")
    assert chip.startswith("Not on screen"), chip
    assert int(re.search(r"(\d+)$", chip).group(1)) == more_loaded(tpage), "the chip counts what the status line calls more loaded"
    assert tpage.inner_text("#anCount") == "(1)", "it is not a finding: only the change guess is counted"
    assert "known wallets" in tpage.get_attribute("#findStrip [data-key=offscreen]", "title") and "service hand-off" in tpage.get_attribute("#findStrip [data-key=offscreen]", "title")
    tpage.click("#findStrip [data-key=offscreen]"); settle(tpage)
    sec = tpage.locator("#anFindings [data-group=offscreen]")
    assert sec.count() == 1
    text = tpage.inner_text("#anFindings")
    assert "vertices loaded are not on screen" in text and "The findings below are over everything loaded" in text
    assert tpage.locator("#anFindings [data-offscreen=known]").count() == 2, "both named wallets are off screen"
    assert tpage.locator("#anFindings [data-offscreen=handoff]").count() == 1
    assert "Test exchange" in tpage.locator("#anFindings [data-offscreen=handoff]").inner_text()
    shot(tpage, "offscreen.png")


def test_a_row_in_it_brings_its_vertices_into_view_and_the_row_goes(tpage, mock):
    trace_case(tpage, mock)
    before = more_loaded(tpage)
    tpage.click("#findStrip [data-key=offscreen]"); settle(tpage)
    tpage.locator("#anFindings [data-offscreen=handoff]").click(); idle(tpage); settle(tpage)
    assert "addr:" + EX in shown(tpage) and lit(tpage), "the route to the service wallet was shown"
    assert more_loaded(tpage) < before
    assert tpage.locator("#anFindings [data-offscreen=handoff]").count() == 0, "it is on screen now"
    assert tpage.locator("#anFindings [data-offscreen=known]").count() == 1, "only the other named wallet is still off screen"
    chip = tpage.inner_text("#findStrip [data-key=offscreen]")
    assert int(re.search(r"(\d+)$", chip).group(1)) == more_loaded(tpage)


def test_nothing_to_say_when_everything_loaded_is_on_screen(fpage, mock):
    case(mock)
    open_query(fpage, tid(3))
    fpage.uncheck("#focusOn"); settle(fpage)
    assert fpage.locator("#findStrip [data-key=offscreen]").count() == 0
    assert fpage.locator("#anFindings [data-group=offscreen]").count() == 0


def test_the_report_says_how_much_it_leaves_out_and_the_count_is_in_its_evidence(tpage, mock, tmp_path):
    trace_case(tpage, mock)
    left = more_loaded(tpage)
    assert left > 0
    p = make_report(tpage, tmp_path, "left-out.html")
    html = p.read_text(encoding="utf-8")
    assert "<b>Not everything that was loaded is in this report.</b>" in html
    readable = html.split('<script type="application/json"')[0]
    m = re.search(r"Not everything that was loaded is in this report\.</b> ([\d,]+) of the ([\d,]+) vertices", readable)
    assert m and int(m.group(1).replace(",", "")) == left, readable[readable.find("Not everything"):][:300]
    cov = report_evidence(html)["evidence"]["coverage"]
    assert cov["left"] == left and cov["total"] == left + int(m.group(2).replace(",", "")) - left and cov["transactions"] + cov["wallets"] + cov["other"] == left
    r = verify_report(p)
    assert r.returncode == 0 and "OK:" in r.stdout, r.stdout + r.stderr


def test_the_report_has_no_such_line_when_everything_loaded_was_on_screen(fpage, mock, tmp_path):
    case(mock)
    open_query(fpage, tid(3))
    fpage.uncheck("#focusOn"); settle(fpage)
    html = make_report(fpage, tmp_path, "all.html").read_text(encoding="utf-8")
    assert "Not everything that was loaded" not in html
    assert report_evidence(html)["evidence"]["coverage"]["left"] == 0
