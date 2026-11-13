"""Update from the chain: a file (or a session) shows the chain as it was when it was made; the button, the bar after an old file and the wallet's own button ask the server again about
what can have changed (new payments, a transaction that confirmed, an output that was spent), never from the cache, and never by themselves unless "Update from the chain when I open a file" is on."""
import json
from datetime import datetime, timedelta, timezone

import pytest

from chains import IN, OUT, addr, tid, tx
from conftest import NORMAL
from helpers import idle, open_query, settle

W = "addr:" + addr("w")
STATE = "window.__hopline.state"


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def wallet_stats(mock, txs, chain_n, mempool_n):
    a = addr("w")
    mock.routes["/address/" + a] = {"address": a, "chain_stats": {"tx_count": chain_n, "funded_txo_sum": 1000 * chain_n, "spent_txo_sum": 0},
                                    "mempool_stats": {"tx_count": mempool_n, "funded_txo_sum": 1000 * mempool_n, "spent_txo_sum": 0}}
    mock.routes["/address/" + a + "/txs"] = [mock.routes["/tx/" + tid(n)] for n in txs]


def chain_then(mock):
    """The chain when the file was made: w has two settled transactions and an unconfirmed one (4); tx 1 has an output that nobody has spent."""
    tx(mock, 1, [IN(90, 0, "src", 1000)], [OUT("w", 900), OUT("other", 50)], spent={0: 2})
    tx(mock, 2, [IN(1, 0, "w", 900)], [OUT("dest", 800)])
    tx(mock, 4, [IN(91, 0, "src4", 700)], [OUT("w", 600)])
    mock.routes["/tx/" + tid(4)]["status"] = {"confirmed": False}
    wallet_stats(mock, [4, 2, 1], 2, 1)


def chain_now(mock):
    """Two hours later: a new payment to w (5, the newest), 4 is in a block, and tx 2's output was spent (by 6)."""
    tx(mock, 5, [IN(92, 0, "src5", 500)], [OUT("w", 400)])
    mock.routes["/tx/" + tid(4)]["status"] = {"confirmed": True, "block_height": 700004, "block_time": 1650002400}
    mock.routes["/tx/" + tid(2) + "/outspends"] = [{"spent": True, "txid": tid(6), "vin": 0, "status": {"confirmed": True, "block_height": 700006, "block_time": 1650003600}}]
    wallet_stats(mock, [5, 4, 2, 1], 3, 0)


def export_json(page, path):
    page.click("summary:has-text('Export')")
    with page.expect_download() as d:
        page.click("[data-export=json]")
    d.value.save_as(str(path))
    page.evaluate("() => { const m = document.getElementById('exportMenu'); if (m) m.open = false; }")


def made_ago(path, **delta):
    """Say the file was made `delta` ago (or, with nothing, take the time out): the file holds the moment it was exported."""
    d = json.loads(path.read_text(encoding="utf-8"))
    if delta:
        d["exported"] = (datetime.now(timezone.utc) - timedelta(**delta)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    else:
        d.pop("exported", None)
    path.write_text(json.dumps(d), encoding="utf-8")


def build_file(page, mock, path, **ago):
    """Open tx 1, show w beside it, read w's history (and mark it complete as the page does), open tx 2 with its outspends, label and tag w, and export; then empty the page."""
    chain_then(mock)
    open_query(page, tid(1)); settle(page)
    page.evaluate("() => window.__hopline.traceExpand('tx:' + '%s', 'next')" % tid(1)); idle(page); settle(page)
    page.evaluate("""(a) => window.__hopline.state.explorer.expandAddress(a, { pages: 4, cap: 0 }).then((r) => { const n = window.__hopline.state.graph.nodes.get('addr:' + a);
        n.histNext = r.last || null; n.histDone = !r.last && !r.truncated; n.label = 'my label'; n.tag = 'EXCH'; })""", addr("w"))
    open_query(page, tid(2)); settle(page)
    assert page.evaluate("(id) => window.__hopline.state.trace.shown.has(id)", W), "w is on the trace"
    export_json(page, path)
    made_ago(path, **(ago or {"hours": 2}))
    page.click("#btnClear"); page.click("#btnClear"); settle(page)
    assert page.evaluate(STATE + ".graph.nodes.size") == 0


def import_file(page, path):
    page.set_input_files("#fileImport", str(path)); page.wait_for_timeout(900); idle(page); settle(page)


def node(page, nid):
    return page.evaluate("(id) => { const n = %s.graph.nodes.get(id); return n ? JSON.parse(JSON.stringify(n)) : null; }" % STATE, nid)


def toast(page):
    return page.evaluate("() => document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent")


def asked(mock, since):
    return [p for _, p in mock.requests[since:]]


def test_an_old_file_opens_with_no_request_and_a_bar_that_says_what_updating_costs(tpage, mock, tmp_path):
    f = tmp_path / "old.json"
    build_file(tpage, mock, f)
    chain_now(mock)
    before = len(mock.requests)
    import_file(tpage, f)
    assert asked(mock, before) == [], "opening a file asks the server nothing"
    assert tpage.is_visible("#staleBar")
    text = tpage.text_content("#staleText")
    assert "2 hours ago" in text and "1 wallet" in text and "1 unconfirmed transaction" in text and "transactions with an output not known to be spent" in text, text
    assert tpage.is_enabled("#btnUpdate")
    assert not tpage.is_visible("#updateChip")
    assert node(tpage, tid_id(5)) is None, "the new payment is not in the file"


def tid_id(n):
    return "tx:" + tid(n)


def test_pressing_the_bar_reads_the_chain_again_and_brings_in_what_happened_without_touching_what_was_written(tpage, mock, tmp_path):
    f = tmp_path / "old.json"
    build_file(tpage, mock, f)
    chain_now(mock)
    import_file(tpage, f)
    before, undo = len(mock.requests), tpage.evaluate(STATE + ".undoLoads.length")
    tpage.click("#staleYes"); idle(tpage); settle(tpage)
    ps = asked(mock, before)
    assert ps.count("/address/" + addr("w")) == 1 and ps.count("/address/" + addr("w") + "/txs") == 1, ps
    assert "/tx/" + tid(4) not in ps, "the unconfirmed one came with the wallet's newest page: it is not asked for a second time"
    assert "/tx/" + tid(4) + "/outspends" in ps, "but what spends its outputs is read again: %s" % ps
    assert "/tx/" + tid(2) + "/outspends" in ps, "and the transaction with an output that nobody had spent"
    assert len(ps) <= 8, ps
    assert not tpage.is_visible("#staleBar")
    assert node(tpage, tid_id(5))["loaded"] is True, "the new payment is in"
    assert node(tpage, tid_id(4))["confirmed"] is True and node(tpage, tid_id(4))["height"] == 700004
    spent = tpage.evaluate("() => { const e = window.__hopline.state.graph.edges.get('out:%s:0'); return e && { spent: e.spent, by: e.spentBy && e.spentBy.txid }; }" % tid(2))
    assert spent == {"spent": True, "by": tid(6)}, spent
    w = node(tpage, W)
    assert w["label"] == "my label" and w["tag"] == "EXCH", "what was written is untouched"
    assert w["txCount"] == 3 and w["histDone"] is True, "its totals are current and its history is complete again"
    t = toast(tpage)
    assert "1 new transaction in 1 wallet" in t and "1 transaction confirmed" in t and "1 output now spent" in t, t
    assert tpage.evaluate("(id) => window.__hopline.state.trace.shown.has(id)", tid_id(5)), "the new payment is on the trace, beside its wallet"
    assert "not on the trace" not in t
    chip = tpage.text_content("#updateChipText")
    assert tpage.is_visible("#updateChip") and "1 new" in chip and "1 confirmed" in chip and "1 spent" in chip and "UTC" in chip, chip
    tpage.click("#updateChipSelect"); settle(tpage)
    assert tpage.evaluate("() => [...window.__hopline.state.selected]") == [tid_id(5)], "Select the new"
    assert tpage.evaluate(STATE + ".undoLoads.length") == undo + 1, "one step in Undo load"
    tpage.click("#btnUndoLoad"); idle(tpage); settle(tpage)
    assert node(tpage, tid_id(5)) is None and node(tpage, tid_id(4))["confirmed"] is False, "Undo load puts the file back as it was opened"
    assert node(tpage, W)["label"] == "my label"


def test_the_server_is_asked_again_even_when_the_browser_still_holds_an_answer(tpage, mock, tmp_path):
    """The same page keeps its answers for five minutes: an update that used them would find nothing."""
    f = tmp_path / "old.json"
    build_file(tpage, mock, f)
    assert any(p == "/address/" + addr("w") for _, p in mock.requests), "the wallet was read while the file was made, and the page still holds that answer"
    chain_now(mock)
    import_file(tpage, f)
    tpage.click("#staleYes"); idle(tpage); settle(tpage)
    assert node(tpage, tid_id(5))["loaded"] is True


def test_not_now_closes_the_bar_and_nothing_is_asked_but_the_button_is_still_there(tpage, mock, tmp_path):
    f = tmp_path / "old.json"
    build_file(tpage, mock, f)
    chain_now(mock)
    import_file(tpage, f)
    before = len(mock.requests)
    tpage.click("#staleNo"); settle(tpage)
    assert not tpage.is_visible("#staleBar") and asked(mock, before) == []
    assert tpage.is_enabled("#btnUpdate")
    tpage.click("#btnUpdate"); idle(tpage); settle(tpage)
    assert node(tpage, tid_id(5))["loaded"] is True, "the top bar button does the same"


def test_a_file_made_a_moment_ago_or_one_that_does_not_say_when_gets_no_bar(tpage, mock, tmp_path):
    f = tmp_path / "recent.json"
    build_file(tpage, mock, f, minutes=2)
    import_file(tpage, f)
    assert not tpage.is_visible("#staleBar"), "two minutes is not old"
    tpage.click("#btnClear"); tpage.click("#btnClear"); settle(tpage)
    made_ago(f)                                                              # takes the time out
    import_file(tpage, f)
    assert not tpage.is_visible("#staleBar"), "a file that does not say when it was made is not called old"


def test_nothing_changed_is_said_and_costs_no_step_in_undo_load(tpage, mock, tmp_path):
    f = tmp_path / "old.json"
    build_file(tpage, mock, f)
    import_file(tpage, f)                                                    # the chain is as the file says
    undo = tpage.evaluate(STATE + ".undoLoads.length")
    tpage.click("#staleYes"); idle(tpage); settle(tpage)
    t = toast(tpage)
    assert "Nothing has changed" in t, t
    assert tpage.evaluate(STATE + ".undoLoads.length") == undo, "nothing changed: nothing to take back"
    assert not tpage.is_visible("#updateChip")
    assert node(tpage, tid_id(5)) is None


def test_the_setting_is_off_for_a_new_visitor_is_remembered_and_opens_a_file_updated_without_asking(newpage, mock, tmp_path):
    assert not newpage.is_checked("#autoUpdate"), "off by default"
    assert newpage.evaluate(STATE + ".autoUpdate") is False
    newpage.evaluate("() => { for (const id of ['autoBalance', 'autoHistory']) { const c = document.getElementById(id); c.checked = false; c.dispatchEvent(new Event('change')); } }")
    f = tmp_path / "old.json"
    build_file(newpage, mock, f)
    chain_now(mock)
    newpage.evaluate("() => { const c = document.getElementById('autoUpdate'); c.checked = true; c.dispatchEvent(new Event('change')); }")
    assert json.loads(newpage.evaluate("() => localStorage.getItem('hopline.prefs.v1')"))["autoUpdate"] is True
    import_file(newpage, f)
    assert not newpage.is_visible("#staleBar"), "no question when the setting is on"
    assert node(newpage, tid_id(5))["loaded"] is True and node(newpage, tid_id(4))["confirmed"] is True, "it was updated as the file opened"
    assert "1 new transaction" in toast(newpage)
    newpage.reload(); newpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert newpage.is_checked("#autoUpdate") and newpage.evaluate(STATE + ".autoUpdate") is True, "remembered"


def test_with_the_setting_on_a_recent_file_is_still_left_alone(newpage, mock, tmp_path):
    newpage.evaluate("() => { for (const id of ['autoBalance', 'autoHistory']) { const c = document.getElementById(id); c.checked = false; c.dispatchEvent(new Event('change')); } }")
    f = tmp_path / "recent.json"
    build_file(newpage, mock, f, minutes=3)
    chain_now(mock)
    newpage.evaluate("() => { const c = document.getElementById('autoUpdate'); c.checked = true; c.dispatchEvent(new Event('change')); }")
    before = len(mock.requests)
    import_file(newpage, f)
    assert asked(mock, before) == [] and node(newpage, tid_id(5)) is None


def test_a_wallet_has_its_own_button_and_an_unconfirmed_transaction_its_own(tpage, mock, tmp_path):
    chain_then(mock)
    open_query(tpage, tid(1)); settle(tpage)
    tpage.evaluate("""(a) => window.__hopline.state.explorer.expandAddress(a, { pages: 4, cap: 0 }).then((r) => { const n = window.__hopline.state.graph.nodes.get('addr:' + a);
        n.histNext = r.last || null; n.histDone = !r.last && !r.truncated; })""", addr("w"))
    chain_now(mock)
    tpage.evaluate("(id) => window.__hopline.setSel([id])", W); settle(tpage)
    b = tpage.locator("#inspBody button:has-text('Check for new transactions')").first
    assert b.is_visible(), "a wallet whose totals were read has the button, though Load history is off"
    before = len(mock.requests)
    b.click(); idle(tpage); settle(tpage)
    ps = asked(mock, before)
    assert ps.count("/address/" + addr("w")) == 1 and ps.count("/address/" + addr("w") + "/txs") == 1 and not any(p.startswith("/tx/") for p in ps if p.endswith("/outspends")), "only that wallet: %s" % ps
    assert node(tpage, tid_id(5))["loaded"] is True
    tpage.evaluate("(id) => window.__hopline.setSel([id])", tid_id(4)); settle(tpage)
    assert node(tpage, tid_id(4))["confirmed"] is True, "the check of the wallet read it again too, from the history"
    assert tpage.locator("button:has-text('Check for confirmation')").count() == 0, "a confirmed transaction has no such button"


def test_an_unconfirmed_transaction_can_be_asked_about_on_its_own(tpage, mock):
    chain_then(mock)
    open_query(tpage, tid(4)); settle(tpage)
    assert node(tpage, tid_id(4))["confirmed"] is False
    mock.routes["/tx/" + tid(4)]["status"] = {"confirmed": True, "block_height": 700004, "block_time": 1650002400}
    b = tpage.locator("button:has-text('Check for confirmation')").first
    assert b.is_visible()
    before = len(mock.requests)
    b.click(); idle(tpage); settle(tpage)
    ps = asked(mock, before)
    assert ps == ["/tx/" + tid(4), "/tx/" + tid(4) + "/outspends"], ps
    assert node(tpage, tid_id(4))["confirmed"] is True
    assert tpage.locator("button:has-text('Check for confirmation')").count() == 0


def test_the_update_button_is_off_on_an_empty_canvas_and_the_request_limit_is_kept(tpage, mock, tmp_path):
    assert tpage.is_disabled("#btnUpdate")
    f = tmp_path / "old.json"
    build_file(tpage, mock, f)
    chain_now(mock)
    import_file(tpage, f)
    tpage.evaluate(STATE + ".capReq = 2")
    before = len(mock.requests)
    tpage.click("#staleYes"); idle(tpage); settle(tpage)
    assert len(asked(mock, before)) <= 2, asked(mock, before)
    assert "request limit" in toast(tpage)


def test_the_update_button_is_an_icon_with_its_name_and_leaves_the_box_its_whole_placeholder_on_one_row_at_1366(tpage, mock):
    """The top bar has no spare room: a labelled button pushed the placeholder of the Add box out at 1400 px and the bar onto a second row at 1280."""
    assert tpage.inner_text("#btnUpdate").strip() == "↻" and tpage.get_attribute("#btnUpdate", "aria-label") == "Update from the chain"
    assert tpage.get_attribute("#btnUpdate", "title").startswith("Update from the chain")
    tpage.set_viewport_size({"width": 1366, "height": 800})
    open_query(tpage, NORMAL["txid"]); settle(tpage)
    assert tpage.get_attribute("#q", "placeholder") == "Add up to 10 IDs or addresses"
    room = tpage.evaluate("""() => { const q = document.getElementById('q'), cs = getComputedStyle(q), cv = document.createElement('canvas').getContext('2d');
        cv.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
        return q.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - cv.measureText(q.placeholder).width; }""")
    assert room >= 0, "the placeholder is cut off by %d px at 1366 px" % -room
    height = tpage.evaluate("() => document.getElementById('top').getBoundingClientRect().height")
    assert height < 60, "the top bar is one row at 1366 px (%d px high)" % height
