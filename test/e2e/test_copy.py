"""Copy icons beside every address and transaction id, the multi-selection copy buttons and Ctrl+C on the graph."""
import pytest

from chains import addr, consolidation, tid
from conftest import ADDRESS, NORMAL
from helpers import click_node, idle, open_query, settle, toast_text, xy

NORMAL_ID = "tx:" + NORMAL["txid"]
OUT_ADDRS = [o["scriptpubkey_address"] for o in NORMAL["vout"]]
BIG_ADDR = max(NORMAL["vout"], key=lambda o: o["value"])["scriptpubkey_address"]


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def capture(page):
    """Replace the clipboard with a list the test can read (the real one cannot be read back without a permission prompt)."""
    page.evaluate("""() => {
      window.__copied = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__copied.push(t); return Promise.resolve(); } } });
    }""")


def copied(page):
    return page.evaluate("() => window.__copied")


def select(page, ids):
    page.evaluate("(ids) => window.__orion.setSel(ids)", ids); settle(page)


def opened(fpage):
    open_query(fpage, NORMAL["txid"])
    capture(fpage)


def test_the_transaction_header_has_a_copy_icon_that_copies_the_full_id(fpage):
    opened(fpage)
    select(fpage, [NORMAL_ID])
    btn = fpage.locator("#inspBody .idrow .copybtn")
    assert btn.count() == 1 and btn.get_attribute("title") == "Copy transaction id"
    btn.click()
    assert copied(fpage) == [NORMAL["txid"]], "the whole id, not the shortened one on screen"
    assert "Copied transaction id" in toast_text(fpage)


def test_the_address_header_copies_the_address_and_not_its_label(fpage):
    opened(fpage)
    fpage.evaluate("([id, label]) => { window.__orion.state.graph.nodes.get(id).label = label; window.__orion.refresh(); }", ["addr:" + BIG_ADDR, "Alice <b>exchange</b>"])
    select(fpage, ["addr:" + BIG_ADDR])
    fpage.click("#inspBody .idrow .copybtn")
    assert copied(fpage) == [BIG_ADDR]
    assert fpage.locator("#inspBody b, #inspBody img, #inspBody script").count() == 0


def test_every_address_and_transaction_in_the_lists_has_its_own_icon(fpage):
    opened(fpage)
    select(fpage, [NORMAL_ID])
    rows = fpage.locator("#inspBody .rowcopy")
    n = rows.count()
    assert n >= 2 + len(NORMAL["vin"]), n                                    # the outputs and the inputs
    titles = fpage.eval_on_selector_all("#inspBody .rowcopy .linkrow", "els => els.map(e => e.title)")
    assert all(t.startswith(("addr:", "tx:")) for t in titles)
    for i in range(n):                                                       # each icon copies the id of its own row, without the "addr:" or "tx:" prefix
        row_title = rows.nth(i).locator(".linkrow").get_attribute("title").split(" ")[0]
        rows.nth(i).locator(".copybtn").click()
        assert copied(fpage)[-1] == row_title.split(":", 1)[1]
    assert fpage.evaluate("() => [...window.__orion.state.selected]") == [NORMAL_ID], "copying is not a click on the row"
    assert fpage.evaluate("() => window.__orion.state.focus") == NORMAL_ID


def test_the_bar_under_the_graph_copies_the_vertex_it_shows(fpage):
    opened(fpage)
    assert fpage.is_visible("#stepCopy") and fpage.get_attribute("#stepCopy", "title") == "Copy transaction id"
    fpage.click("#stepCopy")
    assert copied(fpage) == [NORMAL["txid"]]
    fpage.evaluate("(id) => window.__orion.navigate(id, { light: true })", "addr:" + BIG_ADDR); idle(fpage); settle(fpage)       # light: no history request, the mock has none for it
    assert fpage.get_attribute("#stepCopy", "title") == "Copy address"
    fpage.click("#stepCopy")
    assert copied(fpage)[-1] == BIG_ADDR


def test_the_previous_and_next_lists_have_icons_too(fpage):
    opened(fpage)
    fpage.click("#stepNext")
    wraps = fpage.locator("#stepMenu .steprowwrap")
    assert wraps.count() >= 1
    expected = fpage.eval_on_selector_all("#stepMenu .steprowwrap .steprow", "els => els.map(e => e.title.split(':').slice(1).join(':'))")
    wraps.first.locator(".copybtn").click()
    assert copied(fpage) == [expected[0]]
    assert fpage.evaluate("() => window.__orion.state.focus") == NORMAL_ID, "the click on the icon did not step anywhere"
    assert fpage.is_visible("#stepMenu")


def test_balances_and_clusters_list_their_addresses_with_icons(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30))
    capture(fpage)
    k1 = "addr:" + addr("k1")
    select(fpage, [k1])
    fpage.click("#inspBody button:has-text('Copy 6 addresses')")
    lines = copied(fpage)[-1].split("\n")
    assert len(lines) == 6 and all(l.startswith("bc1q") for l in lines), lines
    assert fpage.locator("#inspBody .rowcopy").count() >= 6, "the member rows of the cluster"
    fpage.locator("#inspBody .rowcopy").first.locator(".copybtn").click()
    assert copied(fpage)[-1].startswith("bc1q") and ":" not in copied(fpage)[-1]


def test_the_balance_rows_have_icons(fpage, mock):
    from test_balances import BIG_ADDR as BIG, SMALL_ADDR as SMALL, stats
    open_query(fpage, NORMAL["txid"])
    capture(fpage)
    fpage.uncheck("#focusOn"); settle(fpage)
    stats(mock, BIG, 900000, 400000)
    stats(mock, SMALL, 200000, 150000)
    select(fpage, ["addr:" + BIG, "addr:" + SMALL])
    fpage.click("#inspBody button:has-text('Load 2 balances')"); idle(fpage); settle(fpage)
    rows = fpage.locator("#inspBody .rowcopy:has(.balrow)")
    assert rows.count() == 2, rows.count()
    rows.first.locator(".copybtn").click()
    assert copied(fpage)[-1] == BIG, "largest balance first, and its icon copies the whole address"


def test_several_selected_offer_copy_buttons_one_per_line(fpage):
    opened(fpage)
    ids = ["addr:" + a for a in OUT_ADDRS] + [NORMAL_ID]
    select(fpage, ids)
    fpage.click("#inspBody button:has-text('Copy %d addresses')" % len(OUT_ADDRS)) if len(OUT_ADDRS) > 1 else fpage.click("#inspBody button:has-text('Copy 1 address')")
    assert sorted(copied(fpage)[-1].split("\n")) == sorted(OUT_ADDRS)
    fpage.click("#inspBody button:has-text('Copy 1 transaction id')")
    assert copied(fpage)[-1] == NORMAL["txid"]


def test_the_menu_of_a_selection_copies_it_too(fpage):
    opened(fpage)
    ids = ["addr:" + a for a in OUT_ADDRS] + [NORMAL_ID]
    select(fpage, ids)
    p = xy(fpage, NORMAL_ID); fpage.mouse.click(p["x"], p["y"], button="right")
    fpage.click("#ctxMenu >> text=Copy 1 transaction id")
    assert copied(fpage)[-1] == NORMAL["txid"]


def test_ctrl_c_copies_the_selected_ids_and_leaves_the_panels_alone(fpage):
    opened(fpage)
    ids = ["addr:" + BIG_ADDR, NORMAL_ID]
    select(fpage, ids)
    side = fpage.evaluate("() => window.__orion.state.sideCollapsed")
    fpage.locator("#cv").focus(); fpage.keyboard.press("Control+c")
    assert copied(fpage) == [BIG_ADDR + "\n" + NORMAL["txid"]], "addresses first, then transactions"
    assert fpage.evaluate("() => window.__orion.state.sideCollapsed") == side, "Ctrl+C is not the C shortcut for the side panel"
    assert "Copied" in toast_text(fpage)


def test_ctrl_c_with_nothing_selected_does_nothing_and_text_selection_keeps_its_own_copy(fpage):
    opened(fpage)
    select(fpage, [])
    fpage.locator("#cv").focus(); fpage.keyboard.press("Control+c")
    assert copied(fpage) == [] and "Copied" not in toast_text(fpage)
    select(fpage, [NORMAL_ID])
    fpage.evaluate("() => { const r = document.createRange(); r.selectNodeContents(document.querySelector('#inspBody .mono')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }")
    fpage.keyboard.press("Control+c")
    assert copied(fpage) == [], "selected text is left to the browser's own copy"


def test_letter_shortcuts_do_not_fire_while_ctrl_or_alt_is_held(fpage):
    opened(fpage)
    st = fpage.evaluate("() => [window.__orion.state.boxMode, window.__orion.state.tbCollapsed, window.__orion.state.inspCollapsed]")
    fpage.locator("#cv").focus()
    for combo in ("Control+b", "Alt+t", "Control+d"):
        fpage.keyboard.press(combo)
    assert fpage.evaluate("() => [window.__orion.state.boxMode, window.__orion.state.tbCollapsed, window.__orion.state.inspCollapsed]") == st
    fpage.keyboard.press("b")
    assert fpage.evaluate("() => window.__orion.state.boxMode") is True, "the plain key still works"


def test_without_the_clipboard_api_the_old_way_is_used(fpage):
    opened(fpage)
    fpage.evaluate("""() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      window.__legacy = [];
      document.execCommand = (c) => { const ta = document.querySelector('textarea[readonly]'); window.__legacy.push([c, ta && ta.value]); return true; };
    }""")
    select(fpage, [NORMAL_ID])
    fpage.click("#inspBody .idrow .copybtn")
    assert fpage.evaluate("() => window.__legacy") == [["copy", NORMAL["txid"]]]
    assert "Copied" in toast_text(fpage) and fpage.locator("textarea[readonly]").count() == 0, "the helper field is removed again"


def test_a_failed_copy_says_so(fpage):
    opened(fpage)
    fpage.evaluate("""() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } });
      document.execCommand = () => false;
    }""")
    select(fpage, [NORMAL_ID])
    fpage.click("#inspBody .idrow .copybtn")
    fpage.wait_for_function("() => document.getElementById('toast').textContent.includes('Could not copy')")


def test_an_edge_can_be_copied(fpage):
    opened(fpage)
    fpage.uncheck("#focusOn"); settle(fpage)
    e = fpage.evaluate("() => { const e = [...window.__orion.state.graph.edges.values()].find(e => e.kind === 'out'); return { source: e.source, target: e.target, txid: e.txid }; }")
    a, b = xy(fpage, e["source"]), xy(fpage, e["target"])
    fpage.mouse.click((a["x"] + b["x"]) / 2, (a["y"] + b["y"]) / 2)
    fpage.wait_for_function("() => window.__orion.state.selectedEdge")
    fpage.click("#inspBody button:has-text('Copy txid')")
    assert copied(fpage) == [e["txid"]]


def test_the_rows_in_the_analysis_findings_copy_all_the_ids_of_a_chain_and_a_cluster(fpage, mock):
    from chains import peel_chain
    peel_chain(mock, 6)
    open_query(fpage, tid(10))
    capture(fpage)
    fpage.evaluate("(id) => window.__orion.autoExpand(id, { dir: 'next', hops: 5, follow: 'largest' })", "tx:" + tid(10)); idle(fpage); settle(fpage)
    row = fpage.locator("#anFindings .rowcopy:has(.linkrow[title^='Select the 6 transactions'])")
    assert row.count() == 1, fpage.inner_text("#anFindings")
    row.locator(".copybtn").click()
    assert copied(fpage)[-1].split(chr(10)) == [tid(10 + i) for i in range(6)], "plain transaction ids, one per line, in chain order"
