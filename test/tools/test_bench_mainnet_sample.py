"""tools/bench/fetch_mainnet_sample.py: what can be checked without a network: what is left out of a transaction, how the blocks and pages are chosen from the seed, and what is written."""
import gzip
import json
import pathlib
import random
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "bench"))
import fetch_mainnet_sample as fm  # noqa: E402


def sample_tx(n, coinbase=False):
    vin = {"txid": "00" * 32 if coinbase else ("%02x" % n) * 32, "vout": 0, "is_coinbase": coinbase, "sequence": 4294967295, "scriptsig": "03abcdef", "scriptsig_asm": "OP_PUSH 03abcdef",
           "witness": [] if coinbase else ["3045", "02ab"], "inner_witnessscript_asm": "OP_1"}
    if not coinbase:
        vin["prevout"] = {"scriptpubkey": "0014aa", "scriptpubkey_asm": "OP_0 aa", "scriptpubkey_type": "v0_p2wpkh", "scriptpubkey_address": "bc1qaa", "value": 5000}
    return {"txid": ("%02x" % (100 + n)) * 32, "version": 2, "locktime": 0, "fee": 100, "status": {"confirmed": True, "block_height": 5, "block_time": 1700000000},
            "vin": [vin], "vout": [{"scriptpubkey": "0014bb", "scriptpubkey_asm": "OP_0 bb", "scriptpubkey_type": "v0_p2wpkh", "scriptpubkey_address": "bc1qbb", "value": 4900}]}


def test_the_assembly_text_and_the_signatures_are_left_out_but_a_coinbase_keeps_its_script_and_the_amounts_and_addresses_stay():
    t = fm.slim(sample_tx(1))
    v = t["vin"][0]
    assert "scriptsig" not in v and "witness" not in v and "scriptsig_asm" not in v and "inner_witnessscript_asm" not in v
    assert "scriptpubkey_asm" not in v["prevout"] and v["prevout"]["scriptpubkey"] == "0014aa" and v["prevout"]["value"] == 5000 and v["prevout"]["scriptpubkey_address"] == "bc1qaa"
    assert "scriptpubkey_asm" not in t["vout"][0] and t["vout"][0]["value"] == 4900 and v["sequence"] == 4294967295
    cb = fm.slim(sample_tx(2, coinbase=True))["vin"][0]
    assert cb["scriptsig"] == "03abcdef" and cb["witness"] == [], "the coinbase script names the miner"
    assert "scriptsig_asm" not in cb


def test_the_blocks_chosen_follow_the_seed_spread_over_the_years_and_the_last_is_recent():
    a = fm.choose_heights(random.Random(7), 973000, 8)
    assert a == fm.choose_heights(random.Random(7), 973000, 8) and a == sorted(a) and len(a) == 8
    for h, (lo, hi) in zip(a[:7], fm.ERAS):
        assert lo <= h <= hi
    assert a[7] >= 973000 - 40000 and a[7] <= 973000 - 100
    assert fm.choose_heights(random.Random(8), 973000, 8) != a
    assert len(fm.choose_heights(random.Random(7), 973000, 3)) == 3


class FakeApi:
    def __init__(self, base):
        self.base, self.requests = base, 0
        self.txs = [[sample_tx(p * 3 + i) for i in range(3)] for p in range(6)]          # six pages of three, standing in for pages of 25

    def get(self, path, text=False):
        self.requests += 1
        if path == "/blocks/tip/height":
            return "973000"
        if path.startswith("/block-height/"):
            return "ab" * 32
        if path == "/block/" + "ab" * 32:
            return {"id": "ab" * 32, "timestamp": 1700000000, "tx_count": 25 * 6}
        if path.startswith("/block/") and "/txs/" in path:
            return json.loads(json.dumps(self.txs[int(path.rsplit("/", 1)[1]) // 25]))
        raise AssertionError(path)


def test_a_sample_is_written_with_what_was_chosen_so_it_can_be_made_again(tmp_path, monkeypatch):
    monkeypatch.setattr(fm, "Api", FakeApi)
    monkeypatch.setattr(fm, "PAGE", 25)
    out = tmp_path / "sample"
    assert fm.main(["--out", str(out), "--heights", "230027,960004", "--pages", "2", "--seed", "5"]) == 0
    meta = json.loads((out / "case.json").read_text(encoding="utf-8"))
    txs = json.loads(gzip.decompress((out / "txs.json.gz").read_bytes()))
    assert meta["generator"] == "tools/bench/fetch_mainnet_sample.py" and meta["tier"] == "D" and meta["seed"] == 5 and meta["tip_when_chosen"] == 973000
    assert [b["height"] for b in meta["blocks"]] == [230027, 960004] and all(len(b["pages"]) == 2 and b["transactions"] == 6 for b in meta["blocks"])
    assert "witness" in meta["fields_removed"] and meta["transactions"] == len(txs)
    assert all("witness" not in v and "scriptsig_asm" not in v for t in txs for v in t["vin"]), "stored without them"
    first = (out / "txs.json.gz").read_bytes()
    out2 = tmp_path / "again"
    assert fm.main(["--out", str(out2), "--heights", "230027,960004", "--pages", "2", "--seed", "5"]) == 0
    assert (out2 / "txs.json.gz").read_bytes() == first, "the same blocks and seed give the same bytes"
