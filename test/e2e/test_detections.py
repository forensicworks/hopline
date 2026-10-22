"""Detections: every pattern the analysis found, oldest first with its reason, filterable, and a click goes to the transaction."""
import time

import pytest

from chains import peel_chain, tid
from helpers import idle, open_query, settle
from test_pattern_flags import CHAIN_LABEL, scene
from test_trace import shown


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def open_list(page):
    page.evaluate("() => { document.getElementById('anSection').open = true; document.getElementById('detSection').open = true; }")
    page.wait_for_selector("#detList .detrow")


def rows(page):
    return page.evaluate("() => [...document.querySelectorAll('#detList .detrow')].map((b) => ({ id: b.dataset.id, text: b.innerText, on: b.classList.contains('on') }))")


def chips(page):
    return page.evaluate("() => [...document.querySelectorAll('#detKinds button')].map((b) => ({ text: b.textContent.trim(), on: b.getAttribute('aria-pressed') === 'true' }))")


def many_chains(page, mock, count):
    for k in range(count):
        first = 100 + 5 * k
        peel_chain(mock, 4, first)
        open_query(page, tid(first))
        page.evaluate("(id) => window.__hopline.autoExpand(id, { dir: 'next', hops: 4, follow: 'largest' })", "tx:" + tid(first)); idle(page)
    page.uncheck("#focusOn"); settle(page)


def delete(page, vertex):
    page.evaluate("(id) => window.__hopline.setSel([id])", vertex); settle(page)
    page.locator("#cv").focus(); page.keyboard.press("Shift+Delete"); idle(page); settle(page)


def utc(n):
    return time.strftime("%Y-%m-%d %H:%M", time.gmtime(1650000000 + n * 600)) + " UTC"


def test_the_list_has_every_detection_oldest_first_and_says_why(fpage, mock):
    scene(fpage, mock)
    open_list(fpage)
    r = rows(fpage)
    assert [x["id"] for x in r] == ["tx:" + tid(n) for n in (10, 11, 12, 13, 14, 15, 30, 50)], "time order, one row per pattern"
    assert fpage.inner_text("#detCount") == "(8)"
    step = next(x for x in r if x["id"] == "tx:" + tid(12))["text"]
    assert utc(12) in step and "PEEL 3/6 · " + CHAIN_LABEL in step and "Pays" in step and "passes" in step and "step 3 of 6 in " + CHAIN_LABEL in step
    consol = next(x for x in r if x["id"] == "tx:" + tid(30))["text"]
    assert "CONSOL 6→1" in consol and "Consolidation: 6 inputs" in consol
    assert "COINJOIN?" in next(x for x in r if x["id"] == "tx:" + tid(50))["text"]
    assert "8 detections" in fpage.inner_text("#detFoot") and "none of them proves anything" in fpage.inner_text("#detFoot")


def test_it_lists_what_the_graph_flags_even_when_a_kind_is_switched_off_on_the_graph(fpage, mock):
    scene(fpage, mock)
    fpage.evaluate("() => { document.getElementById('anFlags').closest('details').open = true; }")
    fpage.uncheck("#anKPeel"); fpage.uncheck("#anFlags"); settle(fpage)
    open_list(fpage)
    assert len(rows(fpage)) == 8, "what is drawn on the graph is a display choice; the list is what was found"


def test_the_kind_buttons_show_their_counts_and_narrow_the_list(fpage, mock):
    scene(fpage, mock)
    open_list(fpage)
    assert [c["text"] for c in chips(fpage)] == ["All 8", "PEEL 6", "CONSOL 1", "COINJOIN? 1"], "a kind with nothing found has no button"
    assert chips(fpage)[0]["on"]
    fpage.click("#detKinds button:has-text('CONSOL')")
    assert [x["id"] for x in rows(fpage)] == ["tx:" + tid(30)] and [c["on"] for c in chips(fpage)] == [False, False, True, False]
    fpage.click("#detKinds button:has-text('PEEL')")
    assert len(rows(fpage)) == 6 and all("PEEL" in x["text"] for x in rows(fpage))
    fpage.click("#detKinds button:has-text('All')")
    assert len(rows(fpage)) == 8


def test_every_peel_chain_is_listed_not_only_the_first_six(fpage, mock):
    many_chains(fpage, mock, 8)
    an = fpage.inner_text("#anFindings").lower()
    chains = an.split("possible peel chains")[1].split("address clusters")[0]
    assert "all 8 chains in the detections list" in chains and "… and" not in chains, "the short list says where the rest is"
    assert chains.count(" · 4 transactions") == 6, "six are shown there"
    fpage.click("#anFindings button:has-text('All 8 chains')")
    assert fpage.evaluate("() => document.getElementById('detSection').open")
    fpage.wait_for_selector("#detList .detrow")
    assert [c["text"] for c in chips(fpage)] == ["All 32", "PEEL 32"] and chips(fpage)[1]["on"], "it opens on the peel steps"
    assert len(rows(fpage)) == 32
    opts = fpage.evaluate("() => [...document.querySelectorAll('#detChain option')].map((o) => ({ v: o.value, t: o.textContent }))")
    assert len(opts) == 9 and opts[0]["t"] == "All peel chains (8)" and all("4 transactions" in o["t"] for o in opts[1:])
    fpage.select_option("#detChain", opts[3]["v"])
    r = rows(fpage)
    assert len(r) == 4 and all(opts[3]["v"] in x["text"] for x in r)
    fpage.select_option("#detChain", "")
    assert len(rows(fpage)) == 32


def test_a_click_selects_the_transaction_and_brings_it_to_the_middle(fpage, mock):
    scene(fpage, mock)
    fpage.evaluate("() => window.__hopline.setSel([])"); settle(fpage)
    open_list(fpage)
    target = "tx:" + tid(13)
    fpage.click("#detList .detrow[data-id='%s']" % target); settle(fpage)
    assert fpage.evaluate("() => [...window.__hopline.state.selected]") == [target]
    off = fpage.evaluate("""(id) => { const r = window.__hopline.renderer, p = r.positionOf(id);
        return [Math.abs(r.view.x + p.x * r.view.k - r.w / 2), Math.abs(r.view.y + p.y * r.view.k - (r.h - (r.insets.bottom || 0)) / 2)]; }""", target)
    assert off[0] < 3 and off[1] < 3, "centred: %s" % off
    assert [x["id"] for x in rows(fpage) if x["on"]] == [target], "the row of the selected transaction is marked"
    fpage.evaluate("() => window.__hopline.setSel([])"); settle(fpage)
    assert not any(x["on"] for x in rows(fpage))


def test_in_a_trace_a_click_on_a_transaction_that_is_not_shown_adds_it_and_undo_takes_it_back(tpage, mock):
    peel_chain(mock, 6)
    open_query(tpage, tid(10))
    tpage.evaluate("(id) => window.__hopline.autoExpand(id, { dir: 'next', hops: 6, follow: 'largest' })", "tx:" + tid(10)); idle(tpage); settle(tpage)
    target = "tx:" + tid(13)
    tpage.evaluate("(id) => window.__hopline.setSel([id])", target); settle(tpage)
    tpage.click("#traceHide"); settle(tpage)
    assert target not in shown(tpage)
    n = len(shown(tpage))
    open_list(tpage)
    tpage.click("#detList .detrow[data-id='%s']" % target); idle(tpage); settle(tpage)
    assert target in shown(tpage) and len(shown(tpage)) == n + 1
    assert tpage.evaluate("() => [...window.__hopline.state.selected]") == [target]
    assert "Added to the trace as another starting point" in tpage.inner_text("#toast")


def test_the_arrow_keys_move_between_rows(fpage, mock):
    scene(fpage, mock)
    open_list(fpage)
    fpage.focus("#detList .detrow >> nth=0")
    fpage.keyboard.press("ArrowDown"); fpage.keyboard.press("ArrowDown")
    assert fpage.evaluate("() => document.activeElement.dataset.id") == "tx:" + tid(12)
    fpage.keyboard.press("ArrowUp")
    assert fpage.evaluate("() => document.activeElement.dataset.id") == "tx:" + tid(11)
    fpage.keyboard.press("Enter"); settle(fpage)
    assert fpage.evaluate("() => [...window.__hopline.state.selected]") == ["tx:" + tid(11)]


def test_select_these_selects_what_is_listed_and_copy_list_copies_it(fpage, mock):
    scene(fpage, mock)
    fpage.evaluate("""() => { window.__copied = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__copied.push(t); return Promise.resolve(); } } }); }""")
    open_list(fpage)
    fpage.click("#detKinds button:has-text('PEEL')")
    assert fpage.inner_text("#detSelectAll") == "Select these 6"
    fpage.click("#detSelectAll"); settle(fpage)
    assert sorted(fpage.evaluate("() => [...window.__hopline.state.selected]")) == sorted("tx:" + tid(n) for n in range(10, 16))
    fpage.click("#detCopy")
    text = fpage.evaluate("() => window.__copied[0]")
    lines = text.split("\n")
    assert lines[0] == "Time\tTransaction\tPattern\tWhy" and len(lines) == 7
    assert lines[3].split("\t")[:3] == [utc(12), tid(12), "PEEL 3/6 " + CHAIN_LABEL]
    assert all(len(x.split("\t")) == 4 for x in lines)
    assert "Copied the list of 6 detections" in fpage.inner_text("#toast")


def test_a_copy_icon_copies_the_full_transaction_id(fpage, mock):
    scene(fpage, mock)
    fpage.evaluate("""() => { window.__copied = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__copied.push(t); return Promise.resolve(); } } }); }""")
    open_list(fpage)
    fpage.click("#detList .rowcopy >> nth=2 >> .copybtn")
    assert fpage.evaluate("() => window.__copied") == [tid(12)], "no prefix, not shortened"


def test_the_list_follows_the_workspace(fpage, mock):
    fpage.evaluate("() => { document.getElementById('anSection').open = true; document.getElementById('detSection').open = true; }")
    fpage.wait_for_timeout(100)
    assert rows(fpage) == [] and "Load transactions" in fpage.inner_text("#detFoot") and fpage.inner_text("#detCount") == ""
    scene(fpage, mock)
    fpage.wait_for_selector("#detList .detrow")
    assert len(rows(fpage)) == 8 and "(8)" in fpage.inner_text("#detCount")
    delete(fpage, "tx:" + tid(30))
    assert len(rows(fpage)) == 7 and [c["text"] for c in chips(fpage)] == ["All 7", "PEEL 6", "COINJOIN? 1"], "a kind that is gone loses its button"
    fpage.click("#detKinds button:has-text('COINJOIN')")
    delete(fpage, "tx:" + tid(50))
    assert chips(fpage)[0]["on"] and len(rows(fpage)) == 6, "when the chosen kind is gone the list goes back to All"


def test_long_lists_are_cut_at_400_rows_and_say_so(fpage):
    fpage.evaluate("""() => { const h = window.__hopline, g = h.state.graph;
        for (let i = 0; i < 450; i++) {
          const txid = (1000 + i).toString(16).padStart(64, 'c');
          g.addTx({ txid, fee: 200, weight: 800, status: { confirmed: true, block_height: 800000 + i, block_time: 1650000000 + i * 600 },
            vin: Array.from({ length: 5 }, (_, k) => ({ txid: 'ab'.repeat(32), vout: i * 5 + k, is_coinbase: false, prevout: { scriptpubkey_address: 'bc1qdet' + i + 'k' + k, scriptpubkey_type: 'v0_p2wpkh', value: 10000 } })),
            vout: [{ scriptpubkey_address: 'bc1qdetsink' + i, scriptpubkey_type: 'v0_p2wpkh', value: 49000 }] });
        }
        h.refresh(); }""")
    fpage.wait_for_timeout(300)
    open_list(fpage)
    assert len(rows(fpage)) == 400 and "The first 400 of 450" in fpage.inner_text("#detFoot")
    assert fpage.inner_text("#detSelectAll") == "Select these 450", "Select these and Copy list still take all of them"
