"""tools/bench/make_wallet_case.py: what can be checked without Docker or a network: the descriptors, the refusal of private keys, how the truth of a transaction follows from the change chain, and the gap limit."""
import json
import pathlib
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "bench"))
import make_wallet_case as mw  # noqa: E402


def test_the_address_type_comes_from_the_descriptor():
    assert mw.descriptor_type("wpkh([abcd1234/84h/1h/0h]tpubD6/0/*)") == "bech32"
    assert mw.descriptor_type("sh(wpkh(tpubD6/0/*))") == "p2sh-segwit"
    assert mw.descriptor_type("pkh(tpubD6/0/*)") == "legacy"
    assert mw.descriptor_type("tr(tpubD6/0/*)") == "bech32m"
    assert mw.descriptor_type("wsh(sortedmulti(2,tpubA/0/*,tpubB/0/*))") == "other"


def test_a_multipath_descriptor_is_the_receive_chain_and_the_change_chain_and_a_checksum_is_dropped():
    assert mw.expand_multipath("wpkh(tpubD6/<0;1>/*)") == ["wpkh(tpubD6/0/*)", "wpkh(tpubD6/1/*)"]
    assert mw.expand_multipath("wpkh(tpubD6/0/*)") == ["wpkh(tpubD6/0/*)"]
    assert mw.chains_of({"descriptor": "wpkh(tpubD6/<0;1>/*)#abcdefgh"}) == ("wpkh(tpubD6/0/*)", "wpkh(tpubD6/1/*)")
    assert mw.chains_of({"receive": "wpkh(tpubD6/0/*)#abcdefgh", "change": "wpkh(tpubD6/1/*)"}) == ("wpkh(tpubD6/0/*)", "wpkh(tpubD6/1/*)")
    with pytest.raises(ValueError):
        mw.chains_of({"descriptor": "wpkh(tpubD6/0/*)"})            # one chain only: which is the change?
    with pytest.raises(ValueError):
        mw.chains_of({"receive": "wpkh(tpubD6/0/*)"})


def test_a_private_key_is_refused_and_a_public_one_is_not():
    xprv = "tprv8ZgxMBicQKsPd" + "a" * 90
    wif = "c" + "R" * 51
    for bad in (xprv, wif):
        with pytest.raises(ValueError):
            mw.check_public({"descriptor": "wpkh(%s/<0;1>/*)" % bad})
    mw.check_public({"descriptor": "wpkh([abcd1234/84h/1h/0h]tpubDCBWBScQPGv4Xk3JSbhw6NYoWjqgmgZDHL3z6KkLdCFo9bbWMv2EZ4v1ssDXYPbo9EHy59bQMgnCQHMRGvkJQ4Zz4GcnkMZ2nAyTGaY3Pk3/<0;1>/*)"})


def tx(n, ins, outs):
    """A transaction of the Esplora shape: ins = [(address, value)], outs = [(address, value)]."""
    return {"txid": ("%02x" % n) * 32, "version": 2, "locktime": 0, "size": 200, "weight": 800, "fee": 200, "status": {"confirmed": True, "block_height": 100 + n, "block_time": 1700000000 + n},
            "vin": [{"txid": ("%02x" % (200 + i)) * 32, "vout": 0, "is_coinbase": False, "sequence": 4294967293, "prevout": {"scriptpubkey_address": a, "scriptpubkey_type": "v0_p2wpkh", "value": v}} for i, (a, v) in enumerate(ins)],
            "vout": [{"scriptpubkey_address": a, "scriptpubkey_type": "v0_p2wpkh", "value": v} for a, v in outs]}


def wallets():
    def w(software, tag):
        return {"software": software, "address_type": "bech32", "change_type": "bech32", "receive": {"%sr%d" % (tag, i) for i in range(5)}, "change": {"%sc%d" % (tag, i) for i in range(5)}}
    return {"alice": w("Sparrow", "a"), "bob": w("Electrum", "b")}


def test_the_change_is_the_output_on_the_senders_change_chain_and_what_is_unclear_is_not_scored():
    ws = wallets()
    txs = [
        tx(1, [("faucet", 500000)], [("ar0", 400000), ("faucet2", 99000)]),                                  # paid in from outside: not alice's to score
        tx(2, [("ar0", 400000)], [("br0", 100000), ("ac0", 299000)]),                                        # alice pays bob, change on her change chain, last
        tx(3, [("ac0", 299000)], [("ac1", 150000), ("outsider", 148000)]),                                   # change first
        tx(4, [("ar1", 50000)], [("outsider", 49000)]),                                                      # no change at all
        tx(5, [("ar2", 80000)], [("ar3", 79000)]),                                                           # a payment to oneself: both outputs are alice's
        tx(6, [("ar4", 30000), ("br1", 30000)], [("outsider", 59000)]),                                      # inputs of two of our wallets
        tx(7, [("br2", 90000)], [("bc0", 20000), ("bc1", 69000)]),                                           # two outputs on the change chain
        tx(8, [("ar0", 1000), ("ar1", 1000), ("ar2", 1000), ("ar3", 1000), ("ar4", 1000)], [("ac2", 4000)])   # one output, on the change chain
    ]
    truth = mw.build_truth(ws, txs, {txs[7]["txid"]: "consolidation"})
    t = truth["txs"]
    assert t[txs[0]["txid"]] == {"kind": "incoming"}
    assert t[txs[1]["txid"]]["change_vout"] == 1 and t[txs[1]["txid"]]["wallet"] == "alice" and t[txs[1]["txid"]]["kind"] == "payment"
    assert t[txs[2]["txid"]]["change_vout"] == 0
    assert t[txs[3]["txid"]]["change_vout"] is None and "change_vout" in t[txs[3]["txid"]], "a transaction with no change is scored as having none"
    assert t[txs[4]["txid"]]["kind"] == "self-send" and "change_vout" not in t[txs[4]["txid"]]
    assert t[txs[5]["txid"]] == {"kind": "mixed"}
    assert t[txs[6]["txid"]]["kind"] == "unclear" and "change_vout" not in t[txs[6]["txid"]]
    assert t[txs[7]["txid"]]["kind"] == "consolidation" and t[txs[7]["txid"]]["inputs"] == 5
    assert set(truth["owners"]) == {"ar0", "ar1", "ar2", "ar3", "ar4", "br0", "br1", "br2", "ac0", "ac1", "ac2", "bc0", "bc1"}, "only addresses that appear, and 'faucet' is nobody's"
    assert truth["owners"]["br0"] == "bob" and truth["schema"] == 1 and truth["known"] == [] and truth["chains"] == []


def test_the_habits_of_a_wallet_are_measured_from_what_it_did():
    ws = wallets()
    txs = [tx(10 + i, [("ar%d" % (i % 5), 1000000 + i)], [("outsider", 100000 * (i + 1)), ("ac%d" % (i % 5), 899000 + i)]) for i in range(6)]
    b = mw.build_truth(ws, txs)["wallets"]["alice"]["behaviour"]
    assert b == {"address_type": "bech32", "change_type": "bech32", "change_position": "last", "round_payments": 1.0}
    few = mw.build_truth(ws, txs[:2])["wallets"]["alice"]["behaviour"]
    assert few["change_position"] == "random", "two transactions are not a habit"


class FakeNode:
    def __init__(self):
        self.asked = []

    def call(self, method, params=None):
        self.asked.append(method)
        if method == "getdescriptorinfo":
            return {"descriptor": params[0] + "#abcd1234"}
        if method == "deriveaddresses":
            tag = "c" if "/1/" in params[0] else "r"
            return ["%s%d" % (tag, i) for i in range(params[1][0], params[1][1] + 1)]
        raise AssertionError(method)


class FakeApi:
    def __init__(self, used):
        self.used, self.requests = used, 0

    def get(self, path):
        self.requests += 1
        parts = path.strip("/").split("/")
        if parts[0] == "address" and len(parts) == 2:
            n = 1 if parts[1] in self.used else 0
            return {"chain_stats": {"tx_count": n}, "mempool_stats": {"tx_count": 0}}
        if parts[0] == "address" and parts[2] == "txs":
            return [{"txid": "ab" * 32, "status": {"confirmed": True}}]
        raise AssertionError(path)


def test_a_chain_is_walked_until_a_gap_of_unused_addresses_and_only_used_ones_are_read():
    node, api = FakeNode(), FakeApi({"r0", "r3"})
    seen, derived = mw.scan_chain(node, api, "wpkh(tpub/0/*)", gap=5, batch=4)
    assert set(seen) == {"r0", "r3"}
    assert derived[-1] == "r8", "five unused after r3 (r4 to r8), then it stops"
    assert api.requests == len(derived) + 2, "one stats request per address, and the transactions of the two used ones"


def test_a_config_with_a_private_key_or_an_unknown_network_is_refused_before_anything_is_started(tmp_path, monkeypatch, capsys):
    started = []
    monkeypatch.setattr(mw.mr, "Node", lambda *a, **k: started.append(a))
    cfg = tmp_path / "c.json"
    cfg.write_text(json.dumps({"network": "signet", "wallets": {"w": {"descriptor": "wpkh(tprv8ZgxMBicQKsPd" + "a" * 90 + "/<0;1>/*)"}}}), encoding="utf-8")
    assert mw.main(["--config", str(cfg), "--out", str(tmp_path / "o")]) == 2 and not started and "private key" in capsys.readouterr().err
    cfg.write_text(json.dumps({"network": "mainnet", "wallets": {}}), encoding="utf-8")
    assert mw.main(["--config", str(cfg), "--out", str(tmp_path / "o")]) == 2 and not started and "network must be" in capsys.readouterr().err
