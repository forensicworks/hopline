"""A right-click on a wallet or a transaction offers a link to Arkham's own page for it, in a new tab: no key, no proxy, nothing sent until it is clicked.

The same link is in the details panel and at the top of the wallet overview. It is not offered while the data source is Tor, because opening it would go outside Tor and tell Arkham what is being looked at.
"""
import json
import re

import pytest

from conftest import ADDRESS, NORMAL
from helpers import open_query, settle, xy
from test_wallet_page import WALLET_URL, goto, wpage  # noqa: F401  (the fixture is used by name)

ARK = "https://arkm.com/explorer/"
BIG_ADDR = max(NORMAL["vout"], key=lambda o: o["value"])["scriptpubkey_address"]
OTHER_ADDR = next(o["scriptpubkey_address"] for o in NORMAL["vout"] if o["scriptpubkey_address"] != BIG_ADDR)
TX = NORMAL["txid"]
TITLE_WORDS = "no key or proxy is used"


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def right_click(page, node_id):
    p = xy(page, node_id)
    page.mouse.click(p["x"], p["y"], button="right")
    page.wait_for_function("() => !document.getElementById('ctxMenu').hidden")


def ark_in_menu(page):
    return page.locator("#ctxMenu a:has-text('Check in Arkham')")


def test_the_menu_of_a_wallet_has_a_link_to_arkham_that_opens_a_new_tab_and_sends_nothing_by_itself(fpage):
    requests = []
    fpage.on("request", lambda r: requests.append(r.url) if "arkm.com" in r.url else None)
    open_query(fpage, TX)
    right_click(fpage, "addr:" + BIG_ADDR)
    link = ark_in_menu(fpage)
    assert link.count() == 1
    assert link.get_attribute("href") == ARK + "address/" + BIG_ADDR
    assert link.get_attribute("target") == "_blank" and link.get_attribute("rel") == "noopener noreferrer" and link.get_attribute("role") == "menuitem"
    assert TITLE_WORDS in link.get_attribute("title") and "Arkham is told which one" in link.get_attribute("title")
    assert fpage.locator("#ctxMenu a:has-text('Open in explorer')").count() == 1, "next to the explorer link it sits beside"
    assert requests == [], "opening the menu tells Arkham nothing"


def test_the_menu_of_a_transaction_has_one_too(fpage):
    open_query(fpage, TX)
    right_click(fpage, "tx:" + TX)
    assert ark_in_menu(fpage).get_attribute("href") == ARK + "tx/" + TX


def test_a_menu_for_several_vertices_has_none_because_it_is_about_one(fpage):
    open_query(fpage, TX)
    fpage.evaluate("(ids) => window.__hopline.setSel(ids)", ["addr:" + BIG_ADDR, "addr:" + OTHER_ADDR]); settle(fpage)
    right_click(fpage, "addr:" + BIG_ADDR)
    assert ark_in_menu(fpage).count() == 0


def test_clicking_it_opens_arkham_in_another_tab_without_a_referrer_and_leaves_the_workspace_as_it_was(fpage):
    seen = []
    fpage.context.route(re.compile(r"^https://(intel\.)?arkm\.com/"), lambda r: (seen.append(r.request.headers.get("referer")), r.fulfill(status=200, content_type="text/html", body="<title>Arkham</title>"))[1])
    open_query(fpage, TX)
    here = fpage.url
    right_click(fpage, "addr:" + BIG_ADDR)
    with fpage.expect_popup() as pop:
        ark_in_menu(fpage).click()
    tab = pop.value
    tab.wait_for_load_state()
    assert tab.url == ARK + "address/" + BIG_ADDR
    assert seen == [None], "no referrer: Arkham is not told which page of Hopline the visitor came from"
    assert fpage.url == here and fpage.evaluate("() => document.getElementById('ctxMenu').hidden") is True, "the menu closed and this page did not move"
    assert fpage.evaluate("() => window.__hopline.state.graph.nodes.size") > 0
    tab.close()


def test_the_details_panel_has_the_link_for_a_wallet_and_for_a_transaction(fpage):
    open_query(fpage, TX)
    fpage.evaluate("(id) => window.__hopline.setSel([id])", "addr:" + BIG_ADDR); settle(fpage)
    link = fpage.locator("#inspBody a:has-text('Check in Arkham')")
    assert link.count() == 1 and link.get_attribute("href") == ARK + "address/" + BIG_ADDR and link.get_attribute("rel") == "noopener noreferrer" and link.get_attribute("target") == "_blank"
    fpage.evaluate("(id) => window.__hopline.setSel([id])", "tx:" + TX); settle(fpage)
    assert fpage.locator("#inspBody a:has-text('Check in Arkham')").get_attribute("href") == ARK + "tx/" + TX


def test_it_is_not_offered_while_the_data_source_is_tor(fpage):
    open_query(fpage, TX)
    fpage.select_option("#source", "tor")
    settle(fpage)
    right_click(fpage, "addr:" + BIG_ADDR)
    assert fpage.locator("#ctxMenu a:has-text('Open in explorer')").count() == 1 and ark_in_menu(fpage).count() == 0
    fpage.keyboard.press("Escape")
    fpage.evaluate("(id) => window.__hopline.setSel([id])", "addr:" + BIG_ADDR); settle(fpage)
    assert fpage.locator("#inspBody a:has-text('Check in Arkham')").count() == 0 and fpage.locator("#inspBody a:has-text('Open in explorer')").count() == 1


# ---------------------------------------------------------------- the wallet overview
def test_the_wallet_overview_links_to_arkham_next_to_the_address(wpage):
    goto(wpage)
    link = wpage.locator("#arkLink")
    assert link.is_visible() and link.get_attribute("href") == ARK + "address/" + ADDRESS and link.get_attribute("target") == "_blank" and link.get_attribute("rel") == "noopener noreferrer"
    assert TITLE_WORDS in link.get_attribute("title") and link.inner_text().startswith("Check in Arkham")


def test_the_wallet_overview_does_not_offer_it_over_tor(ctx, wpage):
    ctx.add_init_script("localStorage.setItem('hopline.prefs.v1', %s);" % json.dumps(json.dumps({"source": "tor"})))
    goto(wpage)
    assert wpage.locator("#arkLink").is_hidden() and wpage.locator("#head").is_visible()
