"""Password managers are told to keep out of the fields: every box on the landing page, the workspace and the wallet page (and the ones the pages make later) carries autocomplete="off" and the ignore
attribute of each manager, except the three key fields, which are left exactly as they were so that a person can have a manager keep a key."""
import pytest

from conftest import NORMAL, ROOT
from helpers import open_query, settle
from test_wallet_page import goto, wpage  # noqa: F401  (the fixture is used by name)

NEEDED = ["autocomplete", "data-1p-ignore", "data-lpignore", "data-bwignore", "data-form-type", "data-protonpass-ignore"]
KEYS = ["srcKey", "claudeKey", "arkToken"]
UNCOVERED = """(needed) => [...document.querySelectorAll('input, textarea, select')]
    .filter((e) => !(e.tagName === 'INPUT' && /^(hidden|submit|button|reset|image)$/i.test(e.getAttribute('type') || 'text')) && e.getAttribute('data-autofill') !== 'allow')
    .filter((e) => needed.some((a) => !e.hasAttribute(a)))
    .map((e) => (e.id || e.name || e.className || e.tagName) + ':' + (e.getAttribute('type') || e.tagName.toLowerCase()))"""
COUNT = "() => document.querySelectorAll('input, textarea, select').length"


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def test_every_box_of_the_workspace_is_covered_except_the_key_fields(page):
    assert page.evaluate(COUNT) > 70, "the workspace has dozens of boxes"
    assert page.evaluate(UNCOVERED, NEEDED) == []


def test_the_values_are_the_ones_each_manager_looks_for(page):
    got = page.evaluate("() => { const e = document.getElementById('q'); return Object.fromEntries(['autocomplete', 'data-1p-ignore', 'data-lpignore', 'data-bwignore', 'data-form-type', 'data-protonpass-ignore'].map((a) => [a, e.getAttribute(a)])); }")
    assert got == {"autocomplete": "off", "data-1p-ignore": "true", "data-lpignore": "true", "data-bwignore": "true", "data-form-type": "other", "data-protonpass-ignore": "true"}, got


def test_the_three_key_fields_are_left_as_they_were(page):
    for id_ in KEYS:
        got = page.evaluate("""(id) => { const e = document.getElementById(id); return { type: e.getAttribute('type'), allow: e.getAttribute('data-autofill'), autocomplete: e.getAttribute('autocomplete'),
                              ignores: ['data-1p-ignore', 'data-lpignore', 'data-bwignore', 'data-form-type', 'data-protonpass-ignore'].filter((a) => e.hasAttribute(a)) }; }""", id_)
        assert got == {"type": "password", "allow": "allow", "autocomplete": "off", "ignores": []}, (id_, got)


def test_a_box_added_to_the_page_later_is_covered_and_the_ones_that_are_not_boxes_are_not(page):
    page.evaluate("""() => {
        const box = document.createElement('div');
        box.innerHTML = '<label><input id="t1" type="text"></label><select id="t2"><option>a</option></select><textarea id="t3"></textarea><input id="t4" type="checkbox">'
          + '<input id="t5" type="hidden"><button id="t6">x</button><input id="t7" type="submit"><input id="t8" type="password" data-autofill="allow"><input id="t9" type="text" autocomplete="username">';
        document.body.appendChild(box);
    }""")
    page.wait_for_timeout(100)
    has = page.evaluate("""() => Object.fromEntries(['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'].map((id) => [id, document.getElementById(id).hasAttribute('data-1p-ignore')]))""")
    assert has == {"t1": True, "t2": True, "t3": True, "t4": True, "t5": False, "t6": False, "t7": False, "t8": False, "t9": True}, has
    assert page.evaluate("() => document.getElementById('t9').getAttribute('autocomplete')") == "username", "a value that was chosen stays"
    assert page.evaluate("() => document.getElementById('t8').getAttribute('autocomplete')") is None, "the allowed one is not touched at all"


def test_the_boxes_the_workspace_makes_itself_are_covered_too(page, mock):
    open_query(page, NORMAL["txid"]); settle(page)
    page.evaluate("(id) => window.__hopline.setSel([id])", "tx:" + NORMAL["txid"]); settle(page)
    page.click("#exportMenu summary")
    assert page.evaluate(COUNT) > 70
    assert page.evaluate(UNCOVERED, NEEDED) == []


def test_every_box_of_the_wallet_page_is_covered(wpage):
    goto(wpage)
    assert wpage.evaluate(COUNT) > 15
    assert wpage.evaluate(UNCOVERED, NEEDED) == []
    assert wpage.evaluate("() => document.querySelectorAll('[data-autofill=allow]').length") == 0, "no key field on this page"


def test_the_landing_page_has_its_search_box_covered(ctx):
    p = ctx.new_page()
    p.goto((ROOT / "index.html").as_uri())
    p.wait_for_selector("#q")
    assert p.evaluate("() => document.querySelectorAll('input, textarea, select').length") >= 1
    assert p.evaluate(UNCOVERED, NEEDED) == []
