"""The wallet page's Export menu: the transactions as a CSV, as a workspace file the workspace opens, and as a report that checks out."""
import csv
import io
import json
import re
import subprocess
import sys

import pytest

from conftest import ADDR_TXS, ADDRESS, PAGE_URL, ROOT
from helpers import idle, node_ids, wallet_export
from test_wallet_history import count, history, type_in
from test_wallet_page import goto, wpage  # noqa: F401  (the fixture is used by name)

VERIFY = ROOT / "tools" / "verify_report.py"
API = "https://mempool.space/api"


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def open_menu(page):
    if not page.evaluate("() => document.getElementById('exportMenu').open"):
        page.click("#exportMenu summary")


def save(page, kind, tmp_path, name):
    with page.expect_download(timeout=60000) as dl:
        wallet_export(page, kind)
    p = tmp_path / name
    dl.value.save_as(p)
    return p


def csv_rows(path):
    return list(csv.reader(io.StringIO(path.read_bytes().decode("utf-8-sig"))))


def evidence(html):
    return json.loads(re.search(r'<script type="application/json" id="hopline-evidence">(.*?)</script>', html, re.S).group(1))


def verify(path):
    return subprocess.run([sys.executable, "-I", str(VERIFY), str(path)], capture_output=True, text=True, timeout=60)


def test_the_menu_starts_closed_and_offers_the_three_files(wpage):
    goto(wpage)
    assert wpage.evaluate("() => document.getElementById('exportMenu').open") is False and wpage.is_hidden("[data-export=csv]")
    wpage.click("#exportMenu summary")
    assert wpage.locator("[data-export]").all_inner_texts() == ["Transactions (.csv)", "Workspace (.json) — can be imported", "Wallet report (.html)"]
    assert not wpage.is_checked("#exportShown") and not wpage.is_checked("#exportAll")
    assert wpage.is_disabled("#exportAll"), "the whole history is loaded already: nothing to load first"
    assert all(wpage.is_enabled("[data-export=%s]" % k) for k in ("csv", "json", "report"))


def test_only_the_transactions_shown_leaves_out_what_the_search_hides(wpage, mock, tmp_path):
    history(mock, 25)
    goto(wpage)
    type_in(wpage, "700003")
    n = count(wpage)
    assert 0 < n < 25
    open_menu(wpage); wpage.check("#exportShown")
    assert len(csv_rows(save(wpage, "csv", tmp_path, "shown.csv"))) == n + 1, "a heading and the ones shown"
    open_menu(wpage); wpage.uncheck("#exportShown")
    assert len(csv_rows(save(wpage, "csv", tmp_path, "all.csv"))) == 26, "a heading and every loaded one"


def test_with_nothing_shown_nothing_is_exported_and_the_page_says_why(wpage):
    goto(wpage)
    type_in(wpage, "zzzzzz")
    got = []
    wpage.on("download", lambda d: got.append(d))
    open_menu(wpage); wpage.check("#exportShown"); wpage.click("[data-export=csv]")
    wpage.wait_for_timeout(300)
    assert got == [] and "nothing to export" in wpage.inner_text("#message")


def test_the_workspace_file_says_when_and_where_each_transaction_came_from_and_the_workspace_opens_it(ctx, errors, wpage, tmp_path):
    goto(wpage)
    p = save(wpage, "json", tmp_path, "w.json")
    d = json.loads(p.read_text(encoding="utf-8"))
    assert d["format"] == "hopline-workspace" and d["source"] == API
    txs = [n for n in d["nodes"] if n["type"] == "tx" and n.get("loaded")]
    assert sorted(n["txid"] for n in txs) == sorted(t["txid"] for t in ADDR_TXS)
    assert all(n["source"] == API and isinstance(n["fetchedAt"], int) for n in txs), "provenance on every transaction"
    me = next(n for n in d["nodes"] if n["id"] == "addr:" + ADDRESS)
    assert me["fundedSum"] == 1555415 and me["spentSum"] == 1555415 and me["statsSource"] == API
    ws = ctx.new_page()
    ws.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    ws.goto(PAGE_URL); ws.wait_for_function("window.__hopline && window.__hopline.renderer")
    ws.set_input_files("#fileImport", str(p)); idle(ws)
    assert sorted(i[3:] for i in node_ids(ws, "tx") if i[3:] in {t["txid"] for t in ADDR_TXS}) == sorted(t["txid"] for t in ADDR_TXS)
    assert "addr:" + ADDRESS in node_ids(ws, "addr")


def test_the_report_covers_the_loaded_transactions_and_verifies(wpage, tmp_path):
    goto(wpage)
    open_menu(wpage); wpage.fill("#reportTitle", "Case 7: the hot wallet"); wpage.fill("#reportBy", "A. Analyst")
    p = save(wpage, "report", tmp_path, "r.html")
    html = p.read_text(encoding="utf-8")
    assert "<h1>Case 7: the hot wallet</h1>" in html and "Prepared by A. Analyst" in html and "made with Hopline wallet" in html
    assert "This is the whole history of the wallet " + ADDRESS + ": 8 transactions." in html
    assert all(t["txid"] in html for t in ADDR_TXS) and "from mempool.space" in html, "every transaction, and where it was retrieved from"
    assert "Report written: 8 transactions" in wpage.inner_text("#message") and "SHA-256" in wpage.inner_text("#message")
    r = verify(p)
    assert r.returncode == 0 and "OK:" in r.stdout, r.stdout + r.stderr
    ev = evidence(html)
    assert ev["evidence"]["generatedBy"] == "Hopline wallet" and ev["evidence"]["counts"]["transactionsLoaded"] == 8 and ev["evidence"]["title"] == "Case 7: the hot wallet"


def test_a_report_of_part_of_a_history_says_which_part(wpage, mock, tmp_path):
    history(mock, 60)
    goto(wpage)
    html = save(wpage, "report", tmp_path, "part.html").read_text(encoding="utf-8")
    assert "This is 25 transactions of the wallet " in html and "the ones loaded on the wallet page when the report was made. The wallet has 60 in all." in html
    type_in(wpage, "700040")                                                  # a block among the 25 newest, which are the ones loaded
    n = count(wpage)
    assert 0 < n < 25
    open_menu(wpage); wpage.check("#exportShown")
    html = save(wpage, "report", tmp_path, "shown.html").read_text(encoding="utf-8")
    assert "This is %d transaction" % n in html and "the ones the search and limits showed among the 25 loaded on the wallet page. The wallet has 60 in all." in html
    assert verify(tmp_path / "shown.html").returncode == 0


def test_the_open_menu_stays_on_a_phone_screen(wpage):
    wpage.set_viewport_size({"width": 390, "height": 800})
    goto(wpage)
    wpage.click("#exportMenu summary")
    box = wpage.locator("#exportMenu .menu-body").bounding_box()
    assert box["x"] >= 0 and box["x"] + box["width"] <= 391, box
    assert wpage.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth + 1")
