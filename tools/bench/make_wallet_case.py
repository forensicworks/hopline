#!/usr/bin/env python3
"""Real wallets on a public test network, as a benchmark case (tier B of docs/benchmark.md).

You make transactions with real wallet software (Sparrow, Electrum, Bitcoin Core, a hardware wallet) on signet or testnet4, with coins from a
faucet, following docs/benchmark-wallets.md. This script takes the wallets' PUBLIC descriptors, derives their addresses with Bitcoin Core,
reads their transactions from an Esplora API, and writes a case folder in the format the harness reads. The truth is free: an output that
pays an address of the sender's change chain (the /1/ branch of the descriptor) is its change, and a wallet knows nothing else about it.

    python tools/bench/make_wallet_case.py --config wallets.json --out test/benchmark/cases/signet-v1/<name>

wallets.json:
    { "name": "signet-1", "network": "signet",
      "wallets": { "sparrow": { "software": "Sparrow 2.1", "descriptor": "wpkh([fp/84h/1h/0h]tpub.../<0;1>/*)" },
                   "electrum": { "software": "Electrum 4.5", "receive": "wpkh(tpub.../0/*)", "change": "wpkh(tpub.../1/*)" } },
      "kinds": { "<txid>": "consolidation" } }          optional: what you meant a transaction to be, where it was not an ordinary payment

Only public keys are read. A descriptor with a private key (xprv, tprv) is refused: nothing here needs one, and none should leave the wallet.
"""
import argparse
import gzip
import hashlib
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import fetch_mainnet_sample as fm  # noqa: E402
import make_regtest as mr  # noqa: E402

APIS = {"signet": "https://mempool.space/signet/api", "testnet4": "https://mempool.space/testnet4/api"}
PRIVATE = re.compile(r"\b[xtyzuv]prv[1-9A-HJ-NP-Za-km-z]{20,}|\b[5KL9c][1-9A-HJ-NP-Za-km-z]{50,51}\b")
ADDRESS_TYPES = (("sh(wpkh(", "p2sh-segwit"), ("wpkh(", "bech32"), ("pkh(", "legacy"), ("tr(", "bech32m"))


def descriptor_type(desc):
    """The address type of a single-key descriptor, in the words the harness uses; 'other' for anything with several keys or a script."""
    d = desc.strip()
    for prefix, name in ADDRESS_TYPES:
        if d.startswith(prefix):
            return name
    return "other"


def expand_multipath(desc):
    """A descriptor with <0;1> in it is two: the first is the receive chain, the second the change chain. Without it, there is only one."""
    m = re.search(r"<(\d+);(\d+)>", desc)
    if not m:
        return [desc]
    return [desc[:m.start()] + m.group(1) + desc[m.end():], desc[:m.start()] + m.group(2) + desc[m.end():]]


def chains_of(spec):
    """(receive, change) descriptors of a wallet in the config, without their checksums."""
    if "descriptor" in spec:
        both = [re.sub(r"#[a-z0-9]{8}$", "", d) for d in expand_multipath(spec["descriptor"].strip())]
        if len(both) != 2:
            raise ValueError("a 'descriptor' needs <0;1> in it; give 'receive' and 'change' instead")
        return both[0], both[1]
    if "receive" in spec and "change" in spec:
        return re.sub(r"#[a-z0-9]{8}$", "", spec["receive"].strip()), re.sub(r"#[a-z0-9]{8}$", "", spec["change"].strip())
    raise ValueError("a wallet needs a 'descriptor' with <0;1> in it, or a 'receive' and a 'change'")


def check_public(spec):
    for v in spec.values():
        if isinstance(v, str) and PRIVATE.search(v):
            raise ValueError("that looks like a private key: give the public descriptor (xpub/tpub) instead, and keep the private key to yourself")


def derive(node, descriptor, start, count):
    """Addresses start .. start+count-1 of a descriptor, by Bitcoin Core (which knows every address type and its encoding on the network)."""
    info = node.call("getdescriptorinfo", [descriptor])
    return node.call("deriveaddresses", [info["descriptor"], [start, start + count - 1]])


def scan_chain(node, api, descriptor, gap, batch=20, limit=400):
    """Walk a chain of addresses until `gap` in a row have no history. Returns ({address: [esplora transactions]}, every address derived)."""
    seen, derived, empty, start = {}, [], 0, 0
    while empty < gap and start < limit:
        for a in derive(node, descriptor, start, batch):
            derived.append(a)
            st = api.get("/address/" + a)
            used = st["chain_stats"]["tx_count"] + st["mempool_stats"]["tx_count"]
            if not used:
                empty += 1
                if empty >= gap:
                    break
                continue
            empty = 0
            seen[a] = address_txs(api, a)
        start += batch
    return seen, derived


def address_txs(api, address):
    """Every transaction of an address: the mempool and the first page of the chain, then the chain page by page."""
    out = list(api.get("/address/%s/txs" % address))
    confirmed = [t for t in out if t["status"]["confirmed"]]
    while len(confirmed) >= 25 and confirmed[-1]["txid"]:
        page = api.get("/address/%s/txs/chain/%s" % (address, confirmed[-1]["txid"]))
        if not page:
            break
        out.extend(page); confirmed = page
    return out


def measure_behaviour(name, w, tx_truth, by_id):
    """The habits a wallet showed, measured from what it did: where its change went in a transaction, and how round its payments were
    (the share of the amounts it paid that are a multiple of 0.001 BTC: what the harness calls 'mostly round' above one half)."""
    pos, rnd, pays = [], 0, 0
    for txid, t in tx_truth.items():
        if t.get("wallet") != name or t.get("kind") != "payment":
            continue
        outs = by_id[txid]["vout"]
        for i, o in enumerate(outs):
            if i != t.get("change_vout"):
                pays += 1
                if o["value"] % 100000 == 0:
                    rnd += 1
        if t.get("change_vout") is not None and len(outs) == 2:
            pos.append("first" if t["change_vout"] == 0 else "last")
    if len(pos) < 5 or (pos.count("last") / len(pos) < 0.8 and pos.count("first") / len(pos) < 0.8):
        position = "random"
    else:
        position = "last" if pos.count("last") > pos.count("first") else "first"
    return {"address_type": w["address_type"], "change_type": w["change_type"], "change_position": position, "round_payments": (rnd / pays) if pays else 0.0}


def build_truth(wallets, txs, kinds=None):
    """The truth of a list of transactions. wallets = {name: {software, address_type, change_type, receive: set, change: set}}.

    A transaction all of whose inputs are one of our wallets' is that wallet's: its change is the one output on the wallet's change chain (None
    when it has none). What is not clear is left out of the scoring: transactions that pay in from outside, spend from several of our wallets
    at once, pay the wallet's own receive chain (a payment to oneself makes both outputs its own), or have two change-chain outputs.
    """
    kinds = kinds or {}
    owner = {}
    for name, w in wallets.items():
        for a in set(w["receive"]) | set(w["change"]):
            owner[a] = name
    tx_truth, by_id = {}, {t["txid"]: t for t in txs}
    for t in txs:
        ins = [v["prevout"]["scriptpubkey_address"] for v in t["vin"] if not v.get("is_coinbase") and v.get("prevout")]
        senders = {owner.get(a) for a in ins}
        if senders == {None} or (not ins):
            tx_truth[t["txid"]] = {"kind": "incoming"}; continue
        if None in senders or len(senders) != 1:
            tx_truth[t["txid"]] = {"kind": "mixed"}; continue
        name = next(iter(senders))
        w = wallets[name]
        change = [i for i, o in enumerate(t["vout"]) if o.get("scriptpubkey_address") in w["change"]]
        to_self = any(o.get("scriptpubkey_address") in w["receive"] for o in t["vout"])
        entry = {"kind": kinds.get(t["txid"], "payment"), "wallet": name, "inputs": len(ins)}
        if len(change) > 1 or to_self:
            entry["kind"] = "self-send" if to_self else "unclear"
        else:
            entry["change_vout"] = change[0] if change else None
        tx_truth[t["txid"]] = entry
    out_wallets = {}
    for name, w in wallets.items():
        out_wallets[name] = {"software": w["software"], "behaviour": measure_behaviour(name, w, tx_truth, by_id), "service": False}
    appearing = {a for t in txs for a in [o.get("scriptpubkey_address") for o in t["vout"]] + [v["prevout"]["scriptpubkey_address"] for v in t["vin"] if v.get("prevout")] if a in owner}
    return {"schema": 1, "wallets": out_wallets, "owners": {a: owner[a] for a in sorted(appearing)}, "txs": tx_truth, "chains": [], "known": []}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--config", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--image", default=mr.IMAGE)
    ap.add_argument("--gap", type=int, default=20, help="stop a chain after this many addresses in a row with no history")
    ap.add_argument("--api", help="an Esplora API (the default is mempool.space for the network)")
    a = ap.parse_args(argv)
    cfg = json.loads(pathlib.Path(a.config).read_text(encoding="utf-8"))
    network = cfg.get("network", "signet")
    if network not in APIS:
        print("the network must be one of: " + ", ".join(sorted(APIS)), file=sys.stderr); return 2
    specs = cfg["wallets"]
    try:
        for s in specs.values():
            check_public(s); chains_of(s)
    except ValueError as e:
        print(str(e), file=sys.stderr); return 2
    api = fm.Api(a.api or APIS[network])
    node = mr.Node(a.image, network)
    try:
        wallets, txs = {}, {}
        for name, spec in specs.items():
            receive, change = chains_of(spec)
            r_seen, r_all = scan_chain(node, api, receive, a.gap)
            c_seen, c_all = scan_chain(node, api, change, a.gap)
            for lst in list(r_seen.values()) + list(c_seen.values()):
                for t in lst:
                    txs[t["txid"]] = fm.slim(t)
            wallets[name] = {"software": spec.get("software", "unknown"), "address_type": descriptor_type(receive), "change_type": descriptor_type(change), "receive": set(r_all), "change": set(c_all)}
            print("  %s: %d receive and %d change addresses derived, %d with history" % (name, len(r_all), len(c_all), len(r_seen) + len(c_seen)))
        ordered = sorted(txs.values(), key=lambda t: ((t["status"].get("block_height") or 10 ** 9), t["txid"]))
        truth = build_truth(wallets, ordered, cfg.get("kinds"))
        out = pathlib.Path(a.out); out.mkdir(parents=True, exist_ok=True)
        (out / "txs.json.gz").write_bytes(gzip.compress(json.dumps(ordered, separators=(",", ":"), sort_keys=True).encode("utf-8"), 9, mtime=0))
        (out / "truth.json").write_text(json.dumps(truth, separators=(",", ":"), sort_keys=True) + "\n", encoding="utf-8", newline="\n")
        digest = hashlib.sha256(json.dumps({n: chains_of(s) for n, s in sorted(specs.items())}, sort_keys=True).encode("utf-8")).hexdigest()
        meta = {"generator": "tools/bench/make_wallet_case.py", "tier": "B", "name": out.name, "network": network, "api": api.base, "node": node.version, "image": a.image,
                "descriptors_sha256": digest, "transactions": len(ordered), "wallets": len(wallets),
                "summary": cfg.get("summary", "real wallet software on %s; the change of each transaction is the output on its change chain" % network),
                "wallet_software": {n: w["software"] for n, w in wallets.items()}}
        (out / "case.json").write_text(json.dumps(meta, indent=1, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
        scored = sum(1 for t in truth["txs"].values() if "change_vout" in t)
        print("wrote %d transactions (%d with a known change answer), %d requests" % (len(ordered), scored, api.requests))
    finally:
        node.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
