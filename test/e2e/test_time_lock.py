"""Where x is time, a transaction is dragged up and down only (Shift frees it) and says so; wallets move freely."""
import pytest

from chains import addr, peel_chain, tid
from helpers import click_node, idle, open_query, settle, xy
from test_arrange_select import arrange, drag, pos, traced

TX = "tx:" + tid(11)


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def screen(page, id_):
    p = xy(page, id_)
    return [p["x"], p["y"]]


def test_a_new_trace_starts_in_columns(tpage, mock):
    peel_chain(mock, 4)
    open_query(tpage, tid(10)); settle(tpage)
    assert tpage.evaluate("() => window.__hopline.state.arrange") == "columns" and tpage.input_value("#traceArrange") == "columns"
    assert tpage.evaluate("() => window.__hopline.renderer.data.axis.mode") == "marks", "timestamps along the top, not a time scale"
    arrange(tpage, "timeforce")
    tpage.click("#btnClear"); tpage.click("#btnClear"); settle(tpage)
    assert tpage.evaluate("() => window.__hopline.state.arrange") == "columns", "clearing starts again from Columns"


def test_a_session_saved_in_columns_comes_back_in_columns(tpage, mock):
    peel_chain(mock, 4)
    open_query(tpage, tid(10))
    arrange(tpage, "columns")
    tpage.wait_for_timeout(1100)
    tpage.reload(); tpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    tpage.click("#restoreYes"); tpage.wait_for_function("() => window.__hopline.state.graph.nodes.size > 0"); settle(tpage)
    assert tpage.evaluate("() => window.__hopline.state.arrange") == "columns" and tpage.input_value("#traceArrange") == "columns"


def test_a_transaction_moves_up_and_down_only_in_timeline_plus_force(tpage, mock):
    traced(tpage, mock, hops=3, arrangement="timeforce")
    assert tpage.evaluate("() => window.__hopline.state.arrange") == "timeforce"
    a = screen(tpage, TX)
    drag(tpage, a, [a[0] + 70, a[1] + 90]); settle(tpage)
    b = screen(tpage, TX)
    assert abs(b[0] - a[0]) < 1, "it stays where its time is"
    assert abs(b[1] - a[1] - 90) < 4, "and follows the pointer up and down"


def test_shift_lets_a_transaction_move_sideways_too(tpage, mock):
    traced(tpage, mock, hops=3, arrangement="timeforce")
    a = screen(tpage, TX)
    drag(tpage, a, [a[0] + 70, a[1] + 60], shift=True); settle(tpage)
    b = screen(tpage, TX)
    assert abs(b[0] - a[0] - 70) < 4 and abs(b[1] - a[1] - 60) < 4


@pytest.mark.parametrize("name", ["timeline", "timeamount"])
def test_the_other_time_arrangements_hold_a_transaction_to_its_time_as_well(tpage, mock, name):
    traced(tpage, mock, hops=3, arrangement="timeforce")
    arrange(tpage, name)
    a = screen(tpage, TX)
    drag(tpage, a, [a[0] + 70, a[1] + 50]); settle(tpage)
    assert abs(screen(tpage, TX)[0] - a[0]) < 1


def test_the_timeline_layout_holds_a_transaction_to_its_time_too(tpage, mock):
    traced(tpage, mock, hops=3, arrangement="timeforce")
    tpage.click("#layoutSeg [data-layout=timeline]"); idle(tpage); settle(tpage)
    a = screen(tpage, TX)
    drag(tpage, a, [a[0] + 70, a[1] + 50]); settle(tpage)
    assert abs(screen(tpage, TX)[0] - a[0]) < 1


def test_a_wallet_has_no_time_and_moves_anywhere(tpage, mock):
    traced(tpage, mock, hops=3, arrangement="timeforce")
    wallet = "addr:" + addr("peel11")
    assert wallet in tpage.evaluate("() => [...window.__hopline.renderer.data.visible.nodes]")
    a = screen(tpage, wallet)
    drag(tpage, a, [a[0] + 60, a[1] + 70]); settle(tpage)
    b = screen(tpage, wallet)
    assert abs(b[0] - a[0] - 60) < 4 and abs(b[1] - a[1] - 70) < 4, "both ways, no Shift needed"


def test_columns_are_not_time_so_nothing_is_held(tpage, mock):
    traced(tpage, mock, hops=3, arrangement="timeforce")
    arrange(tpage, "columns")
    a = screen(tpage, TX)
    drag(tpage, a, [a[0] + 70, a[1] + 40]); settle(tpage)
    b = screen(tpage, TX)
    assert abs(b[0] - a[0] - 70) < 4


def test_clicking_a_transaction_says_how_to_move_it_once_and_the_details_say_it_every_time(tpage, mock):
    traced(tpage, mock, hops=3, arrangement="timeforce")
    assert not tpage.evaluate("() => window.__hopline.state.moveHinted")
    click_node(tpage, TX); settle(tpage)
    assert "Hold Shift to move it sideways" in tpage.inner_text("#toast") and tpage.is_visible("#toast")
    assert "up and down only" in tpage.inner_text("#inspBody") and tpage.locator("#inspBody .movehint").count() == 1
    tpage.evaluate("() => { document.getElementById('toast').hidden = true; }")
    click_node(tpage, "tx:" + tid(12)); settle(tpage)
    assert tpage.is_hidden("#toast"), "the toast is not repeated"
    assert tpage.locator("#inspBody .movehint").count() == 1, "but the details panel always says it"


def test_no_hint_for_a_wallet_or_in_columns(tpage, mock):
    traced(tpage, mock, hops=3, arrangement="timeforce")
    tpage.evaluate("() => { document.getElementById('toast').hidden = true; }")                 # what the expansion said
    click_node(tpage, "addr:" + addr("peel11")); settle(tpage)
    assert "Hold Shift" not in tpage.inner_text("#toast") and tpage.locator("#inspBody .movehint").count() == 0 and not tpage.evaluate("() => window.__hopline.state.moveHinted")
    arrange(tpage, "columns")
    click_node(tpage, TX); settle(tpage)
    assert tpage.locator("#inspBody .movehint").count() == 0 and "Hold Shift" not in tpage.inner_text("#toast") and not tpage.evaluate("() => window.__hopline.state.moveHinted")


def test_re_layout_puts_a_dragged_transaction_back_on_its_time(tpage, mock):
    traced(tpage, mock, hops=3, arrangement="timeforce")
    home = pos(tpage, TX)
    a = screen(tpage, TX)
    drag(tpage, a, [a[0], a[1] + 120]); settle(tpage)
    assert pos(tpage, TX) != home
    tpage.click("#btnRelayout"); idle(tpage); settle(tpage)
    assert pos(tpage, TX) == home
