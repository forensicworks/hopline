"""The prepared examples on the front page ("No address at hand? Start from an example"): a card says what to look for and what the example does not show, and opens a canvas that is
in the link, so nothing is looked up. Two cards are in view and five more sit folded under "More examples (5)"; the folding itself is also tested from a two-card baseline."""
import re

import pytest

from test_index import INDEX_URL

TX = "35a8e48ecf210d2b5d86ff88c02a5d6f41038b0ed9ef639d97bde16c4261d2fd"
FOLDED = ["sampleConsol", "sampleCoinjoin", "samplePeel", "samplePeelLookalike", "sampleHandoff"]


@pytest.fixture
def ipage(ctx, errors):
    p = ctx.new_page()
    p.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    p.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" else None)
    p.goto(INDEX_URL)
    return p


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def visible_cards(page):
    """The ids of the cards a visitor can see (the page's own visibility check: a closed <details> keeps its content without a box)."""
    cards = page.locator(".learn .lcard")
    return [cards.nth(i).get_attribute("id") for i in range(cards.count()) if cards.nth(i).is_visible()]


def open_list(page):
    if page.locator("details.more").get_attribute("open") is None:
        page.click("details.more > summary")


def open_card(page, mock, cid):
    """Click a card (opening the list first when it is folded) and wait for its canvas; returns how many requests the opening made."""
    if cid in FOLDED:
        open_list(page)
    before = len(mock.requests)
    page.click("#" + cid)
    page.wait_for_function("() => window.__hopline && window.__hopline.state.graph.nodes.size > 0")
    page.wait_for_function("() => window.__hopline.renderer && window.__hopline.renderer.data")
    return len(mock.requests) - before


FACTS = """() => {
  const a = window.__hopline.analysis(), g = window.__hopline.state.graph, flags = [];
  a.tx.forEach((r) => r.flags.forEach((f) => flags.push(f.short)));
  return { n: g.nodes.size, e: g.edges.size, layout: window.__hopline.state.layout, flags, chains: a.chains.map((c) => c.ids.length), clusters: a.clusters.list.length };
}"""


# ---- the plain transaction -----------------------------------------------------------------------------------------------------------------

def test_the_plain_transaction_card_says_what_to_look_for_and_what_it_does_not_show(ipage):
    card = ipage.locator("#samplePlain")
    assert ipage.locator(".learn h2").inner_text() == "No address at hand? Start from an example"
    t = card.inner_text()
    assert "A plain transaction" in t and "One input, two outputs and a fee" in t
    assert "Look for" in t and "Likely change" in t
    assert "Does not show" in t and "who owns any of the wallets" in t
    assert "nothing is looked up" in t
    href = card.get_attribute("href")
    assert href.startswith("public/workspace.html#s1/") and len(href) < 2500, "the example is a canvas link: it needs no data source"


def test_the_card_opens_the_example_without_any_request(ipage, mock):
    assert open_card(ipage, mock, "samplePlain") == 0, "opening a prepared example looks nothing up"
    s = ipage.evaluate("() => ({ layout: window.__hopline.state.layout, n: window.__hopline.state.graph.nodes.size, e: window.__hopline.state.graph.edges.size })")
    assert s == {"layout": "flow", "n": 4, "e": 3}, "wallet, transaction and two outputs"


def test_the_example_is_one_input_two_outputs_a_fee_and_a_change_guess_with_reasons(ipage):
    ipage.click("#samplePlain")
    ipage.wait_for_function("() => window.__hopline && window.__hopline.state.graph.nodes.size > 0")
    info = ipage.evaluate("""(id) => {
      const g = window.__hopline.state.graph, n = g.nodes.get(id), r = window.__hopline.analysis().tx.get(id);
      return { nIn: n.nIn, nOut: n.nOut, valueIn: n.valueIn, valueOut: n.valueOut, fee: n.fee, loaded: n.loaded, flags: r.flags.length,
               change: r.change && { confidence: r.change.confidence, vout: r.change.vout, reasons: r.change.reasons },
               labels: [...g.nodes.values()].filter((x) => x.label).map((x) => x.label).sort(), note: n.note || '' };
    }""", "tx:" + TX)
    assert (info["nIn"], info["nOut"], info["loaded"]) == (1, 2, True)
    assert info["valueIn"] == info["valueOut"] + info["fee"], "inputs = outputs + fee, as the note says"
    assert info["flags"] == 0, "a plain payment: no pattern"
    assert info["change"]["confidence"] == "high" and info["change"]["vout"] == 1 and len(info["change"]["reasons"]) == 2
    assert info["labels"] == ["A plain payment", "Likely the change", "Likely the payment", "Spent from here"]
    assert "inputs = outputs + fee" in info["note"] and "does not show who owns" in info["note"]


def test_the_pills_became_cards_in_one_block_and_a_saved_workspace_is_still_one_link_away(ipage):
    assert ipage.locator(".samples").count() == 0 and ipage.locator("#sampleTx").count() == 0, "no second row of samples, and no sample without a story"
    assert ipage.eval_on_selector_all(".learn .lcard", "els => els.map((e) => e.id)") == ["samplePlain", "sampleWallet"] + FOLDED
    head = ipage.locator(".learnhead #openSaved")
    assert head.inner_text().startswith("Open a saved workspace") and head.get_attribute("href") == "public/workspace.html"


def test_the_ransom_wallet_card_says_what_to_look_for_and_that_it_is_looked_up_live(ipage):
    t = ipage.locator("#sampleWallet").inner_text()
    assert "A real case: the Colonial Pipeline ransom wallet" in t and "Look for" in t
    assert "Does not show" in t and "who is behind the wallet" in t and "public reporting, not from the chain" in t
    assert "looks the wallet up live" in t, "unlike the prepared example, this one contacts the data source"


# ---- the five examples that sit folded -----------------------------------------------------------------------------------------------------

def test_the_shipped_page_shows_two_examples_and_folds_five_under_a_line_that_counts_them(ipage):
    assert visible_cards(ipage) == ["samplePlain", "sampleWallet"]
    det = ipage.locator(".learn details.more")
    assert det.count() == 1 and det.get_attribute("open") is None, "closed whenever the page opens"
    assert ipage.locator("details.more > summary").inner_text() == "More examples (5)"
    assert ipage.eval_on_selector_all("details.more .lcard", "els => els.map((e) => e.id)") == FOLDED
    ipage.click("details.more > summary")
    assert len(visible_cards(ipage)) == 7
    assert ipage.eval_on_selector_all("details.more .lgroup", "els => els.map((e) => e.textContent)") == ["Learn the patterns", "Where a trail meets a service"]


def test_a_link_ending_in_examples_opens_the_list_when_the_page_loads(ipage):
    p = ipage.context.new_page()
    p.goto(INDEX_URL + "#examples")
    assert p.locator("details.more").get_attribute("open") is not None and len(visible_cards(p)) == 7


@pytest.mark.parametrize("cid, name, look, month", [
    ("sampleConsol", "A consolidation", "CONSOL 8→1", "January 2021"),
    ("sampleCoinjoin", "A CoinJoin", "COINJOIN?", "May 2026"),
    ("samplePeel", "A peel chain: the same amount, again and again", "PEEL 1/12", "March 2024"),
    ("samplePeelLookalike", "A peel chain that may be a service paying out", "PEEL 1/10", "March 2020"),
    ("sampleHandoff", "Where a trail meets an exchange", "Service hand-offs", "February 2023"),
])
def test_each_folded_card_says_what_to_look_for_and_what_it_does_not_show(ipage, cid, name, look, month):
    open_list(ipage)
    t = ipage.locator("#" + cid).inner_text()
    assert name in t and "Look for" in t and "Does not show" in t, t
    assert look in t, "the card names what to look for: " + look
    assert re.search(r"A real (transaction|run|deposit) from " + month + r"\.", t) and "Opens a prepared example: nothing is looked up." in t, t
    href = ipage.locator("#" + cid).get_attribute("href")
    assert href.startswith("public/workspace.html#s1/") and len(href) < 6500, "a canvas link: no data source needed"


def test_the_consolidation_opens_as_eight_wallets_into_one_output_grouped_as_one_owner(ipage, mock):
    assert open_card(ipage, mock, "sampleConsol") == 0
    f = ipage.evaluate(FACTS)
    assert f["n"] == 10 and "CONSOL 8→1" in f["flags"] and f["clusters"] == 1 and f["chains"] == []


def test_the_coinjoin_opens_whole_and_its_input_wallets_are_not_grouped(ipage, mock):
    assert open_card(ipage, mock, "sampleCoinjoin") == 0
    f = ipage.evaluate(FACTS)
    assert f["n"] == 38 and "COINJOIN?" in f["flags"], "18 input wallets, the transaction and 19 outputs, all on the canvas"
    assert f["clusters"] == 0, "wallets spent together in a CoinJoin are probably different owners: not grouped"


def test_the_peel_chain_opens_as_a_run_of_twelve_with_one_receiving_wallet(ipage, mock):
    assert open_card(ipage, mock, "samplePeel") == 0
    f = ipage.evaluate(FACTS)
    assert f["layout"] == "trace" and f["n"] == 26 and f["chains"] == [12]
    assert "PEEL 1/12" in f["flags"] and "PEEL 12/12" in f["flags"] and "ROUND 1 BTC" in f["flags"]
    receivers = ipage.evaluate("() => { const g = window.__hopline.state.graph; return [...g.nodes.values()].filter((n) => n.label === 'Receives every 1 BTC').length; }")
    assert receivers == 1, "one wallet receives every payment"


def test_the_look_alike_opens_as_ten_payments_in_one_day(ipage, mock):
    assert open_card(ipage, mock, "samplePeelLookalike") == 0
    f = ipage.evaluate(FACTS)
    assert f["layout"] == "trace" and f["n"] == 30 and f["chains"] == [10] and "PEEL 10/10" in f["flags"]


def test_the_hand_off_opens_with_the_exchange_wallet_tagged_exch_and_one_service_hand_off(ipage, mock):
    assert open_card(ipage, mock, "sampleHandoff") == 0
    f = ipage.evaluate(FACTS)
    assert f["layout"] == "trace" and f["n"] == 4
    w = ipage.evaluate("() => { const n = window.__hopline.state.graph.nodes.get('addr:1VERF5rDyVoS4mPCbK68vSGpVo95cAXRm'); return n && { tag: n.tag, shape: n.shape, color: n.color }; }")
    assert w == {"tag": "EXCH", "shape": "hexagon", "color": "#2ecc71"}, "the named wallet carries the EXCH tag as Hopline itself applies it: a green hexagon"
    ipage.wait_for_function("() => /Service hand-offs\\s*1/.test(document.getElementById('findStrip').innerText)")


def test_the_hand_off_card_names_the_tag_and_what_it_does(ipage):
    open_list(ipage)
    t = ipage.locator("#sampleHandoff").inner_text()
    assert "green hexagon" in t and "EXCH" in t and "marks it as a service" in t and "Service hand-offs" in t, t


# ---- the folding, from a two-card baseline with cards made up for the test ---------------------------------------------------------------------

def two_cards(page):
    """The page as it was with two examples: the folded cards removed, so the folding can be tried with cards the test adds."""
    page.evaluate("""() => {
      const grid = document.querySelector('.learn > .lcards'), det = document.querySelector('.learn > details.more');
      if (det) { [...det.querySelectorAll('.lcard')].forEach((c) => grid.appendChild(c)); det.remove(); }
      [...grid.querySelectorAll('.lcard')].slice(2).forEach((c) => c.remove());
      window.__examples.collapse();
    }""")


def add_examples(page, n, groups=None):
    """n more cards like the second one (the real ones are added the same way), then the folding runs again as it does when the page opens."""
    page.evaluate("""([n, groups]) => {
      const grid = document.querySelector('.learn > .lcards'), proto = document.getElementById('sampleWallet');
      for (let i = 0; i < n; i++) {
        const c = proto.cloneNode(true); c.id = 'extra' + i; c.querySelector('.name').textContent = 'Extra example ' + (i + 1);
        if (groups) c.setAttribute('data-group', groups[i % groups.length]);
        grid.appendChild(c);
      }
      window.__examples.collapse();
    }""", [n, groups])


def test_with_two_examples_nothing_is_folded(ipage):
    two_cards(ipage)
    assert ipage.locator("details.more").count() == 0 and visible_cards(ipage) == ["samplePlain", "sampleWallet"]


def test_a_third_example_alone_is_not_folded_because_one_hidden_card_saves_nothing(ipage):
    two_cards(ipage)
    add_examples(ipage, 1)
    assert ipage.locator("details.more").count() == 0 and len(visible_cards(ipage)) == 3


def test_from_the_fourth_example_on_the_rest_fold_under_a_line_that_counts_them(ipage):
    two_cards(ipage)
    add_examples(ipage, 5)                                                              # seven in all
    assert visible_cards(ipage) == ["samplePlain", "sampleWallet"], "the first two stay in view"
    det = ipage.locator(".learn details.more")
    assert det.count() == 1 and det.get_attribute("open") is None, "closed whenever the page opens"
    assert ipage.locator("details.more > summary").inner_text() == "More examples (5)"
    assert ipage.locator("details.more .lcard").count() == 5


def test_the_line_opens_and_closes_the_list_with_the_mouse_and_the_keyboard(ipage):
    two_cards(ipage)
    add_examples(ipage, 5)
    ipage.click("details.more > summary")
    assert len(visible_cards(ipage)) == 7, "all seven once it is open"
    ipage.click("details.more > summary")
    assert visible_cards(ipage) == ["samplePlain", "sampleWallet"]
    ipage.focus("details.more > summary"); ipage.keyboard.press("Enter")
    assert len(visible_cards(ipage)) == 7, "Enter on the line opens it too"
    ipage.keyboard.press("Space")
    assert len(visible_cards(ipage)) == 2, "and Space closes it"


def test_the_folded_cards_keep_their_order_and_a_group_heading_comes_before_its_cards(ipage):
    two_cards(ipage)
    add_examples(ipage, 4, groups=["Learn the patterns", "Follow a real case"])
    ipage.click("details.more > summary")
    inner = ipage.eval_on_selector_all("details.more .lcards > *", "els => els.map((e) => e.tagName === 'H3' ? 'H:' + e.textContent : e.id)")
    assert inner == ["H:Learn the patterns", "extra0", "H:Follow a real case", "extra1", "H:Learn the patterns", "extra2", "H:Follow a real case", "extra3"], inner


def test_running_it_again_does_not_duplicate_anything(ipage):
    two_cards(ipage)
    add_examples(ipage, 5)
    ipage.evaluate("() => { window.__examples.collapse(); window.__examples.collapse(); }")
    assert ipage.locator("details.more").count() == 1 and ipage.locator(".learn .lcard").count() == 7
    assert ipage.eval_on_selector_all(".learn .lcard", "els => els.map((e) => e.id)") == ["samplePlain", "sampleWallet", "extra0", "extra1", "extra2", "extra3", "extra4"]


def test_a_link_ending_in_examples_opens_the_list_and_nothing_is_stored(ipage):
    two_cards(ipage)
    add_examples(ipage, 5)
    assert ipage.locator("details.more").get_attribute("open") is None
    ipage.evaluate("() => { window.location.hash = '#examples'; window.__examples.collapse(); }")
    assert ipage.locator("details.more").get_attribute("open") is not None and len(visible_cards(ipage)) == 7
    ipage.click("details.more > summary")
    assert ipage.evaluate("() => localStorage.length + sessionStorage.length") == 0, "the start page remembers nothing, not even whether the list was open"


def test_the_folded_list_fits_a_phone(ipage):
    ipage.set_viewport_size({"width": 390, "height": 800})
    open_list(ipage)
    assert ipage.evaluate("() => document.documentElement.scrollWidth") <= 390, "no sideways scroll with the real list open"


def test_cards_added_after_the_first_fold_join_the_list_and_are_counted_with_nothing_lost(ipage):
    two_cards(ipage)
    add_examples(ipage, 5)
    ipage.evaluate("""() => {
      const grid = document.querySelector('.learn > .lcards'), proto = document.getElementById('sampleWallet');
      for (const id of ['late0', 'late1']) { const c = proto.cloneNode(true); c.id = id; grid.appendChild(c); }
      window.__examples.collapse();
    }""")
    assert ipage.locator("details.more > summary").inner_text() == "More examples (7)"
    ids = ipage.eval_on_selector_all(".learn .lcard", "els => els.map((e) => e.id)")
    assert ids[:2] == ["samplePlain", "sampleWallet"] and sorted(ids) == sorted(["samplePlain", "sampleWallet", "extra0", "extra1", "extra2", "extra3", "extra4", "late0", "late1"]), ids
    assert ipage.locator("details.more").count() == 1 and visible_cards(ipage) == ["samplePlain", "sampleWallet"]
