"""tools/make_label_pack_miningpools.py: the mining pools list that mempool.space uses becomes a label pack that Hopline's importer accepts."""
import hashlib
import json
import pathlib
import subprocess
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
import build_packs as bp  # noqa: E402
import make_label_pack_miningpools as mp  # noqa: E402

LEGACY, P2SH = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT", "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy"
BECH = "bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h"
TESTNET = ["tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn", "2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc"]
LICENCE_TEXT = "MIT License" + chr(10) + chr(10) + "Copyright (c) 2019 btc.com" + chr(10)
COMMIT = {"sha": "a" * 40, "date": "2026-09-24", "licence_text": LICENCE_TEXT}


def pool(name, addresses=(), link="https://pool.example", tags=("/x/",)):
    return {"id": 1, "name": name, "addresses": list(addresses), "tags": list(tags), "link": link}


def data_of(pools):
    return json.dumps(pools).encode("utf-8")


def test_each_pool_address_is_labelled_with_the_pool_and_its_own_link():
    pack, info = mp.convert(data_of([pool("AntPool", [LEGACY, P2SH], "https://www.antpool.com"), pool("Foundry USA", [BECH]), pool("Tags only", [])]), COMMIT)
    by = {e["address"]: e for e in pack["labels"]}
    assert by[LEGACY] == {"address": LEGACY, "label": "Mining pool: AntPool", "category": "MINING", "url": "https://www.antpool.com"}
    assert by[BECH]["label"] == "Mining pool: Foundry USA" and by[BECH]["url"] == "https://pool.example"
    assert info["pools"] == 3 and info["poolsWithAddresses"] == 2 and info["read"] == 3, "a pool with only coinbase tags names no address"


def test_addresses_that_cannot_be_used_are_counted_and_left_out():
    bad = LEGACY[:-1] + ("a" if LEGACY[-1] != "a" else "b")
    pack, info = mp.convert(data_of([pool("A", [LEGACY, bad] + TESTNET), pool("B", [LEGACY, P2SH]), pool("   ", [BECH]), pool("C", ["bogus", 5, None])]), COMMIT)
    assert sorted(e["address"] for e in pack["labels"]) == sorted([LEGACY, P2SH])
    assert info["skipped"] == {"invalid": 4, "duplicate": 1, "otherNetwork": 3, "noName": 1}
    assert next(e for e in pack["labels"] if e["address"] == LEGACY)["label"] == "Mining pool: A", "the first pool to name an address keeps it"


@pytest.mark.parametrize("link,kept", [("https://ok.example/a?b=1", True), ("http://ok.example", True), ("pool.example.org", False), ("", False), ("javascript:alert(1)", False),
                                       ("https://x.example/" + "a" * 400, False), ("https://bad.example/<script>", False), (None, False), (5, False)])
def test_only_a_plain_web_link_is_kept(link, kept):
    pack, _ = mp.convert(data_of([pool("A", [LEGACY], link)]), COMMIT)
    assert ("url" in pack["labels"][0]) is kept


def test_hostile_text_in_a_pool_name_is_cleaned_and_capped():
    pack, _ = mp.convert(data_of([pool("Evil" + chr(10) + chr(0x202e) + "gnp.exe " + "x" * 300, [LEGACY])]), COMMIT)
    label = pack["labels"][0]["label"]
    assert chr(10) not in label and chr(0x202e) not in label and label.startswith("Mining pool: Evil ") and len(label) <= 120


def test_the_licence_and_the_commit_are_stated_only_for_data_that_came_with_them():
    pack, info = mp.convert(data_of([pool("A", [LEGACY])]), COMMIT)
    assert info["official"] is True and pack["licence"] == "MIT" and pack["asOf"] == "2026-09-24" and pack["licenceText"] == LICENCE_TEXT
    assert "commit aaaaaaa (2026-09-24)" in pack["source"] and "btc.com" in pack["attribution"] and pack["sourceUrl"] == "https://github.com/mempool/mining-pools"
    other, info2 = mp.convert(data_of([pool("A", [LEGACY])]))
    assert info2["official"] is False and "licence" not in other and "asOf" not in other and "licenceText" not in other and "a file you supplied" in other["source"]


@pytest.mark.parametrize("data", [b"", b"<html></html>", b"{}", b"[]", b"[1, 2]", b'[{"name": "A"}]', b"\xff\xfe"])
def test_anything_that_is_not_the_list_is_refused_with_advice(data):
    with pytest.raises(mp.ListError) as e:
        mp.convert(data)
    assert "pools-v2.json" in str(e.value) or "larger" in str(e.value)


# ---- the download ----------------------------------------------------------------------------------------------------------
class Web:
    """A stand-in for http_get: what each address answers, and which ones were asked with the token."""
    def __init__(self, files):
        self.files, self.asked = files, []

    def __call__(self, url, token=False, timeout=60, limit=0):
        self.asked.append((url, token))
        if url not in self.files:
            raise OSError("404 " + url)
        v = self.files[url]
        return v if isinstance(v, bytes) else json.dumps(v).encode("utf-8")


def files(sha="b" * 40, date="2026-09-24T04:24:21Z", licence=None, pools=None):
    base = mp.RAW % (sha, "%s")
    return {mp.API_COMMIT: {"sha": sha, "commit": {"committer": {"date": date}}}, base % "pools-v2.json": data_of(pools or [pool("A", [LEGACY])]), base % "LICENSE": licence if licence is not None else REAL_LICENCE}


REAL_LICENCE = None


def known_licence(monkeypatch):
    """The licence text hashed as the tool pins it: the test needs bytes with that hash, so it pins the hash of its own text."""
    global REAL_LICENCE
    REAL_LICENCE = LICENCE_TEXT.encode("utf-8")
    monkeypatch.setattr(mp, "LICENSE_SHA256", hashlib.sha256(REAL_LICENCE).hexdigest())


def test_a_download_gets_the_commit_first_then_the_files_of_that_commit_and_sends_the_token_only_to_the_api(monkeypatch):
    known_licence(monkeypatch)
    web = Web(files())
    monkeypatch.setattr(mp, "http_get", web)
    data, commit = mp.fetch()
    assert commit == {"sha": "b" * 40, "date": "2026-09-24", "licence_text": LICENCE_TEXT} and json.loads(data)[0]["name"] == "A"
    assert web.asked[0] == (mp.API_COMMIT, True) and all(token is False for _, token in web.asked[1:]), "the token goes to api.github.com and nowhere else"
    assert all(url.startswith("https://raw.githubusercontent.com/mempool/mining-pools/" + "b" * 40 + "/") for url, _ in web.asked[1:]), "both files are from the commit that was read"


def test_a_licence_text_that_has_changed_stops_the_download(monkeypatch):
    known_licence(monkeypatch)
    monkeypatch.setattr(mp, "http_get", Web(files(licence=b"Some other licence" + bytes([10]))))
    with pytest.raises(mp.ListError) as e:
        mp.fetch()
    assert "no longer the one this script was written against" in str(e.value) and "LICENSE_SHA256" in str(e.value)


@pytest.mark.parametrize("meta", [{"sha": "nothex", "commit": {"committer": {"date": "2026-09-24T00:00:00Z"}}}, {"sha": "b" * 40, "commit": {"committer": {"date": "yesterday"}}}, {"sha": "b" * 40}, [], "x"])
def test_a_reply_about_the_commit_that_is_not_understood_is_refused(monkeypatch, meta):
    known_licence(monkeypatch)
    f = files(); f[mp.API_COMMIT] = meta
    monkeypatch.setattr(mp, "http_get", Web(f))
    with pytest.raises(mp.ListError) as e:
        mp.fetch()
    assert "Could not download the mining pools list" in str(e.value)


def test_a_download_that_fails_says_so_and_how_to_go_on(monkeypatch):
    monkeypatch.setattr(mp, "http_get", Web({}))
    with pytest.raises(mp.ListError) as e:
        mp.fetch()
    assert "use --file" in str(e.value)


def test_the_request_with_the_token_never_follows_a_redirect():
    assert mp.NoRedirect().redirect_request(None, None, 301, "Moved", {}, "https://elsewhere.example/") is None


# ---- the pack file and build_packs -------------------------------------------------------------------------------------------
def test_the_pack_file_starts_with_the_licence_text_and_the_data_is_still_one_wallet_per_line(tmp_path, monkeypatch):
    known_licence(monkeypatch)
    monkeypatch.setattr(mp, "http_get", Web(files(pools=[pool("AntPool", [LEGACY, P2SH]), pool("Foundry USA", [BECH])])))
    monkeypatch.setattr(mp, "LICENSE_SHA256", hashlib.sha256(REAL_LICENCE).hexdigest())
    pack_id, pack, default_on = bp.build_miningpools(None)
    assert (pack_id, default_on) == ("mining-pools", False)
    entry, changed, diff = bp.add_pack(str(tmp_path), pack_id, pack, default_on)
    text = (tmp_path / "mining-pools.js").read_text(encoding="utf-8")
    assert text.index("The data below is under this licence") < text.index("Copyright (c) 2019 btc.com") < text.index("(window.HOPLINE_PACKS")
    assert "licenceText" not in text.split("(window.HOPLINE_PACKS", 1)[1], "the licence text is a comment, not data the page loads"
    assert len([ln for ln in text.splitlines() if ln.startswith('{"address"')]) == 3 and entry["licence"] == "MIT" and entry["defaultOn"] is False and len(diff["added"]) == 3


def test_a_licence_text_cannot_close_the_comment_it_is_in(tmp_path):
    pack, _ = mp.convert(data_of([pool("A", [LEGACY])]), dict(COMMIT, licence_text="MIT */ window.pwned = 1; /*" + chr(10)))
    text = bp.pack_text("mining-pools", pack)
    assert text.count("*/") == 2, "only the two comments of the tool close a comment"
    assert "window.pwned" in text.split("(window.HOPLINE_PACKS", 1)[0] and "window.pwned" not in text.split("(window.HOPLINE_PACKS", 1)[1]


def test_build_packs_refuses_a_list_where_many_addresses_are_unusable(monkeypatch):
    known_licence(monkeypatch)
    bad = LEGACY[:-1] + ("a" if LEGACY[-1] != "a" else "b")
    monkeypatch.setattr(mp, "http_get", Web(files(pools=[pool("A", [LEGACY] + [bad[:-2] + "%02d" % i for i in range(5)])])))
    with pytest.raises(bp.BuildError) as e:
        bp.build_miningpools(None)
    assert "could not be used" in str(e.value)


def test_the_cli_writes_a_pack_from_a_file_and_says_it_states_no_licence(tmp_path):
    src, out = tmp_path / "pools-v2.json", tmp_path / "pack.json"
    src.write_bytes(data_of([pool("A", [LEGACY] + TESTNET)]))
    r = subprocess.run([sys.executable, "-I", str(ROOT / "tools" / "make_label_pack_miningpools.py"), "--file", str(src), "--out", str(out)], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0 and "Wrote 1 addresses of 1 pools (left out: 0 failed the checksum, 3 testnet, 0 repeated)" in r.stdout, r.stderr
    assert "does not state a licence" in r.stderr and json.loads(out.read_text(encoding="utf-8"))["format"] == "hopline-labels"
    bad = subprocess.run([sys.executable, "-I", str(ROOT / "tools" / "make_label_pack_miningpools.py"), "--file", str(tmp_path / "missing.json"), "--out", str(out)], capture_output=True, text=True, timeout=60)
    assert bad.returncode != 0


def test_the_shipped_pack_is_what_the_tool_writes_today_in_form(tmp_path):
    """The committed file has the licence comment first, one wallet per line, mainnet addresses only, and the MIT notice the licence asks for."""
    text = (ROOT / "public" / "packs" / "mining-pools.js").read_text(encoding="utf-8")
    assert "Copyright (c) 2019 btc.com" in text.split("(window.HOPLINE_PACKS", 1)[0]
    addresses = [json.loads(ln.rstrip(","))["address"] for ln in text.splitlines() if ln.startswith('{"address"')]
    assert len(addresses) > 150 and all(mp.address_ok(a) for a in addresses) and len(set(addresses)) == len(addresses)
