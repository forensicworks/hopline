"""The investigation report: one HTML file for what is on screen, with its evidence embedded and checkable."""
import datetime
import json
import pathlib
import re
import subprocess
import sys

import pytest

from chains import consolidation, peel_chain, reuse_change, tid
from conftest import NORMAL
from helpers import idle, open_query, settle, toast_text

ROOT = pathlib.Path(__file__).resolve().parents[2]
VERIFY = ROOT / "tools" / "verify_report.py"
BIG = max(range(len(NORMAL["vout"])), key=lambda i: NORMAL["vout"][i]["value"])
SMALL_ADDR = NORMAL["vout"][1 - BIG]["scriptpubkey_address"]


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def open_menu(page):
    page.evaluate("() => { document.getElementById('exportMenu').open = true; }")


def make_report(page, tmp_path, name="report.html"):
    open_menu(page)
    with page.expect_download() as dl:
        page.click("[data-export=report]")
    p = tmp_path / name
    dl.value.save_as(p)
    return p


def verify(path, *extra):
    return subprocess.run([sys.executable, "-I", str(VERIFY), str(path), *extra], capture_output=True, text=True, timeout=60)


def evidence(html):
    return json.loads(re.search(r'<script type="application/json" id="hopline-evidence">(.*?)</script>', html, re.S).group(1))


def test_the_report_covers_what_is_on_screen_and_verifies(fpage, tmp_path):
    open_query(fpage, NORMAL["txid"])
    open_menu(fpage); fpage.fill("#reportTitle", "Case 12: the hot wallet"); fpage.fill("#reportBy", "A. Analyst")
    p = make_report(fpage, tmp_path)
    html = p.read_text(encoding="utf-8")
    assert "<h1>Case 12: the hot wallet</h1>" in html and "Prepared by A. Analyst" in html
    assert NORMAL["txid"] in html and "Likely change" in html and "Wallet habits: version 1" in html
    assert '<img class="graph"' in html and "data:image/png;base64," in html
    assert "Report written" in toast_text(fpage) and "SHA-256" in toast_text(fpage)
    r = verify(p)
    assert r.returncode == 0 and "OK:" in r.stdout, r.stdout + r.stderr
    ev = evidence(html)
    on_screen = fpage.evaluate("() => window.__hopline.renderer.data.visible.nodes.size")
    assert len(ev["nodes"]) == on_screen and ev["evidence"]["counts"]["nodes"] == on_screen
    assert ev["evidence"]["title"] == "Case 12: the hot wallet" and ev["evidence"]["preparedBy"] == "A. Analyst"


def test_what_is_hidden_is_not_in_the_report(fpage, tmp_path):
    open_query(fpage, NORMAL["txid"])
    fpage.uncheck("#focusOn"); settle(fpage)
    fpage.evaluate("(id) => window.__hopline.hideIds([id])", "addr:" + SMALL_ADDR); settle(fpage)
    html = make_report(fpage, tmp_path).read_text(encoding="utf-8")
    assert SMALL_ADDR not in html, "neither in the readable part nor in the embedded evidence"
    assert all(n.get("address") != SMALL_ADDR for n in evidence(html)["nodes"])


def test_each_transaction_says_where_and_when_it_was_fetched(fpage, tmp_path):
    open_query(fpage, NORMAL["txid"])
    html = make_report(fpage, tmp_path).read_text(encoding="utf-8")
    today = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
    assert re.search(r"Retrieved %s \d\d:\d\d:\d\d UTC from mempool\.space; spent/unspent status as of %s" % (today, today), html), "provenance in the readable part"
    tx = next(n for n in evidence(html)["nodes"] if n.get("txid") == NORMAL["txid"])
    assert tx["source"] == "https://mempool.space/api" and abs(tx["fetchedAt"] - datetime.datetime.now(datetime.timezone.utc).timestamp()) < 120 and tx["spendsCheckedAt"] >= tx["fetchedAt"]


def test_hostile_labels_in_the_workspace_cannot_run_anything_in_the_report(fpage, ctx, tmp_path):
    open_query(fpage, NORMAL["txid"])
    fpage.evaluate("""(a) => { const g = window.__hopline.state.graph; g.annotate('addr:' + a, '<img src=x onerror=window.__pwned=1>Suspect', '</script><script>window.__pwned=2</script>'); g.nodes.get('addr:' + a).tag = 'THREAT'; window.__hopline.refresh(); }""", SMALL_ADDR)
    open_menu(fpage); fpage.fill("#reportTitle", "<script>window.__pwned=3</script>")
    p = make_report(fpage, tmp_path)
    html = p.read_text(encoding="utf-8")
    assert "<img src=x onerror" not in html and "<script>window.__pwned" not in html
    assert verify(p).returncode == 0
    viewer = ctx.new_page(); errs = []
    viewer.on("pageerror", lambda e: errs.append(str(e)))
    viewer.goto(p.as_uri())
    assert viewer.evaluate("() => window.__pwned") is None and not errs
    assert viewer.locator("img.graph").count() == 1 and viewer.locator("section.tx").count() >= 1
    assert "<img src=x onerror=window.__pwned=1>Suspect" in viewer.inner_text("body"), "shown as the text it is"
    viewer.close()


def test_the_embedded_evidence_is_a_workspace_that_imports_back(fpage, tmp_path):
    open_query(fpage, NORMAL["txid"])
    p = make_report(fpage, tmp_path)
    out = tmp_path / "evidence.json"
    assert verify(p, "--extract", str(out)).returncode == 0
    n_nodes = len(json.loads(out.read_text(encoding="utf-8"))["nodes"])
    fpage.click("#btnClear"); fpage.click("#btnClear"); settle(fpage)
    fpage.set_input_files("#fileImport", str(out))
    fpage.wait_for_function("() => window.__hopline.state.graph.nodes.size > 0"); settle(fpage)
    assert fpage.evaluate("() => window.__hopline.state.graph.nodes.size") == n_nodes
    assert fpage.evaluate("(id) => window.__hopline.state.graph.nodes.get(id).source", "tx:" + NORMAL["txid"]) == "https://mempool.space/api", "provenance survives the round trip"


def test_findings_and_their_reasons_are_in_the_report(fpage, mock, tmp_path):
    consolidation(mock); reuse_change(mock)
    open_query(fpage, tid(30)); open_query(fpage, tid(40))
    fpage.uncheck("#focusOn"); settle(fpage)
    html = make_report(fpage, tmp_path).read_text(encoding="utf-8")
    assert "CONSOL 6→1" in html and "Consolidation: 6 inputs gathered into 1 output" in html
    assert "Likely change:" in html and "also one of the inputs" in html and 'class="chg"' in html
    assert "Address clusters (1)" in html and "Method and limits" in html


def test_a_peel_chain_is_listed_with_its_totals(fpage, mock, tmp_path):
    peel_chain(mock, 6)
    open_query(fpage, tid(10))
    fpage.evaluate("(id) => window.__hopline.autoExpand(id, { dir: 'next', hops: 5, follow: 'largest' })", "tx:" + tid(10)); idle(fpage); settle(fpage)
    html = make_report(fpage, tmp_path).read_text(encoding="utf-8")
    assert "Possible peel chains (1)" in html and "PEEL 3/6" in html and "Step 3 of 6 in a possible peel chain (P-%s)" % tid(10)[:4] in html
    order = re.findall(r'<section class="tx" id="tx-([0-9a-f]{64})"', html)
    assert order == [tid(10 + i) for i in range(6)], "in time order"


def test_fiat_values_follow_the_display_choice(fpage, tmp_path):
    open_query(fpage, NORMAL["txid"])
    fpage.select_option("#fiatCur", "USD")
    fpage.wait_for_function("() => /history to|today|Could not|need/i.test(document.getElementById('fiatStatus').textContent)")
    settle(fpage)
    html = make_report(fpage, tmp_path).read_text(encoding="utf-8")
    assert "Fiat values" in html and "Shown in USD at the price at each transaction" in html and re.search(r"\$[\d,]+\.\d\d", html)
    fpage.select_option("#fiatCur", "off"); settle(fpage)
    plain = make_report(fpage, tmp_path, "plain.html").read_text(encoding="utf-8")
    assert "Fiat values" not in plain


def test_prepared_by_is_remembered_and_an_empty_screen_gives_a_message(fpage, tmp_path):
    open_menu(fpage); fpage.fill("#reportBy", "A. Analyst"); fpage.dispatch_event("#reportBy", "change")
    fpage.click("[data-export=report]")
    assert "Nothing to export" in toast_text(fpage)
    open_query(fpage, NORMAL["txid"])
    fpage.reload(); fpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert fpage.input_value("#reportBy") == "A. Analyst"
