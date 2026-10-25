"""tools/make_label_pack_uksanctions.py: the UK Sanctions List becomes a label pack of the Bitcoin addresses written in the text of its entries."""
import io
import json
import pathlib
import subprocess
import sys
from xml.sax.saxutils import escape

import pytest

from test_ofac_pack import valid_address

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
import build_packs as bp  # noqa: E402
import make_label_pack_uksanctions as uk  # noqa: E402

BECH = "bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h"
LEGACY, P2SH = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT", "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy"
ETH, TRON = "0x175d44451403Edf28469dF03A9280c1197ADb92c", "TGJVc32ig2u8tQsYMLE7KXHT5NDQroaVNU"


@pytest.fixture(autouse=True)
def few_designations(monkeypatch):
    monkeypatch.setattr(uk, "MIN_DESIGNATIONS", 1)                           # the real list has thousands; the tests need a few


def designation(uid, name, other="", reasons="", given=(), kind="Entity", regime="The Russia (Sanctions) (EU Exit) Regulations 2019", address_line=""):
    names = "<Names><Name>" + "".join("<Name%d>%s</Name%d>" % (i + 1, escape(g), i + 1) for i, g in enumerate(given)) + "<Name6>%s</Name6><NameType>Primary Name</NameType></Name>" % escape(name)
    names += "<Name><Name6>An alias</Name6><NameType>Alias</NameType></Name></Names>"
    return ("<Designation><LastUpdated>04/08/2026</LastUpdated><UniqueID>%s</UniqueID>%s<RegimeName>%s</RegimeName><IndividualEntityShip>%s</IndividualEntityShip>"
            "<OtherInformation>%s</OtherInformation><UKStatementofReasons>%s</UKStatementofReasons><Addresses><Address><AddressLine1>%s</AddressLine1></Address></Addresses></Designation>"
            % (uid, names, escape(regime), kind, escape(other), escape(reasons), escape(address_line)))


def uk_xml(designations, date="16/10/2026"):
    return ('<?xml version="1.0" encoding="utf-8"?><Designations xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">'
            "<DateGenerated>%s</DateGenerated>%s</Designations>" % (date, "".join(designations))).encode("utf-8")


def test_an_address_in_the_text_of_an_entry_is_labelled_with_the_entry_and_says_where_it_was_written():
    pack, info = uk.convert(uk_xml([designation("RUS1421", "GARANTEX EUROPE OU", other="Digital Currency Address: XBT %s Digital Currency Address: ETH %s" % (P2SH, ETH)),
                                    designation("RUS3605", "RAPIRA GROUP LLC", other="Digital address: " + BECH)]))
    by = {e["address"]: e for e in pack["labels"]}
    assert set(by) == {P2SH, BECH}, "the Ethereum address is not a Bitcoin one"
    assert by[P2SH] == {"address": P2SH, "label": "UK Sanctions: GARANTEX EUROPE OU", "category": "RUS",
                        "note": "UK Sanctions List entry RUS1421 (The Russia (Sanctions) (EU Exit) Regulations 2019); the address is written in the entry's text (marked XBT)"}
    assert by[BECH]["note"].endswith("the address is written in the entry's text"), "no coin was named before it"
    assert pack["sanctions"] is True and pack["asOf"] == "2026-10-16" and pack["licence"] == "Open Government Licence v3.0" and "Open Government Licence v3.0" in pack["attribution"]
    assert pack["sourceUrl"] == "https://www.gov.uk/government/publications/the-uk-sanctions-list" and info["designations"] == 2 and info["read"] == 2


def test_a_person_is_written_surname_first_and_only_the_primary_name_is_used():
    pack, _ = uk.convert(uk_xml([designation("CTD0004", "AYASH", given=("Mustafa", "Ali"), other="BTC: " + LEGACY, kind="Individual")]))
    assert pack["labels"][0]["label"] == "UK Sanctions: AYASH, Mustafa Ali"


def test_only_the_two_text_fields_are_read():
    pack, _ = uk.convert(uk_xml([designation("A1", "X", other="nothing here", reasons="The statement names " + LEGACY + ".", address_line=BECH)]))
    assert [e["address"] for e in pack["labels"]] == [LEGACY], "an address-looking line in a postal address is not read"


def test_what_is_not_a_bitcoin_address_is_not_taken_for_one():
    text = " ".join(["ETH: " + ETH, "TRON: " + TRON, "hash " + "a1" * 32, "url https://example.org/" + P2SH + "x", "glued x" + LEGACY + " and " + LEGACY + "y", "short 1abc"])
    pack, info = uk.convert(uk_xml([designation("A1", "X", other=text)]))
    assert pack["labels"] == []
    assert info["skipped"] == {"invalid": 2, "duplicate": 0, "otherCoin": 0}, "only the two address-shaped strings with a letter added fail their checksum; the rest is not address-shaped"


def test_an_address_is_found_wherever_the_text_puts_it():
    text = "wallets: (1) BTC: %s; (2) USDT: %s, (3) %s. And (4) UPPER %s" % (LEGACY, P2SH, BECH, BECH.upper())
    pack, info = uk.convert(uk_xml([designation("A1", "X", other=text)]))
    assert [e["address"] for e in pack["labels"]] == [LEGACY, P2SH, BECH] and info["skipped"]["duplicate"] == 1, "the same address in capitals is the same address"


def test_an_address_the_text_gives_as_another_coin_is_left_out_but_a_usdt_one_is_kept():
    text = "BCH: %s USDT: %s ETH: %s BNB: %s" % (LEGACY, P2SH, BECH, valid_address(7))
    pack, info = uk.convert(uk_xml([designation("A1", "X", other=text)]))
    assert [e["address"] for e in pack["labels"]] == [P2SH] and info["skipped"]["otherCoin"] == 3
    assert "(marked USDT)" in pack["labels"][0]["note"], "USDT can be paid to a Bitcoin address (the Omni layer), and the note says what the entry called it"


def test_an_address_that_fails_its_checksum_is_counted_and_left_out_and_a_repeat_is_kept_once():
    bad = LEGACY[:-1] + ("a" if LEGACY[-1] != "a" else "b")
    pack, info = uk.convert(uk_xml([designation("A1", "FIRST", other=LEGACY + " " + bad), designation("A2", "SECOND", reasons=LEGACY)]))
    assert [(e["address"], e["label"]) for e in pack["labels"]] == [(LEGACY, "UK Sanctions: FIRST")] and info["skipped"] == {"invalid": 1, "duplicate": 1, "otherCoin": 0}


def test_hostile_text_in_a_name_is_cleaned_and_capped():
    pack, _ = uk.convert(uk_xml([designation("A1", "Evil" + chr(0x202e) + "gnp.exe " + "x" * 300, other=LEGACY)]))
    label = pack["labels"][0]["label"]
    assert chr(0x202e) not in label and len(label) <= 120 and label.startswith("UK Sanctions: Evil ")


def test_the_date_of_the_list_is_the_date_it_was_generated():
    assert uk.convert(uk_xml([designation("A1", "X", other=LEGACY)], "02/03/2026"))[0]["asOf"] == "2026-03-02"
    assert "asOf" not in uk.convert(uk_xml([designation("A1", "X", other=LEGACY)], "31/02/2026"))[0]
    assert "asOf" not in uk.convert(uk_xml([designation("A1", "X", other=LEGACY)], ""))[0]


@pytest.mark.parametrize("data,why", [(b"", "not the UK Sanctions List"), (b"<html></html>", "not the UK Sanctions List"), (b"\xff\xfe", "not the UK Sanctions List"),
                                      (b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><Designations/>', "DOCTYPE"),
                                      (uk_xml([designation("A1", "X", other=LEGACY)])[:-30], "not valid XML")])
def test_a_file_that_is_not_the_list_is_refused_with_advice(data, why):
    with pytest.raises(uk.ListError) as e:
        uk.convert(data)
    assert why in str(e.value)


def test_a_file_with_far_too_few_designations_is_refused(monkeypatch):
    monkeypatch.setattr(uk, "MIN_DESIGNATIONS", 1000)
    with pytest.raises(uk.ListError) as e:
        uk.convert(uk_xml([designation("A1", "X", other=LEGACY)]))
    assert "holds only 1 designations" in str(e.value)


def test_the_download_names_itself_and_refuses_a_file_that_is_too_large(monkeypatch):
    seen = []

    class Reply(io.BytesIO):
        def __enter__(self): return self
        def __exit__(self, *a): return False
    monkeypatch.setattr(uk.urllib.request, "urlopen", lambda req, timeout=0: (seen.append((req.full_url, req.get_header("User-agent"))), Reply(b"<x/>"))[1])
    assert uk.download() == b"<x/>" and seen == [(uk.URL, "hopline-build-packs")]
    monkeypatch.setattr(uk, "MAX_BYTES", 2)
    with pytest.raises(uk.ListError):
        uk.download()


def test_the_cli_writes_a_pack_and_says_what_it_left_out(tmp_path):
    src, out = tmp_path / "UK-Sanctions-List.xml", tmp_path / "pack.json"
    src.write_bytes(uk_xml([designation("A1", "X", other="BCH: %s XBT: %s" % (LEGACY, P2SH))] * 1200))
    r = subprocess.run([sys.executable, "-I", str(ROOT / "tools" / "make_label_pack_uksanctions.py"), "--file", str(src), "--out", str(out)], capture_output=True, text=True, timeout=120)
    assert r.returncode == 0 and "Wrote 1 Bitcoin addresses (from 1200 designations on the list generated 16/10/2026; left out: 0 failed the checksum, 1200 named as another coin, 1199 repeated)" in r.stdout, r.stderr
    assert json.loads(out.read_text(encoding="utf-8"))["format"] == "hopline-labels"
    none = tmp_path / "none.xml"; none.write_bytes(uk_xml([designation("A1", "X", other="nothing")] * 1200))
    r2 = subprocess.run([sys.executable, "-I", str(ROOT / "tools" / "make_label_pack_uksanctions.py"), "--file", str(none), "--out", str(tmp_path / "n.json")], capture_output=True, text=True, timeout=120)
    assert r2.returncode != 0 and "No Bitcoin addresses found" in r2.stderr


# ---- build_packs -----------------------------------------------------------------------------------------------------------
def test_build_packs_ships_the_list_switched_on_as_a_sanctions_list_and_refuses_a_list_that_names_no_address(tmp_path):
    src = tmp_path / "uk.xml"; src.write_bytes(uk_xml([designation("RUS1", "GARANTEX", other="XBT " + P2SH)]))
    bp.main(["--uk", str(src), "--out", str(tmp_path / "packs")])
    (e,) = bp.read_index(str(tmp_path / "packs" / "index.js"))
    assert (e["id"], e["entries"], e["sanctions"], e["defaultOn"], e["licence"], e["asOf"]) == ("uk-sanctions", 1, True, True, "Open Government Licence v3.0", "2026-10-16")
    empty = tmp_path / "empty.xml"; empty.write_bytes(uk_xml([designation("RUS1", "GARANTEX", other="ETH " + ETH)]))
    with pytest.raises(SystemExit) as ex:
        bp.main(["--uk", str(empty), "--out", str(tmp_path / "packs2")])
    assert "its layout may have changed" in str(ex.value) and not (tmp_path / "packs2").exists()
    with pytest.raises(SystemExit) as ex2:
        bp.main(["--uk", "x", "--download-uk", "--out", str(tmp_path / "packs3")])
    assert ex2.value.code == 2


def test_the_shipped_pack_names_only_valid_bitcoin_addresses_and_carries_its_attribution():
    text = (ROOT / "public" / "packs" / "uk-sanctions.js").read_text(encoding="utf-8")
    lines = [json.loads(ln.rstrip(",")) for ln in text.splitlines() if ln.startswith('{"address"')]
    assert lines and all(uk.address_ok(e["address"]) and e["label"].startswith("UK Sanctions: ") and e["note"].startswith("UK Sanctions List entry ") for e in lines)
    assert "Open Government Licence v3.0" in text.split("(window.HOPLINE_PACKS", 1)[1][:900]
