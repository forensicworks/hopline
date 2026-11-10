"""The balance chart on the wallet page: round axes with dates, a guide line, a warning on the chart with a way to load the rest, and a period to look at (buttons, a dragged selection, the From and To dates)."""
import re

import pytest

from chains import tid
from test_wallet_analysis import funded, over, points
from test_wallet_fiat import prefs, wait_prices
from test_wallet_history import history
from test_wallet_page import goto, wpage  # noqa: F401  (the fixture is used by name)


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def chart(page):
    return page.evaluate("""() => { const c = window.__wallet.chart; return { n: c.pts.length, first: c.pts.length ? c.pts[0].p.txid : null, last: c.pts.length ? c.pts[c.pts.length - 1].p.txid : null,
                                                                   xt: c.xticks, yt: c.yticks, w: c.w }; }""")


def checked(page):
    """Which period button is pressed (None when none is)."""
    return page.evaluate("() => { const b = document.querySelector('#rangeSeg [aria-checked=true]'); return b ? b.dataset.range : null; }")


def everything(page, mock):
    """125 payments, one a day from 1 March 2022 to 3 July 2022, all of them loaded."""
    history(mock, 125); funded(mock, 125)
    goto(page)
    page.click("#chartLoadAll")
    page.wait_for_function("() => document.getElementById('chartBanner').hidden", timeout=60000)
    assert chart(page)["n"] == 125


def drag(page, x0, x1):
    """Drag across the chart from x0 to x1 (in the chart's own pixels)."""
    page.locator("#chart").scroll_into_view_if_needed()
    box = page.locator("#chart").bounding_box(); y = box["y"] + 100
    page.mouse.move(box["x"] + x0, y); page.mouse.down()
    page.mouse.move(box["x"] + (x0 + x1) / 2, y, steps=3); page.mouse.move(box["x"] + x1, y, steps=3); page.mouse.up()


# ---- the axes and the guide line ---------------------------------------------------------------------------------------------------------------

def test_the_axes_have_round_values_and_dates_between_the_ends(wpage, mock):
    history(mock, 25); funded(mock, 25)
    goto(wpage)
    c = chart(wpage)
    xs = [t["x"] for t in c["xt"]]
    assert len(xs) >= 3 and xs == sorted(xs) and all(0 < x < c["w"] for x in xs), c["xt"]
    assert all(re.fullmatch(r"\d{1,2} [A-Z][a-z]{2}|\d\d:\d\d", t["label"]) for t in c["xt"]), c["xt"]
    vals = [float(t["label"]) for t in c["yt"]]
    assert len(vals) >= 3 and vals[0] == 0 and vals == sorted(vals) and vals[-1] >= 0.0055, "from nothing to a round value above the highest balance: %s" % vals
    assert len({round(b - a, 9) for a, b in zip(vals, vals[1:])}) == 1, "an even step: %s" % vals
    ys = [t["y"] for t in c["yt"]]
    assert ys == sorted(ys, reverse=True), "the larger value is higher up"


def test_hovering_draws_a_guide_line_through_the_point(wpage, mock):
    history(mock, 25); funded(mock, 25)
    goto(wpage)
    assert wpage.is_hidden("#chartLine")
    over(wpage, 4)
    wpage.wait_for_selector("#chartLine:not([hidden])")
    got = wpage.evaluate("""() => { const r = (id) => document.getElementById(id).getBoundingClientRect(), c = r('chart'), l = r('chartLine'), d = r('chartDot'), k = window.__wallet.chart, q = k.pts[4];
                                    return { line: l.left - c.left, dotx: d.left + d.width / 2 - c.left, doty: d.top + d.height / 2 - c.top, top: l.top - c.top, height: l.height, T: k.T, ph: k.ph, x: q.x, y: q.y }; }""")
    assert abs(got["line"] - got["x"]) <= 1.5 and abs(got["dotx"] - got["x"]) <= 2.5 and abs(got["doty"] - got["y"]) <= 2.5, got
    assert abs(got["top"] - got["T"]) <= 1 and abs(got["height"] - got["ph"]) <= 1, "the line spans the plot"
    wpage.mouse.move(5, 5)
    assert wpage.is_hidden("#chartLine")


# ---- a history that is only partly loaded ----------------------------------------------------------------------------------------------------

def test_a_partial_history_is_said_on_the_chart_with_a_way_to_load_the_rest(wpage, mock):
    history(mock, 125); funded(mock, 125)
    goto(wpage)
    assert wpage.is_visible("#chartBanner") and wpage.is_visible("#chartLoadAll") and wpage.is_hidden("#chartCancel")
    assert "Only the newest 25 of 125 transactions are loaded" in wpage.inner_text("#chartBanner")
    assert chart(wpage)["n"] == 25
    wpage.click("#chartLoadAll")
    wpage.wait_for_function("() => document.getElementById('chartBanner').hidden", timeout=60000)
    assert chart(wpage)["n"] == 125 and wpage.is_hidden("#chartCancel")


# ---- the period ------------------------------------------------------------------------------------------------------------------------------------

def test_the_period_buttons_show_the_last_month_six_months_year_or_everything(wpage, mock):
    everything(wpage, mock)
    assert checked(wpage) == "all" and wpage.is_hidden("#chartReset") and wpage.inner_text("#chartRange") == ""
    wpage.click('[data-range="1m"]')
    c = chart(wpage)
    assert c["n"] == 31 and c["last"] == tid(224) and checked(wpage) == "1m" and wpage.is_visible("#chartReset")
    assert wpage.inner_text("#chartRange") == "2022-06-03 to 2022-07-03", "counted back from the newest transaction loaded"
    assert float(c["yt"][0]["label"]) > 0, "a period is drawn as close as it needs, not from nothing"
    assert "31 confirmed transactions in this period (of 125 loaded)" in wpage.inner_text("#chartText")
    for key in ("6m", "1y"):
        wpage.click('[data-range="%s"]' % key)
        assert chart(wpage)["n"] == 125 and checked(wpage) == key and wpage.is_hidden("#chartReset"), "the data is shorter than that: it is all there is"
    wpage.click('[data-range="1m"]'); wpage.click("#chartReset")
    assert chart(wpage)["n"] == 125 and checked(wpage) == "all" and wpage.is_hidden("#chartReset")


def test_dragging_across_the_chart_zooms_to_that_period(wpage, mock):
    everything(wpage, mock)
    p = points(wpage)
    drag(wpage, p[20][0] - 2, p[50][0] + 2)
    c = chart(wpage)
    assert (c["n"], c["first"], c["last"]) == (31, tid(120), tid(150)), c
    assert wpage.is_visible("#chartReset") and checked(wpage) is None and wpage.is_hidden("#chartSel")
    assert re.fullmatch(r"2022-03-2\d to 2022-04-\d\d", wpage.inner_text("#chartRange")), wpage.inner_text("#chartRange")
    wpage.wait_for_timeout(300)
    assert wpage.locator("#ledger .tx.flash").count() == 0, "the click that ends a drag does not go looking for a transaction"
    wpage.click("#chartReset")
    assert chart(wpage)["n"] == 125 and checked(wpage) == "all"


def test_a_tiny_movement_is_still_a_click_on_a_point(wpage, mock):
    history(mock, 25); funded(mock, 25)
    goto(wpage)
    x, y = over(wpage, 4)
    wpage.mouse.down(); wpage.mouse.move(x + 3, y); wpage.mouse.up()
    wpage.wait_for_selector('#ledger .tx.flash[data-txid="%s"]' % tid(104))
    assert chart(wpage)["n"] == 25 and wpage.is_hidden("#chartReset")


def test_the_chart_can_follow_the_from_and_to_dates_of_the_list(wpage, mock):
    everything(wpage, mock)
    wpage.fill("#fFrom", "2022-04-01"); wpage.fill("#fTo", "2022-04-30"); wpage.dispatch_event("#fTo", "change")
    assert chart(wpage)["n"] == 125, "the list is filtered; the chart is not, unless it is asked to follow"
    wpage.check("#chartFollow")
    assert chart(wpage)["n"] == 30 and checked(wpage) is None and wpage.inner_text("#chartRange") == "2022-04-01 to 2022-04-30 (the From and To dates)"
    wpage.fill("#fTo", "2022-04-10"); wpage.dispatch_event("#fTo", "change")
    assert chart(wpage)["n"] == 10, "changing the dates changes the chart"
    wpage.click('[data-range="1m"]')
    assert not wpage.is_checked("#chartFollow") and chart(wpage)["n"] == 31, "a button takes the choice back from the dates"
    wpage.check("#chartFollow")
    assert chart(wpage)["n"] == 10
    wpage.uncheck("#chartFollow")
    assert chart(wpage)["n"] == 31 and checked(wpage) == "1m"


def test_a_period_with_no_transaction_shows_the_balance_that_stayed(wpage, mock):
    everything(wpage, mock)
    wpage.check("#chartFollow")
    wpage.fill("#fFrom", "2022-01-01"); wpage.fill("#fTo", "2022-01-31"); wpage.dispatch_event("#fTo", "change")
    assert chart(wpage)["n"] == 0
    assert "No confirmed transaction from 2022-01-01 to 2022-01-31" in wpage.inner_text("#chartText") and "stayed at 0.00000000 BTC" in wpage.inner_text("#chartText")
    wpage.fill("#fFrom", "2022-09-01"); wpage.fill("#fTo", "2022-09-30"); wpage.dispatch_event("#fTo", "change")
    assert chart(wpage)["n"] == 0 and "stayed at 0.09000000 BTC" in wpage.inner_text("#chartText"), wpage.inner_text("#chartText")


def test_a_zoomed_chart_stays_in_the_currency_when_it_is_the_currency_alone(ctx, wpage):
    prefs(ctx, {"currency": "USD", "basis": "each", "show": "fiat", "ref": None})
    goto(wpage); wait_prices(wpage); wpage.wait_for_timeout(300)
    p = points(wpage)
    assert len(p) == 8
    drag(wpage, p[2][0] - 2, p[5][0] + 2)
    text = wpage.inner_text("#chartText")
    assert "in this period" in text and "The axis is in USD" in text, text
    assert all(t["label"].startswith("$") for t in chart(wpage)["yt"]), chart(wpage)["yt"]
