"""tools/bench/make_regtest.py: what can be checked without Docker: how a Bitcoin Core transaction becomes an Esplora one, the options, and that the scenarios are documented."""
import gzip
import json
import pathlib
import re
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "bench"))
import make_regtest as mr  # noqa: E402


class FakeNode:
    """A node that answers getrawtransaction and getblockheader from a canned transaction."""
    version = "/Satoshi:test/"

    def __init__(self):
        self.asked = []

    def call(self, method, params=None, wallet=None):
        self.asked.append(method)
        if method == "getrawtransaction":
            return {"txid": "ab" * 32, "version": 2, "locktime": 102, "size": 245, "vsize": 164, "weight": 653, "fee": 1.476e-05, "blockhash": "cd" * 32,
                    "vin": [{"txid": "ef" * 32, "vout": 1, "sequence": 4294967293, "scriptSig": {"hex": "1600"}, "txinwitness": ["30", "02"],
                             "prevout": {"value": 1.0, "scriptPubKey": {"asm": "OP_HASH160 aa OP_EQUAL", "hex": "a914aa87", "address": "2Mxxx", "type": "scripthash"}}}],
                    "vout": [{"value": 0.79998524, "n": 0, "scriptPubKey": {"asm": "0 aa", "hex": "0014aa", "address": "bcrt1qxxx", "type": "witness_v0_keyhash"}},
                             {"value": 0.2, "n": 1, "scriptPubKey": {"asm": "OP_RETURN 00", "hex": "6a0100", "type": "nulldata"}}]}
        if method == "getblockheader":
            return {"height": 103, "time": 1793005533}
        raise AssertionError(method)


def test_a_core_transaction_becomes_an_esplora_one_in_satoshis_with_the_script_types_renamed():
    node, heights = FakeNode(), {}
    t = mr.esplora(node, "ab" * 32, heights)
    assert t["fee"] == 1476 and t["vout"][0]["value"] == 79998524 and t["vin"][0]["prevout"]["value"] == 100000000, "BTC floats become whole satoshis"
    assert t["vin"][0]["prevout"]["scriptpubkey_type"] == "p2sh" and t["vout"][0]["scriptpubkey_type"] == "v0_p2wpkh" and t["vout"][1]["scriptpubkey_type"] == "op_return"
    assert "scriptpubkey_address" not in t["vout"][1], "a data output has no address"
    assert t["status"] == {"confirmed": True, "block_height": 103, "block_hash": "cd" * 32, "block_time": 1793005533}
    assert t["vin"][0]["sequence"] == 4294967293 and t["vin"][0]["is_coinbase"] is False and t["vin"][0]["witness"] == ["30", "02"]
    assert t["locktime"] == 102 and t["weight"] == 653 and t["version"] == 2
    mr.esplora(node, "ab" * 32, heights)
    assert node.asked.count("getblockheader") == 1, "a block is asked about once"


def test_amounts_go_back_and_forth_between_satoshis_and_bitcoin_without_drift():
    for v in (1, 546, 79998524, 100000000, 2099999997690000):
        assert mr.sat(mr.btc(v)) == v


def test_a_wallet_pays_round_amounts_in_proportion_to_its_habit_and_never_more_than_it_may():
    import random
    rng = random.Random(1)

    class W(mr.Wallet):
        def __init__(self, p):
            self.b = {"round_payments": p}
    always, never = W(1.0), W(0.0)
    rounds = [always.amount(rng, 10 ** 9) for _ in range(200)]
    assert all(r in [mr.sat(x) for x in mr.ROUND_BTC] for r in rounds)
    odd = [never.amount(rng, 10 ** 9) for _ in range(200)]
    assert all(a <= 6000000 for a in odd) and all(always.amount(rng, 150000) <= 150000 for _ in range(50))


def test_every_scenario_is_in_the_document_with_what_it_tests_and_the_script_has_the_same_six():
    doc = (ROOT / "docs" / "benchmark.md").read_text(encoding="utf-8")
    assert set(mr.SCENARIOS) == set(mr.SUMMARY) == {"payments", "peel-chains", "batch-consolidation", "coinjoins", "payjoin", "sweeps"}
    for name in mr.SCENARIOS:
        assert "`%s`" % name in doc, name + " is not in docs/benchmark.md"


def test_an_unknown_scenario_is_refused_before_anything_is_started(capsys, monkeypatch):
    started = []
    monkeypatch.setattr(mr, "Node", lambda image: started.append(image))
    with pytest.raises(SystemExit) as e:
        mr.main(["--out", "x", "--scenarios", "payments,nothing"])
    assert e.value.code == 2 and not started and "no such scenario: nothing" in capsys.readouterr().err


def test_the_committed_cases_were_made_by_this_script_and_say_what_node_and_seed():
    cases = ROOT / "test" / "benchmark" / "cases" / "regtest-v1"
    folders = sorted(p for p in cases.iterdir() if p.is_dir()) if cases.exists() else []
    if not folders:
        pytest.skip("no committed cases yet")
    assert {p.name for p in folders} == set(mr.SCENARIOS)
    for p in folders:
        meta = json.loads((p / "case.json").read_text(encoding="utf-8"))
        assert meta["generator"] == "tools/bench/make_regtest.py" and meta["tier"] == "A" and meta["name"] == p.name and meta["seed"] and re.match(r"/Satoshi:", meta["node"]) and meta["image"].startswith("bitcoin/bitcoin@sha256:")
        txs = json.loads(gzip.decompress((p / "txs.json.gz").read_bytes()))
        assert len(txs) == meta["transactions"] and all("vin" in t and "vout" in t for t in txs)
        truth = json.loads((p / "truth.json").read_text(encoding="utf-8"))
        assert truth["schema"] == 1 and set(truth["txs"]) == {t["txid"] for t in txs}
