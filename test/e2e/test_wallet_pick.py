"""Tick several rows of a wallet's Transactions and act on them together: show them on the graph, as one vertex, select, copy."""
import pytest

from chains import tid
from helpers import idle, open_query, settle
from test_copy import capture, copied
from test_grouping import busy_wallet
from test_trace import shown
from test_wallet_panel import W, W_ID

TXS_OUT = [106, 107, 108]                                         # three payments to three different wallets: rows of their own
TXS_IN = [120, 121]                                               # two ordinary payments in: rows of their own


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def start(page, mock, trace=True):
    busy_wallet(mock)
    open_query(page, W)
    if trace:
        page.click("#layoutSeg [data-layout=trace]"); page.select_option("#traceArrange", "columns"); settle(page)
        page.evaluate("(id) => window.__hopline.setSel([id])", W_ID); settle(page)


def tick(page, *ns):
    for n in ns:
        page.locator("#inspBody .walletsec .rowcopy:has(.linkrow[title^='tx:%s']) .rowtick" % tid(n)).check()


def bar(page):
    return page.inner_text("#inspBody .walletpick")


def buttons(page):
    return page.locator("#inspBody .walletpick .pickacts button").all_inner_texts()


def txs_on(page):
    return {i for i in shown(page) if i.startswith("tx:")}


def test_every_row_has_a_tick_box_and_the_bar_starts_quiet(fpage, mock):
    start(fpage, mock)
    assert fpage.locator("#inspBody .walletsec .rowcopy.tickable .rowtick").count() >= 15
    assert "Tick rows to act on several at once" in bar(fpage) and buttons(fpage) == []
    assert fpage.locator("#inspBody .walletpick .rowtick").count() == 1, "one box ticks everything listed"


def test_ticking_rows_counts_them_and_offers_the_actions_of_a_trace(fpage, mock):
    start(fpage, mock)
    tick(fpage, 106, 107)
    assert "2 ticked" in bar(fpage)
    assert buttons(fpage) == ["Show on graph (2)", "As one vertex", "Copy ids", "Clear"]
    fpage.click("#inspBody .walletpick >> text=Clear")
    assert "Tick rows" in bar(fpage) and buttons(fpage) == []
    assert fpage.locator("#inspBody .walletsec .rowtick:checked").count() == 0


def test_show_on_graph_puts_all_the_ticked_transactions_on_the_trace_in_the_right_direction(fpage, mock):
    start(fpage, mock)
    tick(fpage, 106, 107, 120)
    fpage.click("#inspBody .walletpick >> text=Show on graph (3)"); idle(fpage); settle(fpage)
    assert txs_on(fpage) == {"tx:" + tid(n) for n in (106, 107, 120)}
    px = lambda i: fpage.evaluate("(id) => window.__hopline.renderer.positionOf(id).x", i)
    assert px("tx:" + tid(106)) > px(W_ID) and px("tx:" + tid(107)) > px(W_ID), "what the wallet spent goes forward"
    assert px("tx:" + tid(120)) < px(W_ID), "what paid the wallet comes from behind"
    assert fpage.locator("#inspBody .walletsec .rowtick:checked").count() == 0, "the ticks are used up"
    assert "Tick rows" in bar(fpage)
    for n in (106, 107, 120):
        assert fpage.locator("#inspBody .walletsec .rowcopy:has(.linkrow[title^='tx:%s']) .showbtn" % tid(n)).count() == 0, "no '+ show' on what is shown"
    assert fpage.locator("#inspBody .walletsec .rowcopy:has(.linkrow[title^='tx:%s']) .showbtn" % tid(108)).count() == 1, "the others are untouched"


def test_rows_already_on_the_trace_are_not_counted_again(fpage, mock):
    start(fpage, mock)
    tick(fpage, 106)
    fpage.click("#inspBody .walletpick >> text=Show on graph (1)"); idle(fpage); settle(fpage)
    tick(fpage, 106, 107)
    assert buttons(fpage)[0] == "Show on graph (1)", buttons(fpage)
    fpage.evaluate("(id) => window.__hopline.setSel([id])", W_ID); settle(fpage)
    fpage.click("#inspBody .walletpick >> text=Clear")
    tick(fpage, 106)
    assert buttons(fpage)[0] == "Show on graph (0)"
    assert fpage.is_disabled("#inspBody .walletpick >> text=Show on graph (0)")
    assert fpage.is_disabled("#inspBody .walletpick >> text=As one vertex")


def test_as_one_vertex_folds_the_ticked_ones_into_a_group_per_direction(fpage, mock):
    start(fpage, mock)
    tick(fpage, *TXS_OUT)
    fpage.click("#inspBody .walletpick >> text=As one vertex"); idle(fpage); settle(fpage)
    g = fpage.evaluate("() => [...window.__hopline.state.trace.groups.values()].map(g => [g.dir, g.kind, g.members.length])")
    assert g == [["next", "picked", 3]], g
    assert shown(fpage) == {W_ID, "grp:1"}


def test_as_one_vertex_with_two_directions_makes_a_group_where_it_can_and_shows_the_rest_normally(fpage, mock):
    start(fpage, mock)
    tick(fpage, 106, 107, 120)                                              # two out, one in
    fpage.click("#inspBody .walletpick >> text=As one vertex"); idle(fpage); settle(fpage)
    g = fpage.evaluate("() => [...window.__hopline.state.trace.groups.values()].map(g => [g.dir, g.members.length])")
    assert g == [["next", 2]], g
    assert "tx:" + tid(120) in shown(fpage), "the single one that came in is just shown"


def test_the_group_box_ticks_every_member_even_while_folded_and_goes_half_ticked(fpage, mock):
    start(fpage, mock)
    head_box = fpage.locator("#inspBody .walletsec .groupwrap").filter(has_text="6 transactions to").locator(".rowtick").first
    head_box.check()
    assert "6 ticked" in bar(fpage)
    fpage.click("#inspBody .walletsec .groupwrap >> text=6 transactions to")
    members = fpage.locator("#inspBody .walletsec .groupwrap").filter(has_text="6 transactions to").locator(".groupmembers .rowtick")
    assert members.count() == 6 and all(members.nth(i).is_checked() for i in range(6))
    members.nth(2).uncheck()
    assert "5 ticked" in bar(fpage)
    exch = fpage.locator("#inspBody .walletsec .groupwrap").filter(has_text="6 transactions to").locator(".rowtick").first
    assert exch.evaluate("e => e.indeterminate") is True and not exch.is_checked(), "half-ticked"
    exch.check()
    assert "6 ticked" in bar(fpage)
    fpage.click("#inspBody .walletpick >> text=Show on graph (6)"); idle(fpage); settle(fpage)
    assert txs_on(fpage) == {"tx:" + tid(n) for n in range(100, 106)}


def test_tick_all_listed_follows_the_filter_and_ticks_persist_when_it_changes(fpage, mock):
    start(fpage, mock)
    fpage.click("#inspBody .walletseg [data-dir=in]")
    fpage.locator("#inspBody .walletpick label .rowtick").check()
    assert "18 ticked" in bar(fpage), "every incoming row, including the ones inside groups and the ones only known from an input"
    fpage.click("#inspBody .walletseg [data-dir=out]")
    assert "Tick rows" in bar(fpage), "none of the listed ones is ticked"
    fpage.locator("#inspBody .walletpick label .rowtick").check()
    assert "9 ticked" in bar(fpage)
    fpage.click("#inspBody .walletseg [data-dir=in]")
    assert "18 ticked" in bar(fpage), "the earlier ticks are still there"
    fpage.locator("#inspBody .walletpick label .rowtick").uncheck()
    assert "Tick rows" in bar(fpage)


def test_ticks_survive_a_new_order_and_more_rows_but_not_another_wallet(fpage, mock):
    start(fpage, mock)
    tick(fpage, 106, 120)
    fpage.select_option("#inspBody .walletbar select", "big")
    assert "2 ticked" in bar(fpage)
    fpage.evaluate("(id) => window.__hopline.setSel([id])", "tx:" + tid(106)); settle(fpage)
    fpage.evaluate("(id) => window.__hopline.setSel([id])", W_ID); settle(fpage)
    assert "2 ticked" in bar(fpage), "the same wallet again"
    fpage.evaluate("(id) => window.__hopline.setSel([id])", "addr:bc1qexchxxxxxxxxxxxxxxxx"); settle(fpage)
    fpage.evaluate("(id) => window.__hopline.setSel([id])", W_ID); settle(fpage)
    assert "Tick rows" in bar(fpage), "ticks made on one wallet do not follow you to another"


def test_copy_ids_copies_one_transaction_id_per_line(fpage, mock):
    start(fpage, mock)
    capture(fpage)
    tick(fpage, 106, 121)
    fpage.click("#inspBody .walletpick >> text=Copy ids")
    assert sorted(copied(fpage)[-1].split("\n")) == sorted([tid(106), tid(121)])


def test_outside_a_trace_the_bar_selects_the_ticked_transactions_on_the_graph(fpage, mock):
    start(fpage, mock, trace=False)
    fpage.uncheck("#focusOn"); settle(fpage)
    fpage.evaluate("(id) => window.__hopline.setSel([id])", W_ID); settle(fpage)
    tick(fpage, 106, 107)
    assert buttons(fpage) == ["Show on graph (2)", "Select on graph", "Copy ids", "Clear"], "no trace actions where there is no trace (and no 'As one vertex': a group lives in a trace)"
    fpage.click("#inspBody .walletpick >> text=Select on graph"); settle(fpage)
    assert set(fpage.evaluate("() => [...window.__hopline.state.selected]")) == {"tx:" + tid(106), "tx:" + tid(107)}
    assert "2 selected" in fpage.inner_text("#inspBody")


def test_the_tick_boxes_work_from_the_keyboard(fpage, mock):
    start(fpage, mock)
    box = fpage.locator("#inspBody .walletsec .rowcopy:has(.linkrow[title^='tx:%s']) .rowtick" % tid(106))
    box.focus(); fpage.keyboard.press("Space")
    assert "1 ticked" in bar(fpage)
    fpage.keyboard.press("Space")
    assert "Tick rows" in bar(fpage)
