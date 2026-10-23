"""The right-hand panel: Details of what is selected and Findings (what the analysis and the lists found), one tab each."""
import pytest

from chains import addr, consolidation, reuse_change, tid
from conftest import NORMAL
from helpers import click_node, open_query, settle
from test_every_name import load_json, sanctions_pack
from test_label_packs import SMALL_ADDR


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def nothing_selected(page):
    page.evaluate("() => window.__hopline.setSel([])"); settle(page)


def selected(page):
    return set(page.evaluate("() => [...window.__hopline.state.selected]"))


def tab(page):
    return page.evaluate("() => document.getElementById('tabFindings').getAttribute('aria-selected') === 'true' ? 'findings' : 'details'")


def groups(page):
    return page.eval_on_selector_all("#anFindings [data-group]", "els => els.map((e) => e.dataset.group)")


def in_panel_view(page, selector):
    return page.evaluate("""(sel) => { const p = document.getElementById('inspector').getBoundingClientRect(), r = document.querySelector(sel).getBoundingClientRect();
                                      return r.top >= p.top - 1 && r.bottom <= p.bottom + 1; }""", selector)


def test_with_findings_and_nothing_selected_the_panel_shows_them(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30)); nothing_selected(fpage)
    assert fpage.is_visible("#inspector") and fpage.is_visible("#findPane") and fpage.is_hidden("#inspBody")
    assert fpage.is_hidden("#rpTabs") and fpage.inner_text("#findTitle") == "Findings"
    text = fpage.inner_text("#anFindings").lower()
    assert "consol" in text and "address clusters" in text
    assert fpage.locator("#side #anFindings").count() == 0 and fpage.locator("#side #detSection").count() == 0, "the left panel keeps only the switches"
    assert fpage.is_visible("#anOpenFindings")


def test_a_click_on_the_graph_turns_the_panel_to_details_and_the_tabs_switch_between_the_two(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30)); nothing_selected(fpage)
    click_node(fpage, "tx:" + tid(30)); settle(fpage)
    assert fpage.is_visible("#rpTabs") and fpage.is_visible("#inspBody") and fpage.is_hidden("#findPane") and tab(fpage) == "details"
    assert "TRANSACTION" in fpage.inner_text("#inspBody").upper()
    fpage.click("#tabFindings"); settle(fpage)
    assert tab(fpage) == "findings" and fpage.is_visible("#findPane") and fpage.is_hidden("#inspBody")
    assert selected(fpage) == {"tx:" + tid(30)}, "the selection is kept"
    fpage.click("#tabDetails"); settle(fpage)
    assert tab(fpage) == "details" and fpage.is_visible("#inspBody")
    fpage.focus("#tabDetails"); fpage.keyboard.press("ArrowRight"); settle(fpage)
    assert tab(fpage) == "findings" and fpage.evaluate("() => document.activeElement.id") == "tabFindings"
    fpage.keyboard.press("ArrowLeft"); settle(fpage)
    assert tab(fpage) == "details"


def test_a_chip_opens_the_panel_at_its_group_selects_and_stays_on_the_findings(fpage, mock):
    consolidation(mock); reuse_change(mock)
    open_query(fpage, tid(30)); open_query(fpage, tid(40)); fpage.uncheck("#focusOn"); settle(fpage)
    click_node(fpage, "tx:" + tid(40)); settle(fpage)
    assert tab(fpage) == "details"
    fpage.click("#findStrip [data-key=consolidation]"); settle(fpage)
    assert tab(fpage) == "findings" and fpage.is_visible("#findPane")
    assert selected(fpage) == {"tx:" + tid(30)}
    assert in_panel_view(fpage, '#anFindings [data-group="consolidation"]'), "the group is brought into view"


def test_a_chip_unfolds_a_folded_panel(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30)); nothing_selected(fpage)
    fpage.click("#inspCollapse"); settle(fpage)
    assert fpage.is_hidden("#inspector")
    fpage.click("#findStrip [data-key=clusters]"); settle(fpage)
    assert fpage.is_visible("#inspector") and tab(fpage) == "findings" and selected(fpage) == {"addr:" + addr("k%d" % i) for i in range(6)}


def test_acting_from_the_findings_keeps_the_panel_on_findings_until_you_click_the_graph(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30)); nothing_selected(fpage)
    fpage.click("#detList .detrow >> nth=0"); settle(fpage)
    assert selected(fpage) == {"tx:" + tid(30)}
    assert tab(fpage) == "findings" and fpage.is_visible("#findPane"), "a row of the list selects it without leaving the list"
    fpage.click("#detSelectAll"); settle(fpage)
    assert tab(fpage) == "findings"
    click_node(fpage, "addr:" + addr("k0")); settle(fpage)
    assert tab(fpage) == "details" and "ADDRESS" in fpage.inner_text("#inspBody").upper(), "a click on the graph is about the vertex"


def test_close_folds_the_panel_on_findings_and_the_edge_tab_names_it(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30)); nothing_selected(fpage)
    fpage.click("#inspClose"); settle(fpage)
    assert fpage.is_hidden("#inspector") and fpage.is_visible("#inspTab") and "Findings (2)" in fpage.inner_text("#inspTab")
    fpage.click("#inspTab"); settle(fpage)
    assert fpage.is_visible("#inspector") and tab(fpage) == "findings"


def test_close_on_details_clears_the_selection_and_the_findings_are_what_is_left(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30)); nothing_selected(fpage)
    click_node(fpage, "tx:" + tid(30)); settle(fpage)
    fpage.click("#inspClose"); settle(fpage)
    assert selected(fpage) == set() and fpage.is_visible("#findPane") and fpage.is_hidden("#rpTabs")


def test_the_groups_are_listed_in_the_order_of_the_strip(fpage):
    open_query(fpage, NORMAL["txid"])
    load_json(fpage, "list.json", sanctions_pack(SMALL_ADDR))
    nothing_selected(fpage)
    g = [x for x in groups(fpage) if x in ("sanctions", "change", "known")]
    assert g == ["sanctions", "known"], "sanctions first, known wallets last (no change guess: both outputs are on lists, so neither stands out)"
    pane = fpage.inner_text("#anFindings")
    assert "Listed person" in pane and "Robinhood Hot Wallet" in pane and "open its source before relying on it" in pane


def test_a_hostile_name_in_a_list_stays_text_in_the_panel(fpage):
    open_query(fpage, NORMAL["txid"])
    load_json(fpage, "list.json", sanctions_pack(SMALL_ADDR, label="<img src=x onerror=window.__pwned=1>"))
    nothing_selected(fpage)
    assert "<img src=x" in fpage.inner_text("#anFindings") and fpage.locator("#findPane img").count() == 0
    assert fpage.evaluate("() => window.__pwned") is None


def test_the_switches_under_analysis_do_not_hide_what_the_panel_lists(fpage, mock):
    consolidation(mock); reuse_change(mock)
    open_query(fpage, tid(30)); open_query(fpage, tid(40)); fpage.uncheck("#focusOn"); nothing_selected(fpage)
    assert {"change", "clusters", "consolidation"} <= set(groups(fpage))
    pane = fpage.inner_text("#anFindings").lower()
    assert "change guesses" in pane and "→ output 1" in pane and "high" in pane and "not findings: follow both outputs" in pane
    fpage.uncheck("#anChange"); fpage.uncheck("#anClusters"); fpage.uncheck("#anFlags")
    assert {"change", "clusters", "consolidation"} <= set(groups(fpage)), "they only decide what is drawn on the graph"


def test_nothing_to_show_means_no_panel(fpage):
    assert fpage.is_hidden("#inspector")


def test_the_panel_is_there_in_full_screen(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30)); nothing_selected(fpage)
    fpage.evaluate("() => { document.documentElement.requestFullscreen = () => Promise.reject(new Error('not allowed here')); }")
    fpage.click("#fullBtn"); settle(fpage)
    assert fpage.is_visible("#inspector") and fpage.is_visible("#findPane") and fpage.is_visible("#findStrip")
    fpage.click("#findStrip [data-key=details]"); settle(fpage)
    assert fpage.is_visible("#findPane")


def test_the_left_panel_button_and_the_strip_button_open_the_findings(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30)); nothing_selected(fpage)
    fpage.click("#inspCollapse"); settle(fpage)
    assert fpage.is_hidden("#inspector")
    fpage.click("#anOpenFindings"); settle(fpage)
    assert fpage.is_visible("#inspector") and tab(fpage) == "findings"
    fpage.click("#inspCollapse"); settle(fpage)
    fpage.click("#findStrip [data-key=details]"); settle(fpage)
    assert fpage.is_visible("#inspector") and tab(fpage) == "findings"


def test_the_details_tab_says_how_many_are_selected(fpage, mock):
    consolidation(mock)
    open_query(fpage, tid(30)); nothing_selected(fpage)
    fpage.evaluate("(ids) => window.__hopline.setSel(ids)", ["addr:" + addr("k0"), "addr:" + addr("k1")]); settle(fpage)
    assert fpage.is_visible("#rpTabs") and fpage.inner_text("#tabDetails") == "Details · 2"
