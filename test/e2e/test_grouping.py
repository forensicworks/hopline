"""Rows that look alike fold into one line, in a wallet's Transactions and in the list behind an arrow."""
import pytest

from chains import IN, OUT, addr, tid, tx
from conftest import ADDRESS
from helpers import click_node, idle, open_query, settle
from test_copy import capture, copied
from test_trace import click_handle, many_outputs, shown
from test_wallet_panel import W, W_ID, WIN, WOUT

EXCH = "addr:" + addr("exch")


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def busy_wallet(mock):
    """The wallet paid the same exchange six times (100-105), three other wallets once each (106-108), and received seven small amounts
    (110-116, 500..1100 sats) and two ordinary ones (120, 121). Each outgoing transaction also leaves a funding transaction known only from its input."""
    ns = []
    for i in range(6):
        ns.append(tx(mock, 100 + i, [WIN(50 + i, 0, 50000 + i * 1000)], [OUT("exch", 40000 + i * 1000), OUT("chg%d" % i, 9000)]))
    for i in range(3):
        ns.append(tx(mock, 106 + i, [WIN(56 + i, 0, 70000)], [OUT("pay%d" % i, 60000), OUT("chgp%d" % i, 9000)]))
    for i in range(7):
        ns.append(tx(mock, 110 + i, [IN(60 + i, 0, "small%d" % i, 2000)], [WOUT(500 + i * 100)]))
    for i in range(2):
        ns.append(tx(mock, 120 + i, [IN(70 + i, 0, "big%d" % i, 60000)], [WOUT(50000)]))
    mock.routes["/address/" + W] = {"address": W, "chain_stats": {"funded_txo_count": 5, "funded_txo_sum": 1, "spent_txo_count": 5, "spent_txo_sum": 1, "tx_count": len(ns)},
                                    "mempool_stats": {"funded_txo_count": 0, "funded_txo_sum": 0, "spent_txo_count": 0, "spent_txo_sum": 0, "tx_count": 0}}
    mock.routes["/address/" + W + "/txs"] = [mock.routes["/tx/" + i[3:]] for i in sorted(ns, reverse=True, key=lambda x: int(x[3:5], 16))]
    return ns


def heads(page):
    return page.locator("#inspBody .walletsec .groupbtn")


def head_texts(page):
    return page.eval_on_selector_all("#inspBody .walletsec .groupbtn", "els => els.map(e => e.innerText.replace(/\\s+/g, ' '))")


def row_titles(page):
    return page.eval_on_selector_all("#inspBody .walletsec .linkrow:not(.groupbtn)", "els => els.map(e => e.title)")


def test_repeated_payments_to_one_wallet_and_small_amounts_each_fold_into_one_line(fpage, mock):
    busy_wallet(mock)
    open_query(fpage, W)
    t = head_texts(fpage)
    assert len(t) == 2, t
    out = next(x for x in t if "to " in x and "small" not in x)
    assert "6 transactions to" in out and "0.00050000 to 0.00055000 BTC each" in out and "−0.00315000 BTC" in out, out
    small = next(x for x in t if "small" in x)
    assert "7 small transactions (each under 0.00010000 BTC)" in small and "+0.00005600 BTC" in small and "0.00000500 to 0.00001100 BTC each" in small, small
    assert "transactions (27)" in fpage.inner_text("#inspBody").lower(), "the heading still counts every transaction, not every line"
    folded = set(row_titles(fpage))
    assert "tx:" + tid(100) not in folded and "tx:" + tid(110) not in folded, "the members are inside their groups"
    assert "tx:" + tid(106) in folded and "tx:" + tid(120) in folded, "the ones that do not look alike are rows of their own"


def test_a_group_opens_to_its_rows_and_folds_again(fpage, mock):
    busy_wallet(mock)
    open_query(fpage, W)
    g = heads(fpage).first
    assert g.get_attribute("aria-expanded") == "false"
    g.click()
    g = heads(fpage).first
    assert g.get_attribute("aria-expanded") == "true"
    members = fpage.locator("#inspBody .walletsec .groupmembers .linkrow")
    assert members.count() in (6, 7)
    assert all(t.startswith("tx:") for t in fpage.eval_on_selector_all("#inspBody .walletsec .groupmembers .linkrow", "els => els.map(e => e.title)"))
    members.first.click()
    fpage.wait_for_function("() => window.__hopline.state.focus && window.__hopline.state.focus.startsWith('tx:')"); idle(fpage)


def test_folding_never_loses_a_row(fpage, mock):
    ns = busy_wallet(mock)
    open_query(fpage, W)
    for i in range(heads(fpage).count()):
        heads(fpage).nth(i).click()
    fpage.wait_for_timeout(50)
    for i in range(heads(fpage).count()):                                    # a click rebuilds the list: open whatever is still folded
        if heads(fpage).nth(i).get_attribute("aria-expanded") == "false":
            heads(fpage).nth(i).click()
    every = set(fpage.eval_on_selector_all("#inspBody .walletsec .linkrow:not(.groupbtn)", "els => els.map(e => e.title)"))
    assert {"tx:" + tid(n) for n in list(range(100, 109)) + list(range(110, 117)) + [120, 121]} <= every


def test_the_amounts_and_the_range_of_a_group_are_right(fpage, mock):
    busy_wallet(mock)
    open_query(fpage, W)
    out = next(x for x in head_texts(fpage) if "6 transactions to" in x)
    assert "2022-04-15" in out and "→" not in out, "both ends fall on the same day: one date, no arrow: " + out


def test_the_small_limit_is_a_setting_and_zero_switches_small_groups_off(fpage, mock):
    busy_wallet(mock)
    open_query(fpage, W)
    assert heads(fpage).count() == 2
    fpage.evaluate("() => { [...document.querySelectorAll('details')].find(d => d.querySelector('summary').textContent.trim() === 'Expansion limits').open = true; }")
    fpage.fill("#dustSats", "0"); fpage.dispatch_event("#dustSats", "change"); settle(fpage)
    assert heads(fpage).count() == 1 and "6 transactions to" in head_texts(fpage)[0], "the repeated wallet still groups; the small ones are rows now"
    fpage.fill("#dustSats", "800"); fpage.dispatch_event("#dustSats", "change"); settle(fpage)
    assert heads(fpage).count() == 2 and "3 small transactions (each under 0.00000800 BTC)" in " ".join(head_texts(fpage)), "500, 600 and 700 are under 800: three, so they group"
    fpage.fill("#dustSats", "99999999999"); fpage.dispatch_event("#dustSats", "change")
    assert fpage.input_value("#dustSats") == "1000000000"


def test_group_similar_rows_can_be_switched_off_in_the_list_and_in_the_settings_and_is_remembered(fpage, mock):
    busy_wallet(mock)
    open_query(fpage, W)
    assert fpage.is_checked("#inspBody .walletgroup input")
    fpage.uncheck("#inspBody .walletgroup input")
    assert heads(fpage).count() == 0 and not fpage.is_checked("#groupRows")
    assert len(row_titles(fpage)) == 27
    fpage.reload(); fpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert fpage.evaluate("() => window.__hopline.state.groupRows") is False
    fpage.evaluate("() => [...document.querySelectorAll('details')].find(d => d.querySelector('summary').textContent.trim() === 'Expansion limits').open = true")
    fpage.check("#groupRows")
    assert fpage.evaluate("() => window.__hopline.state.groupRows") is True


def test_a_group_copies_the_ids_of_all_its_transactions(fpage, mock):
    busy_wallet(mock)
    open_query(fpage, W)
    capture(fpage)
    wrap = fpage.locator("#inspBody .walletsec .groupwrap").filter(has_text="6 transactions to")
    wrap.locator(".copybtn").first.click()
    ids = copied(fpage)[-1].split("\n")
    assert sorted(ids) == sorted(tid(n) for n in range(100, 106))


def test_the_filters_apply_before_the_grouping(fpage, mock):
    busy_wallet(mock)
    open_query(fpage, W)
    fpage.click("#inspBody .walletseg [data-dir=in]")
    t = head_texts(fpage)
    assert len(t) == 1 and "7 small transactions" in t[0], t
    fpage.click("#inspBody .walletseg [data-dir=out]")
    t = head_texts(fpage)
    assert len(t) == 1 and "6 transactions to" in t[0], t


def test_in_a_trace_a_group_puts_its_largest_few_or_all_of_them_on_the_trace(fpage, mock):
    busy_wallet(mock)
    open_query(fpage, W)
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    fpage.evaluate("(id) => window.__hopline.setSel([id])", W_ID); settle(fpage)
    wrap = fpage.locator("#inspBody .walletsec .groupwrap").filter(has_text="6 transactions to")
    assert wrap.locator(".groupacts .showbtn").all_inner_texts() == ["+ largest 5", "+ all 6", "◼ as one"]
    wrap.locator(".groupacts .showbtn >> text=+ largest 5").click(); idle(fpage); settle(fpage)
    got = {i for i in shown(fpage) if i.startswith("tx:")}
    assert got == {"tx:" + tid(n) for n in range(101, 106)}, "the five largest of the six: " + str(sorted(got))
    wrap = fpage.locator("#inspBody .walletsec .groupwrap").filter(has_text="6 transactions to")
    assert wrap.locator(".groupacts .showbtn").all_inner_texts() == ["+ all 1"], "one left: just 'all'"
    wrap.locator(".groupacts .showbtn").click(); idle(fpage); settle(fpage)
    assert "tx:" + tid(100) in shown(fpage)
    assert fpage.locator("#inspBody .walletsec .groupwrap").filter(has_text="6 transactions to").locator(".groupacts").count() == 0


def test_in_a_trace_a_group_of_incoming_ones_is_brought_in_from_behind(fpage, mock):
    busy_wallet(mock)
    open_query(fpage, W)
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    fpage.evaluate("(id) => window.__hopline.setSel([id])", W_ID); settle(fpage)
    wrap = fpage.locator("#inspBody .walletsec .groupwrap").filter(has_text="small transactions")
    wrap.locator(".groupacts .showbtn >> text=+ all 7").click(); idle(fpage); settle(fpage)
    got = {i for i in shown(fpage) if i.startswith("tx:")}
    assert got == {"tx:" + tid(n) for n in range(110, 117)}
    px = lambda i: fpage.evaluate("(id) => window.__hopline.renderer.positionOf(id).x", i)
    assert all(px("tx:" + tid(n)) < px(W_ID) for n in range(110, 117)), "they came before the wallet: to its left"


def test_outside_a_trace_a_group_has_no_show_buttons(fpage, mock):
    busy_wallet(mock)
    open_query(fpage, W)
    assert fpage.locator("#inspBody .walletsec .groupacts").count() == 0


# ---- the list behind an arrow
def test_the_arrow_list_folds_repeated_payees_too_and_one_box_ticks_a_whole_group(fpage, mock):
    busy_wallet(mock)
    open_query(fpage, W)
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    click_handle(fpage, W_ID, "right"); idle(fpage)
    assert fpage.is_visible("#ctxMenu .chooser")
    assert fpage.locator("#ctxMenu .choosergroup").count() == 1, "the six payments to the exchange"
    head = fpage.locator("#ctxMenu .grouphead")
    assert "6 transactions to" in head.inner_text()
    box = head.locator("input[type=checkbox]")
    assert fpage.evaluate("() => document.querySelector('#ctxMenu .grouphead input').indeterminate") is True, "five of its six are ticked to start with: half-ticked"
    box.check()
    ticked_now = int(fpage.inner_text("#ctxMenu .chooserfoot .primary").split()[1])
    box.uncheck()
    assert int(fpage.inner_text("#ctxMenu .chooserfoot .primary").split()[1]) == ticked_now - 6


def test_the_group_opens_to_its_rows_in_the_arrow_list_and_a_row_can_be_ticked_alone(fpage, mock):
    busy_wallet(mock)
    open_query(fpage, W)
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    click_handle(fpage, W_ID, "right"); idle(fpage)
    fpage.click("#ctxMenu .chooserfoot >> text=None")
    assert fpage.evaluate("() => document.querySelector('#ctxMenu .grouphead input').checked") is False
    assert fpage.locator("#ctxMenu .groupmembers").first.is_hidden()
    fpage.click("#ctxMenu .groupfold")
    assert fpage.locator("#ctxMenu .groupmembers").first.is_visible()
    inside = fpage.locator("#ctxMenu .groupmembers input[type=checkbox]")
    assert inside.count() == 6
    inside.nth(2).check()
    assert fpage.evaluate("() => document.querySelector('#ctxMenu .grouphead input').indeterminate") is True
    fpage.click("#ctxMenu .chooserfoot .primary"); idle(fpage); settle(fpage)
    assert len([i for i in shown(fpage) if i.startswith("tx:")]) == 1, "only the one that was ticked"


def test_the_arrow_list_groups_follow_the_filters_and_say_how_many_match(fpage, mock):
    busy_wallet(mock)
    open_query(fpage, W)
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    click_handle(fpage, W_ID, "right"); idle(fpage)
    fpage.fill("#ctxMenu .choosertools input[type=text]", "0.00052")                 # the exchange payments are 50000..55000 sats: four of them reach 52000
    assert "4 of 6 match" in fpage.inner_text("#ctxMenu .grouphead")
    fpage.fill("#ctxMenu .choosertools input[type=text]", "0.001")
    assert fpage.locator("#ctxMenu .choosergroup").first.is_hidden(), "nothing of the group matches: the group is gone from the list"


def test_group_similar_rows_in_the_arrow_list_is_a_checkbox_shared_with_the_settings(fpage, mock):
    busy_wallet(mock)
    open_query(fpage, W)
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    click_handle(fpage, W_ID, "right"); idle(fpage)
    fpage.uncheck("#ctxMenu .choosertools >> text=Group similar rows")
    assert fpage.locator("#ctxMenu .choosergroup").count() == 0 and fpage.locator("#ctxMenu .chooserrow").count() == 9
    assert fpage.evaluate("() => window.__hopline.state.groupRows") is False and not fpage.is_checked("#groupRows")


def test_many_small_outputs_of_one_transaction_fold_into_one_line(fpage, mock):
    txid = "ef" * 32
    outs = [{"scriptpubkey_address": "bc1qdust%03d" % i, "scriptpubkey_type": "v0_p2wpkh", "value": 1000 + i} for i in range(12)] + [{"scriptpubkey_address": "bc1qlarge%03d" % i, "scriptpubkey_type": "v0_p2wpkh", "value": 500000 + i} for i in range(3)]
    mock.routes["/tx/" + txid] = {"txid": txid, "fee": 100, "weight": 800, "status": {"confirmed": True, "block_height": 1, "block_time": 1650000000},
                                  "vin": [{"txid": "cd" * 32, "vout": 0, "is_coinbase": False, "prevout": {"scriptpubkey_address": "bc1qsrc", "scriptpubkey_type": "v0_p2wpkh", "value": 9000000}}], "vout": outs}
    mock.routes["/tx/" + txid + "/outspends"] = [{"spent": False} for _ in outs]
    open_query(fpage, txid)
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    click_handle(fpage, "tx:" + txid, "right"); idle(fpage)
    head = fpage.inner_text("#ctxMenu .grouphead")
    assert "12 small outputs (each under 0.00010000 BTC)" in head, head
    assert fpage.locator("#ctxMenu .chooserrow:not(.grouphead)").count() == 15, "the three large ones and the twelve inside the group"
    fpage.click("#ctxMenu .chooserfoot >> text=None")
    fpage.locator("#ctxMenu .grouphead input").check()
    assert fpage.inner_text("#ctxMenu .chooserfoot .primary") == "Show 12 ticked"
    fpage.click("#ctxMenu .chooserfoot .primary"); idle(fpage); settle(fpage)
    assert len([i for i in shown(fpage) if i.startswith("addr:")]) == 12


def test_nothing_folds_when_nothing_looks_alike(fpage, mock):
    tx_, outs = many_outputs(mock, 12)                                           # twelve different wallets, each far above the small limit
    open_query(fpage, tx_[3:])
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    click_handle(fpage, tx_, "right"); idle(fpage)
    assert fpage.locator("#ctxMenu .choosergroup").count() == 0 and fpage.locator("#ctxMenu .chooserrow").count() == 12


def test_the_group_boxes_work_from_the_keyboard(fpage, mock):
    busy_wallet(mock)
    open_query(fpage, W)
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    click_handle(fpage, W_ID, "right"); idle(fpage)
    fpage.click("#ctxMenu .chooserfoot >> text=None")
    fpage.locator("#ctxMenu .grouphead input").focus()
    fpage.keyboard.press("Space")
    assert fpage.evaluate("() => document.querySelector('#ctxMenu .grouphead input').checked") is True
    fpage.keyboard.press("ArrowDown")
    assert fpage.evaluate("() => document.activeElement.type") == "checkbox"
