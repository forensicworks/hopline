"""Arrows in the Trace layout when many vertices wait behind them: ask which, step a few at a time, summarise on hover."""
import pytest

from helpers import click_node, idle, open_query, settle, xy
from test_trace import click_handle, handle, many_outputs, shown
from test_wallet_panel import W, W_ID, wallet


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def trace_of(page, mock, n):
    tx, outs = many_outputs(mock, n)
    open_query(page, tx[3:])
    page.click("#layoutSeg [data-layout=trace]"); settle(page)
    return tx


def handle_xy(page, id_, dir_):
    return page.evaluate("""([id, d]) => { const r = window.__orion.renderer, h = r.handleRects.find(x => x.id === id && x.dir === d);
        const b = r.canvas.getBoundingClientRect(); return { x: b.left + h.x + h.w / 2, y: b.top + h.y + h.h / 2 }; }""", [id_, dir_])


def ticked(page):
    return page.eval_on_selector_all("#ctxMenu .chooserrow", "rows => rows.filter(r => !r.hidden && r.querySelector('input').checked).map(r => r.querySelector('.what').firstChild.textContent)")


def listed(page):
    return page.locator("#ctxMenu .chooserrow:not([hidden])").count()


def open_limits(page):
    page.evaluate("() => { [...document.querySelectorAll('details')].find(d => d.querySelector('summary').textContent.trim() === 'Expansion limits').open = true; }")


def test_up_to_the_step_size_an_arrow_just_shows_everything(fpage, mock):
    tx = trace_of(fpage, mock, 5)
    click_handle(fpage, tx, "right"); idle(fpage)
    assert fpage.is_hidden("#ctxMenu") and len(shown(fpage)) == 6


def test_more_than_the_step_size_opens_the_list_and_shows_nothing_yet(fpage, mock):
    tx = trace_of(fpage, mock, 6)
    click_handle(fpage, tx, "right"); idle(fpage)
    assert fpage.is_visible("#ctxMenu .chooser") and shown(fpage) == {tx}
    assert "6 hidden" in fpage.inner_text("#ctxMenu").lower()
    assert listed(fpage) == 6 and len(ticked(fpage)) == 5, "the five largest are ticked"
    assert fpage.inner_text("#ctxMenu .chooserfoot .primary") == "Show 5 ticked"
    assert "BTC in total" in fpage.inner_text("#ctxMenu") and "largest" in fpage.inner_text("#ctxMenu")


def test_show_five_then_the_next_five_then_the_rest_without_asking(fpage, mock):
    tx = trace_of(fpage, mock, 12)
    click_handle(fpage, tx, "right"); idle(fpage)
    fpage.click("#ctxMenu .chooserfoot .primary"); idle(fpage); settle(fpage)
    got = shown(fpage) - {tx}
    assert got == {"addr:bc1qchoose%03d" % i for i in range(5)}, "the five largest"
    assert handle(fpage, tx, "right")["label"] == "7"
    click_handle(fpage, tx, "right"); idle(fpage)
    assert listed(fpage) == 7 and len(ticked(fpage)) == 5, "the list now holds only what is still hidden, again with five ticked"
    fpage.click("#ctxMenu .chooserfoot .primary"); idle(fpage); settle(fpage)
    assert len(shown(fpage)) == 11 and handle(fpage, tx, "right")["label"] == "2"
    click_handle(fpage, tx, "right"); idle(fpage)
    assert fpage.is_hidden("#ctxMenu") and len(shown(fpage)) == 13, "two are not many: they are just shown"


def test_the_list_opens_beside_the_arrow_that_was_clicked(fpage, mock):
    tx = trace_of(fpage, mock, 12)
    p = handle_xy(fpage, tx, "right")
    click_handle(fpage, tx, "right"); idle(fpage)
    box = fpage.locator("#ctxMenu").bounding_box()
    assert abs(box["x"] - p["x"]) < 120 and abs(box["y"] - p["y"]) < 320, (box, p)


def test_hovering_an_arrow_gives_the_count_the_total_and_the_dates(fpage, mock):
    tx = trace_of(fpage, mock, 12)
    p = handle_xy(fpage, tx, "right")
    fpage.mouse.move(p["x"], p["y"])
    tip = fpage.evaluate("() => window.__orion.renderer.canvas.title")
    assert "Click to choose which: the top 5 come ticked" in tip, tip
    assert "12 outputs" in tip and "BTC in total" in tip and "largest 0.00100000 BTC" in tip and "2022-04-" in tip, tip
    left = handle_xy(fpage, tx, "left")
    fpage.mouse.move(left["x"], left["y"])
    assert "1 input" in fpage.evaluate("() => window.__orion.renderer.canvas.title")


def test_for_a_wallet_the_hover_counts_transactions(fpage, mock):
    wallet(mock)
    open_query(fpage, W)
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    p = handle_xy(fpage, W_ID, "right")
    fpage.mouse.move(p["x"], p["y"])
    tip = fpage.evaluate("() => window.__orion.renderer.canvas.title")
    assert "9 transactions" in tip and "BTC in total" in tip, tip


def test_the_wallets_list_names_the_other_side_and_sorts_by_date(fpage, mock):
    wallet(mock)
    open_query(fpage, W)
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    click_handle(fpage, W_ID, "right"); idle(fpage)
    assert fpage.is_visible("#ctxMenu .chooser") and listed(fpage) == 9, "the nine transactions that spent from the wallet"
    assert "to bc1q" in fpage.inner_text("#ctxMenu .chooserrow >> nth=0"), "who would be paid, not just a transaction id"
    fpage.select_option("#ctxMenu .choosertools select", "new")
    assert "7a7a7a" in fpage.inner_text("#ctxMenu .chooserrow:not([hidden]) >> nth=0"), "the newest transaction first"
    fpage.select_option("#ctxMenu .choosertools select", "old")
    assert "646464" in fpage.inner_text("#ctxMenu .chooserrow:not([hidden]) >> nth=0"), "the oldest first"
    assert fpage.is_visible("#ctxMenu"), "changing the order does not close the list"


def test_the_list_can_be_narrowed_by_amount_and_by_date(fpage, mock):
    tx = trace_of(fpage, mock, 40)
    click_handle(fpage, tx, "right"); idle(fpage)
    fpage.fill("#ctxMenu .choosertools input[type=text]", "0.000999")
    assert listed(fpage) == 15 and "15 of 40 match" in fpage.inner_text("#ctxMenu"), "100000 - 7 i >= 99900 for i <= 14"
    assert len(ticked(fpage)) == 5
    fpage.click("#ctxMenu .chooserfoot >> text=All")
    assert fpage.inner_text("#ctxMenu .chooserfoot .primary") == "Show 15 ticked", "All means everything listed, not what was filtered out"
    fpage.fill("#ctxMenu .choosertools input[type=text]", "")
    assert listed(fpage) == 40
    fpage.fill("#ctxMenu .choosertools input[type=date] >> nth=0", "2030-01-01")
    assert listed(fpage) == 0 and "0 of 40 match" in fpage.inner_text("#ctxMenu")
    assert fpage.is_disabled("#ctxMenu .chooserfoot .primary")
    fpage.fill("#ctxMenu .choosertools input[type=date] >> nth=0", "")
    fpage.fill("#ctxMenu .choosertools input[type=date] >> nth=1", "2022-04-13")
    assert listed(fpage) == 0, "everything happened on 2022-04-14, after that day"
    fpage.fill("#ctxMenu .choosertools input[type=date] >> nth=1", "2022-04-30")
    assert listed(fpage) == 40


def test_top_all_and_none_buttons(fpage, mock):
    tx = trace_of(fpage, mock, 12)
    click_handle(fpage, tx, "right"); idle(fpage)
    fpage.click("#ctxMenu .chooserfoot >> text=All"); assert len(ticked(fpage)) == 12
    fpage.click("#ctxMenu .chooserfoot >> text=None"); assert ticked(fpage) == [] and fpage.is_disabled("#ctxMenu .chooserfoot .primary")
    fpage.click("#ctxMenu .chooserfoot >> text=Top 5"); assert len(ticked(fpage)) == 5


def test_the_list_is_keyboard_friendly(fpage, mock):
    tx = trace_of(fpage, mock, 12)
    click_handle(fpage, tx, "right"); idle(fpage)
    assert fpage.evaluate("() => document.activeElement.type") == "checkbox"
    first = fpage.evaluate("() => document.activeElement.closest('label').textContent")
    fpage.keyboard.press("ArrowDown")
    assert fpage.evaluate("() => document.activeElement.closest('label').textContent") != first, "the arrow keys move between the rows"
    fpage.keyboard.press("Space")
    fpage.keyboard.press("Tab")
    assert fpage.is_visible("#ctxMenu"), "Tab moves on inside the list instead of closing it"
    fpage.keyboard.press("Escape")
    assert fpage.is_hidden("#ctxMenu") and shown(fpage) == {tx}


def test_double_click_and_the_bracket_keys_ask_too(fpage, mock):
    tx = trace_of(fpage, mock, 12)
    click_node(fpage, tx, dbl=True); idle(fpage)
    assert fpage.is_visible("#ctxMenu .chooser") and shown(fpage) == {tx}
    fpage.keyboard.press("Escape")
    fpage.evaluate("(id) => window.__orion.setSel([id])", tx); settle(fpage)
    fpage.locator("#cv").focus(); fpage.keyboard.press("]"); idle(fpage)
    assert fpage.is_visible("#ctxMenu .chooser")
    box = fpage.locator("#ctxMenu").bounding_box(); p = xy(fpage, tx)
    assert abs(box["x"] - p["x"]) < 120 and abs(box["y"] - p["y"]) < 330, "beside the vertex, not in a corner"


def test_the_buttons_in_the_details_and_the_menu_ask_as_well(fpage, mock):
    tx = trace_of(fpage, mock, 12)
    fpage.evaluate("(id) => window.__orion.setSel([id])", tx); settle(fpage)
    fpage.click("#inspBody button:has-text('Show forward')"); idle(fpage)
    assert fpage.is_visible("#ctxMenu .chooser") and shown(fpage) == {tx}
    fpage.keyboard.press("Escape")
    p = xy(fpage, tx); fpage.mouse.click(p["x"], p["y"], button="right")
    fpage.click("#ctxMenu >> text=Show forward ▶"); idle(fpage)
    assert fpage.is_visible("#ctxMenu .chooser")


def test_show_a_few_at_a_time_mode_needs_no_list(fpage, mock):
    tx = trace_of(fpage, mock, 12)
    open_limits(fpage)
    fpage.select_option("#stepMode", "batch")
    click_handle(fpage, tx, "right"); idle(fpage); settle(fpage)
    assert fpage.is_hidden("#ctxMenu") and shown(fpage) - {tx} == {"addr:bc1qchoose%03d" % i for i in range(5)}
    assert handle(fpage, tx, "right")["label"] == "7"
    assert "Click shows the largest 5; click again for the next." in handle(fpage, tx, "right")["tip"]
    click_handle(fpage, tx, "right"); idle(fpage); settle(fpage)
    assert len(shown(fpage)) == 11, "the next five"


def test_show_everything_mode_is_the_old_behaviour(fpage, mock):
    tx = trace_of(fpage, mock, 12)
    open_limits(fpage)
    fpage.select_option("#stepMode", "all")
    click_handle(fpage, tx, "right"); idle(fpage); settle(fpage)
    assert fpage.is_hidden("#ctxMenu") and len(shown(fpage)) == 13
    open_limits(fpage)


def test_the_size_of_a_step_is_a_setting_with_sane_limits(fpage, mock):
    tx = trace_of(fpage, mock, 6)
    open_limits(fpage)
    fpage.fill("#stepSize", "6"); fpage.dispatch_event("#stepSize", "change")
    click_handle(fpage, tx, "right"); idle(fpage); settle(fpage)
    assert fpage.is_hidden("#ctxMenu") and len(shown(fpage)) == 7, "six is not more than six"
    fpage.fill("#stepSize", "0"); fpage.dispatch_event("#stepSize", "change")
    assert fpage.input_value("#stepSize") == "1"
    fpage.fill("#stepSize", "999"); fpage.dispatch_event("#stepSize", "change")
    assert fpage.input_value("#stepSize") == "50"
    fpage.fill("#stepSize", ""); fpage.dispatch_event("#stepSize", "change")
    assert fpage.input_value("#stepSize") == "5"


def test_the_two_settings_are_remembered(fpage):
    open_limits(fpage)
    assert fpage.input_value("#stepMode") == "ask" and fpage.input_value("#stepSize") == "5"
    fpage.select_option("#stepMode", "batch"); fpage.fill("#stepSize", "8"); fpage.dispatch_event("#stepSize", "change")
    fpage.reload(); fpage.wait_for_function("window.__orion && window.__orion.renderer")
    assert fpage.input_value("#stepMode") == "batch" and fpage.input_value("#stepSize") == "8"
    assert fpage.evaluate("() => [window.__orion.state.stepMode, window.__orion.state.stepSize]") == ["batch", 8]


def test_the_list_never_runs_markup_from_an_address_label(fpage, mock):
    tx = trace_of(fpage, mock, 12)
    fpage.evaluate("(id) => { window.__orion.state.graph.nodes.get(id).label = '<img src=x onerror=window.__pwned=1>'; }", "addr:bc1qchoose000")
    click_handle(fpage, tx, "right"); idle(fpage)
    assert fpage.evaluate("() => window.__pwned") is None and fpage.locator("#ctxMenu img").count() == 0
    assert "<img src=x" in fpage.inner_text("#ctxMenu")


def test_smallest_first_is_an_order_and_the_top_few_follow_it(fpage, mock):
    tx = trace_of(fpage, mock, 12)
    click_handle(fpage, tx, "right"); idle(fpage)
    assert fpage.eval_on_selector_all("#ctxMenu .choosertools select >> nth=0 >> option", "os => os.map(o => o.textContent)") == ["Largest first", "Smallest first", "Newest first", "Oldest first", "Known or labelled first"]
    fpage.select_option("#ctxMenu .choosertools select", "small")
    first = fpage.eval_on_selector_all("#ctxMenu .chooserrow", "rows => rows.map(r => r.querySelector('.amt').textContent)")
    amounts = [float(a.split()[0]) for a in first]
    assert amounts == sorted(amounts), "the smallest at the top"
    fpage.click("#ctxMenu .chooserfoot >> text=Top 5")
    fpage.click("#ctxMenu .chooserfoot .primary"); idle(fpage); settle(fpage)
    got = shown(fpage) - {tx}
    assert got == {"addr:bc1qchoose%03d" % i for i in range(7, 12)}, "the five smallest were shown: " + str(sorted(got))


def test_the_order_is_remembered_the_next_time_the_list_opens_and_after_a_reload(fpage, mock):
    tx = trace_of(fpage, mock, 12)
    click_handle(fpage, tx, "right"); idle(fpage)
    assert fpage.input_value("#ctxMenu .choosertools select") == "big", "largest first to begin with"
    fpage.select_option("#ctxMenu .choosertools select", "old")
    fpage.keyboard.press("Escape")
    click_handle(fpage, tx, "right"); idle(fpage)
    assert fpage.input_value("#ctxMenu .choosertools select") == "old", "the order of last time"
    fpage.select_option("#ctxMenu .choosertools select", "small")
    fpage.keyboard.press("Escape")
    fpage.reload(); fpage.wait_for_function("window.__orion && window.__orion.renderer")
    assert fpage.evaluate("() => window.__orion.state.chooseSort") == "small"
    if fpage.evaluate("() => window.__orion.state.layout") != "trace":                  # the saved session comes back with its graph; open the trace again if it is not showing
        fpage.click("#layoutSeg [data-layout=trace]")
    settle(fpage)
    click_handle(fpage, tx, "right"); idle(fpage)
    assert fpage.input_value("#ctxMenu .choosertools select") == "small"
    assert fpage.evaluate("() => [...document.querySelectorAll('#ctxMenu .chooserrow')].slice(0, 5).every(r => r.querySelector('input').checked)"), "the ticked ones are the first five in that order"
    amounts = [float(a.split()[0]) for a in fpage.eval_on_selector_all("#ctxMenu .chooserrow .amt", "els => els.map(e => e.textContent)")]
    assert amounts == sorted(amounts)

