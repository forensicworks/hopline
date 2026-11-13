"""The id check, when a model clips or garbles a real address: the page says it looks like a copy slip and names the id it probably meant."""
import pytest

from helpers import settle
from test_assistant import open_ai, result
from test_pattern_flags import scene


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def a_wallet(page):
    return page.evaluate("() => { for (const n of window.__hopline.state.graph.nodes.values()) if (n.type === 'addr') return n.address; return null; }")


def test_a_clipped_address_is_named_as_a_copy_slip_with_the_real_one_under_it(fpage, mock):
    scene(fpage, mock); open_ai(fpage)
    real = a_wallet(fpage)
    fpage.fill("#aiText", "The money went to %s." % real[:-1]); fpage.click("#aiCheck"); settle(fpage)
    r = result(fpage)
    assert "1 id is NOT in this workspace" in r and "looks like a copy slip, not an invented id" in r, r
    assert "one character short of this id" in r, r
    assert fpage.locator("#aiResult [data-near]").count() == 1
    rows = fpage.eval_on_selector_all("#aiResult .idrow .mono", "els => els.map((e) => e.textContent)")
    assert rows == [real[:-1], real], rows


def test_an_id_that_is_nothing_like_one_in_the_workspace_keeps_the_old_wording(fpage, mock):
    scene(fpage, mock); open_ai(fpage)
    fpage.fill("#aiText", "The money went to bc1q%s." % ("z" * 30)); fpage.click("#aiCheck"); settle(fpage)
    r = result(fpage)
    assert "1 id is NOT in this workspace: a model made up or garbled it." in r and "copy slip" not in r
    assert fpage.locator("#aiResult [data-near]").count() == 0
