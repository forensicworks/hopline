"""Payments from victims: the Findings group, its fiat values, the CSV (copied and saved) and the report section.

A victim wallet pays a threat wallet a small test amount and then a large one; the threat pays a part back. The wallets are tagged by the test, as an analyst would.
"""
import csv
import io
import re

import pytest

from chains import IN, OUT, addr, tid, tx
from helpers import idle, open_controls, open_query, selected, settle, show_findings
from test_money_now import fix_fee
from test_time_evidence import report_html  # noqa: F401


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def tag(page, name, preset):
    page.evaluate("(id) => window.__hopline.setSel([id])", "addr:" + addr(name)); settle(page)
    page.select_option("#fTag", preset); settle(page)


def scene(page, mock, tag_victim=True, tag_threat=True):
    tx(mock, 1, [IN(90, 0, "vic", 2000000)], [OUT("thr", 10000), OUT("vchg", 1989000)])
    tx(mock, 2, [IN(91, 0, "vic", 99000000)], [OUT("thr", 1000000), OUT("vchg2", 97990000)])
    tx(mock, 3, [IN(92, 0, "thr", 500000)], [OUT("vic", 400000), OUT("tc", 90000)])
    for n in (1, 2, 3):
        fix_fee(mock, n)
        open_query(page, tid(n)); settle(page)
    if tag_victim:
        tag(page, "vic", "VICTIM")
    if tag_threat:
        tag(page, "thr", "THREAT")
    show_findings(page); settle(page)


def findings(page):
    return page.inner_text("#anFindings")


def capture(page):
    page.evaluate("""() => { window.__copied = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__copied.push(t); return Promise.resolve(); } } }); }""")


def fiat_on(page):
    open_controls(page)
    page.select_option("#fiatCur", "USD")
    page.wait_for_function("() => /\\$/.test(document.getElementById('anFindings').textContent)", timeout=15000); idle(page); settle(page)


def test_the_group_lists_what_the_victim_paid_what_came_back_and_names_the_test_and_the_main_payment(tpage, mock):
    scene(tpage, mock)
    t = findings(tpage)
    assert "Payments from victims" in t or "PAYMENTS FROM VICTIMS" in t
    assert "The tags are yours" in t and "not what the victim's wallet spent" in t
    assert "2022-04-15 05:30 UTC · test payment" in t and "0.00010000 BTC" in t
    assert "2022-04-15 05:40 UTC · main payment" in t and "0.01000000 BTC" in t
    assert "Returned · 2022-04-15 05:50 UTC" in t and "−0.00400000 BTC" in t
    assert "Paid: 2 payments, 0.01010000 BTC. Returned: 0.00400000 BTC. Net 0.00610000 BTC." in t
    assert tpage.inner_text("#btnLossCopy") == "Copy CSV" and tpage.inner_text("#btnLossSave") == "Save CSV"


def test_it_appears_only_when_both_sides_are_tagged_and_follows_the_tags(tpage, mock):
    scene(tpage, mock, tag_victim=False)
    assert "payments from victims" not in findings(tpage).lower(), "only the threat is tagged"
    tag(tpage, "vic", "VICTIM"); show_findings(tpage); settle(tpage)
    assert "Paid: 2 payments" in findings(tpage)
    tag(tpage, "vic", "WATCH"); show_findings(tpage); settle(tpage)
    assert "payments from victims" not in findings(tpage).lower(), "no longer a victim wallet"


def test_pressing_a_payment_selects_its_transaction(tpage, mock):
    scene(tpage, mock)
    tpage.locator("#anFindings .linkrow", has_text="main payment").first.click(); settle(tpage)
    assert selected(tpage) == ["tx:" + tid(2)]


def test_with_a_currency_each_payment_has_its_value_at_its_time_and_the_total_has_today_as_well(tpage, mock):
    scene(tpage, mock)
    fiat_on(tpage)
    show_findings(tpage); settle(tpage)
    t = findings(tpage)
    assert re.search(r"0\.00010000 BTC · (≈ )?\$", t) and re.search(r"0\.01000000 BTC · (≈ )?\$", t), t
    assert "at the time of each)" in t and "at the time, $" in t and "today)" in t, t


def test_the_csv_is_copied_and_saved_with_a_total_row_and_a_return_that_is_negative(tpage, mock, tmp_path):
    scene(tpage, mock)
    capture(tpage)
    tpage.click("#btnLossCopy")
    tpage.wait_for_function("() => window.__copied.length > 0")
    text = tpage.evaluate("() => window.__copied[0]")
    rows = list(csv.reader(io.StringIO(text)))
    assert rows[0] == ["time_utc", "txid", "kind", "from", "to", "amount_sat", "amount_btc", "roles", "block_height", "first_seen_utc", "fiat_at_time", "fiat_today", "currency"]
    assert [(r[1], r[2], r[5], r[7]) for r in rows[1:4]] == [(tid(1), "paid", "10000", "test"), (tid(2), "paid", "1000000", "main"), (tid(3), "returned", "-400000", "")]
    assert rows[1][3] == addr("vic") and rows[1][4] == addr("thr") and rows[1][0] == "2022-04-15 05:30:00"
    assert rows[4][0] == "TOTAL" and rows[4][2] == "net" and rows[4][5] == "610000" and rows[4][6] == "0.00610000"
    assert "Copied the payments as CSV." in tpage.evaluate("() => document.getElementById('toast').textContent")
    with tpage.expect_download() as d:
        tpage.click("#btnLossSave")
    f = tmp_path / "p.csv"; d.value.save_as(str(f))
    assert d.value.suggested_filename.startswith("hopline-payments-") and d.value.suggested_filename.endswith(".csv")
    assert f.read_text(encoding="utf-8").replace("\r\n", "\n") == text.replace("\r\n", "\n"), "the file is the same table"


def test_the_csv_carries_the_fiat_values_when_a_currency_is_chosen(tpage, mock):
    scene(tpage, mock)
    fiat_on(tpage)
    capture(tpage)
    show_findings(tpage); tpage.click("#btnLossCopy")
    tpage.wait_for_function("() => window.__copied.length > 0")
    rows = list(csv.reader(io.StringIO(tpage.evaluate("() => window.__copied[0]"))))
    assert rows[1][12] == "USD" and float(rows[1][10]) > 0 and float(rows[1][11]) > 0, rows[1]
    assert float(rows[3][10]) < 0 and float(rows[3][11]) < 0, "a return is negative in the value columns too"
    total = rows[4]
    assert total[0] == "TOTAL" and abs(float(total[10]) - (float(rows[1][10]) + float(rows[2][10]) + float(rows[3][10]))) < 0.02 and total[12] == "USD"


def test_the_report_has_the_table_the_totals_and_the_caution_that_the_tags_are_the_analysts(tpage, mock, tmp_path):
    scene(tpage, mock)
    tpage.click("#sideTab"); tpage.click("#layoutSeg [data-layout=flow]"); tpage.uncheck("#focusOn"); settle(tpage)
    html = report_html(tpage, tmp_path, False)
    assert "<h2>Payments from victim wallets</h2>" in html and "The tags are the analyst's: Hopline does not find who is whose" in html
    assert "test payment" in html and "main payment" in html and "returned to the victim" in html and tid(1) in html and addr("thr") in html
    assert "<th>Net</th>" in html and "0.00610000 BTC" in html and "2 payments paid, 1 return" in html


def test_the_report_values_each_payment_at_its_time_when_a_currency_is_chosen(tpage, mock, tmp_path):
    scene(tpage, mock)
    fiat_on(tpage)
    tpage.click("#layoutSeg [data-layout=flow]"); tpage.uncheck("#focusOn"); settle(tpage)
    html = report_html(tpage, tmp_path, False)
    assert "<th>Value then (USD)</th>" in html and "Values are indicative, at the time of each transaction" in html and "worth $" in html and "today" in html


def test_without_tags_the_report_has_no_such_section_and_the_page_no_group(tpage, mock, tmp_path):
    scene(tpage, mock, tag_victim=False, tag_threat=False)
    assert "payments from victims" not in findings(tpage).lower()
    html = report_html(tpage, tmp_path, False)
    assert "Payments from victim wallets" not in html
