"""tools/make_label_pack_graphsense.py: a chosen part of the GraphSense TagPacks becomes a label pack of Bitcoin addresses, each with the link to its source."""
import hashlib
import json
import pathlib
import subprocess
import sys

import pytest

from test_ofac_pack import valid_address

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
import build_packs as bp  # noqa: E402
import make_label_pack_graphsense as gs  # noqa: E402

LICENCE_TEXT = "MIT License" + chr(10) + chr(10) + "Copyright (c) 2022 Iknaio" + chr(10)
COMMIT = {"sha": "d" * 40, "date": "2026-10-21", "licence_text": LICENCE_TEXT}
A, B, C = valid_address(1), valid_address(2), valid_address(3)
DOJ = "https://www.justice.gov/opa/press-release/file/1/download"

FORFEIT = chr(10).join(["title: 155 virtual currency assets", "creator: GraphSense Core team", "label: Al-Qaeda Campaign", "confidence: authority_data", "source: " + DOJ,
                        "currency: BTC", "abuse: terrorism", "tags:", "- address: " + A, "- address: " + B, ""])
EXCHANGE = chr(10).join(["title: Binance reserve wallets", "confidence: service_data", "category: exchange", "lastmod: 2022-11-16", "source: https://www.binance.com/en/blog/x",
                         "tags:", "- address: " + C, "  currency: BTC", "  label: binance reserve wallets BTC", "- address: 0x742d35Cc6634C0532925a3b844Bc454e4438f44e", "  currency: ETH", ""])


def test_a_pack_is_its_header_then_its_tags_and_each_tag_takes_what_it_does_not_say_from_the_header():
    header, tags = gs.parse_pack(FORFEIT, "x")
    assert header["label"] == "Al-Qaeda Campaign" and header["abuse"] == "terrorism" and [t["address"] for t in tags] == [A, B]
    pack, info = gs.convert({"aft-alqaeda-forfeit_vc": FORFEIT, "exchange-wallets-binance": EXCHANGE}, COMMIT)
    by = {e["address"]: e for e in pack["labels"]}
    assert by[A] == {"address": A, "label": "Al-Qaeda Campaign", "category": "TERRORISM", "url": DOJ, "note": "GraphSense tagpack aft-alqaeda-forfeit_vc (authority_data; abuse type: terrorism)"}
    assert by[C]["label"] == "binance reserve wallets BTC" and by[C]["category"] == "EXCHANGE" and by[C]["note"] == "GraphSense tagpack exchange-wallets-binance (service_data, 2022-11-16)"
    assert info["skipped"]["otherCurrency"] == 1 and info["read"] == 3 and pack["asOf"] == "2022-11-16", "the date is the newest change to a tag, not the day it was copied"


def test_a_tag_of_its_own_overrides_the_header_and_a_pack_with_no_label_is_named_by_its_title():
    text = chr(10).join(["title: Some title", "category: user", "source: https://archive.org/a", "currency: BTC", "tags:", "- address: " + A, "  label: Own label", "  category: service",
                         "  source: https://archive.org/b", "- address: " + B, ""])
    pack, _ = gs.convert({"demo": text})
    by = {e["address"]: e for e in pack["labels"]}
    assert (by[A]["label"], by[A]["category"], by[A]["url"]) == ("Own label", "SERVICE", "https://archive.org/b")
    assert (by[B]["label"], by[B]["category"], by[B]["url"]) == ("Some title", "USER", "https://archive.org/a")


def test_the_abuse_type_is_kept_in_the_note_and_does_not_replace_the_category():
    text = chr(10).join(["title: T", "category: user", "abuse: sanction", "label: Lazarus group", "source: https://www.fbi.gov/p", "currency: BTC", "confidence: authority_data", "lastmod: 2023-08-28", "tags:", "- address: " + A, ""])
    (e,) = gs.convert({"lazarus2": text})[0]["labels"]
    assert e["category"] == "USER" and e["note"] == "GraphSense tagpack lazarus2 (authority_data, 2023-08-28; abuse type: sanction)"


def test_a_tag_is_taken_only_when_its_source_is_the_kind_of_page_the_pack_is_chosen_for():
    text = chr(10).join(["title: T", "label: L", "currency: BTC", "source: https://www.binance.com/en/blog/x", "tags:", "- address: " + A, "- address: " + B, "  source: https://twitter.com/someone/status/1",
                         "- address: " + C, "  source: https://evil.example/https://www.binance.com/", "- address: " + valid_address(4), "  source: javascript:alert(1)", ""])
    pack, info = gs.convert({"exchange-wallets-binance": text})
    assert [e["address"] for e in pack["labels"]] == [A] and info["skipped"]["otherSource"] == 3


def test_a_pack_that_is_not_in_the_list_is_never_read():
    pack, info = gs.convert({"miners": FORFEIT, "walletexplorer": FORFEIT, "aft-alqaeda-forfeit_vc": FORFEIT})
    assert info["packs"] == ["aft-alqaeda-forfeit_vc"] and len(pack["labels"]) == 2
    assert not any(n in gs.PACKS for n in ("miners", "walletexplorer", "samourai", "ransomwhere", "ofac", "Alt-Right")), "bulk lists, scraped sites and people are not chosen"


def test_addresses_that_fail_their_checksum_and_repeats_are_counted_and_left_out():
    bad = A[:-1] + ("a" if A[-1] != "a" else "b")
    text = chr(10).join(["title: T", "label: L", "currency: BTC", "source: " + DOJ, "tags:", "- address: " + A, "- address: " + bad, "- address: " + A, "- address: not an address", ""])
    pack, info = gs.convert({"aft-alqaeda-forfeit_vc": text})
    assert [e["address"] for e in pack["labels"]] == [A] and info["skipped"] == {"otherCurrency": 0, "otherSource": 0, "invalid": 2, "duplicate": 1}


def test_quotes_comments_and_windows_line_endings_are_understood():
    text = ("# a comment" + chr(13) + chr(10) + "title: 'It''s a title'" + chr(13) + chr(10) + 'label: "Quoted: label"' + chr(13) + chr(10) + "currency: BTC # the coin" + chr(13) + chr(10) + "source: " + DOJ + chr(13) + chr(10)
            + "tags:" + chr(13) + chr(10) + "- address: " + A + chr(13) + chr(10))
    header, tags = gs.parse_pack(text, "x")
    assert header["title"] == "It's a title" and header["label"] == "Quoted: label" and header["currency"] == "BTC" and tags == [{"address": A}]


@pytest.mark.parametrize("text,why", [("title: T" + chr(10) + "tags:" + chr(10) + "- address: x" + chr(10) + "  note: |" + chr(10) + "    more", "a YAML construct"),
                                      ("title: T" + chr(10) + "tags:" + chr(10) + "- address: x" + chr(10) + "  tag: [a, b]", "a YAML construct"),
                                      ("title: T" + chr(10) + "label: *anchor" + chr(10) + "tags:", "a YAML construct"),
                                      ("title: T" + chr(10) + "tags:" + chr(10) + "- address: x" + chr(10) + "    deeper: 1", "not a tag entry"),
                                      ("title: T" + chr(10) + "tags:" + chr(10) + "  - address: x", "not a tag entry"),
                                      ("just some words", "not a 'key: value' line"),
                                      ("title: T" + chr(10) + "label: L", "no 'tags:' list")])
def test_anything_this_reader_does_not_know_is_refused_and_not_guessed_at(text, why):
    with pytest.raises(gs.ListError) as e:
        gs.parse_pack(text, "x.yaml")
    assert why in str(e.value) and "x.yaml" in str(e.value)


def test_the_licence_is_stated_only_for_data_that_came_with_it(tmp_path):
    pack, info = gs.convert({"aft-alqaeda-forfeit_vc": FORFEIT}, COMMIT)
    assert info["official"] and pack["licence"] == "MIT" and pack["licenceText"] == LICENCE_TEXT and "commit ddddddd (2026-10-21)" in pack["source"] and "Iknaio" in pack["attribution"]
    other, info2 = gs.convert({"aft-alqaeda-forfeit_vc": FORFEIT})
    assert not info2["official"] and "licence" not in other and "licenceText" not in other and "files you supplied" in other["source"]


# ---- the download ----------------------------------------------------------------------------------------------------------
class Web:
    def __init__(self, files):
        self.files, self.asked = files, []

    def __call__(self, url, token=False, timeout=60, limit=0):
        self.asked.append((url, token))
        if url not in self.files:
            raise OSError("404 " + url)
        v = self.files[url]
        return v if isinstance(v, bytes) else json.dumps(v).encode("utf-8")


def served(sha="e" * 40, licence=None):
    base = gs.RAW % (sha, "%s")
    f = {gs.API_COMMIT: {"sha": sha, "commit": {"committer": {"date": "2026-10-21T08:21:47Z"}}}, base % "LICENSE": licence if licence is not None else LICENCE_TEXT.encode("utf-8")}
    for name in gs.PACKS:
        f[base % ("packs/%s.yaml" % name)] = FORFEIT.encode("utf-8").replace(DOJ.encode(), (gs.PACKS[name][0] + "x").encode())
    return f


def test_a_download_reads_the_commit_then_the_chosen_packs_of_that_commit_and_the_token_goes_only_to_the_api(monkeypatch):
    monkeypatch.setattr(gs, "LICENSE_SHA256", hashlib.sha256(LICENCE_TEXT.encode("utf-8")).hexdigest())
    web = Web(served())
    monkeypatch.setattr(gs, "http_get", web)
    files, commit = gs.fetch()
    assert set(files) == set(gs.PACKS) and commit == {"sha": "e" * 40, "date": "2026-10-21", "licence_text": LICENCE_TEXT}
    assert web.asked[0] == (gs.API_COMMIT, True) and all(t is False for _, t in web.asked[1:])
    assert all(u.startswith("https://raw.githubusercontent.com/graphsense/graphsense-tagpacks/" + "e" * 40 + "/") for u, _ in web.asked[1:])
    assert len(web.asked) == 2 + len(gs.PACKS), "one request for the commit, one for the licence, one for each chosen pack and nothing else"


def test_a_licence_text_that_has_changed_stops_the_download(monkeypatch):
    monkeypatch.setattr(gs, "LICENSE_SHA256", hashlib.sha256(LICENCE_TEXT.encode("utf-8")).hexdigest())
    monkeypatch.setattr(gs, "http_get", Web(served(licence=b"Another licence")))
    with pytest.raises(gs.ListError) as e:
        gs.fetch()
    assert "no longer the one this script was written against" in str(e.value) and "LICENSE_SHA256" in str(e.value)


def test_a_missing_pack_or_a_reply_that_is_not_understood_says_how_to_go_on(monkeypatch):
    monkeypatch.setattr(gs, "LICENSE_SHA256", hashlib.sha256(LICENCE_TEXT.encode("utf-8")).hexdigest())
    f = served(); del f[gs.RAW % ("e" * 40, "packs/demo.yaml")]
    monkeypatch.setattr(gs, "http_get", Web(f))
    with pytest.raises(gs.ListError) as e:
        gs.fetch()
    assert "use --dir" in str(e.value)
    f2 = served(); f2[gs.API_COMMIT] = {"sha": "nothex"}
    monkeypatch.setattr(gs, "http_get", Web(f2))
    with pytest.raises(gs.ListError):
        gs.fetch()


# ---- build_packs and the cli -----------------------------------------------------------------------------------------------
def test_build_packs_ships_it_switched_off_with_the_licence_first_in_the_file_and_refuses_a_partial_read(tmp_path, monkeypatch):
    monkeypatch.setattr(gs, "LICENSE_SHA256", hashlib.sha256(LICENCE_TEXT.encode("utf-8")).hexdigest())
    monkeypatch.setattr(gs, "http_get", Web(served()))
    pack_id, pack, default_on = bp.build_graphsense(None)
    assert (pack_id, default_on) == ("graphsense", False)
    entry, _, diff = bp.add_pack(str(tmp_path), pack_id, pack, default_on)
    text = (tmp_path / "graphsense.js").read_text(encoding="utf-8")
    assert text.index("Copyright (c) 2022 Iknaio") < text.index("(window.HOPLINE_PACKS") and entry["licence"] == "MIT" and entry["defaultOn"] is False and len(diff["added"]) == 2
    monkeypatch.setattr(gs, "convert", lambda files, commit: ({"labels": [{"address": A}]}, {"packs": ["demo"]}))
    with pytest.raises(bp.BuildError) as e:
        bp.build_graphsense(None)
    assert "Only 1 of the %d chosen GraphSense packs were read" % len(gs.PACKS) in str(e.value)


def test_the_cli_reads_a_folder_of_pack_files_and_says_it_states_no_licence(tmp_path):
    folder = tmp_path / "packs"; folder.mkdir()
    (folder / "aft-alqaeda-forfeit_vc.yaml").write_text(FORFEIT, encoding="utf-8")
    (folder / "miners.yaml").write_text(FORFEIT, encoding="utf-8")
    out = tmp_path / "pack.json"
    r = subprocess.run([sys.executable, "-I", str(ROOT / "tools" / "make_label_pack_graphsense.py"), "--dir", str(folder), "--out", str(out)], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0 and "Wrote 2 Bitcoin addresses from 1 packs" in r.stdout and "does not state a licence" in r.stderr, r.stderr
    assert len(json.loads(out.read_text(encoding="utf-8"))["labels"]) == 2, "the pack that is not in the list was not read"


# ---- the real files, when there is a YAML library to check this reader against ---------------------------------------------------
def test_this_reader_agrees_with_a_real_yaml_library_on_the_shapes_the_packs_use():
    yaml = pytest.importorskip("yaml")

    def texts(d):                                    # a library types a value (0x... is a number, true is a boolean); the tool keeps every value as the text it was
        return {k: v for k, v in d.items() if isinstance(v, str)}
    for text in (FORFEIT, EXCHANGE, "title: 'It''s'" + chr(10) + 'label: "Q: x"' + chr(10) + "tags:" + chr(10) + "- address: " + A + chr(10) + "  source: https://a.example/x?y=1&z=2" + chr(10)):
        header, tags = gs.parse_pack(text, "x")
        lib = yaml.safe_load(text)
        lib_header = texts({k: v for k, v in lib.items() if k != "tags"})
        assert lib_header == {k: header[k] for k in lib_header}
        assert len(lib["tags"]) == len(tags)
        for lib_tag, mine in zip(lib["tags"], tags):
            assert texts(lib_tag) == {k: mine[k] for k in texts(lib_tag)}


def test_the_shipped_pack_names_only_valid_bitcoin_addresses_each_with_a_source_link_and_carries_the_licence():
    text = (ROOT / "public" / "packs" / "graphsense.js").read_text(encoding="utf-8")
    lines = [json.loads(ln.rstrip(",")) for ln in text.splitlines() if ln.startswith('{"address"')]
    assert len(lines) > 100 and all(gs.address_ok(e["address"]) and e["url"].startswith("https://") and e["note"].startswith("GraphSense tagpack ") for e in lines)
    assert "Copyright (c) 2022 Iknaio" in text.split("(window.HOPLINE_PACKS", 1)[0]
    hosts = tuple(p for prefixes in gs.PACKS.values() for p in prefixes)
    assert all(e["url"].startswith(hosts) for e in lines), "every link is on a page of the kind its pack was chosen for"
