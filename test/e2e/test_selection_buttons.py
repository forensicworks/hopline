"""The "N selected" details: Clear selection (always) and, after Select all under a transaction's Funded by / Spent by, a way back to that transaction."""
import re

import pytest

from helpers import idle, selected, settle
from test_inspector_links import HUB, SPENT, opened, preview, section


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def select_all(page, title, n):
    section(page, title).locator(".selall").click()
    page.wait_for_function("(n) => window.__hopline.state.selected.size === n", arg=n, timeout=4000)
    page.wait_for_timeout(300)


def buttons(page):
    return page.locator("#inspBody .selbuttons button")


def labels(page):
    return [b.inner_text() for b in buttons(page).all()]


# ---- where they are ----------------------------------------------------------------------------------------------------------------------------------

def test_after_select_all_the_details_say_how_many_are_selected_and_offer_the_way_back_and_clear(fpage, mock):
    opened(fpage, mock)
    select_all(fpage, "Spent by", 3)
    assert fpage.inner_text("#inspBody h3") == "3 selected"
    assert labels(fpage) == ["← Back to the transaction", "Clear selection"], "right under the heading, before everything else"
    first = fpage.evaluate("() => document.querySelector('#inspBody').children[1].className")
    assert "selbuttons" in first, "the second thing in the panel, after the heading"


def test_a_selection_made_any_other_way_has_clear_selection_but_no_way_back(fpage, mock):
    opened(fpage, mock)
    fpage.evaluate("(ids) => window.__hopline.setSel(ids)", SPENT)
    settle(fpage)
    assert labels(fpage) == ["Clear selection"], labels(fpage)
    fpage.keyboard.press("Control+A")
    settle(fpage)
    assert labels(fpage) == ["Clear selection"], labels(fpage)


def test_one_selected_vertex_has_neither_since_there_is_nothing_to_clear_down_to(fpage, mock):
    opened(fpage, mock)
    assert buttons(fpage).count() == 0


# ---- Clear selection ---------------------------------------------------------------------------------------------------------------------------------

def test_clear_selection_deselects_everything_and_leaves_no_ring(fpage, mock):
    opened(fpage, mock)
    select_all(fpage, "Funded by", 2)
    fpage.get_by_role("button", name="Clear selection").click()
    fpage.wait_for_function("() => window.__hopline.state.selected.size === 0", timeout=4000)
    fpage.wait_for_timeout(300)
    assert selected(fpage) == [] and preview(fpage) is None
    assert fpage.is_hidden("#inspBody"), "the details of a selection are gone (the panel shows the findings, or nothing)"


def test_clear_selection_tells_what_it_deselects_and_how_else_to_do_it(fpage, mock):
    opened(fpage, mock)
    select_all(fpage, "Spent by", 3)
    title = fpage.get_by_role("button", name="Clear selection").get_attribute("title")
    assert "all 3" in title and "Esc" in title, title


# ---- Back to the transaction -------------------------------------------------------------------------------------------------------------------------

def test_back_to_the_transaction_selects_just_that_transaction_and_shows_its_details_again(fpage, mock):
    opened(fpage, mock)
    select_all(fpage, "Spent by", 3)
    fpage.get_by_role("button", name="← Back to the transaction").click()
    fpage.wait_for_function("() => window.__hopline.state.selected.size === 1", timeout=4000)
    fpage.wait_for_timeout(300)
    assert selected(fpage) == [HUB]
    body = fpage.inner_text("#inspBody").lower()
    assert "funded by (2)" in body and "spent by (3)" in body, "the transaction's own details, with its lists again"
    assert buttons(fpage).count() == 0


def test_pointing_at_back_rings_the_transaction_it_goes_to(fpage, mock):
    opened(fpage, mock)
    select_all(fpage, "Funded by", 2)
    fpage.get_by_role("button", name="← Back to the transaction").hover()
    fpage.wait_for_function("() => window.__hopline.renderer.preview !== null", timeout=4000)
    assert preview(fpage)["ids"] == [HUB]
    fpage.mouse.move(5, 5)
    fpage.wait_for_function("() => window.__hopline.renderer.preview === null", timeout=4000)


def test_it_works_again_for_the_other_list(fpage, mock):
    opened(fpage, mock)
    select_all(fpage, "Funded by", 2)
    fpage.get_by_role("button", name="← Back to the transaction").click()
    fpage.wait_for_function("() => window.__hopline.state.selected.size === 1", timeout=4000); settle(fpage)
    select_all(fpage, "Spent by", 3)
    assert sorted(selected(fpage)) == sorted(SPENT)
    fpage.get_by_role("button", name="← Back to the transaction").click()
    fpage.wait_for_function("() => window.__hopline.state.selected.size === 1", timeout=4000)
    assert selected(fpage) == [HUB]


def test_back_is_gone_as_soon_as_the_selection_is_not_what_select_all_made(fpage, mock):
    opened(fpage, mock)
    select_all(fpage, "Spent by", 3)
    assert "← Back to the transaction" in labels(fpage)
    fpage.evaluate("(ids) => window.__hopline.setSel(ids)", SPENT[:2])                    # two of the three: it is a different selection now
    settle(fpage)
    assert labels(fpage) == ["Clear selection"], labels(fpage)
    fpage.evaluate("(ids) => window.__hopline.setSel(ids)", SPENT)                        # the same three, picked by hand: nothing records where they came from
    settle(fpage)
    assert "← Back to the transaction" not in labels(fpage), "it only offers the way back after Select all"


def test_the_buttons_are_in_the_details_not_in_the_empty_canvas_message(fpage, mock):
    opened(fpage, mock)
    select_all(fpage, "Spent by", 3)
    assert re.search(r"3 selected", fpage.inner_text("#inspBody")) and fpage.is_visible("#inspBody .selbuttons")
    idle(fpage)
