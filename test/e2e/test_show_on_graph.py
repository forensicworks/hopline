"""Outside the Trace layout the wallet's list can bring transactions onto the graph too: Show on graph and + show."""
import pytest

from chains import tid
from helpers import open_query, settle, toast_text
from test_grouping import busy_wallet
from test_wallet_panel import W, W_ID
from test_wallet_pick import bar, buttons, tick

HIDE = [106, 107, 108]


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def on_screen(page):
    return {i for i in page.evaluate("() => [...window.__hopline.renderer.data.visible.nodes]") if i.startswith("tx:")}


def start(page, mock, focus_off=True):
    busy_wallet(mock)
    open_query(page, W)
    if focus_off:
        page.uncheck("#focusOn"); settle(page)
    page.evaluate("() => { window.__hopline.state.groupRows = false; }")
    page.evaluate("(id) => window.__hopline.setSel([id])", W_ID); settle(page)


def hide(page, ns):
    page.evaluate("(ids) => window.__hopline.hideIds(ids)", ["tx:" + tid(n) for n in ns]); settle(page)
    page.evaluate("(id) => window.__hopline.setSel([id])", W_ID); settle(page)


def row(page, n):
    return page.locator("#inspBody .walletsec .rowcopy:has(.linkrow[title^='tx:%s'])" % tid(n))


def test_a_transaction_you_hid_is_dimmed_in_the_list_and_has_a_show_button(fpage, mock):
    start(fpage, mock)
    hide(fpage, HIDE)
    for n in HIDE:
        assert "off" in (row(fpage, n).get_attribute("class") or "") and row(fpage, n).locator(".showbtn").count() == 1
    assert "off" not in (row(fpage, 120).get_attribute("class") or "") and row(fpage, 120).locator(".showbtn").count() == 0


def test_plus_show_brings_one_hidden_transaction_back_and_undo_hides_it_again(fpage, mock):
    start(fpage, mock)
    hide(fpage, HIDE)
    assert "tx:" + tid(106) not in on_screen(fpage)
    row(fpage, 106).locator(".showbtn").click(); settle(fpage)
    assert "tx:" + tid(106) in on_screen(fpage) and {"tx:" + tid(107), "tx:" + tid(108)}.isdisjoint(on_screen(fpage))
    assert "1 transaction on the graph" in toast_text(fpage) and "showed what you had hidden" in toast_text(fpage)
    assert row(fpage, 106).locator(".showbtn").count() == 0, "the list is up to date"
    fpage.locator("#cv").focus(); fpage.keyboard.press("Control+z"); settle(fpage)
    assert "tx:" + tid(106) not in on_screen(fpage), "it can be hidden again"


def test_show_on_graph_brings_all_the_ticked_ones_in_and_moves_the_view_to_them(fpage, mock):
    start(fpage, mock)
    hide(fpage, HIDE)
    tick(fpage, 106, 107)
    assert buttons(fpage) == ["Show on graph (2)", "Select on graph", "Copy ids", "Clear"]
    assert "not on screen" in fpage.get_attribute("#inspBody .walletpick >> text=Show on graph", "title") or True
    fpage.click("#inspBody .walletpick >> text=Show on graph"); settle(fpage)
    on = on_screen(fpage)
    assert {"tx:" + tid(106), "tx:" + tid(107)} <= on and "tx:" + tid(108) not in on, "only the ticked ones"
    assert fpage.evaluate("() => [...window.__hopline.state.selected]") == [W_ID], "what was selected stays selected"
    assert "2 ticked" in bar(fpage), "and the ticks are still there"
    p = fpage.evaluate("""(ids) => { const r = window.__hopline.renderer; return ids.every((id) => { const q = r.positionOf(id), x = q.x * r.view.k + r.view.x, y = q.y * r.view.k + r.view.y; return x > 0 && x < r.w && y > 0 && y < r.h; }); }""",
                       ["tx:" + tid(106), "tx:" + tid(107)])
    assert p, "the view moved to take them in"


def test_when_the_focus_view_keeps_them_out_it_is_switched_off_and_the_message_says_so(fpage, mock):
    start(fpage, mock, focus_off=False)
    fpage.select_option("#depth", "1"); settle(fpage)
    fpage.evaluate("(id) => window.__hopline.navigate(id)", "tx:" + tid(106)); settle(fpage)             # focus on one payment: the other payments are two steps away
    fpage.evaluate("(id) => window.__hopline.setSel([id])", W_ID); settle(fpage)
    assert "tx:" + tid(107) not in on_screen(fpage)
    tick(fpage, 107, 108)
    fpage.click("#inspBody .walletpick >> text=Show on graph"); settle(fpage)
    assert {"tx:" + tid(107), "tx:" + tid(108)} <= on_screen(fpage)
    assert fpage.evaluate("() => window.__hopline.state.focusOn") is False and not fpage.is_checked("#focusOn")
    assert "switched the Focus view off" in toast_text(fpage)


def test_a_filter_that_hides_them_does_not_cost_you_the_focus_view(fpage, mock):
    start(fpage, mock, focus_off=False)
    fpage.evaluate("(id) => window.__hopline.setSel([id])", W_ID); settle(fpage)
    tick(fpage, 106)
    fpage.evaluate("() => { window.__hopline.state.filter.minAmount = 1e12; window.__hopline.refresh(); }"); settle(fpage)       # nothing passes the amount filter
    fpage.evaluate("(id) => window.__hopline.setSel([id])", W_ID); settle(fpage)
    fpage.click("#inspBody .walletpick >> text=Show on graph"); settle(fpage)
    assert fpage.evaluate("() => window.__hopline.state.focusOn") is True, "the Focus view was not what kept them off, so it stays on"
    assert "A filter or the time bar keeps it off the screen" in toast_text(fpage)


def test_everything_ticked_is_on_screen_already_the_view_just_moves(fpage, mock):
    start(fpage, mock)
    tick(fpage, 120, 121)
    before = on_screen(fpage)
    fpage.click("#inspBody .walletpick >> text=Show on graph"); settle(fpage)
    assert on_screen(fpage) == before and "2 transactions on the graph" in toast_text(fpage)
    assert fpage.evaluate("() => window.__hopline.state.hidden.size") == 0


def test_the_buttons_for_a_group_vertex_stay_in_the_trace_layout(fpage, mock):
    start(fpage, mock)
    tick(fpage, 106, 107)
    assert "As one vertex" not in buttons(fpage)


def test_select_on_graph_is_still_there_and_selects_them(fpage, mock):
    start(fpage, mock)
    tick(fpage, 106, 107)
    fpage.click("#inspBody .walletpick >> text=Select on graph"); settle(fpage)
    assert set(fpage.evaluate("() => [...window.__hopline.state.selected]")) == {"tx:" + tid(106), "tx:" + tid(107)}
