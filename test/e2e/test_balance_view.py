"""Which wallets hold funds: Colour by Balance, the Holding funds chip and group in the Findings, and the note after an update that says which wallets were emptied or received funds.

Five wallets receive from one transaction: a holds 80,000 sat, b once held 40,000 and spent all of it, c holds 5,000 (small: the default limit is 10,000), d was never asked about, and e holds 20,000.
"""
import json

import pytest

from chains import IN, OUT, addr, tid, tx
from helpers import idle, open_query, selected, settle

STATE = "window.__hopline.state"
HOLDS, SMALL, EMPTY, UNKNOWN, KIND_TX = "#3ddc97", "#a8c9b6", "#5f6b7a", "#9aa3ad", "#5b8def"


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def stats(mock, name, funded, spent, pending=0):
    a = addr(name)
    mock.routes["/address/" + a] = {"address": a, "chain_stats": {"tx_count": 1, "funded_txo_sum": funded, "spent_txo_sum": spent},
                                    "mempool_stats": {"tx_count": 1 if pending else 0, "funded_txo_sum": pending, "spent_txo_sum": 0}}


def scene(page, mock):
    """Open the transaction and show its wallets beside it. Only a, b, c and e have totals the server can give (until a test adds the others)."""
    tx(mock, 1, [IN(90, 0, "src", 200000)], [OUT("a", 80000), OUT("b", 40000), OUT("c", 5000), OUT("d", 30000), OUT("e", 20000)])
    stats(mock, "a", 80000, 0); stats(mock, "b", 40000, 40000); stats(mock, "c", 5000, 0); stats(mock, "e", 20000, 0)
    open_query(page, tid(1)); settle(page)
    page.evaluate("() => window.__hopline.traceExpand('tx:' + '%s', 'next')" % tid(1)); idle(page); settle(page)


def balance_mode(page):
    page.click("#sideTab")
    page.click("#colorSeg [data-color=balance]"); settle(page)


def ids_of(*names):
    return ["addr:" + addr(n) for n in names]


def read_balances(page, *names):
    """Select these wallets and press the button the details give (one request each)."""
    page.evaluate("(ids) => window.__hopline.setSel(ids)", ids_of(*names)); settle(page)
    page.click("#inspBody button:has-text('Load')"); idle(page); settle(page)
    page.evaluate("() => window.__hopline.setSel([])"); settle(page)


def look(page, name):
    """[fill colour, hollow] of a wallet as the canvas draws it now."""
    return page.evaluate("(id) => { const h = window.__hopline, st = h.renderer.data.style, n = h.state.graph.nodes.get(id); return [st.nodeColor(n), st.hollow(n)]; }", "addr:" + addr(name))


def legend(page):
    return page.evaluate("() => [...document.querySelectorAll('#legend .item')].map((i) => i.textContent)")


def chip(page):
    c = page.locator("#findStrip [data-key=holding]")
    return c.inner_text().replace("\n", " ") if c.count() else None


def open_group(page):
    page.click("#findStrip [data-key=holding]"); settle(page)


def group_rows(page):
    """The Holding funds group as [(left text, right text)]: the four counts, then the wallets that hold funds."""
    return page.evaluate("""() => { const box = document.querySelector('#anFindings [data-group=holding]'); if (!box) return null; const out = [];
        for (let n = box.nextElementSibling; n && !n.hasAttribute('data-group'); n = n.nextElementSibling) {
          const b = n.matches('.linkrow') ? n : n.querySelector('.linkrow'); if (b) out.push([(b.querySelector('.rowtext') || b).textContent.trim(), (b.querySelector('.amt') || {}).textContent || '']); }
        return out; }""")


def preview(page):
    return page.evaluate("() => { const p = window.__hopline.renderer.preview; return p ? { ids: [...p.ids].sort(), color: p.color } : null; }")


def toast(page):
    return page.evaluate("() => document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent")


def test_a_wallet_is_coloured_by_what_it_holds_and_one_not_read_is_hollow_not_empty(tpage, mock):
    scene(tpage, mock)
    balance_mode(tpage)
    assert tpage.evaluate(STATE + ".colorBy") == "balance"
    assert all(look(tpage, n) == [UNKNOWN, True] for n in "abcde"), "nothing was read yet: every wallet is hollow, none is shown as empty"
    read_balances(tpage, "a", "b", "c", "e")
    assert look(tpage, "a") == [HOLDS, False] and look(tpage, "e") == [HOLDS, False]
    assert look(tpage, "c") == [SMALL, False], "5,000 sat is under the limit of 10,000"
    assert look(tpage, "b") == [EMPTY, False], "received and spent in full"
    assert look(tpage, "d") == [UNKNOWN, True], "not asked about: hollow"
    assert tpage.evaluate("(id) => window.__hopline.renderer.data.style.nodeColor(window.__hopline.state.graph.nodes.get(id))", "tx:" + tid(1)) == KIND_TX, "a transaction keeps its kind colour"
    lg = legend(tpage)
    assert "holds funds (0.00010000 BTC or more)" in lg and "small balance (under 0.00010000 BTC)" in lg and "empty (nothing confirmed)" in lg and "balance not read (not the same as empty)" in lg
    tpage.click("#colorSeg [data-color=type]"); settle(tpage)
    assert look(tpage, "b")[1] is False and look(tpage, "d")[1] is False, "in the other modes nothing is hollow"
    assert look(tpage, "a")[0] != HOLDS


def test_in_balance_colour_a_tag_gives_way_in_the_fill_but_its_name_keeps_its_colour(tpage, mock):
    scene(tpage, mock)
    read_balances(tpage, "a", "b", "c", "e")
    tpage.evaluate("(id) => window.__hopline.setSel([id])", "addr:" + addr("a")); settle(tpage)
    tpage.select_option("#fTag", "THREAT"); settle(tpage)
    tagc = tpage.evaluate("(id) => window.__hopline.renderer.data.style.nodeColor(window.__hopline.state.graph.nodes.get(id))", "addr:" + addr("a"))
    assert tagc == "#ff4d4d", "in the Kind colouring the tag colour wins"
    balance_mode(tpage)
    assert look(tpage, "a")[0] == HOLDS, "in this mode the fill says what the wallet holds"
    assert tpage.evaluate("(id) => window.__hopline.renderer.data.style.badgeColor(window.__hopline.state.graph.nodes.get(id))", "addr:" + addr("a")) == "#ff4d4d", "the tag's name is still in its colour"


def test_the_holding_funds_chip_and_group_list_the_wallets_without_being_a_finding(tpage, mock):
    scene(tpage, mock)
    balance_mode(tpage)
    assert chip(tpage) is None, "no balance read: no chip"
    read_balances(tpage, "a", "b", "c", "e")
    assert "Holding funds" in chip(tpage) and chip(tpage).endswith("2"), chip(tpage)
    assert tpage.inner_text("#findCount").strip() == "", "not a finding: the Findings are not counted up by it"
    assert "not a finding" in tpage.get_attribute("#findStrip [data-key=holding]", "title").lower()
    open_group(tpage)
    assert sorted(selected(tpage)) == sorted(ids_of("a", "e")), "a click on the chip selects the wallets that hold funds"
    rows = group_rows(tpage)
    assert [r[1] for r in rows[:4]] == ["2", "1", "1", "2"], rows                  # holding, small, empty, not read (d and the wallet that paid)
    assert rows[0][0].endswith("Holding funds (0.00010000 BTC or more)") and "Small balance (under 0.00010000 BTC)" in rows[1][0] and "Empty" in rows[2][0] and "Balance not read" in rows[3][0]
    assert [r[1] for r in rows[4:]] == ["0.00080000 BTC", "0.00020000 BTC"], "the wallets that hold funds, largest first"
    text = tpage.evaluate("() => document.getElementById('anFindings').textContent")
    assert "The oldest was read" in text and "A balance is for one address" in text and "Unconfirmed amounts are not counted" in text
    tpage.evaluate("() => window.__hopline.setSel([])"); settle(tpage)
    tpage.hover("#anFindings .linkrow:has-text('Small balance')"); tpage.wait_for_function("() => window.__hopline.renderer.preview !== null", timeout=4000)
    assert preview(tpage) == {"ids": ids_of("c"), "color": SMALL}, "pointing at a row rings its wallets in that state's colour"
    tpage.mouse.move(5, 5)
    tpage.click("#anFindings .linkrow:has-text('Balance not read')")
    assert selected(tpage) == ids_of("d"), "the wallets not read can be selected, as every chip does: the ones on screen (the wallet that paid is not)"


def test_the_ones_not_read_can_be_read_from_the_group_and_join_the_count(tpage, mock):
    scene(tpage, mock)
    read_balances(tpage, "a", "b", "c", "e")
    open_group(tpage)
    stats(mock, "d", 30000, 0); stats(mock, "src", 200000, 200000)
    tpage.click("#anFindings button:has-text('Load 2 balances')"); idle(tpage); settle(tpage)
    assert chip(tpage).endswith("3"), "d holds 30,000 sat now that it was read: " + str(chip(tpage))
    rows = group_rows(tpage)
    assert [r[1] for r in rows[:3]] == ["3", "1", "2"] and not any("not read" in r[0].lower() for r in rows), rows
    assert tpage.locator("#anFindings button:has-text('Load')").count() == 0, "nothing left to read"


def test_the_small_limit_moves_a_wallet_between_small_and_holding_and_zero_switches_small_off(tpage, mock):
    scene(tpage, mock)
    balance_mode(tpage)
    read_balances(tpage, "a", "b", "c", "e")
    tpage.evaluate("() => { document.getElementById('dustSats').closest('details').open = true; }")
    tpage.fill("#dustSats", "3000"); tpage.dispatch_event("#dustSats", "change"); settle(tpage)
    assert look(tpage, "c") == [HOLDS, False], "5,000 sat is over a limit of 3,000"
    assert chip(tpage).endswith("3") and "holds funds (0.00003000 BTC or more)" in legend(tpage)
    tpage.fill("#dustSats", "0"); tpage.dispatch_event("#dustSats", "change"); settle(tpage)
    assert look(tpage, "c") == [HOLDS, False] and chip(tpage).endswith("3")
    assert "holds funds" in legend(tpage) and not any(x.startswith("small balance") for x in legend(tpage)), "no limit, no small band"
    tpage.fill("#dustSats", "10000"); tpage.dispatch_event("#dustSats", "change"); settle(tpage)
    assert look(tpage, "c") == [SMALL, False] and chip(tpage).endswith("2")


def test_an_update_says_which_wallets_were_emptied_and_which_received_funds(tpage, mock):
    scene(tpage, mock)
    balance_mode(tpage)
    read_balances(tpage, "a", "b", "c", "e")
    assert look(tpage, "a") == [HOLDS, False] and look(tpage, "b") == [EMPTY, False]
    stats(mock, "a", 80000, 80000)                                   # a spent all it had
    stats(mock, "b", 50000, 40000)                                   # b was paid 10,000
    tpage.click("#btnUpdate"); idle(tpage); settle(tpage)
    t = toast(tpage)
    assert "1 wallet now empty (bc1qax" in t and "1 wallet now holds funds (bc1qbx" in t, t
    c = tpage.inner_text("#updateChipText")
    assert "1 emptied" in c and "1 funded" in c, c
    assert look(tpage, "a") == [EMPTY, False] and look(tpage, "b") == [HOLDS, False], "the canvas shows it at once"
    stats(mock, "e", 25000, 0)                                       # a bigger balance is not an event
    tpage.click("#btnUpdate"); idle(tpage); settle(tpage)
    t = toast(tpage)
    assert "now empty" not in t and "now holds" not in t, t
    assert "1 wallet with new totals" in t, t


def test_the_report_says_how_many_balances_were_read_and_what_they_held(tpage, mock, tmp_path):
    scene(tpage, mock)
    read_balances(tpage, "a", "b", "c", "e")
    tpage.evaluate("() => { document.getElementById('exportMenu').open = true; }")
    with tpage.expect_download() as dl:
        tpage.click("[data-export=report]")
    p = tmp_path / "report.html"; dl.value.save_as(p)
    html = p.read_text(encoding="utf-8")
    on_screen = tpage.evaluate("() => [...window.__hopline.renderer.data.visible.nodes].filter((id) => id.startsWith('addr:')).length")
    assert ("Balances were read for 4 of %d wallets" % on_screen) in html, html[html.find("Balances were") - 50:html.find("Balances were") + 300]
    assert "2 held funds (0.00010000 BTC or more), 1 a smaller amount, 1 held nothing." in html
    assert ("The %d not read are not counted as empty." % (on_screen - 4)) in html


def test_the_mode_and_the_balances_survive_a_file(tpage, mock, tmp_path):
    scene(tpage, mock)
    balance_mode(tpage)
    read_balances(tpage, "a", "b", "c", "e")
    tpage.click("summary:has-text('Export')")
    with tpage.expect_download() as d:
        tpage.click("[data-export=json]")
    f = tmp_path / "w.json"; d.value.save_as(str(f))
    tpage.evaluate("() => { const m = document.getElementById('exportMenu'); if (m) m.open = false; }")
    tpage.click("#btnClear"); tpage.click("#btnClear"); settle(tpage)
    assert tpage.evaluate(STATE + ".graph.nodes.size") == 0
    tpage.set_input_files("#fileImport", str(f)); tpage.wait_for_timeout(900); idle(tpage); settle(tpage)
    assert tpage.evaluate(STATE + ".colorBy") == "balance", "the colouring comes back with the file"
    assert look(tpage, "a") == [HOLDS, False] and look(tpage, "b") == [EMPTY, False] and look(tpage, "d") == [UNKNOWN, True]
    assert "Holding funds" in chip(tpage)


def centre(page, name):
    """The colour of the pixel at the middle of a wallet's shape on the canvas, as drawn."""
    return page.evaluate("""(id) => { const r = window.__hopline.renderer, cv = document.querySelector('canvas'), p = r._toScreen(r.cur.get(id)), k = cv.width / cv.clientWidth;
        const d = cv.getContext('2d').getImageData(Math.round(p.x * k), Math.round(p.y * k), 1, 1).data; return [d[0], d[1], d[2]]; }""", "addr:" + addr(name))


def test_the_canvas_draws_what_a_wallet_holds_and_leaves_one_not_read_hollow(tpage, mock):
    scene(tpage, mock)
    balance_mode(tpage)
    read_balances(tpage, "a", "b", "c", "e")
    tpage.mouse.move(700, 790); tpage.wait_for_timeout(400)
    a, b, d = centre(tpage, "a"), centre(tpage, "b"), centre(tpage, "d")
    assert a[1] > 180 and a[0] < 120, "a holds funds: bright green %s" % a
    assert 70 < b[0] < 130 and 80 < b[1] < 140 and b[2] > b[0], "b is empty: grey %s" % b
    assert max(d) < 70, "d was not read: hollow, the canvas shows through %s" % d
