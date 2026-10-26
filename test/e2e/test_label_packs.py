"""Label packs: other people's lists of wallets and names, imported from CSV or JSON, kept apart from your own labels."""
import csv
import io
import json

import pytest

from conftest import NORMAL, OUTSPENDS, ROOT
from helpers import idle, open_query, settle, toast_text

BIG = max(range(len(NORMAL["vout"])), key=lambda i: NORMAL["vout"][i]["value"])
BIG_ADDR = NORMAL["vout"][BIG]["scriptpubkey_address"]
SMALL_ADDR = NORMAL["vout"][1 - BIG]["scriptpubkey_address"]
INPUT_ADDR = NORMAL["vin"][0]["prevout"]["scriptpubkey_address"]
ETH = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def drawn_texts(page):
    return page.evaluate("""() => { const r = window.__hopline.renderer, ctx = r.ctx, orig = ctx.fillText.bind(ctx), seen = [];
        ctx.fillText = (t, ...a) => { seen.push(String(t)); return orig(t, ...a); }; r.draw(); ctx.fillText = orig; return seen; }""")


def open_packs(page):
    page.evaluate("() => { document.getElementById('packSection').open = true; }")


def load(page, name, text):
    open_packs(page)
    page.set_input_files("#packFile", files=[{"name": name, "mimeType": "text/csv", "buffer": text.encode("utf-8")}])
    page.wait_for_function("() => /Imported|Replaced|Import failed/.test(document.getElementById('toast').textContent)")
    settle(page)


def known(page, address):
    return page.evaluate("(a) => window.__hopline.renderer.data.known[a] || null", address)


def test_importing_a_pack_labels_the_wallets_it_names_and_says_where_the_name_came_from(fpage):
    open_query(fpage, NORMAL["txid"])
    load(fpage, "exchange-list.csv", "address,label,category,url,note\n%s,Pack Exchange,EXCH,https://example.org/ref,Hot wallet seen in case 7\n" % SMALL_ADDR)
    t = toast_text(fpage)
    assert "Imported 1 labelled wallets, 1 of them already in the workspace" in t, t
    k = known(fpage, SMALL_ADDR)
    assert k["label"] == "Pack Exchange" and k["pack"] == "exchange-list" and k["category"] == "EXCH"
    assert "Pack Exchange" in drawn_texts(fpage), "drawn on the canvas like any known wallet"
    fpage.evaluate("(id) => window.__hopline.setSel([id])", "addr:" + SMALL_ADDR); settle(fpage)
    insp = fpage.inner_text("#inspBody")
    assert "known: Pack Exchange (exchange-list)" in insp and "EXCH" in insp and "Hot wallet seen in case 7" in insp and "source" in insp.lower()
    assert fpage.get_attribute("#inspBody a:has-text('source')", "href") == "https://example.org/ref"
    assert "exchange-list" in fpage.inner_text("#packList") and "1 wallets" in fpage.inner_text("#packList")


def test_a_pack_can_be_switched_off_and_removed_and_it_is_remembered(fpage):
    open_query(fpage, NORMAL["txid"])
    load(fpage, "p1.csv", "%s,First pack\n" % SMALL_ADDR)
    assert known(fpage, SMALL_ADDR)["label"] == "First pack"
    fpage.uncheck("#packList input[type=checkbox]"); settle(fpage)
    assert known(fpage, SMALL_ADDR) is None and "First pack" not in drawn_texts(fpage)
    fpage.reload(); fpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    open_packs(fpage); settle(fpage)                                      # the page is still arranging itself after a reload (the saved-session bar appears): a click aimed before that can land beside the box
    assert "p1" in fpage.inner_text("#packList") and not fpage.is_checked("#packList input[type=checkbox]"), "still there, still off"
    fpage.check("#packList input[type=checkbox]")
    assert known(fpage, SMALL_ADDR)["label"] == "First pack"
    fpage.click("#packList button[aria-label='Remove p1']")
    assert known(fpage, SMALL_ADDR) is None and "No packs imported" in fpage.inner_text("#packHint")
    fpage.reload(); fpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert fpage.evaluate("() => window.__hopline.state.packs.length") == 0


def test_two_packs_naming_one_wallet_both_show_and_importing_the_same_name_replaces(fpage):
    open_query(fpage, NORMAL["txid"])
    load(fpage, "a.csv", "%s,Name from A\n" % SMALL_ADDR)
    load(fpage, "b.csv", "%s,Name from B\n" % SMALL_ADDR)
    k = known(fpage, SMALL_ADDR)
    assert k["label"] == "Name from A" and k["alt"] == ["Name from B (b)"], "the first pack wins and the other is listed as an alternative"
    fpage.evaluate("(id) => window.__hopline.setSel([id])", "addr:" + SMALL_ADDR); settle(fpage)
    assert "also listed as: Name from B (b)" in fpage.inner_text("#inspBody")
    load(fpage, "a.csv", "%s,Newer name from A\n" % SMALL_ADDR)
    assert "Replaced the pack" in toast_text(fpage) and fpage.evaluate("() => window.__hopline.state.packs.length") == 2
    assert known(fpage, SMALL_ADDR)["label"] != "Name from A"


def test_rows_that_cannot_be_used_are_counted_and_left_out(fpage):
    open_query(fpage, NORMAL["txid"])
    bad = SMALL_ADDR[:-1] + ("a" if SMALL_ADDR[-1] != "a" else "b")
    load(fpage, "mixed.csv", "address,label\n%s,Good\n%s,Typo in the address\n%s,An Ethereum address\n%s,Good again\n" % (INPUT_ADDR, bad, ETH, INPUT_ADDR))
    t = toast_text(fpage)
    assert "Imported 1 labelled wallets" in t and "1 failed the address checksum" in t and "1 were not Bitcoin addresses" in t and "1 repeated" in t, t
    assert known(fpage, bad) is None and known(fpage, INPUT_ADDR)["label"] == "Good"


def test_a_file_with_nothing_usable_is_refused_and_changes_nothing(fpage):
    open_query(fpage, NORMAL["txid"])
    load(fpage, "eth.csv", "address,label\n%s,Ethereum\n" % ETH)
    assert "Import failed" in toast_text(fpage) and "not Bitcoin addresses" in toast_text(fpage)
    assert fpage.evaluate("() => window.__hopline.state.packs.length") == 0


def test_hostile_text_in_a_pack_is_only_ever_text(fpage):
    open_query(fpage, NORMAL["txid"])
    evil = '<img src=x onerror=window.__pwned=1> ' + "x" * 200
    pack = {"format": "hopline-labels", "name": "<b>bold</b> pack", "labels": [{"address": SMALL_ADDR, "label": evil, "category": "<script>1</script>", "url": "javascript:window.__pwned=1", "note": "<i>n</i>"}]}
    load(fpage, "evil.json", json.dumps(pack))
    fpage.evaluate("(id) => window.__hopline.setSel([id])", "addr:" + SMALL_ADDR); settle(fpage)
    assert fpage.evaluate("() => window.__pwned") is None
    assert fpage.locator("#inspBody img, #inspBody script, #packList b, #inspBody i").count() == 0, "nothing was turned into markup"
    assert fpage.locator("#inspBody a:has-text('source')").count() == 0, "a javascript: link is dropped"
    assert "<b>bold</b> pack" in fpage.inner_text("#packList"), "shown literally"
    assert len(known(fpage, SMALL_ADDR)["label"]) == 120


def test_a_wallet_a_pack_labels_stops_auto_expand_like_any_known_wallet(fpage):
    open_query(fpage, NORMAL["txid"])
    load(fpage, "stop.csv", "%s,Pack Exchange\n" % INPUT_ADDR)
    open_packs(fpage)
    fpage.evaluate("(id) => window.__hopline.autoExpand(id, { dir: 'prev', hops: 2, follow: 'all' })", "tx:" + NORMAL["txid"]); idle(fpage); settle(fpage)
    assert "reached a labelled wallet (Pack Exchange)" in toast_text(fpage)


def test_importing_a_pack_refreshes_the_analysis_that_depends_on_known_wallets(fpage):
    open_query(fpage, NORMAL["txid"])
    before = fpage.evaluate("() => [...window.__hopline.analysis().changeEdges.keys()]")
    assert before, "the built-in list knows one output, so the other is the likely change"
    load(fpage, "both.csv", "%s,Also known\n" % SMALL_ADDR)
    after = fpage.evaluate("() => [...window.__hopline.analysis().changeEdges.keys()]")
    assert after == [], "both outputs are now known wallets: nothing singles one out any more"


def test_your_own_labels_export_as_a_pack_that_imports_back(fpage, tmp_path):
    open_query(fpage, NORMAL["txid"])
    fpage.evaluate("""(a) => { const g = window.__hopline.state.graph; g.annotate('addr:' + a, '=SUM(1+1) Suspect', 'seen on 2022-04-05'); g.nodes.get('addr:' + a).tag = 'THREAT'; window.__hopline.refresh(); }""", SMALL_ADDR)
    open_packs(fpage)

    def export(button, name):
        with fpage.expect_download() as dl:
            fpage.click(button)
        p = tmp_path / name; dl.value.save_as(p); return p

    rows = list(csv.reader(io.StringIO(export("#packExportCsv", "l.csv").read_text(encoding="utf-8-sig"), newline="")))
    assert rows[0] == ["address", "label", "category", "url", "note"]
    assert rows[1][0] == SMALL_ADDR and rows[1][1] == "'=SUM(1+1) Suspect" and rows[1][2] == "THREAT" and rows[1][4] == "seen on 2022-04-05", "a formula in a label is defused for spreadsheets"
    doc = json.loads(export("#packExportJson", "l.json").read_text(encoding="utf-8"))
    assert doc["format"] == "hopline-labels" and doc["labels"][0]["address"] == SMALL_ADDR and doc["labels"][0]["label"] == "=SUM(1+1) Suspect"
    load(fpage, "colleague.json", json.dumps(doc))
    assert known(fpage, SMALL_ADDR)["label"] == "=SUM(1+1) Suspect" and known(fpage, SMALL_ADDR)["pack"].startswith("Hopline labels")


def test_exporting_with_nothing_labelled_says_so(fpage):
    open_query(fpage, NORMAL["txid"])
    open_packs(fpage)
    fpage.click("#packExportCsv")
    assert "Nothing to export" in toast_text(fpage)


# ---- OFAC's SDN list, read directly in the page ----------------------------------------------------------------------------

def sdn_xml(address, uid="24003", last="MESRI", first="Behzad"):
    """A miniature SDN.XML in the real layout: one entry with a Bitcoin address, one without."""
    return ('<?xml version="1.0" standalone="yes"?><sdnList xmlns="https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/XML">'
            '<publshInformation><Publish_Date>10/21/2026</Publish_Date><Record_Count>2</Record_Count></publshInformation>'
            '<sdnEntry><uid>%s</uid><firstName>%s</firstName><lastName>%s</lastName><sdnType>Individual</sdnType>'
            '<programList><program>CYBER2</program><program>HRIT-IR</program></programList>'
            '<idList><id><uid>1</uid><idType>Digital Currency Address - XBT</idType><idNumber>%s</idNumber></id></idList></sdnEntry>'
            '<sdnEntry><uid>9</uid><lastName>OTHER</lastName><sdnType>Entity</sdnType></sdnEntry></sdnList>' % (uid, first, last, address))


def zipped(name, data):
    import zipfile
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(name, data)
    return buf.getvalue()


def load_file(page, name, data, mime):
    open_packs(page)
    page.set_input_files("#packFile", files=[{"name": name, "mimeType": mime, "buffer": data if isinstance(data, bytes) else data.encode("utf-8")}])
    page.wait_for_function("() => /Imported|Replaced|Import failed|cannot be used/.test(document.getElementById('toast').textContent)")
    settle(page)


def test_the_ofac_zip_is_read_in_the_page_and_labels_the_wallets_it_names(fpage):
    open_query(fpage, NORMAL["txid"])
    load_file(fpage, "SDN_XML.ZIP", zipped("SDN.XML", sdn_xml(SMALL_ADDR)), "application/zip")
    t = toast_text(fpage)
    assert "Imported 1 labelled wallets, 1 of them already in the workspace" in t and "OFAC list dated 10/21/2026: 1 Bitcoin address from 1 of its 2 entries." in t, t
    k = known(fpage, SMALL_ADDR)
    assert k["label"] == "OFAC SDN: MESRI, Behzad" and k["pack"] == "OFAC SDN list (Bitcoin)" and k["category"] == "CYBER2, HRIT-IR"
    assert "OFAC SDN: MESRI, Behzad" in drawn_texts(fpage), "drawn on the canvas like any known wallet"
    fpage.evaluate("(id) => window.__hopline.setSel([id])", "addr:" + SMALL_ADDR); settle(fpage)
    insp = fpage.inner_text("#inspBody")
    assert "known: OFAC SDN: MESRI, Behzad (OFAC SDN list (Bitcoin))" in insp and "CYBER2, HRIT-IR" in insp
    assert fpage.get_attribute("#inspBody a:has-text('source')", "href") == "https://sanctionssearch.ofac.treas.gov/Details.aspx?id=24003", "links to the entry"
    assert "OFAC SDN list (Bitcoin)" in fpage.inner_text("#packList") and "1 wallets" in fpage.inner_text("#packList")


def test_the_unzipped_xml_works_too_and_importing_again_replaces_the_pack(fpage):
    open_query(fpage, NORMAL["txid"])
    load_file(fpage, "SDN.XML", sdn_xml(SMALL_ADDR), "text/xml")
    assert "Imported 1 labelled wallets" in toast_text(fpage)
    load_file(fpage, "SDN_XML.ZIP", zipped("SDN.XML", sdn_xml(SMALL_ADDR, uid="777", last="RENAMED", first="Ann")), "application/zip")
    assert 'Replaced the pack "OFAC SDN list (Bitcoin)"' in toast_text(fpage)
    assert known(fpage, SMALL_ADDR)["label"] == "OFAC SDN: RENAMED, Ann"
    assert fpage.locator("#packList .packrow").count() == 1


def test_the_ofac_pack_is_remembered_across_a_reload(fpage):
    open_query(fpage, NORMAL["txid"])
    load_file(fpage, "SDN_XML.ZIP", zipped("SDN.XML", sdn_xml(SMALL_ADDR)), "application/zip")
    assert "OFAC SDN list (Bitcoin)" in fpage.evaluate("() => localStorage.getItem('hopline.packs.v1')"), "saved in this browser"
    fpage.reload(); fpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    open_packs(fpage)
    assert "OFAC SDN list (Bitcoin)" in fpage.inner_text("#packList") and "1 wallets" in fpage.inner_text("#packList")
    assert known(fpage, SMALL_ADDR)["label"] == "OFAC SDN: MESRI, Behzad", "and it is active again: the name is known before anything is loaded"


def test_the_ofac_csv_is_refused_because_it_loses_addresses(fpage):
    csv_text = '36,"AEROCARIBBEAN AIRLINES",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- \n173,"ANGLO-CARIBBEAN CO., LTD.",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- \n'
    load_file(fpage, "SDN.CSV", csv_text, "text/csv")
    t = toast_text(fpage)
    assert "SDN.CSV" in t and "cannot be used" in t and "SDN_XML.ZIP" in t, t
    assert fpage.locator("#packList .packrow").count() == 0


def test_a_broken_or_wrong_zip_is_refused_with_a_reason_and_imports_nothing(fpage):
    load_file(fpage, "SDN_XML.ZIP", b"PK\x03\x04 this is not a zip file", "application/zip")
    assert "Import failed" in toast_text(fpage) and "not a readable zip" in toast_text(fpage)
    load_file(fpage, "other.xml", '<?xml version="1.0"?><Whatever xmlns="http://example.org"><DistinctParties/></Whatever>', "text/xml")
    assert "Import failed" in toast_text(fpage) and "not an OFAC SDN list" in toast_text(fpage)
    assert fpage.locator("#packList .packrow").count() == 0


FX_OFAC = ROOT / "test" / "fixtures" / "ofac"
BECH = "bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h"


@pytest.mark.parametrize("layout", ["legacy", "enhanced", "advanced"])
@pytest.mark.parametrize("zipped_up", [True, False])
def test_every_ofac_layout_zipped_or_not_is_read_in_the_page(fpage, layout, zipped_up):
    data = (FX_OFAC / ("sdn_" + layout + ".xml")).read_bytes()
    if zipped_up:
        load_file(fpage, "SDN_%s.ZIP" % layout.upper(), zipped("SDN_%s.XML" % layout.upper(), data), "application/zip")
    else:
        load_file(fpage, "SDN_%s.XML" % layout.upper(), data, "text/xml")
    t = toast_text(fpage)
    assert "Imported 3 labelled wallets" in t and "OFAC list dated 10/21/2026: 3 Bitcoin addresses from 3 of its 5 entries." in t and "Warning" not in t, t
    clean = known(fpage, "1opFYNKYG21CfzMYgCZBDoeBpQ9vhVUC9")           # not on the built-in list: the OFAC name is the name
    assert clean["label"] == "OFAC SDN: DOE, John Michael" and clean["category"] == "SDGT" and clean["pack"] == "OFAC SDN list (Bitcoin)"
    # these two are also on the built-in list (Binance, FTX): the first name stays and the other claim is kept beside it
    both = known(fpage, BECH)
    assert both["label"] == "Binance Hot Wallet" and both["alt"] == ["OFAC SDN: EXAMPLE GROUP & SONS / SMITH, Jane (OFAC SDN list (Bitcoin))"]
    assert known(fpage, "325gSHHe7UGvzEc9kGx43VqPboXUVwa26i")["alt"] == ["OFAC SDN: EXAMPLE GROUP & SONS (OFAC SDN list (Bitcoin))"]
    assert "3 wallets" in fpage.inner_text("#packList")


def test_a_list_the_page_could_not_read_completely_says_so_but_keeps_what_it_read(fpage):
    text = (FX_OFAC / "sdn_enhanced.xml").read_text(encoding="utf-8").replace("<value>1opFYNKYG21CfzMYgCZBDoeBpQ9vhVUC9", "<value>")
    load_file(fpage, "SDN_ENHANCED.XML", text, "text/xml")
    t = toast_text(fpage)
    assert "Imported 2 labelled wallets" in t and "Warning: The file mentions 4 Bitcoin address entries but only 3 could be read" in t, t
