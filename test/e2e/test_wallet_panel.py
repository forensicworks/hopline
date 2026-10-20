"""The details of a selected wallet: its transactions told apart as in / out, with who is on the other side."""
import pytest

from chains import IN, OUT, addr, tid, tx
from conftest import ADDRESS
from helpers import idle, open_query, settle

W = ADDRESS                                    # a real address: the search box verifies the checksum
W_ID = "addr:" + W


def WIN(txn, vout, value):
    """An input spending from the wallet."""
    i = IN(txn, vout, "x", value); i["prevout"]["scriptpubkey_address"] = W
    return i


def WOUT(value):
    """An output paying the wallet."""
    o = OUT("x", value); o["scriptpubkey_address"] = W
    return o


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def wallet(mock):
    """A wallet with 6 payments out (100-105), 3 payments in (110-112), one transaction where it was paid while also spending (120),
    one payment with change back (121) and one move to itself (122): 12 transactions, bigger number = later."""
    ns = []
    for i in range(6):
        ns.append(tx(mock, 100 + i, [WIN(50 + i, 0, 60000 + i * 5000)], [OUT("pay%d" % i, 50000 + i * 4000), OUT("chg%d" % i, 9000)]))
    for i in range(3):
        ns.append(tx(mock, 110 + i, [IN(60 + i, 0, "payer%d" % i, 30000 + i * 1000)], [WOUT(29000 + i * 1000)]))
    ns.append(tx(mock, 120, [WIN(70, 0, 100000), IN(71, 0, "other", 50000)], [WOUT(120000), OUT("zed", 29000)]))
    ns.append(tx(mock, 121, [WIN(72, 0, 100000)], [OUT("shop", 60000), WOUT(39000)]))
    ns.append(tx(mock, 122, [WIN(73, 0, 50000)], [WOUT(49000)]))
    mock.routes["/address/" + W] = {"address": W, "chain_stats": {"funded_txo_count": 5, "funded_txo_sum": 1, "spent_txo_count": 5, "spent_txo_sum": 1, "tx_count": len(ns)},
                                    "mempool_stats": {"funded_txo_count": 0, "funded_txo_sum": 0, "spent_txo_count": 0, "spent_txo_sum": 0, "tx_count": 0}}
    mock.routes["/address/" + W + "/txs"] = [mock.routes["/tx/" + i[3:]] for i in sorted(ns, reverse=True, key=lambda x: int(x[3:5], 16))]
    return ns


def rows(page):
    return page.locator("#inspBody .walletsec .linkrow")


def titles(page):
    return page.eval_on_selector_all("#inspBody .walletsec .linkrow", "els => els.map(e => e.title)")


def tags(page):
    return page.eval_on_selector_all("#inspBody .walletsec .linkrow .dirtag", "els => els.map(e => e.textContent)")


def test_every_transaction_is_tagged_in_out_or_self(fpage, mock):
    wallet(mock)
    open_query(fpage, W)
    t = tags(fpage)
    assert len(t) == 21 and t.count("↓ in") == 13 and t.count("↑ out") == 7 and t.count("↔ self") == 1, t
    assert fpage.locator("#inspBody .walletsec .linkrow.in").count() == 13 and fpage.locator("#inspBody .walletsec .linkrow.out").count() == 7
    body = fpage.inner_text("#inspBody").lower()
    assert "transactions (21)" in body


def test_the_tags_follow_what_the_transaction_did_to_the_wallet_net_of_change(fpage, mock):
    wallet(mock)
    open_query(fpage, W)
    by = {t: fpage.locator("#inspBody .walletsec .linkrow[title^='%s']" % t) for t in titles(fpage)}
    def tag_of(n):
        return by["tx:" + tid(n)].locator(".dirtag").inner_text()
    assert tag_of(100) == "↑ out" and tag_of(110) == "↓ in"
    assert tag_of(120) == "↓ in", "paid 120000 while spending 100000: money came in"
    assert tag_of(121) == "↑ out", "a payment with change back reads as out, for what really left"
    assert tag_of(122) == "↔ self", "everything went back to the wallet itself"
    assert "net shown" in by["tx:" + tid(121)].locator(".dirtag").get_attribute("title")
    out_amt = by["tx:" + tid(121)].locator(".amt").inner_text()
    assert out_amt.startswith("−") and "0.00061000" in out_amt, out_amt
    assert by["tx:" + tid(110)].locator(".amt").inner_text().startswith("+")


def test_each_row_says_who_is_on_the_other_side(fpage, mock):
    wallet(mock)
    open_query(fpage, W)
    fpage.evaluate("([id, label]) => { window.__orion.state.graph.nodes.get(id).label = label; window.__orion.refresh(); }", ["addr:" + addr("payer1"), "Alice <img src=x onerror=window.__pwned=1>"])
    fpage.evaluate("(id) => window.__orion.setSel([id])", W_ID); settle(fpage)
    inn = fpage.locator("#inspBody .walletsec .linkrow[title^='tx:%s']" % tid(111)).inner_text()
    assert "from Alice <img src=x onerror=window.__pwned=1>" in inn, "a label is shown as text, never as markup"
    assert fpage.evaluate("() => window.__pwned") is None and fpage.locator("#inspBody img").count() == 0
    out = fpage.locator("#inspBody .walletsec .linkrow[title^='tx:%s']" % tid(102)).inner_text()
    assert out.startswith("↑ out") and "to bc1qpa" in out and "bc1qch" in out, out        # the payee and the change address (the page cannot tell which is which)
    assert "to bc1qpa" in fpage.locator("#inspBody .walletsec .linkrow[title^='tx:%s']" % tid(100)).inner_text()
    own = fpage.locator("#inspBody .walletsec .linkrow[title^='tx:%s']" % tid(122)).inner_text()
    assert "itself" in own


def test_the_filter_shows_only_in_or_only_out_and_keeps_the_totals(fpage, mock):
    wallet(mock)
    open_query(fpage, W)
    btns = fpage.locator("#inspBody .walletseg button")
    assert btns.all_inner_texts() == ["All 21", "↓ In 13", "↑ Out 7"]
    assert btns.nth(0).get_attribute("aria-checked") == "true"
    fpage.click("#inspBody .walletseg [data-dir=in]")
    assert tags(fpage) == ["↓ in"] * 13 and btns.nth(1).get_attribute("aria-checked") == "true"
    fpage.click("#inspBody .walletseg [data-dir=out]")
    assert tags(fpage) == ["↑ out"] * 7
    fpage.click("#inspBody .walletseg [data-dir=all]")
    assert len(tags(fpage)) == 21
    sums = fpage.inner_text("#inspBody .walletsum")
    assert "↓ in" in sums and "(13)" in sums and "↑ out" in sums and "(7)" in sums and "BTC" in sums, sums


def test_the_choice_is_kept_when_another_wallet_is_looked_at(fpage, mock):
    wallet(mock)
    open_query(fpage, W)
    fpage.click("#inspBody .walletseg [data-dir=out]")
    fpage.evaluate("(id) => window.__orion.setSel([id])", "tx:" + tid(110)); settle(fpage)
    fpage.evaluate("(id) => window.__orion.setSel([id])", W_ID); settle(fpage)
    assert tags(fpage) == ["↑ out"] * 7


def test_newest_first_by_default_and_largest_first_on_request(fpage, mock):
    wallet(mock)
    open_query(fpage, W)
    t = titles(fpage)
    assert t[:3] == ["tx:" + tid(122), "tx:" + tid(121), "tx:" + tid(120)] and t[11] == "tx:" + tid(100), "the loaded ones newest first; the ones only known from an input (no date yet) come last"
    fpage.select_option("#inspBody .walletbar select", "big")
    amounts = fpage.eval_on_selector_all("#inspBody .walletsec .linkrow .amt", "els => els.map(e => parseFloat(e.textContent.replace(/[^0-9.]/g, '')))")
    assert amounts == sorted(amounts, reverse=True)


def test_a_long_list_is_paged_not_dropped(fpage, mock):
    # 45 transactions paying one wallet, added straight to the graph (no history paging involved)
    fpage.evaluate("""() => {
      const g = window.__orion.state.graph, w = 'bc1qbig' + 'x'.repeat(13);
      for (let i = 0; i < 45; i++) {
        const txid = (i < 16 ? '0' : '') + (i + 1).toString(16) + (((i + 1) * 7) % 256).toString(16).padStart(2, '0') ;
        const id = txid.padEnd(64, 'a').slice(0, 64);
        g.addTx({ txid: id, fee: 1, weight: 400, status: { confirmed: true, block_height: 1, block_time: 1650000000 + i * 60 },
                  vin: [{ txid: 'ff'.repeat(32), vout: i, prevout: { scriptpubkey_address: 'bc1qsender' + i, scriptpubkey_type: 'v0_p2wpkh', value: 10000 + i } }],
                  vout: [{ scriptpubkey_address: w, scriptpubkey_type: 'v0_p2wpkh', value: 9000 + i }] });
      }
      g.refreshDerived();
      window.__orion.navigate('addr:' + w, { light: true });
    }""")
    idle(fpage); settle(fpage)
    assert rows(fpage).count() == 40 and "(45)" in fpage.inner_text("#inspBody")
    more = fpage.locator("#inspBody .walletsec .moreRows")
    assert more.count() == 1 and "5 more" in more.inner_text()
    more.click()
    assert rows(fpage).count() == 45 and fpage.locator("#inspBody .walletsec .moreRows").count() == 0


def test_the_row_under_the_pointer_is_outlined_on_the_graph(fpage, mock):
    wallet(mock)
    open_query(fpage, W)
    fpage.locator("#inspBody .walletsec .rowcopy").nth(1).hover()
    assert fpage.evaluate("() => window.__orion.renderer.highlight") == titles(fpage)[1]
    fpage.mouse.move(5, 5)
    assert fpage.evaluate("() => window.__orion.renderer.highlight") is None


def test_clicking_a_row_still_moves_the_focus_there(fpage, mock):
    wallet(mock)
    open_query(fpage, W)
    fpage.locator("#inspBody .walletsec .linkrow[title='tx:%s']" % tid(110)).click()
    fpage.wait_for_function("(id) => window.__orion.state.focus === id", arg="tx:" + tid(110)); idle(fpage)


def test_in_the_trace_a_row_not_yet_shown_can_be_put_on_it_one_at_a_time(fpage, mock):
    wallet(mock)
    open_query(fpage, W)
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    fpage.evaluate("(id) => window.__orion.setSel([id])", W_ID); settle(fpage)
    assert fpage.locator("#inspBody .walletsec .showbtn").count() == 21, "nothing but the wallet is on the trace yet"
    assert fpage.locator("#inspBody .walletsec .rowcopy.off").count() == 21
    row = fpage.locator("#inspBody .walletsec .rowcopy:has(.linkrow[title^='tx:%s'])" % tid(121))
    row.locator(".showbtn").click(); idle(fpage); settle(fpage)
    shown = set(fpage.evaluate("() => [...window.__orion.renderer.data.visible.nodes]"))
    assert {W_ID, "tx:" + tid(121), "addr:" + addr("shop")} <= shown
    assert "tx:" + tid(120) not in shown and "tx:" + tid(110) not in shown, "only the chosen transaction came"
    assert fpage.locator("#inspBody .walletsec .showbtn").count() == 20
    assert fpage.locator("#inspBody .walletsec .rowcopy:has(.linkrow[title^='tx:%s']) .showbtn" % tid(121)).count() == 0


def test_in_the_trace_an_incoming_row_is_brought_in_from_behind(fpage, mock):
    wallet(mock)
    open_query(fpage, W)
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    fpage.evaluate("(id) => window.__orion.setSel([id])", W_ID); settle(fpage)
    fpage.locator("#inspBody .walletsec .rowcopy:has(.linkrow[title^='tx:%s']) .showbtn" % tid(111)).click(); idle(fpage); settle(fpage)
    shown = set(fpage.evaluate("() => [...window.__orion.renderer.data.visible.nodes]"))
    assert "tx:" + tid(111) in shown and "addr:" + addr("payer1") in shown, "the transaction and the wallet that paid"
    pos = lambda i: fpage.evaluate("(id) => window.__orion.renderer.positionOf(id).x", i)
    assert pos("tx:" + tid(111)) < pos(W_ID), "it sits to the left: it came before"


def test_outside_the_trace_there_is_no_show_button(fpage, mock):
    wallet(mock)
    open_query(fpage, W)
    assert fpage.locator("#inspBody .walletsec .showbtn").count() == 0 and fpage.locator("#inspBody .walletsec .rowcopy.off").count() == 0
