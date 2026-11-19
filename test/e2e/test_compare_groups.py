"""Compare two groups: a button for two selected vertices of two signing groups, a card with the pairs close in time between them, how many pairs chance gives and the habits side by side,
and a group of comparisons in the Findings. A similarity or a coincidence to weigh, never a finding, and never saved in the file.

Two wallets of three transactions each, all made up; transaction 1 and transaction 4 were first seen 58 seconds apart.
"""
import json

import pytest

from chains import addr, tid
from helpers import selected, settle, show_findings
from test_assistant_timing import groups_scene

STATE = "window.__hopline.state"


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def pick(page, *ids):
    page.evaluate("(ids) => window.__hopline.setSel(ids)", list(ids)); settle(page)


def wallets(*who):
    return ["addr:" + addr(w) for w in who]


def test_two_wallets_of_two_groups_get_a_button_and_the_card_says_what_it_is_and_what_chance_gives(tpage, mock):
    groups_scene(tpage, mock)
    pick(tpage, *wallets("aa", "bb"))
    assert tpage.locator("#inspBody button", has_text="Compare these two groups").is_enabled()
    assert tpage.locator("#inspBody .cmpcard").count() == 0, "the card comes only after the button was pressed"
    tpage.click("#inspBody button:has-text('Compare these two groups')"); settle(tpage)
    card = tpage.locator("#inspBody .cmpcard")
    assert card.count() == 1
    t = card.inner_text()
    assert "vs" in t and "a similarity or a coincidence to weigh, not a finding" in t
    assert "Signed transactions" in t and "3 and 3" in t
    assert "from tx 010101…010101, tx 020202…020202, tx 030303…030303 and from tx 040404…040404, tx 050505…050505, tx 060606…060606: this links two starting points" in t.replace("\n", " "), "each transaction opened is a starting point of its own, written 'tx 010101…010101', not with the internal prefix"
    assert "tx:" not in t
    assert "Pairs close in time" in t and "Expected by chance" in t and "activity comes in bursts" in t
    assert "habits" in t.lower() and "shape: 1in/1out / 1in/1out" in t and "same" in t
    assert "version: " in t and ("not known" in t or "no single value" in t or "version: v" in t), "every habit row says what is known: a value, mixed, or not known"
    assert "Select the 2 transactions of the pairs" in t


def test_the_pair_row_selects_its_two_transactions_and_the_button_selects_them_all(tpage, mock):
    groups_scene(tpage, mock)
    pick(tpage, *wallets("aa", "bb"))
    tpage.click("#inspBody button:has-text('Compare these two groups')"); settle(tpage)
    tpage.locator("#inspBody .cmpcard .linkrow").first.click(); settle(tpage)
    assert sorted(selected(tpage)) == sorted(["tx:" + tid(1), "tx:" + tid(4)])


def test_the_findings_list_the_comparisons_of_this_session_and_remove_takes_one_out(tpage, mock):
    groups_scene(tpage, mock)
    pick(tpage, *wallets("aa", "bb"))
    assert tpage.locator("#anFindings [data-group=compare]").count() == 0
    tpage.click("#inspBody button:has-text('Compare these two groups')"); settle(tpage)
    show_findings(tpage); settle(tpage)
    assert tpage.locator("#anFindings [data-group=compare]").count() == 1
    summary = tpage.locator("#anFindings .cmpdet summary").inner_text()
    assert " vs " in summary and "1 pair" in summary
    assert "not saved in the file" in tpage.inner_text("#anFindings")
    tpage.locator("#anFindings .cmpdet summary").click()
    tpage.locator("#anFindings .cmpdet button:has-text('Remove')").click(); settle(tpage)
    assert tpage.locator("#anFindings [data-group=compare]").count() == 0


def test_transactions_of_two_groups_work_as_well_as_wallets(tpage, mock):
    groups_scene(tpage, mock)
    pick(tpage, "tx:" + tid(2), "tx:" + tid(5))
    tpage.click("#inspBody button:has-text('Compare these two groups')"); settle(tpage)
    assert tpage.locator("#inspBody .cmpcard").count() == 1


def test_one_group_or_more_than_two_vertices_get_no_working_button(tpage, mock):
    groups_scene(tpage, mock)
    pick(tpage, "tx:" + tid(1), "tx:" + tid(2))                                  # both signed by wallet aa
    assert tpage.locator("#inspBody button:has-text('Compare these two groups')").is_disabled()
    pick(tpage, "tx:" + tid(1), "tx:" + tid(2), "tx:" + tid(4))
    assert tpage.locator("#inspBody button:has-text('Compare these two groups')").count() == 0
    pick(tpage, "tx:" + tid(1))
    assert tpage.locator("#inspBody button:has-text('Compare these two groups')").count() == 0


def test_a_comparison_is_never_saved_in_the_file_and_clearing_the_workspace_forgets_it(tpage, mock):
    groups_scene(tpage, mock)
    pick(tpage, *wallets("aa", "bb"))
    tpage.click("#inspBody button:has-text('Compare these two groups')"); settle(tpage)
    text = tpage.evaluate("() => window.__hopline.exportJson ? window.__hopline.exportJson() : ''")
    stored = tpage.evaluate("() => localStorage.getItem('hopline.workspace.v1') || ''")
    assert "compar" not in (text or "").lower() and "compar" not in stored.lower()
    tpage.click("#btnClear"); tpage.click("#btnClear"); settle(tpage)
    assert tpage.evaluate("() => window.__hopline.state.graph.nodes.size") == 0, "the workspace is empty"
    groups_scene(tpage, mock)                                                     # the same transactions are loaded again
    pick(tpage, *wallets("aa", "bb"))
    assert tpage.locator("#inspBody .cmpcard").count() == 0, "the comparison asked for before is not remembered: only the button is offered"
    show_findings(tpage); settle(tpage)
    assert tpage.locator("#anFindings [data-group=compare]").count() == 0
