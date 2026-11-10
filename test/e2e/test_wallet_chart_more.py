"""The wallet chart: bars of what came in and went out under the balance, the whole history loaded by itself, and fingers (pinch to zoom, slide to move) on a touch screen."""
import pytest

from chains import tid
from test_wallet_analysis import funded, serve
from test_wallet_chart_range import chart, checked, everything, goto, wpage  # noqa: F401  (the fixture is used by name)
from test_wallet_fiat import prefs, wait_prices
from test_wallet_history import W, history, utc


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def spend(n, day, ins, outs, hour=12):
    """A confirmed transaction on a day of March 2022: ins and outs are lists of (address, value)."""
    def side(a, v):
        return {"scriptpubkey_address": a, "scriptpubkey_type": "v0_p2wpkh", "value": v}
    return {"txid": tid(n), "fee": 150, "weight": 800, "status": {"confirmed": True, "block_height": 700000 + n, "block_time": utc(2022, 3, day, hour)},
            "vin": [{"txid": tid(90), "vout": 0, "is_coinbase": False, "prevout": side(a, v)} for a, v in ins], "vout": [side(a, v) for a, v in outs]}


OTHER = "bc1qotherxxxxxxxxxxxxxxxx"


def mixed(mock):
    """Two payments in on 1 March (150,000), a spend on 2 March that gives 30,000 away and sends 69,850 back to the wallet (the wallet is 30,150 poorer), 5,000 in on the 3rd and 40,000 on "51 March", which is 20 April."""
    txs = [spend(5, 51, [("bc1qpayerxxxxxxxxxxxxxx", 50000)], [(W, 40000)]),
           spend(4, 3, [("bc1qpayerxxxxxxxxxxxxxx", 6000)], [(W, 5000)]),
           spend(3, 2, [(W, 100000)], [(OTHER, 30000), (W, 69850)]),
           spend(2, 1, [("bc1qpayerxxxxxxxxxxxxxx", 60000)], [(W, 50000)], hour=13),
           spend(1, 1, [("bc1qpayerxxxxxxxxxxxxxx", 110000)], [(W, 100000)])]
    serve(mock, W, txs, balance=164850)
    return txs


def over_bar(page, i):
    page.locator("#chart").scroll_into_view_if_needed()
    box = page.locator("#chart").bounding_box()
    x, y = page.evaluate("(i) => { const c = window.__wallet.chart, k = c.buckets[i]; return [(k.x0 + k.x1) / 2, (c.strip.top + c.strip.bottom) / 2]; }", i)
    page.mouse.move(box["x"] + x, box["y"] + y)
    return box["x"] + x, box["y"] + y


def buckets(page):
    return page.evaluate("() => window.__wallet.chart.buckets.map((q) => q.b)")


# ---- what came in and what went out ----------------------------------------------------------------------------------------------------------

def test_the_bars_add_up_what_each_transaction_did_to_the_balance_day_by_day(wpage, mock):
    mixed(mock)
    goto(wpage)
    c = wpage.evaluate("() => ({ unit: window.__wallet.chart.unit, strip: window.__wallet.chart.strip })")
    assert c["unit"] == "day" and c["strip"], c
    by = {k["from"]: k for k in buckets(wpage)}
    first, second, third = by[utc(2022, 3, 1, 0)], by[utc(2022, 3, 2, 0)], by[utc(2022, 3, 3, 0)]
    assert (first["inn"], first["out"], first["ins"], first["outs"]) == (150000, 0, 2, 0)
    assert (second["inn"], second["out"], second["ins"], second["outs"]) == (0, 30150, 0, 1), "the change that came back is not counted as money in"
    assert (third["inn"], third["out"]) == (5000, 0)
    assert sum(k["inn"] - k["out"] for k in buckets(wpage)) == 164850, "in minus out is how the balance changed"


def test_hovering_a_bar_says_what_came_in_and_went_out_and_marks_the_period(wpage, mock):
    mixed(mock)
    goto(wpage)
    i = [k["from"] for k in buckets(wpage)].index(utc(2022, 3, 2, 0))
    over_bar(wpage, i)
    wpage.wait_for_selector("#chartTip:not([hidden])")
    tip = wpage.inner_text("#chartTip")
    assert "2022-03-02" in tip and "Went out: −0.00030150 BTC (1 transaction)" in tip and "The balance changed by −0.00030150 BTC" in tip and "Came in" not in tip, tip
    assert wpage.is_visible("#chartBand") and wpage.is_hidden("#chartDot") and wpage.is_hidden("#chartLine"), "a bar, not a point"
    j = [k["from"] for k in buckets(wpage)].index(utc(2022, 3, 1, 0))
    over_bar(wpage, j)
    tip = wpage.inner_text("#chartTip")
    assert "Came in: +0.00150000 BTC (2 transactions)" in tip and "Went out" not in tip, tip
    wpage.mouse.move(5, 5)
    assert wpage.is_hidden("#chartTip") and wpage.is_hidden("#chartBand")


def test_clicking_a_bar_zooms_to_that_day(wpage, mock):
    everything(wpage, mock)
    over_bar(wpage, 60)
    wpage.mouse.down(); wpage.mouse.up()
    c = chart(wpage)
    assert c["n"] == 1 and c["first"] == tid(160) and wpage.inner_text("#chartRange") == "2022-04-30 to 2022-04-30" and checked(wpage) is None, c
    assert wpage.locator("#ledger .tx.flash").count() == 0, "a bar is not a point: no card is looked for"
    wpage.click("#chartReset")
    assert chart(wpage)["n"] == 125


def test_a_narrow_chart_has_weekly_bars_that_begin_on_mondays(wpage, mock):
    everything(wpage, mock)
    assert wpage.evaluate("() => window.__wallet.chart.unit") == "day"
    wpage.set_viewport_size({"width": 420, "height": 800})
    wpage.wait_for_function("() => window.__wallet.chart.unit === 'week'", timeout=5000)
    b = buckets(wpage)
    assert len(b) < 30 and all(k["to"] - k["from"] == 7 * 86400 for k in b)
    assert wpage.evaluate("(t) => new Date(t * 1000).getUTCDay()", b[0]["from"]) == 1


def test_the_bars_can_be_switched_off_and_stay_off(wpage, mock):
    history(mock, 25); funded(mock, 25)
    goto(wpage)
    height = lambda: wpage.evaluate("() => Math.round(document.getElementById('chart').getBoundingClientRect().height)")
    assert wpage.is_checked("#chartBars") and height() == 338 and wpage.evaluate("() => !!window.__wallet.chart.strip")
    wpage.uncheck("#chartBars")
    assert height() == 260 and wpage.evaluate("() => window.__wallet.chart.strip === null && window.__wallet.chart.buckets.length === 0")
    assert "The bars below" not in wpage.inner_text("#chartText")
    goto(wpage)
    assert not wpage.is_checked("#chartBars") and height() == 260, "remembered"
    wpage.check("#chartBars")
    assert height() == 338 and "The bars below show, for each day" in wpage.inner_text("#chartText")


def test_the_bars_are_in_the_currency_when_the_chart_is(ctx, wpage):
    prefs(ctx, {"currency": "USD", "basis": "each", "show": "fiat", "ref": None})
    goto(wpage); wait_prices(wpage); wpage.wait_for_timeout(300)
    assert len(buckets(wpage)) >= 1
    over_bar(wpage, 0)
    tip = wpage.inner_text("#chartTip")
    assert "$" in tip and "BTC" not in tip, tip


# ---- the whole history, loaded by itself --------------------------------------------------------------------------------------------------------

def test_with_the_setting_on_a_small_wallet_is_loaded_in_full_as_it_opens(ctx, wpage, mock):
    ctx.add_init_script("localStorage.setItem('hopline.walletchart.v1', JSON.stringify({ auto: true, bars: true }));")
    history(mock, 125); funded(mock, 125)
    goto(wpage)
    wpage.wait_for_function("() => window.__wallet.chart.pts.length === 125", timeout=60000)
    assert wpage.is_hidden("#chartBanner") and wpage.is_checked("#chartAuto")
    assert "the whole history is here" in wpage.inner_text("#message")


def test_a_wallet_with_more_transactions_than_the_limit_waits_for_load_all(ctx, wpage, mock):
    ctx.add_init_script("localStorage.setItem('hopline.walletchart.v1', JSON.stringify({ auto: true, bars: true }));")
    history(mock, 125); funded(mock, 125)
    mock.routes["/address/" + W]["chain_stats"]["tx_count"] = 300                       # the wallet says it has 300, more than a wallet that loads by itself
    goto(wpage)
    wpage.wait_for_timeout(600)
    assert chart(wpage)["n"] == 25
    assert "Only the newest 25 of 300 transactions are loaded" in wpage.inner_text("#chartBanner") and wpage.is_visible("#chartLoadAll")


def test_switching_it_on_loads_now_and_is_remembered_for_the_next_wallet(wpage, mock):
    history(mock, 125); funded(mock, 125)
    goto(wpage)
    assert not wpage.is_checked("#chartAuto") and chart(wpage)["n"] == 25, "the tests start with it off"
    wpage.check("#chartAuto")
    wpage.wait_for_function("() => window.__wallet.chart.pts.length === 125", timeout=60000)
    goto(wpage)
    wpage.wait_for_function("() => window.__wallet.chart.pts.length === 125", timeout=60000)
    wpage.uncheck("#chartAuto")
    goto(wpage)
    wpage.wait_for_timeout(600)
    assert not wpage.is_checked("#chartAuto") and chart(wpage)["n"] == 25, "switched off, it stays off"


def test_loading_by_itself_shows_how_far_it_is_on_the_chart(ctx, wpage, mock):
    ctx.add_init_script("localStorage.setItem('hopline.walletchart.v1', JSON.stringify({ auto: true, bars: true }));")
    history(mock, 125); funded(mock, 125)
    wpage.add_init_script("window.__seen = []; new MutationObserver(() => { const t = document.getElementById('chartBannerText'); if (t && /Loading the whole history/.test(t.textContent)) window.__seen.push(t.textContent); })"
                          ".observe(document, { subtree: true, childList: true, characterData: true });")
    goto(wpage)
    wpage.wait_for_function("() => window.__wallet.chart.pts.length === 125", timeout=60000)
    assert any("of 125 transactions" in t for t in wpage.evaluate("() => window.__seen")), "the chart said how far it was"


# ---- fingers -----------------------------------------------------------------------------------------------------------------------------------------

def finger(page, kind, pid, x, y=100):
    """A touch pointer event on the chart, x in the chart's own pixels."""
    page.evaluate("""([kind, pid, x, y]) => { const cv = document.getElementById('chart'), r = cv.getBoundingClientRect();
                                              cv.dispatchEvent(new PointerEvent(kind, { pointerId: pid, pointerType: 'touch', isPrimary: pid === 1, button: 0, bubbles: true, cancelable: true, clientX: r.left + x, clientY: r.top + y })); }""",
                  [kind, pid, x, y])


def geometry(page):
    return page.evaluate("() => { const c = window.__wallet.chart; return { L: c.L, pw: c.pw, from: c.from, to: c.to, key: c.key }; }")


def test_two_fingers_pinch_to_zoom_one_slides_the_period_and_pinching_in_shows_everything(wpage, mock):
    everything(wpage, mock)
    g = geometry(wpage)
    at = lambda f: g["L"] + g["pw"] * f
    span = g["to"] - g["from"]
    under = g["from"] + 0.4 * span                                                       # the time under the left finger
    finger(wpage, "pointerdown", 1, at(0.4)); finger(wpage, "pointerdown", 2, at(0.6))
    finger(wpage, "pointermove", 1, at(0.2)); finger(wpage, "pointermove", 2, at(0.8))
    wpage.wait_for_function("() => window.__wallet.chart.key === 'custom'", timeout=5000)
    z = geometry(wpage)
    assert abs((z["to"] - z["from"]) - span / 3) < 600, "the fingers went three times further apart: a third of the time is shown"
    assert abs(z["from"] + 0.2 * (z["to"] - z["from"]) - under) < 600, "the time that was under the finger is still under it"
    assert wpage.is_visible("#chartReset") and 30 <= chart(wpage)["n"] < 125
    finger(wpage, "pointerup", 1, at(0.2)); finger(wpage, "pointerup", 2, at(0.8))
    # one finger slides the period
    finger(wpage, "pointerdown", 1, at(0.5)); finger(wpage, "pointermove", 1, at(0.5) + 4)
    wpage.wait_for_timeout(150)
    assert geometry(wpage)["from"] == z["from"], "a few pixels is a tap, not a slide"
    finger(wpage, "pointermove", 1, at(0.5) + 80)
    wpage.wait_for_function("(f) => window.__wallet.chart.from < f", arg=z["from"], timeout=5000)
    moved = geometry(wpage)
    assert abs((moved["to"] - moved["from"]) - (z["to"] - z["from"])) < 5, "the same length, earlier"
    finger(wpage, "pointerup", 1, at(0.5) + 80)
    # fingers coming together show more, up to everything
    finger(wpage, "pointerdown", 1, at(0.45)); finger(wpage, "pointerdown", 2, at(0.55))
    finger(wpage, "pointermove", 1, at(0.4985)); finger(wpage, "pointermove", 2, at(0.5015))
    wpage.wait_for_function("() => window.__wallet.chart.key === 'all'", timeout=5000)
    assert chart(wpage)["n"] == 125 and wpage.is_hidden("#chartReset")
    finger(wpage, "pointerup", 1, at(0.4985)); finger(wpage, "pointerup", 2, at(0.5015))


def test_fingers_that_cross_or_a_finger_on_a_chart_that_shows_everything_change_nothing(wpage, mock):
    everything(wpage, mock)
    g = geometry(wpage)
    at = lambda f: g["L"] + g["pw"] * f
    finger(wpage, "pointerdown", 1, at(0.4)); finger(wpage, "pointerdown", 2, at(0.6))
    finger(wpage, "pointermove", 1, at(0.7)); finger(wpage, "pointermove", 2, at(0.3))
    wpage.wait_for_timeout(200)
    assert chart(wpage)["n"] == 125 and geometry(wpage)["key"] == "all"
    finger(wpage, "pointerup", 1, at(0.7)); finger(wpage, "pointerup", 2, at(0.3))
    finger(wpage, "pointerdown", 1, at(0.5)); finger(wpage, "pointermove", 1, at(0.5) + 90)
    wpage.wait_for_timeout(200)
    assert chart(wpage)["n"] == 125 and wpage.is_hidden("#chartReset"), "there is nothing to slide along when everything is shown"
    finger(wpage, "pointerup", 1, at(0.5) + 90)
