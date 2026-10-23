"""Rows can be folded by the period they happened in (month, week, day, year) instead of by wallet and small amounts."""
import calendar
import json

import pytest

from chains import IN, OUT, tid, tx
from conftest import ADDRESS
from helpers import idle, open_query, settle
from test_trace import click_handle, shown
from test_wallet_panel import W_ID

W = ADDRESS


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def utc(y, m, d, h=12):
    return calendar.timegm((y, m, d, h, 0, 0))


def to(address, value):
    o = OUT("x", value); o["scriptpubkey_address"] = address
    return o


def spending(txn, value):
    i = IN(txn, 0, "x", value); i["prevout"]["scriptpubkey_address"] = W
    return i


def scene(mock):
    """In: 5 payments in March 2022 (1-5), 4 in April (11-14), 2 in May (3, 4). Out: 3 payments in April (20-22). Numbers 300+ = in, 400+ = out."""
    when = {}
    n = 300
    for day in (1, 2, 3, 4, 5):
        when[n] = utc(2022, 3, day); tx(mock, n, [IN(n - 100, 0, "p%d" % n, 20000 + n)], [to(W, 10000 + n)]); n += 1
    for day in (11, 12, 13, 14):
        when[n] = utc(2022, 4, day); tx(mock, n, [IN(n - 100, 0, "p%d" % n, 20000 + n)], [to(W, 10000 + n)]); n += 1
    for day in (3, 4):
        when[n] = utc(2022, 5, day); tx(mock, n, [IN(n - 100, 0, "p%d" % n, 20000 + n)], [to(W, 10000 + n)]); n += 1
    for i, day in enumerate((20, 21, 22)):
        k = 400 + i
        when[k] = utc(2022, 4, day); tx(mock, k, [spending(300 + i, 10300 + i)], [OUT("shop%d" % i, 9000 + i)])                  # each spends one of the March payments, so no funding stub joins the list
    ids = sorted(when, key=lambda k: -when[k])
    for k in when:
        mock.routes["/tx/" + tid(k)]["status"]["block_time"] = when[k]
    txs = [mock.routes["/tx/" + tid(k)] for k in ids]
    mock.routes["/address/" + W] = {"address": W, "chain_stats": {"funded_txo_count": 11, "funded_txo_sum": 1, "spent_txo_count": 3, "spent_txo_sum": 1, "tx_count": len(txs)},
                                    "mempool_stats": {"funded_txo_count": 0, "funded_txo_sum": 0, "spent_txo_count": 0, "spent_txo_sum": 0, "tx_count": 0}}
    mock.routes["/address/" + W + "/txs"] = txs
    return when


def by(page, value):
    page.select_option("#inspBody .walletsec select[aria-label='Group rows by']", value); settle(page)


def heads(page):
    return page.eval_on_selector_all("#inspBody .walletsec .groupbtn .who", "els => els.map(e => e.firstChild.textContent.replace(/^[▾▸] /, ''))")


def rows_left(page):
    return page.locator("#inspBody .walletsec .linkrows > .rowcopy").count()


def start(page, mock, trace=False):
    scene(mock)
    open_query(page, W); settle(page)
    if trace:
        page.click("#layoutSeg [data-layout=trace]"); settle(page)
    page.evaluate("(id) => window.__hopline.setSel([id])", W_ID); settle(page)


def test_the_usual_grouping_is_the_default_and_the_choice_is_there(fpage, mock):
    start(fpage, mock)
    assert fpage.input_value("#inspBody .walletsec select[aria-label='Group rows by']") == "party"
    assert fpage.eval_on_selector_all("#inspBody .walletsec select[aria-label='Group rows by'] option", "os => os.map(o => o.value)") == ["party", "month", "week", "day", "year"]
    assert not any(" in " in h and "20" in h for h in heads(fpage)), "no period groups until you ask"


def test_by_month_folds_each_direction_and_month_with_three_or_more_rows(fpage, mock):
    start(fpage, mock)
    by(fpage, "month")
    h = heads(fpage)
    assert sorted(h) == ["3 transactions in Apr 2022 (out)", "4 transactions in Apr 2022 (in)", "5 transactions in Mar 2022 (in)"], h
    assert rows_left(fpage) == 2, "the two in May are not enough to fold: they stay rows"


def test_by_week_by_day_and_by_year(fpage, mock):
    start(fpage, mock)
    by(fpage, "week")
    assert sorted(heads(fpage)) == ["3 transactions in week 16 of 2022 (out)", "4 transactions in week 15 of 2022 (in)", "5 transactions in week 9 of 2022 (in)"]
    by(fpage, "day")
    assert heads(fpage) == [], "one a day: nothing to fold"
    by(fpage, "year")
    assert sorted(heads(fpage)) == ["11 transactions in 2022 (in)", "3 transactions in 2022 (out)"]


def test_a_period_group_opens_to_its_rows_and_back_to_the_usual_grouping(fpage, mock):
    start(fpage, mock)
    by(fpage, "month")
    fpage.locator("#inspBody .walletsec .groupbtn").filter(has_text="5 transactions in Mar 2022").click(); settle(fpage)
    assert fpage.locator("#inspBody .walletsec .groupmembers .linkrow").count() == 5
    by(fpage, "party")
    assert not [h for h in heads(fpage) if " in Mar" in h]


def test_the_choice_is_saved_and_shared_with_expansion_limits(fpage, mock):
    start(fpage, mock)
    by(fpage, "month")
    assert fpage.input_value("#groupBy") == "month"
    assert json.loads(fpage.evaluate("() => localStorage.getItem('hopline.prefs.v1')"))["groupBy"] == "month"
    fpage.evaluate("() => { document.getElementById('groupBy').closest('details').open = true; }")
    fpage.select_option("#groupBy", "week"); settle(fpage)
    assert fpage.evaluate("() => window.__hopline.state.groupBy") == "week"
    assert fpage.input_value("#inspBody .walletsec select[aria-label='Group rows by']") == "week", "the list follows"
    fpage.reload(); fpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert fpage.evaluate("() => window.__hopline.state.groupBy") == "week" and fpage.input_value("#groupBy") == "week"


def test_switching_grouping_off_still_lists_everything_and_a_bad_saved_value_is_ignored(ctx, mock):
    scene(mock)
    ctx.add_init_script("localStorage.setItem('hopline.prefs.v1', %s);" % json.dumps(json.dumps({"groupBy": "<b>decade</b>", "groupRows": True})))
    page = ctx.new_page()
    page.goto(__import__("conftest").PAGE_URL); page.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert page.evaluate("() => window.__hopline.state.groupBy") == "party"


def test_as_one_vertex_makes_a_group_of_that_period_that_says_so(tpage, mock):
    start(tpage, mock, trace=True)
    by(tpage, "month")
    wrap = tpage.locator("#inspBody .walletsec .groupwrap").filter(has_text="5 transactions in Mar 2022")
    wrap.locator(".groupacts .showbtn >> text=as one").click(); idle(tpage); settle(tpage)
    spec = tpage.evaluate("() => [...window.__hopline.state.trace.groups.values()].map(g => ({ kind: g.kind, bucket: g.bucket, members: g.members.length, dir: g.dir }))")
    assert spec == [{"kind": "time", "bucket": "2022-03", "members": 5, "dir": "prev"}]
    texts = tpage.evaluate("""() => { const r = window.__hopline.renderer, ctx = r.ctx, orig = ctx.fillText.bind(ctx), seen = [];
        ctx.fillText = (t, ...a) => { seen.push(String(t)); return orig(t, ...a); }; r.draw(); ctx.fillText = orig; return seen; }""")
    assert "5 transactions in Mar 2022" in texts
    tpage.evaluate("() => window.__hopline.setSel(['grp:1'])"); settle(tpage)
    assert "Mar 2022 (UTC)" in tpage.inner_text("#inspBody")


def test_a_period_group_is_saved_and_checked_when_the_workspace_is_opened_again(tpage, mock, tmp_path):
    start(tpage, mock, trace=True)
    by(tpage, "month")
    tpage.locator("#inspBody .walletsec .groupwrap").filter(has_text="4 transactions in Apr 2022").locator(".groupacts .showbtn >> text=as one").click(); idle(tpage); settle(tpage)
    tpage.evaluate("() => { document.getElementById('exportMenu').open = true; document.getElementById('exportVisible').checked = false; }")
    with tpage.expect_download() as dl:
        tpage.click("[data-export=json]")
    p = tmp_path / "ws.json"; dl.value.save_as(p)
    saved = json.loads(p.read_text(encoding="utf-8"))
    assert saved["view"]["trace"]["groups"][0]["kind"] == "time" and saved["view"]["trace"]["groups"][0]["bucket"] == "2022-04"
    tpage.click("#btnClear"); tpage.click("#btnClear"); settle(tpage)
    tpage.set_input_files("#fileImport", str(p)); idle(tpage); settle(tpage)
    g = tpage.evaluate("() => [...window.__hopline.state.trace.groups.values()].map(g => ({ kind: g.kind, bucket: g.bucket }))")
    assert g == [{"kind": "time", "bucket": "2022-04"}]
    saved["view"]["trace"]["groups"][0]["bucket"] = "<b>April</b>"
    p.write_text(json.dumps(saved), encoding="utf-8")
    tpage.click("#btnClear"); tpage.click("#btnClear"); settle(tpage)
    tpage.set_input_files("#fileImport", str(p)); idle(tpage); settle(tpage)
    g = tpage.evaluate("() => [...window.__hopline.state.trace.groups.values()].map(g => ({ kind: g.kind, bucket: g.bucket || null }))")
    assert g == [{"kind": "picked", "bucket": None}], "a period that is not one is not believed: it is just a group you picked"


def test_the_list_behind_an_arrow_groups_by_period_too(tpage, mock):
    scene(mock)
    open_query(tpage, W); settle(tpage)
    tpage.evaluate("() => { window.__hopline.state.groupBy = 'month'; window.__hopline.state.groupRows = true; }")
    click_handle(tpage, W_ID, "left"); settle(tpage)
    assert tpage.is_visible("#ctxMenu.choosing")
    text = tpage.inner_text("#ctxMenu")
    assert "5 transactions in Mar 2022" in text and "4 transactions in Apr 2022" in text
    assert tpage.locator("#ctxMenu select[aria-label='Group rows by']").count() == 1
