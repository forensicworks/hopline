"""The wallet page shows amounts in a currency, with the choice the workspace saved, and saves a choice made here for the workspace."""
import csv
import io
import json
import re

import pytest

from chains import IN, OUT, tx
from conftest import ADDRESS, ADDR_TXS, HIST, PRICES_NOW, fx
from helpers import wallet_export
from test_fiat_sources import price_at
from test_wallet_analysis import ring
from test_wallet_history import history
from test_wallet_page import WALLET_URL, cards, goto, wpage  # noqa: F401  (the fixture is used by name)


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def prefs(ctx, fiat, extra=None):
    p = {"fiat": fiat}
    p.update(extra or {})
    ctx.add_init_script("localStorage.setItem('hopline.prefs.v1', %s);" % json.dumps(json.dumps(p)))


def saved(page):
    return json.loads(page.evaluate("() => localStorage.getItem('hopline.prefs.v1') || '{}'")).get("fiat")


def wait_prices(page):
    page.wait_for_function("() => /Prices from/.test(document.getElementById('fiatStatus').textContent) && !/Loading|Not loaded/.test(document.getElementById('fiatStatus').textContent)")


def first_card_amount(page):
    return page.locator("#ledger .tx").first.locator(".net").inner_text()


def test_the_choice_the_workspace_saved_is_used_and_prices_are_fetched(ctx, wpage, mock):
    prefs(ctx, {"currency": "USD", "basis": "each", "show": "both", "ref": None})
    goto(wpage); wait_prices(wpage)
    assert wpage.input_value("#fiatCur") == "USD" and wpage.input_value("#fiatShow") == "both" and wpage.input_value("#fiatBasis") == "each"
    paths = [p for h, p in mock.requests if p.startswith("/v1/")]
    assert sorted(paths) == ["/v1/historical-price?currency=USD", "/v1/prices"]
    net = first_card_amount(wpage)
    assert " BTC · " in net and "$" in net, net


def test_each_amount_is_priced_at_its_own_time_and_says_how(ctx, wpage):
    prefs(ctx, {"currency": "USD", "basis": "each", "show": "fiat", "ref": None})
    goto(wpage); wait_prices(wpage)
    card = cards(wpage).first
    t = ADDR_TXS[0]["status"]["block_time"]
    line = card.locator(".cols .amt").first
    sats = ADDR_TXS[0]["vin"][0]["prevout"]["value"]
    got = float(re.search(r"([\d,]+\.\d+)", line.inner_text()).group(1).replace(",", ""))
    assert abs(got - sats / 1e8 * price_at(t)) < 0.02, (got, sats / 1e8 * price_at(t))
    assert "per BTC at" in line.get_attribute("title")


def test_the_currency_alone_and_bitcoin_alone(ctx, wpage):
    prefs(ctx, {"currency": "EUR", "basis": "each", "show": "fiat", "ref": None})
    goto(wpage); wait_prices(wpage)
    text = first_card_amount(wpage)
    assert "€" in text and "BTC" not in text, text
    wpage.select_option("#fiatShow", "btc")
    text = first_card_amount(wpage)
    assert "BTC" in text and "€" not in text


def test_choosing_a_currency_here_fetches_the_prices_saves_the_choice_for_the_workspace_and_changes_nothing_else(ctx, wpage, mock):
    ctx.add_init_script("localStorage.setItem('hopline.prefs.v1', %s);" % json.dumps(json.dumps({"stepSize": 7, "fallback": False})))
    goto(wpage)
    assert wpage.input_value("#fiatCur") == "off" and "BTC" in first_card_amount(wpage) and "$" not in first_card_amount(wpage)
    assert wpage.is_disabled("#fiatShow") and wpage.is_disabled("#fiatBasis")
    wpage.select_option("#fiatCur", "GBP"); wait_prices(wpage)
    assert "£" in first_card_amount(wpage)
    assert saved(wpage) == {"currency": "GBP", "basis": "each", "show": "both", "ref": None}
    all_prefs = json.loads(wpage.evaluate("() => localStorage.getItem('hopline.prefs.v1')"))
    assert all_prefs["stepSize"] == 7 and all_prefs["fallback"] is False, "the other saved choices are left as they were"
    wpage.select_option("#fiatCur", "off")
    assert "£" not in first_card_amount(wpage) and saved(wpage)["currency"] == "off"


def test_today_as_the_price_needs_no_history(ctx, wpage, mock):
    prefs(ctx, {"currency": "USD", "basis": "today", "show": "fiat", "ref": None})
    goto(wpage)
    wpage.wait_for_function("() => document.getElementById('fiatStatus').textContent.includes('today')")
    assert [p for h, p in mock.requests if p.startswith("/v1/")] == ["/v1/prices"], "no price history was fetched"
    line = cards(wpage).first.locator(".cols .amt").first
    sats = ADDR_TXS[0]["vin"][0]["prevout"]["value"]
    got = float(re.search(r"([\d,]+\.\d+)", line.inner_text()).group(1).replace(",", ""))
    assert abs(got - sats / 1e8 * PRICES_NOW["USD"]) < 0.02


def test_the_balance_is_shown_at_todays_price(ctx, wpage):
    prefs(ctx, {"currency": "USD", "basis": "each", "show": "both", "ref": None})
    goto(wpage); wait_prices(wpage)
    assert "at today's price" in wpage.inner_text("#sBalance") and "$" in wpage.inner_text("#sBalance")


def test_a_reference_moment_chosen_in_the_workspace_is_kept(ctx, wpage):
    t = HIST["prices"][5]["time"]
    prefs(ctx, {"currency": "USD", "basis": "ref", "show": "fiat", "ref": {"txid": "ab" * 32, "time": t}})
    goto(wpage); wait_prices(wpage)
    assert wpage.input_value("#fiatBasis") == "ref" and any("chosen in the workspace" in o for o in wpage.eval_on_selector_all("#fiatBasis option", "os => os.map(o => o.textContent)"))
    line = cards(wpage).first.locator(".cols .amt").first
    sats = ADDR_TXS[0]["vin"][0]["prevout"]["value"]
    got = float(re.search(r"([\d,]+\.\d+)", line.inner_text()).group(1).replace(",", ""))
    assert abs(got - sats / 1e8 * price_at(t)) < 0.02, "every amount at that one moment"


def test_the_csv_gets_the_currency_columns_only_when_a_currency_is_on(ctx, wpage, tmp_path):
    prefs(ctx, {"currency": "USD", "basis": "each", "show": "both", "ref": None})
    goto(wpage); wait_prices(wpage)
    with wpage.expect_download() as dl:
        wallet_export(wpage, "csv")
    p = tmp_path / "w.csv"; dl.value.save_as(p)
    rows = list(csv.reader(io.StringIO(p.read_bytes().decode("utf-8-sig"))))
    head = rows[0]
    assert head[-5:] == ["fiat_currency", "fiat_price_per_btc", "fiat_received", "fiat_sent", "fiat_net"]
    first = dict(zip(head, rows[1]))
    t = int(first["time_unix"])
    assert first["fiat_currency"] == "USD" and abs(float(first["fiat_price_per_btc"]) - price_at(t)) < 0.02
    assert abs(float(first["fiat_net"]) - int(first["net_sat"]) / 1e8 * price_at(t)) < 0.001


def test_the_report_carries_the_currency_and_says_how_it_was_worked_out(ctx, wpage, tmp_path):
    prefs(ctx, {"currency": "USD", "basis": "each", "show": "both", "ref": None})
    goto(wpage); wait_prices(wpage)
    with wpage.expect_download() as dl:
        wallet_export(wpage, "report")
    p = tmp_path / "r.html"; dl.value.save_as(p)
    html = p.read_text(encoding="utf-8")
    assert "Fiat values" in html and "Shown in USD at the price at each transaction&#39;s own time" in html
    assert re.search(r'<span class="hint">[^<]*\$[\d,]+\.\d\d</span>', html), "amounts carry their value in the currency"


def test_the_csv_is_as_it_was_without_a_currency(wpage, tmp_path):
    goto(wpage)
    with wpage.expect_download() as dl:
        wallet_export(wpage, "csv")
    p = tmp_path / "w.csv"; dl.value.save_as(p)
    assert "fiat" not in p.read_bytes().decode("utf-8-sig").split("\r\n")[0]


def test_when_the_prices_cannot_be_loaded_the_amounts_stay_in_bitcoin_and_the_page_says_so(ctx, wpage, mock):
    mock.fail["/v1/prices"] = 500; mock.fail["/v1/historical-price?currency=USD"] = 500
    prefs(ctx, {"currency": "USD", "basis": "each", "show": "fiat", "ref": None})
    goto(wpage)
    wpage.wait_for_function("() => /Could not load prices/.test(document.getElementById('fiatStatus').textContent)", timeout=30000)
    assert "BTC" in first_card_amount(wpage) and "$" not in first_card_amount(wpage), "a currency-only choice still shows an amount rather than nothing"
    assert "bad" in (wpage.get_attribute("#fiatStatus", "class") or "")


def test_an_own_server_without_a_price_service_asks_mempool_only_for_prices_if_you_said_so(ctx, wpage, mock):
    prefs(ctx, {"currency": "USD", "basis": "each", "show": "both", "ref": None},
          {"source": "custom", "customBase": "https://my-node.example/api", "customPrices": "mempool", "fallback": False})
    goto(wpage); wait_prices(wpage)
    price_hosts = {h for h, p in mock.requests if p.startswith("/v1/")}
    assert price_hosts == {"https://mempool.space"}, price_hosts
    ctx2_hosts = {h for h, p in mock.requests if not p.startswith("/v1/")}
    assert ctx2_hosts == {"https://my-node.example"}


def test_with_no_price_service_at_all_it_says_so(ctx, wpage):
    prefs(ctx, {"currency": "USD", "basis": "each", "show": "both", "ref": None},
          {"source": "custom", "customBase": "https://my-node.example/api", "customPrices": "off", "fallback": False})
    goto(wpage)
    wpage.wait_for_function("() => /Prices need a mempool-compatible server/.test(document.getElementById('fiatStatus').textContent)")


# ---- every Bitcoin figure on the page has its value in the currency ---------------------------------------------------------------------------

def dollars(text):
    """Every amount in dollars in a piece of text, in order."""
    return [float(m.replace(",", "")) for m in re.findall(r"\$([\d,]+\.\d+)", text)]


def btc_parts(text):
    return [float(m) for m in re.findall(r"(\d+\.\d{8}) BTC", text)]


def test_the_totals_received_and_sent_are_converted_and_the_balance_is_valued_at_todays_price(ctx, wpage):
    prefs(ctx, {"currency": "USD", "basis": "today", "show": "both", "ref": None})
    goto(wpage); wait_prices(wpage)
    for sel in ("#sReceived", "#sSent"):
        text = wpage.inner_text(sel)
        assert "0.01555415 BTC" in text and "at today's price" in text, text
        assert abs(dollars(text)[0] - 1555415 / 1e8 * PRICES_NOW["USD"]) < 0.02
    assert "$0.00" in wpage.inner_text("#sBalance") and "at today's price" in wpage.inner_text("#sBalance")


def test_each_transaction_priced_at_its_own_time_is_added_up_for_the_totals_once_the_whole_history_is_loaded(ctx, wpage):
    prefs(ctx, {"currency": "USD", "basis": "each", "show": "fiat", "ref": None})
    goto(wpage); wait_prices(wpage)
    recv = sum(sum(o["value"] for o in t["vout"] if o.get("scriptpubkey_address") == ADDRESS) * price_at(t["status"]["block_time"]) / 1e8 for t in ADDR_TXS)
    sent = sum(sum(v["prevout"]["value"] for v in t["vin"] if (v.get("prevout") or {}).get("scriptpubkey_address") == ADDRESS) * price_at(t["status"]["block_time"]) / 1e8 for t in ADDR_TXS)
    got_r, got_s = wpage.inner_text("#sReceived"), wpage.inner_text("#sSent")
    assert "BTC" not in got_r and "today" not in got_r, "the currency alone, at each transaction's own price"
    assert abs(dollars(got_r)[0] - recv) < 0.05 * max(1, len(ADDR_TXS)), (got_r, recv)
    assert abs(dollars(got_s)[0] - sent) < 0.05 * max(1, len(ADDR_TXS)), (got_s, sent)
    assert "its own transaction" in wpage.get_attribute("#sReceived", "title")
    wpage.select_option("#fiatShow", "btc")
    assert "$" not in wpage.inner_text("#sReceived") and "0.01555415 BTC" in wpage.inner_text("#sReceived")


def test_while_only_part_of_the_history_is_loaded_the_totals_use_todays_price_and_say_so(ctx, wpage, mock):
    prefs(ctx, {"currency": "USD", "basis": "each", "show": "both", "ref": None})
    history(mock, 60)
    goto(wpage); wait_prices(wpage)
    text = wpage.inner_text("#sReceived")
    assert "at today's price" in text and "$" in text, text
    assert "Load the whole history" in wpage.get_attribute("#sReceived", "title")


def test_pending_and_the_chart_follow_the_currency(ctx, wpage, mock):
    prefs(ctx, {"currency": "USD", "basis": "today", "show": "both", "ref": None})
    o = OUT("x", 7000000); o["scriptpubkey_address"] = ADDRESS
    t = tx(mock, 77, [IN(9, 0, "payer", 9000000)], [o])
    mock.routes["/tx/" + t[3:]]["status"] = {"confirmed": False}
    mock.routes["/address/" + ADDRESS + "/txs"] = [mock.routes["/tx/" + t[3:]]] + ADDR_TXS
    st = dict(fx("address_stats.json")); st["mempool_stats"] = {"funded_txo_count": 1, "funded_txo_sum": 7000000, "spent_txo_count": 0, "spent_txo_sum": 0, "tx_count": 1}
    mock.routes["/address/" + ADDRESS] = st
    goto(wpage); wait_prices(wpage)
    pend = wpage.inner_text("#sPending")
    assert "+0.07000000 BTC" in pend and abs(dollars(pend)[0] - 0.07 * PRICES_NOW["USD"]) < 0.02, pend
    chart = wpage.inner_text("#chartText")
    assert "Highest" in chart and len(dollars(chart)) == 2 and len(btc_parts(chart)) == 2, chart


def test_the_wallets_it_dealt_with_show_what_they_moved_in_the_currency(ctx, wpage):
    prefs(ctx, {"currency": "USD", "basis": "today", "show": "both", "ref": None})
    goto(wpage); wait_prices(wpage)
    assert wpage.locator("#cp .cprow").count() > 0 and wpage.locator("#assoc .assocrow").count() > 0
    for sel in ("#cp .cprow .vol", "#cp .cprow .nums", "#assoc .assocrow .nums"):
        for text in wpage.eval_on_selector_all(sel, "els => els.map(e => e.textContent)"):
            b, d = btc_parts(text), dollars(text)
            assert len(b) == len(d) and b, (sel, text)
            for x, y in zip(b, d):
                assert abs(y - x * PRICES_NOW["USD"]) <= 0.02 + 1e-9 * y, (sel, text)
    wpage.select_option("#fiatShow", "btc")
    assert all("$" not in v for v in wpage.eval_on_selector_all("#cp .cprow .vol", "els => els.map(e => e.textContent)"))


def test_the_whole_wallet_balances_are_valued_at_todays_price(ctx, wpage, mock):
    prefs(ctx, {"currency": "USD", "basis": "each", "show": "both", "ref": None})
    ring(mock)
    goto(wpage); wait_prices(wpage)
    wpage.click("#clLook"); wpage.wait_for_function("() => /Looked at/.test(document.getElementById('message').textContent)", timeout=30000)
    wpage.click("#clBalances"); wpage.wait_for_function("() => /Read 3 balances/.test(document.getElementById('message').textContent)", timeout=30000)
    rows = wpage.eval_on_selector_all("#clList .clrow .nums", "els => els.map(e => e.textContent)")
    assert len(rows) == 4
    for text, sats in zip(rows, (50000, 5000, 7000, 9000)):
        assert btc_parts(text) == [sats / 1e8] and abs(dollars(text)[0] - sats / 1e8 * PRICES_NOW["USD"]) < 0.02, text
    total = wpage.inner_text("#clTotal")
    assert "0.00071000 BTC" in total and "at today's price" in total and abs(dollars(total)[0] - 0.00071 * PRICES_NOW["USD"]) < 0.02, total


def test_without_a_currency_none_of_these_figures_change(wpage):
    goto(wpage)
    for sel in ("#sBalance", "#sReceived", "#sSent", "#chartText", "#cp", "#assoc"):
        assert "$" not in wpage.inner_text(sel) and "at today" not in wpage.inner_text(sel), sel
    assert wpage.inner_text("#sReceived") == "0.01555415 BTC"


def test_the_currency_choice_sits_above_the_figures_it_changes(wpage):
    goto(wpage)
    top = wpage.evaluate("() => { const b = document.getElementById('fiatBar').getBoundingClientRect(), k = document.getElementById('sBalance').getBoundingClientRect(); return b.bottom <= k.top; }")
    assert top and wpage.is_visible("#fiatCur")
