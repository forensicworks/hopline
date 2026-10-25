"""tools/make_label_pack_ransomwhere.py: the Ransomwhere export becomes a label pack that Hopline's importer accepts."""
import hashlib
import io
import json
import pathlib
import re
import shutil
import subprocess
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
import build_packs as bp  # noqa: E402
import make_label_pack_ransomwhere as rw  # noqa: E402

LEGACY, P2SH = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT", "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy"
BECH, TAPROOT = "bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h", "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0"
ETH = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"


def row(address, family="Locky", txs=(), chain="bitcoin", created="2024-10-27T19:06:11.403Z", updated=None):
    return {"address": address, "balance": 0, "blockchain": chain, "createdAt": created, "updatedAt": updated or created, "family": family, "balanceUSD": 0,
            "transactions": [{"hash": "ab" * 32, "time": t, "amount": a, "amountUSD": 1.0} for t, a in txs]}


def data_of(rows, wrap=False):
    return json.dumps({"result": rows} if wrap else rows).encode("utf-8")


def test_each_address_is_labelled_with_its_family_and_a_note_about_the_payments_it_received():
    pack, info = rw.convert(data_of([row(LEGACY, "Netwalker (Mailto)", [(1587839053, 43577930), (1587165185, 83108418)]), row(BECH, "Conti", [(1650000000, 150000000)]), row(P2SH, "Locky")]))
    by = {e["address"]: e for e in pack["labels"]}
    assert by[LEGACY] == {"address": LEGACY, "label": "Ransomware: Netwalker (Mailto)", "category": "RANSOM", "note": "2 payments, 2020-04-17 to 2020-04-25, 1.26686348 BTC in all"}
    assert by[BECH]["note"] == "1 payment, 2022-04-15, 1.5 BTC in all", "one day is one date, and trailing zeros are dropped"
    assert by[P2SH]["note"] == "No payment recorded in the dataset"
    assert info["read"] == 3 and info["skipped"] == {"invalid": 0, "otherChain": 0, "duplicate": 0}


@pytest.mark.parametrize("family", ["Unlabeled", "unlabeled", "", "Unknown", None])
def test_a_payment_address_with_no_known_family_says_so(family):
    pack, _ = rw.convert(data_of([row(LEGACY, family)]))
    assert pack["labels"][0]["label"] == "Ransomware (family not known)"


def test_rows_that_cannot_be_used_are_counted_and_left_out():
    bad = LEGACY[:-1] + ("a" if LEGACY[-1] != "a" else "b")
    rows = [row(LEGACY), row(LEGACY, "Other"), row(bad), row(ETH, chain="ethereum"), row(BECH[:-1] + "q"), row(TAPROOT[:-2] + "qq"),
            {"address": 5, "blockchain": "bitcoin", "family": "x", "transactions": []}, row(P2SH)]
    pack, info = rw.convert(data_of(rows))
    assert sorted(e["address"] for e in pack["labels"]) == sorted([LEGACY, P2SH]), "a typo is not carried into the pack"
    assert info["skipped"] == {"invalid": 4, "otherChain": 1, "duplicate": 1} and info["read"] == 2 and info["rows"] == 8
    assert next(e for e in pack["labels"] if e["address"] == LEGACY)["label"] == "Ransomware: Locky", "the first row for an address is kept"


def test_the_live_api_shape_and_the_zenodo_shape_are_both_read():
    a, _ = rw.convert(data_of([row(LEGACY)], wrap=True)); b, _ = rw.convert(data_of([row(LEGACY)]))
    assert a["labels"] == b["labels"]


@pytest.mark.parametrize("data", [b"", b"<html></html>", b"{}", b'{"result": 5}', b"[]", b'[1, 2]', b'[{"a": 1}]', b"\xff\xfe"])
def test_anything_that_is_not_an_export_is_refused_with_advice(data):
    with pytest.raises(rw.ListError) as e:
        rw.convert(data)
    assert "ransomwhere.json" in str(e.value) or "larger" in str(e.value)


def test_hostile_text_in_a_family_is_cleaned_and_capped():
    pack, _ = rw.convert(data_of([row(LEGACY, "Evil\n‮gnp.exe " + "x" * 300)]))
    label = pack["labels"][0]["label"]
    assert "\n" not in label and "‮" not in label and len(label) <= 120 and label.startswith("Ransomware: Evil ")


def test_the_date_of_the_data_is_the_newest_record_in_it():
    pack, info = rw.convert(data_of([row(LEGACY, created="2021-07-08T06:43:08.978Z", updated="2021-09-22T20:53:57.424Z"), row(P2SH, created="2024-10-27T19:06:11.403Z")]))
    assert pack["asOf"] == info["asOf"] == "2024-10-27"
    nodates = row(LEGACY); nodates.pop("createdAt"); nodates.pop("updatedAt")
    assert "asOf" not in rw.convert(data_of([nodates]))[0]


def test_the_licence_is_stated_only_for_the_release_it_belongs_to(monkeypatch):
    data = data_of([row(LEGACY)])
    other, info = rw.convert(data)
    assert info["official"] is False and "licence" not in other and "version 1.1.0" not in other["source"] and other["attribution"].startswith("Ransomwhere")
    monkeypatch.setitem(rw.RELEASE, "md5", hashlib.md5(data).hexdigest())
    pack, info = rw.convert(data)
    assert info["official"] is True and pack["licence"] == "CC BY 4.0" and pack["sourceUrl"] == "https://zenodo.org/records/13999026"
    assert "Jack Cable" in pack["attribution"] and "10.5281/zenodo.13999026" in pack["attribution"] and "version 1.1.0" in pack["source"]


def test_a_download_that_is_not_the_pinned_release_is_refused(monkeypatch):
    class Reply(io.BytesIO):
        def __enter__(self): return self
        def __exit__(self, *a): return False
    monkeypatch.setattr(rw.urllib.request, "urlopen", lambda url, timeout=0: Reply(b"[]"))
    with pytest.raises(rw.ListError) as e:
        rw.download()
    assert "not the release" in str(e.value) and "MD5" in str(e.value)


def test_the_cli_writes_a_pack_and_says_what_it_left_out(tmp_path):
    src, out = tmp_path / "ransomwhere.json", tmp_path / "pack.json"
    src.write_bytes(data_of([row(LEGACY), row(ETH, chain="ethereum")]))
    r = subprocess.run([sys.executable, "-I", str(ROOT / "tools" / "make_label_pack_ransomwhere.py"), "--file", str(src), "--out", str(out)], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0 and "Wrote 1 Bitcoin addresses (of 2 rows; left out: 0 failed the checksum, 1 on other chains, 0 repeated)" in r.stdout, r.stderr
    assert "does not state its licence" in r.stderr and json.loads(out.read_text(encoding="utf-8"))["format"] == "hopline-labels"
    bad = subprocess.run([sys.executable, "-I", str(ROOT / "tools" / "make_label_pack_ransomwhere.py"), "--file", str(tmp_path / "missing.json"), "--out", str(out)], capture_output=True, text=True, timeout=60)
    assert bad.returncode != 0 and not (tmp_path / "missing.json").exists()


# ---- the address checks must agree with the page's -------------------------------------------------------------------------
@pytest.mark.skipif(shutil.which("node") is None, reason="node is not available")
def test_the_address_checks_agree_with_the_pages_on_real_and_damaged_addresses():
    text = (ROOT / "public" / "packs" / "ransomwhere.js").read_text(encoding="utf-8")
    real = re.findall(r'^\{"address":"([^"]+)"', text, re.M)
    assert len(real) > 5000
    pick = real[::7] + [BECH, TAPROOT, LEGACY, P2SH, "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "BC1QAR0SRRR7XFKVY5L643LYDNW9RE59GTZZWF5MDQ", "bc1q" + "q" * 38, "1" * 30, "3" + "A" * 33, "0" + LEGACY, ETH]
    damaged = []
    for a in pick[:600]:
        damaged += [a[:-1] + ("q" if a[-1] != "q" else "p"), a[:5] + ("p" if a[5] != "p" else "q") + a[6:], a[:-1]]
    cases = pick + damaged
    js = ("const A = require(process.argv[1]); const list = JSON.parse(require('fs').readFileSync(0, 'utf8'));"
          "console.log(JSON.stringify(list.map((a) => { const v = A.validate(A.normalise(a)); return v.ok && /^(bc1|[13])/.test(A.normalise(a)); })));")
    n = subprocess.run(["node", "-e", js, str(ROOT / "public" / "js" / "hopline-address.js")], input=json.dumps(cases), capture_output=True, text=True, timeout=120)
    assert n.returncode == 0, n.stderr
    page = json.loads(n.stdout)
    mine = [rw.address_ok(a) for a in cases]
    differ = [a for a, p, m in zip(cases, page, mine) if p != m]
    assert not differ, "the tool and the page disagree on: %s" % differ[:5]
    assert sum(mine[:len(pick)]) >= len(real[::7]), "every real address passes"


# ---- build_packs, with Ransomwhere -----------------------------------------------------------------------------------------
def test_build_packs_writes_ransomwhere_off_by_default_and_keeps_the_other_pack(tmp_path, monkeypatch, capsys):
    data = data_of([row(LEGACY, "Conti", [(1650000000, 150000000)]), row(P2SH, "Locky")])
    src = tmp_path / "ransomwhere.json"; src.write_bytes(data)
    out = tmp_path / "packs"
    monkeypatch.setitem(rw.RELEASE, "md5", hashlib.md5(data).hexdigest())
    bp.main(["--ransomwhere", str(src), "--out", str(out)])
    entries = bp.read_index(str(out / "index.js"))
    (e,) = entries
    assert (e["id"], e["entries"], e["defaultOn"], e["sanctions"], e["licence"]) == ("ransomwhere", 2, False, False, "CC BY 4.0") and e["asOf"] == "2024-10-27"
    text = (out / "ransomwhere.js").read_text(encoding="utf-8")
    assert '"licence":"CC BY 4.0"' in text and "created" not in text and e["version"] == hashlib.sha256(text.encode("utf-8")).hexdigest()[:10]
    ofac_entry = {"id": "ofac-sdn", "name": "O", "file": "ofac-sdn.js", "entries": 1, "source": "", "licence": "L", "attribution": "A", "asOf": "2026-01-01", "sourceUrl": "", "sanctions": True, "defaultOn": True, "version": "abc"}
    (out / "index.js").write_bytes(bp.index_text([ofac_entry] + entries).encode("utf-8"))        # bytes: no newline translation on Windows
    capsys.readouterr()
    bp.main(["--ransomwhere", str(src), "--out", str(out)])
    assert "unchanged" in capsys.readouterr().out and [x["id"] for x in bp.read_index(str(out / "index.js"))] == ["ofac-sdn", "ransomwhere"]


def test_build_packs_refuses_a_ransomwhere_file_that_is_not_the_pinned_release(tmp_path):
    src = tmp_path / "ransomwhere.json"; src.write_bytes(data_of([row(LEGACY)]))
    with pytest.raises(SystemExit) as e:
        bp.main(["--ransomwhere", str(src), "--out", str(tmp_path / "packs")])
    assert "not the Ransomwhere release 1.1.0" in str(e.value) and "RELEASE" in str(e.value) and not (tmp_path / "packs").exists()


def test_build_packs_refuses_a_file_where_many_rows_are_unusable(tmp_path, monkeypatch):
    rows = [row(LEGACY)] + [row(ETH, chain="ethereum") for _ in range(5)]
    src = tmp_path / "ransomwhere.json"; src.write_bytes(data_of(rows))
    monkeypatch.setitem(rw.RELEASE, "md5", hashlib.md5(data_of(rows)).hexdigest())
    with pytest.raises(SystemExit) as e:
        bp.main(["--ransomwhere", str(src), "--out", str(tmp_path / "packs")])
    assert "5 of the 6 Ransomwhere rows could not be used" in str(e.value) and not (tmp_path / "packs").exists()


def test_build_packs_needs_a_source_and_one_per_pack(tmp_path):
    for argv in ([], ["--ofac", "a", "--download"], ["--ransomwhere", "a", "--download-ransomwhere"]):
        with pytest.raises(SystemExit) as e:
            bp.main(argv + ["--out", str(tmp_path / "packs")])
        assert e.value.code == 2
    assert not (tmp_path / "packs").exists()
