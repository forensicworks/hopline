"""The From and To of the wallet's transaction list take a time of day (UTC) as well as a date: to the second, both ends included, and a field with no time is the whole day as before."""
import pytest

from chains import tid
from test_wallet_analysis import funded
from test_wallet_chart_range import chart
from test_wallet_history import history
from test_wallet_page import goto, wpage  # noqa: F401  (the fixture is used by name)


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def listed(page):
    return page.eval_on_selector_all("#ledger .tx", "els => els.map(e => e.dataset.txid)")


def set_range(page, a=None, at=None, b=None, bt=None):
    """Fill the four fields (None leaves one as it is) and let the list follow."""
    for sel, v in (("#fFrom", a), ("#fFromTime", at), ("#fTo", b), ("#fToTime", bt)):
        if v is not None:
            page.fill(sel, v)
    page.dispatch_event("#fToTime", "change")
    page.wait_for_timeout(150)


def opened(page, mock, n=25):
    """n payments, one a day at 12:00:00 UTC from 1 March 2022; payment k is on day k + 1 and its transaction is tid(100 + k)."""
    history(mock, n); funded(mock, n)
    goto(page)
    assert len(listed(page)) == n


def days(page):
    """The days of March 2022 the listed transactions are on, oldest first."""
    ids = listed(page)
    return sorted(int(t[:2], 16) - 100 + 1 for t in ids)


# ---- to the second ---------------------------------------------------------------------------------------------------------------------------------

def test_a_from_time_includes_the_second_it_names_and_excludes_the_one_before(wpage, mock):
    opened(wpage, mock)
    set_range(wpage, "2022-03-05", "12:00:00", "2022-03-07", "12:00:00")
    assert days(wpage) == [5, 6, 7], "12:00:00 is the moment of the transaction on both days: both ends are included"
    set_range(wpage, at="12:00:01")
    assert days(wpage) == [6, 7], "one second later and the 5th is out"
    set_range(wpage, bt="11:59:59")
    assert days(wpage) == [6], "and the 7th is out one second before its moment"


def test_a_field_with_no_time_is_the_whole_day_as_before(wpage, mock):
    opened(wpage, mock)
    set_range(wpage, "2022-03-05", "", "2022-03-07", "")
    assert days(wpage) == [5, 6, 7]
    set_range(wpage, at="12:00:01", bt="")
    assert days(wpage) == [6, 7], "only the From got a time"
    set_range(wpage, at="", bt="12:00:00")
    assert days(wpage) == [5, 6, 7], "a To with a time: the 7th up to 12:00:00, which is its moment"
    set_range(wpage, bt="11:59:59")
    assert days(wpage) == [5, 6]


def test_a_time_without_seconds_starts_on_its_first_second_and_a_to_reaches_to_the_end_of_that_minute(wpage, mock):
    opened(wpage, mock)
    set_range(wpage, "2022-03-05", "12:00", "2022-03-07", "12:00")
    assert days(wpage) == [5, 6, 7], "12:00 as From is 12:00:00 and as To is up to 12:00:59: the transactions at 12:00:00 are in"
    set_range(wpage, at="12:01")
    assert days(wpage) == [6, 7], "From 12:01 is after the 5th's moment"
    set_range(wpage, bt="11:59")
    assert days(wpage) == [6], "To 11:59 reaches to 11:59:59, still before the 7th"


def test_a_time_alone_is_not_a_filter(wpage, mock):
    opened(wpage, mock)
    set_range(wpage, at="12:00:01", bt="11:00:00")
    assert len(listed(wpage)) == 25 and wpage.is_hidden("#fClear") and wpage.inner_text("#fCount") == ""
    set_range(wpage, a="2022-03-10")
    assert days(wpage)[0] == 11 and wpage.is_visible("#fClear"), "with a date the From time counts: 12:00:01 on the 10th is after that day's transaction"


def test_to_before_from_in_one_day_shows_nothing_and_says_so(wpage, mock):
    opened(wpage, mock)
    set_range(wpage, "2022-03-05", "18:00:00", "2022-03-05", "06:00:00")
    assert listed(wpage) == [] and "0 of 25 loaded match" in wpage.inner_text("#fCount")


def test_clear_empties_the_times_too(wpage, mock):
    opened(wpage, mock)
    set_range(wpage, "2022-03-05", "12:00:01", "2022-03-07", "11:59:59")
    assert days(wpage) == [6]
    wpage.click("#fClear")
    assert [wpage.input_value(s) for s in ("#fFrom", "#fFromTime", "#fTo", "#fToTime")] == ["", "", "", ""]
    assert len(listed(wpage)) == 25


def test_the_chart_that_follows_the_fields_follows_the_time_too(wpage, mock):
    opened(wpage, mock, n=25)
    set_range(wpage, "2022-03-05", "12:00:01", "2022-03-09", "11:59:59")
    wpage.check("#chartFollow")
    wpage.wait_for_function("() => /the From and To dates/.test(document.getElementById('chartRange').textContent)")
    assert chart(wpage)["n"] == 3, "the 6th, 7th and 8th: not the 5th (a second before From) nor the 9th (a second after To)"
    assert chart(wpage)["first"] == tid(105) and chart(wpage)["last"] == tid(107)


def test_the_time_fields_are_labelled_utc_and_say_what_empty_means(wpage, mock):
    opened(wpage, mock)
    assert "UTC" in wpage.get_attribute("#fFromTime", "aria-label") and "start of the day" in wpage.get_attribute("#fFromTime", "aria-label")
    assert "UTC" in wpage.get_attribute("#fToTime", "aria-label") and "end of the day" in wpage.get_attribute("#fToTime", "aria-label")
    assert wpage.get_attribute("#fFromTime", "step") == "1" and wpage.get_attribute("#fToTime", "step") == "1", "to the second"
