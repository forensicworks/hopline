"""Transactions in the same block with no wallet in common: a small block icon on the time line and a row in each one's details. A coincidence to weigh, never a finding.

The transactions are made up: two with nothing in common that share a block, two that pay the same wallet in one block (expected, so not marked), and one in a block of its own.
The icon is drawn on a canvas, so the tests look at the geometry the page keeps for it (where it is, which transactions it stands for) and at the pixels, and move the pointer over it.
"""
import pytest

from chains import IN, OUT, tid, tx
from helpers import open_query, selected, settle, show_findings

STATE = "window.__hopline.state"
T0 = 1750000000


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def block(mock, n, height, time):
    r = mock.routes["/tx/" + tid(n)]
    r["status"]["block_height"], r["status"]["block_time"] = height, time


def plain(mock, n, who, height, time):
    """A payment with its own change, from a wallet and to wallets that no other transaction here has."""
    tx(mock, n, [IN(200 + n, 0, who, 50000)], [OUT(who + "pay", 30000), OUT(who + "chg", 19000)])
    block(mock, n, height, time)


def load(page, *ns):
    for n in ns:
        open_query(page, tid(n)); settle(page)


def pick(page, n):
    page.evaluate("(ids) => window.__hopline.setSel(ids)", ["tx:" + tid(n)]); settle(page)


def marks(page):
    """The icons on the time line: [{x, height, ids}], or None while the time line is not drawn."""
    return page.evaluate("() => { const g = " + STATE + ".tbGeom; return g ? g.blocks.map(b => ({ x: b.x, height: b.height, ids: b.ids.slice().sort() })) : null; }")


def violet(page, x):
    """How many pixels of the icon's colour are drawn within reach of x at the top of the time line."""
    return page.evaluate("(x) => { const c = document.getElementById('hist'), d = c.getContext('2d').getImageData(Math.max(0, Math.round(x) - 8), 0, 17, 16).data; let n = 0;"
                         " for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i + 2] > 220 && d[i + 1] < 200) n++; return n; }", x)


def over(page, x, dy=7):
    box = page.locator("#hist").bounding_box()
    page.mouse.move(box["x"] + x, box["y"] + dy)


def tip(page):
    return page.inner_text("#tooltip") if page.is_visible("#tooltip") else ""


def two_in_a_block(mock):
    plain(mock, 1, "aa", 800000, T0); plain(mock, 2, "bb", 800000, T0); plain(mock, 3, "cc", 800001, T0 + 600)


def test_two_transactions_in_one_block_with_nothing_in_common_get_an_icon_on_the_time_line(tpage, mock):
    two_in_a_block(mock)
    load(tpage, 1, 3)
    assert marks(tpage) == [], "one of the two is not loaded yet"
    assert violet(tpage, 5) == 0
    load(tpage, 2)
    m = marks(tpage)
    assert len(m) == 1 and m[0]["height"] == 800000 and m[0]["ids"] == sorted(["tx:" + tid(1), "tx:" + tid(2)]), m
    assert violet(tpage, m[0]["x"]) > 10, "the icon is drawn"


def test_pointing_at_the_icon_says_what_it_is_and_rings_the_transactions(tpage, mock):
    two_in_a_block(mock)
    load(tpage, 1, 2, 3)
    x = marks(tpage)[0]["x"]
    over(tpage, x)
    tpage.wait_for_function("() => !document.getElementById('tooltip').hidden", timeout=4000)
    t = tip(tpage)
    assert "Common block 800,000" in t and "2 transactions with no wallet in common" in t and "such pairs expected by chance here" in t and "not a finding" in t and "Click to select them" in t, t
    tpage.wait_for_function("() => { const p = window.__hopline.renderer.preview; return !!p && p.ids.size === 2; }", timeout=4000)
    assert tpage.evaluate("() => [...window.__hopline.renderer.preview.ids].sort()") == sorted(["tx:" + tid(1), "tx:" + tid(2)])
    tpage.mouse.move(5, 5)
    tpage.wait_for_function("() => window.__hopline.renderer.preview === null", timeout=4000)
    assert tip(tpage) == ""


def test_pressing_the_icon_selects_the_transactions_of_that_block_only(tpage, mock):
    two_in_a_block(mock)
    plain(mock, 5, "ee", 800001, T0)                                      # in another block, but with exactly the same time: its dot is under the same place on the line
    load(tpage, 1, 2, 3, 5)
    x = marks(tpage)[0]["x"]
    over(tpage, x); tpage.mouse.down(); tpage.mouse.up(); settle(tpage)
    assert sorted(selected(tpage)) == sorted(["tx:" + tid(1), "tx:" + tid(2)])


def test_a_transactions_details_say_what_else_is_in_its_block_and_a_row_moves_there(tpage, mock):
    two_in_a_block(mock)
    load(tpage, 1, 2, 3)
    pick(tpage, 1)
    body = tpage.inner_text("#inspBody")
    assert "common block with 1 other transaction" in body, body
    sec = tpage.locator("#inspBody .insp-section", has_text="Common block (1)")
    assert sec.count() == 1 and sec.locator(".linkrow").count() == 1
    assert "Confirmed in block 800,000 with no wallet in common" in body and "A coincidence to weigh, not a finding" in body
    pick(tpage, 3)
    assert "ommon block" not in tpage.inner_text("#inspBody"), "alone in its block: no row"
    pick(tpage, 1)
    sec.locator(".linkrow").first.click(); settle(tpage)
    assert tpage.evaluate(STATE + ".focus") == "tx:" + tid(2), "the row moves to the other transaction"
    assert "common block with 1 other transaction" in tpage.inner_text("#inspBody"), "and it lists the first from there"


def test_a_shared_wallet_is_expected_so_it_is_not_marked_and_a_hand_off_is_not_either(tpage, mock):
    tx(mock, 1, [IN(201, 0, "aa", 50000)], [OUT("rr", 30000), OUT("c1", 19000)]); block(mock, 1, 800000, T0)
    tx(mock, 2, [IN(202, 0, "bb", 50000)], [OUT("rr", 30000), OUT("c2", 19000)]); block(mock, 2, 800000, T0)               # both pay rr
    tx(mock, 5, [IN(205, 0, "ee", 50000)], [OUT("px", 30000), OUT("c5", 19000)], spent={0: 6}); block(mock, 5, 800009, T0 + 5400)
    tx(mock, 6, [IN(5, 0, "px", 30000)], [OUT("py", 29000)]); block(mock, 6, 800009, T0 + 5400)                           # a hand-off: 6 spends what 5 paid
    load(tpage, 1, 2, 5, 6)
    assert marks(tpage) == []
    pick(tpage, 1)
    assert "ommon block" not in tpage.inner_text("#inspBody")


def test_a_chain_confirmed_together_is_one_group_and_an_independent_transaction_beside_it_is_the_coincidence(tpage, mock):
    tx(mock, 5, [IN(205, 0, "ee", 50000)], [OUT("px", 30000), OUT("c5", 19000)], spent={0: 6}); block(mock, 5, 800009, T0 + 5400)
    tx(mock, 6, [IN(5, 0, "px", 30000)], [OUT("py", 29000)], spent={0: 7}); block(mock, 6, 800009, T0 + 5400)
    tx(mock, 7, [IN(6, 0, "py", 29000)], [OUT("pz", 28000)]); block(mock, 7, 800009, T0 + 5400)
    plain(mock, 8, "hh", 800009, T0 + 5400)
    plain(mock, 9, "ii", 800000, T0)                                       # another time on the line, so that the line has a length
    load(tpage, 5, 6, 7, 9)
    assert marks(tpage) == [], "the ends of the chain share no wallet, but the middle one ties them: one group"
    load(tpage, 8)
    m = marks(tpage)
    assert len(m) == 1 and m[0]["height"] == 800009 and len(m[0]["ids"]) == 4
    pick(tpage, 6)
    assert "common block with 1 other transaction" in tpage.inner_text("#inspBody")
    pick(tpage, 8)
    assert "common block with 3 other transactions" in tpage.inner_text("#inspBody")


def test_two_blocks_get_two_icons(tpage, mock):
    plain(mock, 1, "aa", 800000, T0); plain(mock, 2, "bb", 800000, T0)
    plain(mock, 3, "cc", 800500, T0 + 300000); plain(mock, 4, "dd", 800500, T0 + 300000)
    load(tpage, 1, 2, 3, 4)
    m = marks(tpage)
    assert [b["height"] for b in m] == [800000, 800500] and m[0]["x"] < m[1]["x"]
    assert violet(tpage, m[0]["x"]) > 10 and violet(tpage, m[1]["x"]) > 10


def test_a_transaction_that_confirms_into_the_same_block_brings_the_icon(tpage, mock):
    two_in_a_block(mock)
    mock.routes["/tx/" + tid(2)]["status"] = {"confirmed": False}
    load(tpage, 1, 2, 3)
    assert marks(tpage) == [], "one of them has not confirmed"
    block(mock, 2, 800000, T0)
    mock.routes["/tx/" + tid(2)]["status"]["confirmed"] = True
    pick(tpage, 2)
    tpage.get_by_role("button", name="Check for confirmation").click(); settle(tpage)
    assert len(marks(tpage)) == 1, "the graph is no bigger than before, but the set of them changed"


def test_it_is_not_a_finding_and_is_not_counted_with_them(tpage, mock):
    two_in_a_block(mock)
    load(tpage, 1, 2, 3)
    assert len(marks(tpage)) == 1
    show_findings(tpage); settle(tpage)
    found = tpage.inner_text("#anFindings").lower()
    assert "same block" not in found and "common block" not in found
    assert not tpage.evaluate("() => [...window.__hopline.state.an.tx.values()].some(r => /same block|common block/.test(JSON.stringify(r).toLowerCase()))"), "no flag on either transaction"


def test_with_the_time_line_folded_there_is_nothing_to_see_and_unfolding_brings_the_icon_back(tpage, mock):
    two_in_a_block(mock)
    load(tpage, 1, 2, 3)
    tpage.click("#tbCollapse"); settle(tpage)
    assert not tpage.is_visible("#hist"), "the time line is folded away"
    assert "ommon block" in (pick(tpage, 1) or tpage.inner_text("#inspBody")), "the row in the details does not need the time line"
    tpage.click("#tbCollapse")
    tpage.wait_for_function("() => { const g = window.__hopline.state.tbGeom; return !!g && g.blocks.length === 1; }", timeout=4000)
    assert violet(tpage, marks(tpage)[0]["x"]) > 10
