"""A wallet that is on several lists shows every claim, and a sanctions list is marked: in the details, on the graph, on the wallet page and in the report."""
import json

import pytest

from conftest import ADDRESS, NORMAL
from helpers import idle, open_query, settle, toast_text
from test_report import make_report
from test_label_packs import INPUT_ADDR, SMALL_ADDR, drawn_texts, known, load, load_file, sdn_xml, zipped
from test_wallet_page import PAYER, WALLET_URL, goto, wpage  # noqa: F401  (the fixture is used by name)


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def select(page, address):
    page.evaluate("(id) => window.__hopline.setSel([id])", "addr:" + address); settle(page)


def sanctions_pack(address, name="Test sanctions list", label="Listed person"):
    return json.dumps({"format": "hopline-labels", "version": 1, "name": name, "sanctions": True, "source": "a test",
                       "labels": [{"address": address, "label": label, "category": "SDN", "url": "https://example.org/entry/7", "note": "entry 7"}]})


def load_json(page, name, text):
    page.evaluate("() => { document.getElementById('packSection').open = true; }")
    page.set_input_files("#packFile", files=[{"name": name, "mimeType": "application/json", "buffer": text.encode("utf-8")}])
    page.wait_for_function("() => /Imported|Replaced|Import failed/.test(document.getElementById('toast').textContent)")
    settle(page)


def sanctions_badges(page):
    return [t for t in drawn_texts(page) if t == "SANCTIONS"]


# ---- every claim in the workspace --------------------------------------------------------------------------------------------------------

def test_a_wallet_on_two_lists_shows_every_claim_with_its_own_source_category_and_note(fpage):
    open_query(fpage, NORMAL["txid"])
    load(fpage, "a.csv", "address,label,category,url,note\n%s,Name from A,EXCH,https://example.org/a,note from A\n" % SMALL_ADDR)
    load(fpage, "b.csv", "address,label,category,url,note\n%s,Name from B,THREAT,https://example.org/b,note from B\n" % SMALL_ADDR)
    k = known(fpage, SMALL_ADDR)
    assert [(c["label"], c["pack"], c["category"]) for c in k["claims"]] == [("Name from A", "a", "EXCH"), ("Name from B", "b", "THREAT")]
    select(fpage, SMALL_ADDR)
    box = fpage.inner_text("#inspBody")
    assert "listed by 2 sources" in box.lower()                                              # the heading is drawn in capitals
    assert "Name from A" in box and "Name from B" in box and "THREAT" in box and "note from B" in box
    links = fpage.evaluate("() => [...document.querySelectorAll('#inspBody .claims a')].map((a) => a.getAttribute('href'))")
    assert links == ["https://example.org/a", "https://example.org/b"]
    assert "also listed as: Name from B (b)" in box, "the short form is still there"


def test_a_wallet_on_one_list_has_no_extra_section(fpage):
    open_query(fpage, NORMAL["txid"])
    load(fpage, "a.csv", "%s,Only A\n" % SMALL_ADDR)
    select(fpage, SMALL_ADDR)
    assert "listed by" not in fpage.inner_text("#inspBody").lower()


# ---- a sanctions list ---------------------------------------------------------------------------------------------------------------------

def test_a_pack_that_says_it_is_a_sanctions_list_marks_its_wallets_on_the_graph_and_in_the_details(fpage):
    open_query(fpage, NORMAL["txid"])
    fpage.evaluate("() => window.__hopline.setSel([])"); settle(fpage)
    assert sanctions_badges(fpage) == []
    load_json(fpage, "list.json", sanctions_pack(SMALL_ADDR))
    assert known(fpage, SMALL_ADDR)["sanctions"] is True
    assert sanctions_badges(fpage) == ["SANCTIONS"], "one wallet, one badge"
    select(fpage, SMALL_ADDR)
    assert "on a sanctions list: Test sanctions list" in fpage.inner_text("#inspBody")
    assert "sanctions list" in fpage.inner_text("#packList")


def test_a_pack_that_does_not_say_so_is_not_marked(fpage):
    open_query(fpage, NORMAL["txid"])
    load(fpage, "plain.csv", "%s,Plain name\n" % SMALL_ADDR)
    assert sanctions_badges(fpage) == [] and not known(fpage, SMALL_ADDR).get("sanctions")


def test_a_sanctions_claim_among_several_marks_the_wallet_whichever_list_came_first(fpage):
    open_query(fpage, NORMAL["txid"])
    load(fpage, "plain.csv", "%s,Plain name\n" % SMALL_ADDR)
    load_json(fpage, "list.json", sanctions_pack(SMALL_ADDR))
    k = known(fpage, SMALL_ADDR)
    assert k["label"] == "Plain name" and k["sanctions"] is True and [c["sanctions"] for c in k["claims"]] == [False, True]
    assert sanctions_badges(fpage) == ["SANCTIONS"]
    select(fpage, SMALL_ADDR)
    assert "sanctions list" in fpage.inner_text("#inspBody") and "listed by 2 sources" in fpage.inner_text("#inspBody").lower()


def test_the_mark_is_kept_when_the_page_is_reloaded_and_goes_when_the_pack_is_switched_off(fpage):
    open_query(fpage, NORMAL["txid"])
    load_json(fpage, "list.json", sanctions_pack(SMALL_ADDR))
    saved = json.loads(fpage.evaluate("() => localStorage.getItem('hopline.packs.v1')"))
    assert saved[0]["sanctions"] is True
    fpage.reload(); fpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert fpage.evaluate("(a) => (window.__hopline.state.packs[0] || {}).sanctions === true", SMALL_ADDR)
    fpage.evaluate("() => { document.getElementById('packSection').open = true; }")
    fpage.uncheck("#packList input[type=checkbox]"); settle(fpage)
    assert not (known(fpage, SMALL_ADDR) or {}).get("sanctions")


def test_the_ofac_list_read_by_the_page_is_a_sanctions_list(fpage):
    open_query(fpage, NORMAL["txid"])
    fpage.evaluate("() => window.__hopline.setSel([])"); settle(fpage)
    load_file(fpage, "SDN_XML.ZIP", zipped("SDN.XML", sdn_xml(SMALL_ADDR)), "application/zip")
    assert known(fpage, SMALL_ADDR)["sanctions"] is True
    assert sanctions_badges(fpage) == ["SANCTIONS"]


def test_a_hostile_claim_that_it_is_a_sanctions_list_still_only_changes_text_and_colour(fpage):
    open_query(fpage, NORMAL["txid"])
    pack = json.loads(sanctions_pack(SMALL_ADDR, label="<img src=x onerror=window.__pwned=1>"))
    load_json(fpage, "evil.json", json.dumps(pack))
    select(fpage, SMALL_ADDR)
    assert fpage.evaluate("() => window.__pwned") is None and fpage.locator("#inspBody img").count() == 0


def test_the_report_names_every_claim_and_says_when_a_list_is_a_sanctions_list(fpage, tmp_path):
    open_query(fpage, NORMAL["txid"])
    load(fpage, "plain.csv", "%s,Plain name\n" % SMALL_ADDR)
    load_json(fpage, "list.json", sanctions_pack(SMALL_ADDR))
    html = make_report(fpage, tmp_path).read_text(encoding="utf-8")
    assert "known: Plain name (plain)" in html and "also listed as: Listed person (Test sanctions list)" in html and "ON A SANCTIONS LIST" in html


def test_the_assistants_evidence_carries_the_sanctions_mark(fpage):
    open_query(fpage, NORMAL["txid"])
    load(fpage, "plain.csv", "%s,Plain name\n" % SMALL_ADDR)
    load_json(fpage, "list.json", sanctions_pack(SMALL_ADDR))
    fpage.evaluate("""() => { window.__copied = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__copied.push(t); return Promise.resolve(); } } });
        document.getElementById('aiSection').open = true; }""")
    fpage.click("#aiCopy")
    text = fpage.evaluate("() => window.__copied[0]")
    wallets = json.loads(text.split("<<EVIDENCE (JSON)\n")[1].split("\nEVIDENCE>>")[0])["wallets"]
    k = [w for w in wallets if w["address"] == SMALL_ADDR][0]["known"]
    assert k["sanctions"] is True and k["alsoListedAs"] == ["Listed person (Test sanctions list)"]


# ---- the wallet page ----------------------------------------------------------------------------------------------------------------------

def stored(ctx, packs):
    ctx.add_init_script("localStorage.setItem('hopline.packs.v1', %s);" % json.dumps(json.dumps(packs)))


def test_the_wallet_page_lists_every_claim_and_warns_about_a_sanctions_list(ctx, wpage):
    stored(ctx, [{"id": "p1", "name": "List one", "enabled": True, "entries": [[ADDRESS, "Name one", "EXCH", "https://example.org/1", "note one"]]},
                 {"id": "p2", "name": "Test sanctions list", "enabled": True, "sanctions": True, "entries": [[ADDRESS, "Listed person", "SDN", "https://example.org/2", "entry 2"]]}])
    goto(wpage)
    assert wpage.is_visible("#sanctionBanner") and "On a sanctions list according to Test sanctions list" in wpage.inner_text("#sanctionBanner")
    assert wpage.is_visible("#claims") and "listed by 2 sources" in wpage.inner_text("#claims").lower()
    rows = wpage.locator("#claims .claimrow")
    assert rows.count() == 2 and "Name one" in rows.nth(0).inner_text() and "List one" in rows.nth(0).inner_text() and "note one" in rows.nth(0).inner_text()
    assert "sanctions list" in rows.nth(1).inner_text() and "SDN" in rows.nth(1).inner_text()
    assert wpage.get_attribute("#claims .claimrow:nth-of-type(2) a", "href") == "https://example.org/2"
    assert "sanctioned" in (wpage.get_attribute("#addrLabel", "class") or "")


def test_a_wallet_on_one_list_has_no_claims_section_and_no_warning(ctx, wpage):
    stored(ctx, [{"id": "p1", "name": "List one", "enabled": True, "entries": [[ADDRESS, "Name one"]]}])
    goto(wpage)
    assert wpage.is_hidden("#claims") and wpage.is_hidden("#sanctionBanner")
    assert wpage.inner_text("#addrLabel") == "Name one"


def test_a_counterparty_on_a_sanctions_list_is_marked_among_the_associations(ctx, wpage):
    stored(ctx, [{"id": "p2", "name": "Test sanctions list", "enabled": True, "sanctions": True, "entries": [[PAYER, "Listed person", "SDN"]]}])
    goto(wpage)
    row = wpage.locator("#assoc .assocrow").filter(has_text="Listed person")
    assert row.count() == 1 and "sanctions list" in row.inner_text()
    assert wpage.is_hidden("#sanctionBanner"), "the wallet itself is not listed"


def test_a_hostile_claim_on_the_wallet_page_stays_text(ctx, wpage):
    stored(ctx, [{"id": "p1", "name": "A", "enabled": True, "entries": [[ADDRESS, "<img src=x onerror=window.__pwned=1>", "<b>c</b>", "javascript:alert(1)", "<script>window.__pwned=2</script>"]]},
                 {"id": "p2", "name": "B", "enabled": True, "sanctions": True, "entries": [[ADDRESS, "Second"]]}])
    goto(wpage)
    assert wpage.evaluate("() => window.__pwned") is None and wpage.locator("#claims img, #claims script").count() == 0
    assert wpage.locator("#claims a[href^='javascript']").count() == 0
    assert "<img src=x" in wpage.inner_text("#claims") and "<script>window.__pwned=2" in wpage.inner_text("#claims"), "shown as the text it is"
