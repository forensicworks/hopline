"""More than one route between two vertices: find the other ones, list them shortest first, and light one at a time."""
import pytest

from chains import IN, OUT, addr, tid, tx
from helpers import idle, open_query, settle, toast_text


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def two_routes(mock):
    """a pays b and c in tx 1; b -> d -> z (txs 2, 3: three transactions from tx 1 to z); c -> e -> f -> z (txs 4, 5, 6: four)."""
    tx(mock, 1, [IN(90, 0, "a", 1000)], [OUT("b", 400), OUT("c", 590)], spent={0: 2, 1: 4})
    tx(mock, 2, [IN(1, 0, "b", 400)], [OUT("d", 390)], spent={0: 3})
    tx(mock, 3, [IN(2, 0, "d", 390)], [OUT("z", 380)])
    tx(mock, 4, [IN(1, 1, "c", 590)], [OUT("e", 580)], spent={0: 5})
    tx(mock, 5, [IN(4, 0, "e", 580)], [OUT("f", 570)], spent={0: 6})
    tx(mock, 6, [IN(5, 0, "f", 570)], [OUT("z", 560)])


def start(tpage, mock, last=6):
    """Everything loaded, tx 1 the starting point (the reference) and z a wallet with a name, so that it can be searched for."""
    two_routes(mock)
    for n in range(1, last + 1):
        open_query(tpage, tid(n))
    tpage.evaluate("(id) => { window.__hopline.state.graph.annotate(id, 'Target', ''); window.__hopline.refresh(); }", "addr:" + addr("z")); settle(tpage)
    tpage.evaluate("(id) => window.__hopline.setSel([id])", "addr:" + addr("z")); settle(tpage)


def lit(page):
    return page.evaluate("() => { const c = window.__hopline.renderer.chain; return c ? { ids: [...c.ids], path: [...c.path] } : null; }")


def show_first_route(tpage):
    tpage.click("#inspBody .relbtn[data-rel=down]"); idle(tpage); settle(tpage)
    tpage.wait_for_selector("#anFindings [data-more-routes]", timeout=5000)


def test_the_shortest_route_is_lit_first_and_a_button_looks_for_the_others(tpage, mock):
    start(tpage, mock)
    assert "3 tx" in tpage.inner_text("#inspBody .relbtn[data-rel=down]")
    show_first_route(tpage)
    c = lit(tpage)
    assert {"tx:" + tid(n) for n in (1, 2, 3)} <= set(c["ids"]) and not ({"tx:" + tid(n) for n in (4, 5, 6)} & set(c["ids"])), "the three-transaction route is lit"
    assert tpage.locator("#anFindings [data-route]").count() == 0, "nothing else is listed before it is asked for"
    tpage.click("#anFindings [data-more-routes=find]"); idle(tpage); settle(tpage)
    rows = tpage.locator("#anFindings [data-route]")
    assert rows.count() == 2, "two routes"
    t = [rows.nth(i).inner_text().replace("\n", " ") for i in range(2)]
    assert t[0].startswith("Route 1 · 3 transactions") and "shown" in t[0] and t[1].startswith("Route 2 · 4 transactions"), t
    assert rows.nth(0).get_attribute("aria-current") == "true" and rows.nth(1).get_attribute("aria-current") is None
    assert "2 routes" in toast_text(tpage)
    assert tpage.inner_text("#anFindings [data-more-routes]") == "Search again"
    assert "Shortest first" in tpage.inner_text("#anFindings")


def test_clicking_another_route_lights_it_instead_and_brings_in_what_is_not_on_screen(tpage, mock):
    start(tpage, mock)
    show_first_route(tpage)
    tpage.click("#anFindings [data-more-routes=find]"); idle(tpage); settle(tpage)
    tpage.click("#anFindings [data-route='2']"); settle(tpage)
    c = lit(tpage)
    assert {"tx:" + tid(n) for n in (1, 4, 5, 6)} <= set(c["ids"]) and not ({"tx:" + tid(n) for n in (2, 3)} & set(c["ids"])), "the four-transaction route is lit now"
    assert "4 transactions" in tpage.inner_text("#chainChip")
    shown = set(tpage.evaluate("() => [...window.__hopline.renderer.data.visible.nodes]"))
    assert {"tx:" + tid(n) for n in (4, 5, 6)} <= shown, "in the Trace layout the route is shown"
    rows = tpage.locator("#anFindings [data-route]")
    assert rows.nth(1).get_attribute("aria-current") == "true" and rows.nth(0).get_attribute("aria-current") is None, "the list says which one is lit"
    assert tpage.locator("#anFindings [data-route]").count() == 2, "the list stays"
    steps = tpage.eval_on_selector_all("#anFindings [data-group=route] ~ .rowcopy .rowtext", "els => els.map((e) => e.textContent.trim())")
    assert len([x for x in steps if x[:2] in ("1.", "2.", "3.", "4.")]) == 4, steps
    tpage.click("#anFindings [data-route='1']"); settle(tpage)
    assert "3 transactions" in tpage.inner_text("#chainChip"), "and back"


def test_when_there_is_only_one_way_it_says_so_and_lists_nothing(tpage, mock):
    start(tpage, mock, last=3)                                                         # only tx 1 to 3 are loaded: one way to z
    show_first_route(tpage)
    tpage.click("#anFindings [data-more-routes=find]"); idle(tpage); settle(tpage)
    assert tpage.locator("#anFindings [data-route]").count() == 0
    assert "No other route in what is loaded" in tpage.inner_text("#anFindings") and "No other route in what is loaded" in toast_text(tpage)


def test_the_list_goes_when_something_new_is_loaded_and_the_button_asks_again(tpage, mock):
    start(tpage, mock, last=3)
    show_first_route(tpage)
    tpage.click("#anFindings [data-more-routes=find]"); idle(tpage); settle(tpage)
    assert "No other route" in tpage.inner_text("#anFindings")
    for n in (4, 5, 6):
        open_query(tpage, tid(n))
    tpage.evaluate("() => window.__hopline.openFindings('route')"); settle(tpage)
    assert tpage.inner_text("#anFindings [data-more-routes]") == "Find other routes", "it may be out of date: ask again"
    tpage.click("#anFindings [data-more-routes=find]"); idle(tpage); settle(tpage)
    assert tpage.locator("#anFindings [data-route]").count() == 2


def test_a_route_that_crosses_a_service_wallet_is_listed_last_and_says_so(tpage, mock):
    two_routes(mock)
    tx(mock, 1, [IN(90, 0, "a", 1100)], [OUT("b", 400), OUT("c", 590), OUT("c2", 100)], spent={0: 2, 1: 4, 2: 7})       # tx 1 pays a third wallet too
    tx(mock, 7, [IN(1, 2, "c2", 100)], [OUT("shop", 95)], spent={0: 8})                  # which pays a service wallet (tagged below), which pays z
    tx(mock, 8, [IN(7, 0, "shop", 95)], [OUT("z", 90)])
    for n in range(1, 9):
        open_query(tpage, tid(n))
    tpage.evaluate("(id) => { const g = window.__hopline.state.graph; g.annotate(id, 'Target', ''); g.nodes.get('addr:' + %s).tag = 'EXCH'; window.__hopline.refresh(); }" % repr(addr("shop")), "addr:" + addr("z")); settle(tpage)
    tpage.evaluate("(id) => window.__hopline.setSel([id])", "addr:" + addr("z")); settle(tpage)
    show_first_route(tpage)
    tpage.click("#anFindings [data-more-routes=find]"); idle(tpage); settle(tpage)
    rows = tpage.locator("#anFindings [data-route]")
    texts = [rows.nth(i).inner_text().replace("\n", " ") for i in range(rows.count())]
    assert rows.count() == 3 and "only across a service wallet" in texts[2] and "only across" not in texts[0] + texts[1], texts
    assert texts[2].startswith("Route 3 · 3 transactions"), "shorter than the second, but it crosses a service wallet: it comes last"
