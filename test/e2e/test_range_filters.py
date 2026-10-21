"""Arrows stay inside the time bar's range, and the arrow list can skip known services, keep unspent outputs only and put known wallets first."""
import pytest

from chains import IN, OUT, real_addr, tid, tx
from helpers import idle, open_query, set_slider, settle, toast_text
from test_grouping import busy_wallet
from test_trace import click_handle, handle, shown
from test_wallet_panel import W, W_ID, WIN


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def t_of(n):
    return 1650000000 + n * 600                                              # what chains.tx gives transaction n


def set_window(page, frm=None, to=None):
    page.evaluate("([a, b]) => { const s = window.__orion.state; s.filter.timeFrom = a; s.filter.timeTo = b; window.__orion.refresh(); }", [frm, to])
    settle(page)


def start_wallet_trace(page, mock):
    busy_wallet(mock)
    open_query(page, W)
    page.click("#layoutSeg [data-layout=trace]"); settle(page)


def listed(page):
    return page.locator("#ctxMenu .chooserrow:not(.grouphead):not([hidden])").count()


# ---------------------------------------------------------------- the time bar
def test_with_the_time_bar_narrowed_the_arrow_counts_only_what_is_inside_and_says_how_many_are_outside(fpage, mock):
    start_wallet_trace(fpage, mock)
    assert handle(fpage, W_ID, "right")["label"] == "9", "nine transactions spent from the wallet"
    set_window(fpage, t_of(102))                                              # from transaction 102 on: 102..108 are inside, 100 and 101 are not
    h = handle(fpage, W_ID, "right")
    assert h["label"] == "7", h
    assert "2 more fall outside the time bar's range" in h["tip"], h["tip"]
    set_window(fpage, None, None)
    assert handle(fpage, W_ID, "right")["label"] == "9", "the full range again"


def test_the_arrow_list_holds_only_what_is_inside_the_range_and_says_so(fpage, mock):
    start_wallet_trace(fpage, mock)
    set_window(fpage, t_of(102))
    click_handle(fpage, W_ID, "right"); idle(fpage)
    assert listed(fpage) + fpage.locator("#ctxMenu .grouphead").count() >= 1
    assert "7 hidden" in fpage.inner_text("#ctxMenu").lower()
    assert "2 more fall outside the time bar's range and are not listed" in fpage.inner_text("#ctxMenu")
    fpage.click("#ctxMenu .chooserfoot >> text=All")
    fpage.click("#ctxMenu .chooserfoot .primary"); idle(fpage); settle(fpage)
    got = {i for i in shown(fpage) if i.startswith("tx:")}
    assert got == {"tx:" + tid(n) for n in range(102, 109)}, sorted(got)


def test_a_plain_click_in_the_few_at_a_time_mode_takes_the_largest_inside_the_range(fpage, mock):
    start_wallet_trace(fpage, mock)
    fpage.evaluate("() => { window.__orion.state.stepMode = 'batch'; }")
    set_window(fpage, t_of(104))                                              # 104..108: five, all of them in range
    click_handle(fpage, W_ID, "right"); idle(fpage); settle(fpage)
    got = {i for i in shown(fpage) if i.startswith("tx:")}
    assert got == {"tx:" + tid(n) for n in range(104, 109)}, "nothing from before the window came with it: " + str(sorted(got))


def test_nothing_inside_the_range_says_so_instead_of_showing_things_that_would_not_be_drawn(fpage, mock):
    start_wallet_trace(fpage, mock)
    set_window(fpage, t_of(500))                                              # after everything
    h = handle(fpage, W_ID, "right")
    assert h["label"] == "0" and "Nothing inside the time bar's range" in h["tip"] and "9 more fall outside" in h["tip"], h
    click_handle(fpage, W_ID, "right"); idle(fpage)
    assert "Nothing inside the time bar's range" in toast_text(fpage) and "9 more fall outside it" in toast_text(fpage)
    assert shown(fpage) == {W_ID}


def test_the_setting_switches_it_off(fpage, mock):
    start_wallet_trace(fpage, mock)
    set_window(fpage, t_of(102))
    assert handle(fpage, W_ID, "right")["label"] == "7"
    fpage.evaluate("() => [...document.querySelectorAll('details')].find(d => d.querySelector('summary').textContent.trim() === 'Expansion limits').open = true")
    fpage.uncheck("#arrowsInRange")
    assert handle(fpage, W_ID, "right")["label"] == "9", "counted as if the range were not there"
    fpage.reload(); fpage.wait_for_function("window.__orion && window.__orion.renderer")
    assert fpage.evaluate("() => window.__orion.state.arrowsInRange") is False, "remembered"


def test_dragging_the_real_slider_narrows_the_arrows_too(fpage, mock):
    start_wallet_trace(fpage, mock)
    before = int(handle(fpage, W_ID, "right")["label"])
    set_slider(fpage, "#tFrom", 600); idle(fpage); settle(fpage)
    h = handle(fpage, W_ID, "right")
    assert h is not None and int(h["label"]) < before and "outside the time bar's range" in h["tip"], h


def test_the_hover_summary_counts_only_what_is_inside_the_range(fpage, mock):
    start_wallet_trace(fpage, mock)
    set_window(fpage, t_of(106))                                              # 106, 107, 108: three, each 70000 sats spent from the wallet
    p = fpage.evaluate("""([id]) => { const r = window.__orion.renderer, h = r.handleRects.find(x => x.id === id && x.dir === 'right');
        const b = r.canvas.getBoundingClientRect(); return { x: b.left + h.x + h.w / 2, y: b.top + h.y + h.h / 2 }; }""", [W_ID])
    fpage.mouse.move(p["x"], p["y"])
    tip = fpage.evaluate("() => window.__orion.renderer.canvas.title")
    assert "3 transactions" in tip and "0.00210000 BTC in total" in tip, tip


# ---------------------------------------------------------------- filters in the arrow list
KNOWN_OUT = [real_addr(i) for i in range(12)]


def twelve_outputs(mock, spent=()):
    """One transaction paying twelve real addresses; the outputs listed in `spent` were spent later."""
    n = 150
    outs = [OUT("x", 100000 - i * 7) for i in range(12)]
    for i, o in enumerate(outs):
        o["scriptpubkey_address"] = KNOWN_OUT[i]
    tx(mock, n, [IN(9, 0, "src", 9000000)], outs, spent={i: 200 + i for i in spent})
    return "tx:" + tid(n)


def pack(page, text):
    page.evaluate("() => { document.getElementById('packSection').open = true; }")
    page.set_input_files("#packFile", files=[{"name": "services.csv", "mimeType": "text/csv", "buffer": text.encode("utf-8")}])
    page.wait_for_function("() => /Imported|Replaced|Import failed/.test(document.getElementById('toast').textContent)")
    settle(page)


def open_list(page, mock, spent=()):
    t = twelve_outputs(mock, spent)
    open_query(page, tid(150))
    page.click("#layoutSeg [data-layout=trace]"); settle(page)
    click_handle(page, t, "right"); idle(page)
    assert page.is_visible("#ctxMenu .chooser")
    return t


def test_skip_known_services_hides_the_rows_on_a_list_and_only_known_keeps_them(fpage, mock):
    t = twelve_outputs(mock)
    open_query(fpage, tid(150))
    pack(fpage, "address,label\n%s,Exchange A\n%s,Exchange B\n%s,Mixer C\n" % (KNOWN_OUT[2], KNOWN_OUT[5], KNOWN_OUT[9]))
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    click_handle(fpage, t, "right"); idle(fpage)
    assert listed(fpage) == 12
    fpage.select_option("#ctxMenu .choosertools select >> nth=1", "skip")
    assert listed(fpage) == 9 and "9 of 12 match" in fpage.inner_text("#ctxMenu")
    fpage.select_option("#ctxMenu .choosertools select >> nth=1", "only")
    assert listed(fpage) == 3 and "3 of 12 match" in fpage.inner_text("#ctxMenu")
    fpage.select_option("#ctxMenu .choosertools select >> nth=1", "any")
    assert listed(fpage) == 12
    fpage.select_option("#ctxMenu .choosertools select >> nth=1", "skip")
    fpage.click("#ctxMenu .chooserfoot >> text=All"); fpage.click("#ctxMenu .chooserfoot .primary"); idle(fpage); settle(fpage)
    got = {i for i in shown(fpage) if i.startswith("addr:")}
    assert len(got) == 9 and not got & {"addr:" + KNOWN_OUT[i] for i in (2, 5, 9)}, "the three services were left out"


def test_a_wallet_you_labelled_is_not_a_service_to_skip_but_counts_as_known(fpage, mock):
    t = twelve_outputs(mock)
    open_query(fpage, tid(150))
    pack(fpage, "address,label\n%s,Exchange A\n" % KNOWN_OUT[2])
    fpage.evaluate("(id) => { window.__orion.state.graph.nodes.get(id).label = 'Suspect 1'; }", "addr:" + KNOWN_OUT[2])      # you labelled the same wallet
    fpage.evaluate("(id) => { window.__orion.state.graph.nodes.get(id).label = 'Suspect 2'; }", "addr:" + KNOWN_OUT[7])
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    click_handle(fpage, t, "right"); idle(fpage)
    fpage.select_option("#ctxMenu .choosertools select >> nth=1", "skip")
    assert listed(fpage) == 12, "your own label beats the list: nothing is skipped"
    fpage.select_option("#ctxMenu .choosertools select >> nth=1", "only")
    assert listed(fpage) == 2, "the two you labelled"


def test_known_or_labelled_first_is_an_order(fpage, mock):
    t = twelve_outputs(mock)
    open_query(fpage, tid(150))
    pack(fpage, "address,label\n%s,Exchange A\n" % KNOWN_OUT[8])
    fpage.evaluate("(id) => { window.__orion.state.graph.nodes.get(id).label = 'Suspect'; }", "addr:" + KNOWN_OUT[10])
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    click_handle(fpage, t, "right"); idle(fpage)
    fpage.select_option("#ctxMenu .choosertools select >> nth=0", "known")
    firsts = fpage.eval_on_selector_all("#ctxMenu .chooserrow", "rows => rows.slice(0, 2).map(r => r.textContent)")
    assert "Suspect" in firsts[0], "labelled by you first"
    assert "Exchange A" in firsts[1], "then the known one"
    assert fpage.input_value("#ctxMenu .choosertools select >> nth=0") == "known"
    fpage.keyboard.press("Escape")
    fpage.reload(); fpage.wait_for_function("window.__orion && window.__orion.renderer")
    assert fpage.evaluate("() => window.__orion.state.chooseSort") == "known", "the order is remembered like the others"


def test_unspent_only_keeps_the_outputs_not_spent_yet(fpage, mock):
    t = open_list(fpage, mock, spent=(0, 1, 2, 3))
    box = fpage.locator("#ctxMenu .unspentopt input")
    assert fpage.locator("#ctxMenu .unspentopt").is_visible()
    assert listed(fpage) == 12
    box.check()
    assert listed(fpage) == 8 and "8 of 12 match" in fpage.inner_text("#ctxMenu")
    fpage.click("#ctxMenu .chooserfoot >> text=All"); fpage.click("#ctxMenu .chooserfoot .primary"); idle(fpage); settle(fpage)
    got = {i for i in shown(fpage) if i.startswith("addr:")}
    assert got == {"addr:" + KNOWN_OUT[i] for i in range(4, 12)}


def test_unspent_only_is_not_offered_where_it_does_not_apply(fpage, mock):
    start_wallet_trace(fpage, mock)
    click_handle(fpage, W_ID, "right"); idle(fpage)                         # transactions that spent from the wallet: nothing about unspent outputs
    assert fpage.is_visible("#ctxMenu .chooser")
    assert fpage.locator("#ctxMenu .unspentopt").is_hidden()


def test_the_wallets_that_paid_this_one_can_be_narrowed_to_those_still_unspent(fpage, mock):
    """◀ on a wallet lists the transactions that paid it: unspent applies to what they paid this wallet."""
    ns = [tx(mock, 300 + i, [IN(250 + i, 0, "payer%d" % i, 20000)], [OUT("x", 10000 + i)], spent={0: 400 + i} if i < 3 else {}) for i in range(8)]
    for i in range(8):
        mock.routes["/tx/" + tid(300 + i)]["vout"][0]["scriptpubkey_address"] = real_addr(500)
    mock.routes["/address/" + real_addr(500)] = {"address": real_addr(500), "chain_stats": {"funded_txo_count": 8, "funded_txo_sum": 1, "spent_txo_count": 3, "spent_txo_sum": 1, "tx_count": 8},
                                                 "mempool_stats": {"funded_txo_count": 0, "funded_txo_sum": 0, "spent_txo_count": 0, "spent_txo_sum": 0, "tx_count": 0}}
    mock.routes["/address/" + real_addr(500) + "/txs"] = [mock.routes["/tx/" + tid(300 + i)] for i in range(8)]
    open_query(fpage, real_addr(500))
    assert fpage.evaluate("() => window.__orion.state.graph.nodes.size") > 8
    for i in range(8):                                                                     # an address history does not say what became of each payment: load that, as expanding a transaction would
        fpage.evaluate("([id, o]) => { window.__orion.state.graph.addOutspends(id, o); }", [tid(300 + i), mock.routes["/tx/" + tid(300 + i) + "/outspends"]])
    fpage.click("#layoutSeg [data-layout=trace]"); settle(fpage)
    click_handle(fpage, "addr:" + real_addr(500), "left"); idle(fpage)
    assert listed(fpage) == 8
    fpage.locator("#ctxMenu .unspentopt input").check()
    assert listed(fpage) == 5 and "5 of 8 match" in fpage.inner_text("#ctxMenu"), "three of the eight payments were spent on"
