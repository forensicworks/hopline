"""The wallet chart's "Filter the list to this period": it sets the From and To (date and time, UTC) under Transactions to the period the chart shows, so the list holds exactly that period."""
import pytest

from chains import tid
from test_wallet_analysis import points
from test_wallet_chart_more import over_bar
from test_wallet_chart_range import checked, chart, drag, everything, wpage  # noqa: F401  (the fixture is used by name)


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def fields(page):
    """The four fields: From date, From time, To date, To time (a time left empty means the whole day)."""
    return page.input_value("#fFrom"), page.input_value("#fFromTime"), page.input_value("#fTo"), page.input_value("#fToTime")


def listed(page):
    return page.eval_on_selector_all("#ledger .tx", "els => els.map(e => e.dataset.txid)")


def chart_txids(page):
    return page.evaluate("() => window.__wallet.chart.pts.map((q) => q.p.txid)")


# ---- when it is offered ------------------------------------------------------------------------------------------------------------------------------

def test_it_is_offered_only_while_the_chart_shows_a_period_of_its_own(wpage, mock):
    everything(wpage, mock)
    assert wpage.is_hidden("#chartFilter"), "all of the history: the list already has it"
    wpage.click('[data-range="6m"]')
    assert wpage.is_hidden("#chartFilter"), "six months is more than the history holds: still all of it"
    wpage.click('[data-range="1m"]')
    assert wpage.is_visible("#chartFilter") and wpage.inner_text("#chartFilter") == "Filter the list to this period"
    wpage.click("#chartReset")
    assert wpage.is_hidden("#chartFilter")


def test_it_is_not_offered_while_the_chart_follows_the_from_and_to_dates(wpage, mock):
    everything(wpage, mock)
    wpage.click('[data-range="1m"]')
    assert wpage.is_visible("#chartFilter")
    wpage.fill("#fFrom", "2022-04-01")
    wpage.check("#chartFollow")
    wpage.wait_for_function("() => /the From and To dates/.test(document.getElementById('chartRange').textContent)")
    assert wpage.is_hidden("#chartFilter"), "the chart already follows the list"
    wpage.uncheck("#chartFollow")
    assert wpage.is_visible("#chartFilter")


# ---- what it does ------------------------------------------------------------------------------------------------------------------------------------

def test_a_period_button_then_the_filter_gives_the_list_of_that_period(wpage, mock):
    everything(wpage, mock)
    wpage.click('[data-range="1m"]')
    assert chart(wpage)["n"] == 31 and wpage.inner_text("#chartRange") == "2022-06-03 to 2022-07-03"
    assert fields(wpage) == ("", "", "", "") and wpage.locator("#ledger .tx").count() == 100, "the list is not filtered yet"
    wpage.click("#chartFilter")
    assert fields(wpage) == ("2022-06-03", "12:00:00", "2022-07-03", "12:00:00"), "the period's own moments, to the second"
    assert wpage.locator("#ledger .tx").count() == 31 and "31 of 125 loaded match" in wpage.inner_text("#fCount") and wpage.is_visible("#fClear")
    assert set(chart_txids(wpage)) == set(listed(wpage)), "the same transactions as the chart's period"
    assert checked(wpage) == "1m", "the chart stays where it was"


def test_a_dragged_period_gives_exactly_what_the_chart_shows(wpage, mock):
    everything(wpage, mock)
    p = points(wpage)
    drag(wpage, p[20][0] - 2, p[50][0] + 2)
    on_chart = chart_txids(wpage)
    assert 25 <= len(on_chart) <= 35 and wpage.is_visible("#chartFilter")
    wpage.click("#chartFilter")
    assert listed(wpage) == on_chart[::-1], "the same transactions, no more and no fewer (the list is newest first, the chart oldest first)"
    a, at, b, bt = fields(wpage)
    assert len(a) == 10 == len(b) and len(at) == 8 == len(bt), "date and time to the second at both ends"


def test_a_bar_zoomed_to_one_day_gives_that_day_only(wpage, mock):
    everything(wpage, mock)
    over_bar(wpage, 60)
    wpage.mouse.down(); wpage.mouse.up()
    assert wpage.inner_text("#chartRange") == "2022-04-30 to 2022-04-30" and wpage.is_visible("#chartFilter")
    wpage.click("#chartFilter")
    assert fields(wpage) == ("2022-04-30", "", "2022-04-30", ""), "a whole day: the times stay empty"
    assert listed(wpage) == [tid(160)], "the one transaction of that day, and not the next day's"


def test_the_search_and_the_amount_limits_stay_as_they_were(wpage, mock):
    everything(wpage, mock)
    wpage.fill("#fMax", "0.0011")                                                          # 110,000 sat or less: the payments up to the 101st
    wpage.wait_for_timeout(400)
    assert "101 of 125 loaded match" in wpage.inner_text("#fCount"), "the cards are drawn 100 at a time; the count is of all that match"
    wpage.click('[data-range="1m"]')
    wpage.click("#chartFilter")
    assert wpage.input_value("#fMax") == "0.0011"
    assert wpage.locator("#ledger .tx").count() == 7 and "7 of 125 loaded match" in wpage.inner_text("#fCount"), "the period (31 transactions) and the limit (up to the 101st) together"


def test_resetting_the_zoom_does_not_undo_the_filter(wpage, mock):
    everything(wpage, mock)
    wpage.click('[data-range="1m"]'); wpage.click("#chartFilter")
    wpage.click("#chartReset")
    assert wpage.is_hidden("#chartFilter") and chart(wpage)["n"] == 125
    assert wpage.locator("#ledger .tx").count() == 31, "the list is the list's own until Clear"
    wpage.click("#fClear")
    assert fields(wpage) == ("", "", "", "") and wpage.locator("#ledger .tx").count() == 100


# ---- already done --------------------------------------------------------------------------------------------------------------------------------------

def test_the_button_says_what_it_will_set_and_is_greyed_out_once_the_list_has_those_days(wpage, mock):
    everything(wpage, mock)
    wpage.click('[data-range="1m"]')
    title = wpage.get_attribute("#chartFilter", "title")
    assert "2022-06-03 12:00:00 and 2022-07-03 12:00:00" in title and "UTC" in title and wpage.is_enabled("#chartFilter"), title
    wpage.click("#chartFilter")
    assert wpage.is_disabled("#chartFilter") and "already shows exactly this period" in wpage.get_attribute("#chartFilter", "title")
    wpage.fill("#fFrom", "2022-06-10")
    assert wpage.is_enabled("#chartFilter"), "the list was changed by hand: the button can set it back"
    wpage.click("#chartFilter")
    assert fields(wpage) == ("2022-06-03", "12:00:00", "2022-07-03", "12:00:00") and wpage.is_disabled("#chartFilter")
    wpage.fill("#fToTime", "12:00:01")
    assert wpage.is_enabled("#chartFilter"), "one second of difference is a difference"
    wpage.click("#fClear")
    assert wpage.is_enabled("#chartFilter")


def test_the_list_is_brought_into_view(wpage, mock):
    everything(wpage, mock)
    wpage.click('[data-range="1m"]')
    wpage.click("#chartFilter")
    wpage.wait_for_timeout(300)
    inside = wpage.evaluate("() => { const r = document.getElementById('ledgerTools').getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; }")
    assert inside, "the filter bar, with the count, is on screen"
