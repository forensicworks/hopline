"""The label packs that come with the site: the OFAC sanctions list is on from the start and Ransomwhere is off until asked for; either can be switched, the choice stays, and a pack you import under the same name replaces it.

The pages are opened from file:// and read the real files in public/packs/, so each test takes a wallet from the shipped pack itself instead of naming one.
"""
import json
import re

import pytest

from chains import IN, tx
from conftest import NORMAL, ROOT
from helpers import open_query, settle, toast_text
from test_wallet_history import to
from test_wallet_page import WALLET_URL, wpage  # noqa: F401  (the fixture is used by name)

PACKS = ROOT / "public" / "packs"
INDEX = json.loads(re.search(r"window\.HOPLINE_PACK_INDEX = (\[.*\]);", (PACKS / "index.js").read_text(encoding="utf-8"), re.S).group(1))
OFAC = next(e for e in INDEX if e["id"] == "ofac-sdn")
RW = next(e for e in INDEX if e["id"] == "ransomwhere")
MP = next(e for e in INDEX if e["id"] == "mining-pools")
UK = next(e for e in INDEX if e["id"] == "uk-sanctions")
GS = next(e for e in INDEX if e["id"] == "graphsense")
SMALL_ADDR = NORMAL["vout"][1 - max(range(len(NORMAL["vout"])), key=lambda i: NORMAL["vout"][i]["value"])]["scriptpubkey_address"]
ADDR = re.search(r'^\{"address":"([^"]+)"', (PACKS / OFAC["file"]).read_text(encoding="utf-8"), re.M).group(1)
RW_ADDR = re.search(r'^\{"address":"([^"]+)","label":"Ransomware: Locky"', (PACKS / RW["file"]).read_text(encoding="utf-8"), re.M).group(1)


MP_LINE = json.loads(re.search(r'^(\{"address":"[^"]+","label":"Mining pool: AntPool".*\})', (PACKS / MP["file"]).read_text(encoding="utf-8"), re.M).group(1))


def row_of(page, pack):
    return page.locator("#shippedList .packrow").filter(has_text=pack["name"])


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def known(page, address):
    return page.evaluate("(a) => window.__hopline.renderer.data.known[a] || null", address)


def wait_known(page, address):
    page.wait_for_function("(a) => !!window.__hopline.renderer.data.known[a]", arg=address)


def open_packs(page):
    page.evaluate("() => { document.getElementById('packSection').open = true; }")


def serve_wallet(mock, address):
    """Two payments to the wallet, answered from the mock like any other address."""
    ids = [tx(mock, 91, [IN(11, 0, "payer1", 90000)], [to(address, 80000)]), tx(mock, 92, [IN(12, 0, "payer2", 60000)], [to(address, 50000)])]
    mock.routes["/address/" + address + "/txs"] = [mock.routes["/tx/" + i[3:]] for i in reversed(ids)]
    mock.routes["/address/" + address] = {"address": address, "chain_stats": {"funded_txo_count": 2, "funded_txo_sum": 130000, "spent_txo_count": 0, "spent_txo_sum": 0, "tx_count": 2},
                                          "mempool_stats": {"funded_txo_count": 0, "funded_txo_sum": 0, "spent_txo_count": 0, "spent_txo_sum": 0, "tx_count": 0}}


# ---------------------------------------------------------------- the workspace
def test_the_ofac_list_is_listed_as_built_in_and_on_from_the_start(tpage):
    wait_known(tpage, ADDR)
    open_packs(tpage)
    assert tpage.locator("#shippedList .packrow").count() == len(INDEX)
    row = row_of(tpage, OFAC)
    assert row.count() == 1 and row.locator("input").is_checked()
    t = row.inner_text()
    assert OFAC["name"] in t and "{:,} wallets".format(OFAC["entries"]) in t and "sanctions list" in t and "as of " + OFAC["asOf"] in t and "Public domain" in t, t
    link = row.locator("a")
    assert link.get_attribute("href") == OFAC["sourceUrl"] and link.get_attribute("rel") == "noopener noreferrer" and link.get_attribute("target") == "_blank"
    k = known(tpage, ADDR)
    assert k["sanctions"] is True and k["pack"] == OFAC["name"] and k["claims"][0]["asOf"] == OFAC["asOf"] and k["url"].startswith("https://sanctionssearch.ofac.treas.gov/")
    assert tpage.evaluate("() => window.__hopline.state.packs.length") == 0, "it is not one of the packs you imported"


def test_switching_it_off_removes_the_marks_and_is_remembered(tpage):
    wait_known(tpage, ADDR)
    open_packs(tpage)
    row_of(tpage, OFAC).locator("input").uncheck()
    settle(tpage)
    assert known(tpage, ADDR) is None
    tpage.reload(); tpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    open_packs(tpage)
    assert not row_of(tpage, OFAC).locator("input").is_checked(), "still off after a reload"
    assert known(tpage, ADDR) is None
    row_of(tpage, OFAC).locator("input").check()
    wait_known(tpage, ADDR)
    assert known(tpage, ADDR)["sanctions"] is True
    assert json.loads(tpage.evaluate("() => localStorage.getItem('hopline.prefs.v1')"))["shippedPacks"] == {"ofac-sdn": True}


def test_a_pack_you_import_under_the_same_name_replaces_the_built_in_one(tpage):
    wait_known(tpage, ADDR)
    open_packs(tpage)
    tpage.set_input_files("#packFile", files=[{"name": OFAC["name"] + ".csv", "mimeType": "text/csv", "buffer": ("address,label\n%s,Newer name\n" % ADDR).encode("utf-8")}])
    tpage.wait_for_function("() => /Imported|Replaced|Import failed/.test(document.getElementById('toast').textContent)")
    settle(tpage)
    k = known(tpage, ADDR)
    assert k["label"] == "Newer name" and len(k["claims"]) == 1, "yours alone, not listed twice"
    assert "your imported pack of the same name is used instead" in tpage.inner_text("#shippedList")
    assert "Imported 1 labelled wallets" in toast_text(tpage)


def test_ransomwhere_is_listed_but_off_until_it_is_switched_on_and_then_stays_on(tpage):
    open_packs(tpage)
    row = row_of(tpage, RW)
    t = row.inner_text()
    assert row.count() == 1 and not row.locator("input").is_checked(), "off as shipped"
    assert "{:,} wallets".format(RW["entries"]) in t and "as of " + RW["asOf"] in t and "CC BY 4.0" in t and "months old" in t and "sanctions list" not in t, t
    assert row.locator("a").get_attribute("href") == RW["sourceUrl"]
    assert known(tpage, RW_ADDR) is None
    row.locator("input").check()
    wait_known(tpage, RW_ADDR)
    k = known(tpage, RW_ADDR)
    assert k["label"] == "Ransomware: Locky" and k["category"] == "RANSOM" and k["pack"] == RW["name"] and not k.get("sanctions")
    assert re.match(r"(No payment recorded|\d+ payments?, )", k["note"]) and k["url"] == RW["sourceUrl"] and k["claims"][0]["asOf"] == RW["asOf"]
    assert "loading" not in row_of(tpage, RW).inner_text() and "wallets" in row_of(tpage, RW).inner_text()
    tpage.reload(); tpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    wait_known(tpage, RW_ADDR)
    assert json.loads(tpage.evaluate("() => localStorage.getItem('hopline.prefs.v1')"))["shippedPacks"] == {"ransomwhere": True}
    assert known(tpage, ADDR) is not None, "and the sanctions list is still on"


def test_a_wallet_named_by_your_pack_and_by_ransomwhere_keeps_both_claims_and_is_not_a_sanctions_hit(tpage):
    open_packs(tpage)
    tpage.set_input_files("#packFile", files=[{"name": "mine.csv", "mimeType": "text/csv", "buffer": ("address,label" + chr(10) + RW_ADDR + ",Mine" + chr(10)).encode("utf-8")}])
    tpage.wait_for_function("() => /Imported|Replaced|Import failed/.test(document.getElementById('toast').textContent)")
    row_of(tpage, RW).locator("input").check()
    tpage.wait_for_function("(a) => { const k = window.__hopline.renderer.data.known[a]; return k && k.claims.length === 2; }", arg=RW_ADDR)
    k = known(tpage, RW_ADDR)
    assert [c["label"] for c in k["claims"]] == ["Mine", "Ransomware: Locky"] and not k.get("sanctions")


# ---------------------------------------------------------------- the wallet page
def test_a_wallet_on_the_ofac_list_is_flagged_on_the_wallet_page_without_importing_anything(wpage, mock):
    serve_wallet(mock, ADDR)
    wpage.goto(WALLET_URL + "?q=" + ADDR)
    wpage.wait_for_function("() => document.querySelectorAll('#ledger .tx').length > 0")
    assert wpage.is_visible("#sanctionBanner") and OFAC["name"] in wpage.inner_text("#sanctionBanner")
    assert wpage.inner_text("#addrLabel").startswith("OFAC SDN: ") and wpage.is_hidden("#packWarn")


def test_the_wallet_page_follows_the_choice_made_in_the_workspace(ctx, wpage, mock):
    ctx.add_init_script("localStorage.setItem('hopline.prefs.v1', %s);" % json.dumps(json.dumps({"shippedPacks": {"ofac-sdn": False}})))
    serve_wallet(mock, ADDR)
    wpage.goto(WALLET_URL + "?q=" + ADDR)
    wpage.wait_for_function("() => document.querySelectorAll('#ledger .tx').length > 0")
    assert wpage.is_hidden("#sanctionBanner") and wpage.is_hidden("#addrLabel")
    assert wpage.evaluate("(a) => window.__wallet.known(a)", ADDR) is None


def test_an_import_of_the_same_name_wins_on_the_wallet_page_too(ctx, wpage, mock):
    pack = [{"id": "p1", "name": OFAC["name"], "enabled": True, "entries": [[ADDR, "Newer name"]]}]
    ctx.add_init_script("localStorage.setItem('hopline.packs.v1', %s);" % json.dumps(json.dumps(pack)))
    serve_wallet(mock, ADDR)
    wpage.goto(WALLET_URL + "?q=" + ADDR)
    wpage.wait_for_function("() => document.querySelectorAll('#ledger .tx').length > 0")
    assert wpage.inner_text("#addrLabel") == "Newer name"
    assert wpage.evaluate("(a) => window.__wallet.known(a).claims.length", ADDR) == 1


# ---------------------------------------------------------------- the report
def test_the_report_says_where_a_pack_that_names_a_wallet_came_from(fpage, tmp_path):
    pack = {"format": "hopline-labels", "name": "Case pack", "source": "our own notes", "licence": "CC BY 4.0", "attribution": "The team", "asOf": "2026-10-21",
            "labels": [{"address": SMALL_ADDR, "label": "Suspect A"}]}
    open_query(fpage, NORMAL["txid"])
    fpage.evaluate("() => { document.getElementById('packSection').open = true; }")
    fpage.set_input_files("#packFile", files=[{"name": "case.json", "mimeType": "application/json", "buffer": json.dumps(pack).encode("utf-8")}])
    fpage.wait_for_function("() => /Imported|Replaced|Import failed/.test(document.getElementById('toast').textContent)")
    settle(fpage)
    fpage.evaluate("() => { document.getElementById('exportMenu').open = true; }")
    with fpage.expect_download() as dl:
        fpage.click("[data-export=report]")
    path = tmp_path / "report.html"; dl.value.save_as(path)
    html = path.read_text(encoding="utf-8")
    assert "Suspect A" in html, "the name is in the report"
    assert "Sources of the names" in html
    assert "Case pack - our own notes; licence: CC BY 4.0; credit: The team; data as of 2026-10-21" in html
    assert "OFAC SDN list (Bitcoin) -" not in html, "the built-in list names nothing here, so it is not listed"


def test_a_ransomwhere_wallet_is_named_on_the_wallet_page_once_the_pack_is_on_and_not_flagged_as_sanctioned(ctx, wpage, mock):
    ctx.add_init_script("localStorage.setItem('hopline.prefs.v1', %s);" % json.dumps(json.dumps({"shippedPacks": {"ransomwhere": True}})))
    serve_wallet(mock, RW_ADDR)
    wpage.goto(WALLET_URL + "?q=" + RW_ADDR)
    wpage.wait_for_function("() => document.querySelectorAll('#ledger .tx').length > 0")
    assert wpage.inner_text("#addrLabel") == "Ransomware: Locky" and wpage.inner_text("#addrTag") == "RANSOM"
    assert wpage.is_hidden("#sanctionBanner") and wpage.is_hidden("#packWarn")
    assert RW["name"] in wpage.get_attribute("#addrLabel", "title")


def test_without_the_choice_a_ransomwhere_wallet_is_not_named_on_the_wallet_page(wpage, mock):
    serve_wallet(mock, RW_ADDR)
    wpage.goto(WALLET_URL + "?q=" + RW_ADDR)
    wpage.wait_for_function("() => document.querySelectorAll('#ledger .tx').length > 0")
    assert wpage.is_hidden("#addrLabel") and wpage.evaluate("(a) => window.__wallet.known(a)", RW_ADDR) is None


# ---------------------------------------------------------------- the mining pools
def test_the_mining_pools_are_off_until_switched_on_and_then_name_the_reward_address_with_the_pools_own_link(tpage):
    open_packs(tpage)
    row = row_of(tpage, MP)
    t = row.inner_text()
    assert row.count() == 1 and not row.locator("input").is_checked() and "{:,} wallets".format(MP["entries"]) in t and "as of " + MP["asOf"] in t and "MIT" in t and "sanctions list" not in t, t
    assert known(tpage, MP_LINE["address"]) is None
    row.locator("input").check()
    wait_known(tpage, MP_LINE["address"])
    k = known(tpage, MP_LINE["address"])
    assert k["label"] == "Mining pool: AntPool" and k["category"] == "MINING" and k["url"] == MP_LINE["url"] and not k.get("sanctions") and k["pack"] == MP["name"]
    assert json.loads(tpage.evaluate("() => localStorage.getItem('hopline.prefs.v1')"))["shippedPacks"] == {"mining-pools": True}


def test_a_mining_pool_address_is_named_on_the_wallet_page_once_the_pack_is_on(ctx, wpage, mock):
    ctx.add_init_script("localStorage.setItem('hopline.prefs.v1', %s);" % json.dumps(json.dumps({"shippedPacks": {"mining-pools": True}})))
    serve_wallet(mock, MP_LINE["address"])
    wpage.goto(WALLET_URL + "?q=" + MP_LINE["address"])
    wpage.wait_for_function("() => document.querySelectorAll('#ledger .tx').length > 0")
    assert wpage.inner_text("#addrLabel") == "Mining pool: AntPool" and wpage.inner_text("#addrTag") == "MINING" and wpage.is_hidden("#sanctionBanner")


# ---------------------------------------------------------------- the UK Sanctions List
UK_ADDR = re.search(r'^\{"address":"([^"]+)"', (PACKS / UK["file"]).read_text(encoding="utf-8"), re.M).group(1)


def test_the_uk_sanctions_list_is_on_from_the_start_like_the_ofac_list_and_flags_its_wallets(tpage):
    wait_known(tpage, UK_ADDR)
    open_packs(tpage)
    row = row_of(tpage, UK)
    t = row.inner_text()
    assert row.count() == 1 and row.locator("input").is_checked() and "sanctions list" in t and "as of " + UK["asOf"] in t and "Open Government Licence v3.0" in t, t
    k = known(tpage, UK_ADDR)
    assert k["sanctions"] is True and k["label"].startswith("UK Sanctions: ") and k["category"] and k["url"] == UK["sourceUrl"]
    assert k["claims"][0]["asOf"] == UK["asOf"] and "UK Sanctions List entry" in k["note"]


def test_a_wallet_on_the_uk_list_is_flagged_on_the_wallet_page_with_the_name_of_the_list(wpage, mock):
    serve_wallet(mock, UK_ADDR)
    wpage.goto(WALLET_URL + "?q=" + UK_ADDR)
    wpage.wait_for_function("() => document.querySelectorAll('#ledger .tx').length > 0")
    assert wpage.is_visible("#sanctionBanner") and UK["name"] in wpage.inner_text("#sanctionBanner")
    assert wpage.inner_text("#addrLabel").startswith("UK Sanctions: ")


# ---------------------------------------------------------------- the GraphSense tag packs
GS_LINE = json.loads(re.search(r'^(\{"address":"[^"]+","label":"Al-Qaeda Campaign".*\})', (PACKS / GS["file"]).read_text(encoding="utf-8"), re.M).group(1))


def test_the_graphsense_packs_are_off_until_switched_on_and_each_name_links_to_its_own_source(tpage):
    open_packs(tpage)
    row = row_of(tpage, GS)
    t = row.inner_text()
    assert row.count() == 1 and not row.locator("input").is_checked() and "{:,} wallets".format(GS["entries"]) in t and "MIT" in t and "sanctions list" not in t, t
    assert known(tpage, GS_LINE["address"]) is None
    row.locator("input").check()
    wait_known(tpage, GS_LINE["address"])
    k = known(tpage, GS_LINE["address"])
    assert k["label"] == "Al-Qaeda Campaign" and k["category"] == "TERRORISM" and k["pack"] == GS["name"] and not k.get("sanctions")
    assert k["url"] == GS_LINE["url"] and k["url"].startswith("https://www.justice.gov/"), "the link is the document the claim comes from, not the repository"
    assert "GraphSense tagpack aft-alqaeda-forfeit_vc" in k["note"]


# ---------------------------------------------------------------- the rows are updated, never replaced
def import_csv(page, name, address, label):
    page.set_input_files("#packFile", files=[{"name": name, "mimeType": "text/csv", "buffer": ("address,label" + chr(10) + address + "," + label + chr(10)).encode("utf-8")}])
    page.wait_for_function("() => /Imported|Replaced|Import failed/.test(document.getElementById('toast').textContent)")


def test_a_row_is_the_same_element_after_a_list_loads_or_is_switched_and_keeps_the_keyboard_focus(tpage):
    """A row that was drawn again took away the checkbox someone was aiming at (a click missed) or had focused (the keyboard user lost their place)."""
    open_packs(tpage)
    import_csv(tpage, "mine.csv", RW_ADDR, "Mine")
    mine = tpage.query_selector("#packList input[type=checkbox]")
    ofac = row_of(tpage, OFAC).locator("input").element_handle()
    rw = row_of(tpage, RW).locator("input").element_handle()
    rw.check()                                                                       # a list that loads: its row is updated when it is done
    wait_known(tpage, RW_ADDR)
    tpage.wait_for_function("() => window.__hopline.state.shipped.every((p) => !p.enabled || p.loaded)")
    mine.uncheck(); settle(tpage)                                                    # your own pack switched off
    ofac.uncheck(); settle(tpage)                                                    # a built-in list switched off
    assert all(h.evaluate("el => el.isConnected") for h in (mine, ofac, rw)), "every row is still the one that was there"
    assert [h.is_checked() for h in (mine, ofac, rw)] == [False, False, True]
    mine.focus(); tpage.keyboard.press("Space"); settle(tpage)
    assert mine.is_checked() and tpage.evaluate("() => document.activeElement.getAttribute('aria-label')") == "Use mine", "the key press switched it on and focus stayed where it was"
    ofac.focus(); tpage.keyboard.press("Space"); settle(tpage)
    assert ofac.is_checked() and tpage.evaluate("() => document.activeElement.getAttribute('aria-label')") == "Use " + OFAC["name"]


def test_importing_and_removing_a_pack_adds_and_removes_only_its_own_row(tpage):
    open_packs(tpage)
    import_csv(tpage, "one.csv", RW_ADDR, "One")
    first = tpage.query_selector("#packList input[type=checkbox]")
    import_csv(tpage, "two.csv", ADDR, "Two")
    assert tpage.locator("#packList .packrow").count() == 2 and first.evaluate("el => el.isConnected"), "a second pack does not redraw the first"
    tpage.click("#packList button[aria-label='Remove two']")
    assert tpage.locator("#packList .packrow").count() == 1 and first.evaluate("el => el.isConnected")
    import_csv(tpage, "one.csv", RW_ADDR, "One again")                                   # the same name replaces the pack: its row is made again, once
    assert tpage.locator("#packList .packrow").count() == 1 and not first.evaluate("el => el.isConnected")
