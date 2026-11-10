"""What the decision on the one-sign change guess (docs/benchmark.md, PR 56) says the page does with a guess, seen in the browser: the card on the graph shows a medium guess and not a low one, the
details of a transaction word a guess on one sign as a lead to check, and Auto-expand's "follow the change" follows the low guess as it follows the medium one."""
import pytest

from chains import IN, OUT, tid, tx
from helpers import idle, open_query, settle, xy


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def medium_one_sign(mock, n):
    """Coins and one output are p2wpkh, the other output taproot: the only sign is "the only output of the coins' address type", worth 40 points: a medium guess."""
    tx(mock, n, [IN(90 + n, 0, "payer%d" % n, 5_000_150)], [OUT("same%d" % n, 3_123_456), OUT("other%d" % n, 1_876_544, "v1_p2tr")], spent={0: n + 10, 1: n + 11})
    tx(mock, n + 10, [IN(n, 0, "same%d" % n, 3_123_456)], [OUT("next%d" % n, 3_123_000)])
    tx(mock, n + 11, [IN(n, 1, "other%d" % n, 1_876_544)], [OUT("else%d" % n, 1_876_000)])
    return "tx:" + tid(n)


def low_one_sign(mock, n):
    """Both outputs p2wpkh and one amount is round (100,000): the only sign is that the other output is not, worth 30 points, a lead of 30: a low guess. The second output is the guess."""
    tx(mock, n, [IN(90 + n, 0, "payer%d" % n, 5_000_150)], [OUT("pay%d" % n, 100_000), OUT("chg%d" % n, 4_899_876)], spent={0: n + 10, 1: n + 11})
    tx(mock, n + 10, [IN(n, 0, "pay%d" % n, 100_000)], [OUT("next%d" % n, 99_000)])
    tx(mock, n + 11, [IN(n, 1, "chg%d" % n, 4_899_876)], [OUT("else%d" % n, 4_899_000)])
    return "tx:" + tid(n)


def change_of(page, id_):
    return page.evaluate("(id) => { const r = window.__hopline.analysis().tx.get(id); return r && r.change ? { vout: r.change.vout, confidence: r.change.confidence, reasons: r.change.reasons.length } : null; }", id_)


def card(page, id_):
    p = xy(page, id_)
    page.mouse.move(5, 5); page.wait_for_timeout(120)
    page.mouse.move(p["x"], p["y"])
    page.wait_for_function("() => !document.getElementById('tooltip').hidden && /Transaction/.test(document.getElementById('tooltip').textContent)", timeout=4000)
    return page.inner_text("#tooltip").replace("\n", " ")


def test_the_scenes_make_the_guesses_they_are_meant_to(fpage, mock):
    m, l = medium_one_sign(mock, 1), low_one_sign(mock, 2)
    open_query(fpage, tid(1)); open_query(fpage, tid(2))
    assert change_of(fpage, m) == {"vout": 0, "confidence": "medium", "reasons": 1}
    assert change_of(fpage, l) == {"vout": 1, "confidence": "low", "reasons": 1}


def test_the_card_on_the_graph_shows_a_medium_guess_and_leaves_a_low_one_out(fpage, mock):
    m, l = medium_one_sign(mock, 1), low_one_sign(mock, 2)
    open_query(fpage, tid(1)); settle(fpage)
    tip = card(fpage, m)
    assert "Possible change" in tip and "output 0 (medium confidence)" in tip, tip
    open_query(fpage, tid(2)); settle(fpage)
    tip = card(fpage, l)
    assert "Possible change" not in tip and "Likely change" not in tip and "confidence" not in tip, "a low guess is not on the card: " + tip


def test_the_details_word_a_guess_on_one_sign_as_a_lead_to_check_for_both_tiers(fpage, mock):
    m, l = medium_one_sign(mock, 1), low_one_sign(mock, 2)
    for id_ in (m, l):
        open_query(fpage, id_[3:]); settle(fpage)
        fpage.evaluate("(id) => window.__hopline.setSel([id])", id_); settle(fpage)
        text = fpage.inner_text("#inspBody")
        assert "possible change" in text.lower(), id_                                  # the headings are drawn in capitals
        assert "Only one sign points to this output. Treat this as a lead to check, not as the change: follow both outputs before relying on it." in text.replace("\n", " "), text


@pytest.mark.parametrize("make,spender_of_change", [(medium_one_sign, 11), (low_one_sign, 11)])
def test_follow_the_change_goes_on_through_the_guessed_output_whatever_the_tier(fpage, mock, make, spender_of_change):
    id_ = make(mock, 1)
    open_query(fpage, tid(1))
    guess = change_of(fpage, id_)
    fpage.evaluate("(id) => window.__hopline.autoExpand(id, { dir: 'next', hops: 1, follow: 'change' })", id_); idle(fpage); settle(fpage)
    loaded = set(fpage.evaluate("() => [...window.__hopline.state.graph.nodes.values()].filter((n) => n.type === 'tx' && n.loaded).map((n) => n.id)"))
    followed = "tx:" + tid(11 if guess["vout"] == 0 else 12)
    other = "tx:" + tid(12 if guess["vout"] == 0 else 11)
    assert followed in loaded and other not in loaded, "%s guess: followed %s only (%s)" % (guess["confidence"], followed[:9], sorted(x[:9] for x in loaded))
