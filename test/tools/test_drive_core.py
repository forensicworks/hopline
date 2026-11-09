"""tools/bench/drive_core.py: the amounts, the unit conversion, and the refusal to write a private key."""
import argparse
import importlib.util
import json
import pathlib

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "tools" / "bench" / (name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


dc = load("drive_core")


def test_satoshi_amounts_are_written_as_bitcoin_with_eight_decimals():
    assert dc.btc(613, "sats") == "0.00000613"
    assert dc.btc(10000, "sats") == "0.00010000"
    assert dc.btc(0.00123, "btc") == 0.00123, "in bitcoin the amount is passed through"


def test_the_scaled_down_plan_pays_every_address_type_and_keeps_round_and_odd_apart():
    DUST = 546                                                    # the largest dust limit of the address types the recipients cycle through (legacy)
    assert all(a > DUST for a in dc.ODD_SATS), "each odd payment can be made to a legacy address"
    assert all(a % 10000 for a in dc.ODD_SATS), "an odd amount has fewer than four trailing zeros, so the round-amount sign does not count it"
    assert all(a % 10000 == 0 for a in dc.ROUND_SATS), "a round amount has four trailing zeros or more"
    assert len(set(dc.ODD_SATS)) == len(dc.ODD_SATS)
    assert dc.TYPES == ["legacy", "p2sh-segwit", "bech32", "bech32m"]


class FakeCore:
    def __init__(self, descriptors):
        self.descriptors = descriptors

    def call(self, *args, **kw):
        assert args == ("listdescriptors",), "only the public listing is ever asked for"
        return {"descriptors": self.descriptors}


def args(tmp_path):
    return argparse.Namespace(name="t", network="signet", receive="sh-wpkh", change="wpkh", software="Bitcoin Core", out=str(tmp_path / "w.json"), kinds=str(tmp_path / "k.json"), dry_run=False)


PUB = [{"desc": "sh(wpkh([a6d16868/49h/1h/0h]tpubDCbZ/0/*))#abc", "active": True, "internal": False},
       {"desc": "wpkh([a6d16868/84h/1h/0h]tpubDD3n/1/*)#def", "active": True, "internal": True}]


def test_the_config_holds_public_descriptors_and_the_noted_kinds(tmp_path):
    (tmp_path / "k.json").write_text(json.dumps({"ab" * 32: "batch"}))
    dc.cmd_config(FakeCore(PUB), args(tmp_path))
    cfg = json.loads((tmp_path / "w.json").read_text())
    assert cfg["wallets"]["core"]["receive"].startswith("sh(wpkh(") and cfg["wallets"]["core"]["change"].startswith("wpkh(")
    assert cfg["kinds"] == {"ab" * 32: "batch"}
    assert "prv" not in json.dumps(cfg)


def test_a_private_key_in_the_listing_stops_it_and_nothing_is_written(tmp_path):
    secret = PUB + [{"desc": "wpkh(tprv8ZgxMBicQKsPd/84h/1h/0h/0/*)#x", "active": False, "internal": False}]
    with pytest.raises(SystemExit):
        dc.cmd_config(FakeCore(secret), args(tmp_path))
    assert not (tmp_path / "w.json").exists()
