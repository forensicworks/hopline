"""The prepared examples on the front page ("Learn what Hopline finds"): a card says what to look for and what the example does not show, and opens a canvas that is in the link,
so nothing is looked up. The first one is a plain transaction: one input, two outputs, a fee, and a change guess with its reasons."""
import pytest

from test_index import INDEX_URL

TX = "35a8e48ecf210d2b5d86ff88c02a5d6f41038b0ed9ef639d97bde16c4261d2fd"


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
    before = len(mock.requests)
    ipage.click("#samplePlain")
    ipage.wait_for_function("() => window.__hopline && window.__hopline.state.graph.nodes.size > 0")
    ipage.wait_for_function("() => window.__hopline.renderer && window.__hopline.renderer.data")
    assert len(mock.requests) == before, "opening a prepared example looks nothing up: " + str(mock.requests[before:])
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
    assert ipage.eval_on_selector_all(".learn .lcard", "els => els.map((e) => e.id)") == ["samplePlain", "sampleWallet"]
    head = ipage.locator(".learnhead #openSaved")
    assert head.inner_text().startswith("Open a saved workspace") and head.get_attribute("href") == "public/workspace.html"


def test_the_ransom_wallet_card_says_what_to_look_for_and_that_it_is_looked_up_live(ipage):
    t = ipage.locator("#sampleWallet").inner_text()
    assert "A real case: the Colonial Pipeline ransom wallet" in t and "Look for" in t
    assert "Does not show" in t and "who is behind the wallet" in t and "public reporting, not from the chain" in t
    assert "looks the wallet up live" in t, "unlike the prepared example, this one contacts the data source"


# ---- more examples than fit: the rest fold under "More examples (N)" ---------------------------------------------------------------------------------

def add_examples(page, n, groups=None):
    """n more cards like the second one (the real ones will be added the same way), then the folding runs again as it does when the page opens."""
    page.evaluate("""([n, groups]) => {
      const grid = document.querySelector('.learn > .lcards'), proto = document.getElementById('sampleWallet');
      for (let i = 0; i < n; i++) {
        const c = proto.cloneNode(true); c.id = 'extra' + i; c.querySelector('.name').textContent = 'Extra example ' + (i + 1);
        if (groups) c.setAttribute('data-group', groups[i % groups.length]);
        grid.appendChild(c);
      }
      window.__examples.collapse();
    }""", [n, groups])


def visible_cards(page):
    """The ids of the cards a visitor can see (the page's own visibility check: a closed <details> keeps its content without a box)."""
    cards = page.locator(".learn .lcard")
    return [cards.nth(i).get_attribute("id") for i in range(cards.count()) if cards.nth(i).is_visible()]


def test_with_two_examples_nothing_is_folded(ipage):
    assert ipage.locator("details.more").count() == 0 and visible_cards(ipage) == ["samplePlain", "sampleWallet"]


def test_a_third_example_alone_is_not_folded_because_one_hidden_card_saves_nothing(ipage):
    add_examples(ipage, 1)
    assert ipage.locator("details.more").count() == 0 and len(visible_cards(ipage)) == 3


def test_from_the_fourth_example_on_the_rest_fold_under_a_line_that_counts_them(ipage):
    add_examples(ipage, 5)                                                              # seven in all
    assert visible_cards(ipage) == ["samplePlain", "sampleWallet"], "the first two stay in view"
    det = ipage.locator(".learn details.more")
    assert det.count() == 1 and det.get_attribute("open") is None, "closed whenever the page opens"
    assert ipage.locator("details.more > summary").inner_text() == "More examples (5)"
    assert ipage.locator("details.more .lcard").count() == 5


def test_the_line_opens_and_closes_the_list_with_the_mouse_and_the_keyboard(ipage):
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
    add_examples(ipage, 4, groups=["Learn the patterns", "Follow a real case"])
    ipage.click("details.more > summary")
    inner = ipage.eval_on_selector_all("details.more .lcards > *", "els => els.map((e) => e.tagName === 'H3' ? 'H:' + e.textContent : e.id)")
    assert inner == ["H:Learn the patterns", "extra0", "H:Follow a real case", "extra1", "H:Learn the patterns", "extra2", "H:Follow a real case", "extra3"], inner


def test_running_it_again_does_not_duplicate_anything(ipage):
    add_examples(ipage, 5)
    ipage.evaluate("() => { window.__examples.collapse(); window.__examples.collapse(); }")
    assert ipage.locator("details.more").count() == 1 and ipage.locator(".learn .lcard").count() == 7
    assert ipage.eval_on_selector_all(".learn .lcard", "els => els.map((e) => e.id)") == ["samplePlain", "sampleWallet", "extra0", "extra1", "extra2", "extra3", "extra4"]


def test_a_link_ending_in_examples_opens_the_list_and_nothing_is_stored(ipage):
    add_examples(ipage, 5)
    assert ipage.locator("details.more").get_attribute("open") is None
    ipage.evaluate("() => { window.location.hash = '#examples'; window.__examples.collapse(); }")
    assert ipage.locator("details.more").get_attribute("open") is not None and len(visible_cards(ipage)) == 7
    ipage.click("details.more > summary")
    assert ipage.evaluate("() => localStorage.length + sessionStorage.length") == 0, "the start page remembers nothing, not even whether the list was open"


def test_the_folded_list_fits_a_phone(ipage):
    add_examples(ipage, 5)
    ipage.set_viewport_size({"width": 390, "height": 800})
    ipage.click("details.more > summary")
    assert ipage.evaluate("() => document.documentElement.scrollWidth") <= 390, "no sideways scroll with the list open"


def test_cards_added_after_the_first_fold_join_the_list_and_are_counted_with_nothing_lost(ipage):
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
