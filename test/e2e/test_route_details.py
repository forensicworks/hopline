"""The Route to section in the details of a wallet or transaction: always there once there is a reference, with a button that makes the vertex the reference."""
import pytest

from chains import addr, tid
from helpers import idle, open_query, settle
from test_routes import EX, K2, case, trace_case


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def select(page, id_):
    page.evaluate("(id) => window.__hopline.setSel([id])", id_); settle(page)


def details(page):
    return page.inner_text("#inspBody")


def use_buttons(page):
    return page.locator("#inspBody .relbtn[data-use-ref]").count()


def test_every_wallet_and_transaction_shows_the_section_with_the_button_when_there_is_a_reference(tpage, mock):
    trace_case(tpage, mock)
    for vid in ("addr:" + addr("z"), "addr:" + K2, "addr:" + EX, "addr:" + addr("vic"), "tx:" + tid(2), "tx:" + tid(5), "tx:" + tid(6)):
        select(tpage, vid)
        assert "route to" in details(tpage).lower(), vid
        assert use_buttons(tpage) == 1, vid


def test_a_wallet_or_transaction_without_a_route_says_so_and_offers_the_searches(tpage, mock):
    trace_case(tpage, mock)
    for vid in ("addr:" + addr("z"), "tx:" + tid(5)):
        select(tpage, vid)
        t = details(tpage).lower()
        assert "route to" in t and "no route in what is loaded" in t, (vid, t)
        assert tpage.locator("#inspBody .relbtn[data-search]").count() == 2 and tpage.locator("#inspBody .relbtn[data-rel]").count() == 0, vid


def test_a_vertex_with_a_route_still_shows_it_and_gets_the_button_too(tpage, mock):
    trace_case(tpage, mock)
    select(tpage, "addr:" + EX)
    assert tpage.locator("#inspBody .relbtn[data-rel=up]").count() == 1 and use_buttons(tpage) == 1


def test_use_as_reference_makes_the_vertex_the_reference_for_every_other_one(tpage, mock):
    trace_case(tpage, mock)
    select(tpage, "addr:" + EX)
    tpage.click("#inspBody .relbtn[data-use-ref]"); settle(tpage)
    assert tpage.evaluate("() => window.__hopline.state.routeRef") == "addr:" + EX
    assert "This is the reference." in details(tpage) and use_buttons(tpage) == 0, "the reference itself needs no button"
    select(tpage, "addr:" + addr("vic"))
    assert "route to test exchange" in details(tpage).lower(), "the others are measured from it now"
    assert tpage.locator("#inspBody .relbtn[data-rel=down]").count() == 1
    tpage.evaluate("() => window.__hopline.openFindings('known')"); settle(tpage)
    assert tpage.eval_on_selector("#anFindings .refsel", "s => s.value") == "addr:" + EX, "the Findings show the same choice"


def test_the_choice_survives_selecting_something_else_and_the_picker_can_change_it_back(tpage, mock):
    trace_case(tpage, mock)
    select(tpage, "addr:" + EX)
    tpage.click("#inspBody .relbtn[data-use-ref]"); settle(tpage)
    select(tpage, "tx:" + tid(2))
    assert "route to test exchange" in details(tpage).lower()
    start = tpage.eval_on_selector("#inspBody .refsel", "s => [...s.options].find((o) => o.textContent.startsWith('START')).value")
    tpage.select_option("#inspBody .refsel", start); settle(tpage)
    assert tpage.evaluate("() => window.__hopline.state.routeRef") == start
    assert "route to test exchange" not in details(tpage).lower()


def test_with_no_start_a_vertex_is_the_reference_only_while_selected_and_the_button_keeps_it(fpage, mock):
    case(mock)
    for n in (3, 2, 5):
        open_query(fpage, tid(n))
    idle(fpage); settle(fpage)
    assert fpage.evaluate("() => window.__hopline.state.trace.seeds.length") == 0, "no trace was started in this layout"
    select(fpage, "tx:" + tid(2))
    t = details(fpage)
    assert "This is the reference, while it is the vertex selected." in t and use_buttons(fpage) == 1
    select(fpage, "tx:" + tid(5))
    assert "This is the reference, while it is the vertex selected." in details(fpage), "it follows the selection"
    select(fpage, "tx:" + tid(2))
    fpage.click("#inspBody .relbtn[data-use-ref]"); settle(fpage)
    assert fpage.evaluate("() => window.__hopline.state.routeRef") == "tx:" + tid(2)
    assert "This is the reference." in details(fpage) and use_buttons(fpage) == 0
    select(fpage, "tx:" + tid(3))
    t = details(fpage).lower()
    assert "route to tx" in t and "this is the reference" not in t, "kept: another vertex is measured from it"
    assert fpage.locator("#inspBody .relbtn[data-rel]").count() == 1, "tx 3 follows tx 2: there is a route"
