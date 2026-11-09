#!/usr/bin/env python3
"""Drive a Bitcoin Core wallet through the real-wallet benchmark plan (tier B, docs/benchmark-wallets.md), and write the config the case tool reads.

Core makes every transaction itself (its own coin selection and its own change), which is the thing being measured. This script only chooses
amounts and who is paid, in a fixed order, and notes the ids of the batches and consolidations. It never reads or prints a private key.

    python drive_core.py --unit sats odd 12 --to buddy     the same, scaled down to satoshis (for a wallet holding a few thousand)
    python drive_core.py info
    python drive_core.py odd 12 --to buddy          odd amounts (0.00123, 0.00457, ...) to the wallet 'buddy', every address type in turn
    python drive_core.py round 8 --to payee         round amounts (0.001, 0.002, 0.005, 0.01)
    python drive_core.py big 4 --to payee           an amount larger than any single coin the wallet holds (needs several coins)
    python drive_core.py batch 2 --recipients 7     one transaction paying 7 addresses of 'payee'
    python drive_core.py sweep --to payee           send everything (a consolidation when the wallet holds 5 coins or more)
    python drive_core.py refill buddy payee         send what the other wallets hold back to the wallet under test (one faucet claim, many rounds)
    python drive_core.py config --name signet-core-1 --network signet --receive sh-wpkh --change wpkh --software "Bitcoin Core 31.1, addresstype=p2sh-segwit, changetype=bech32"

Where Core runs: by default in a Docker container named hb-core, started with -addresstype and -changetype (see the notes that came with this file).
Use --cli "bitcoin-cli -signet" for a Core on this machine instead, and --dry-run to see the commands without sending anything.
The wallets are named by --wallet (the one under test), --buddy and --payee (two other wallets of the same node that receive the payments).
Recipients cycle through legacy, p2sh-segwit, bech32 and bech32m addresses, so the payments are not all of one type.
"""
import argparse
import json
import pathlib
import shlex
import subprocess
import sys

TYPES = ["legacy", "p2sh-segwit", "bech32", "bech32m"]
ODD = [0.00123, 0.00457, 0.00891, 0.00234, 0.00678, 0.00345, 0.00912, 0.00566, 0.00781, 0.00419]
ROUND = [0.001, 0.002, 0.005, 0.01]
# The same plan in satoshis, for a wallet that holds a few thousand of them (--unit sats). Every amount is above the dust limit of every address type
# (546 satoshis for legacy), so each payment can be made to each type, and the "round" ones are multiples of 10,000 satoshis, which is what the change
# guess calls round. The odd ones are not round to any degree the analysis counts.
ODD_SATS = [613, 1457, 891, 734, 2068, 1345, 912, 1566, 781, 1419, 1103, 677]
ROUND_SATS = [10000, 20000]
PREFIX = {"pkh": "pkh(", "sh-wpkh": "sh(wpkh(", "wpkh": "wpkh(", "tr": "tr("}


class Core:
    def __init__(self, cli, wallet, dry):
        self.cli, self.wallet, self.dry = shlex.split(cli), wallet, dry

    def call(self, *args, wallet=None, mutate=False):
        cmd = self.cli + ["-rpcwallet=" + (wallet or self.wallet)] + [str(a) for a in args]
        if self.dry and mutate:
            print("  would run:", " ".join(shlex.quote(c) for c in cmd[len(self.cli):]))
            return "0" * 64
        out = subprocess.run(cmd, capture_output=True, text=True)
        if out.returncode != 0:
            raise RuntimeError((out.stderr or out.stdout).strip())
        text = out.stdout.strip()
        if text[:1] in "{[":
            return json.loads(text)
        return text                                                  # a transaction id or an address: kept as text, whatever it looks like


def address(core, wallet, i):
    return core.call("getnewaddress", "", TYPES[i % len(TYPES)], wallet=wallet)


def coins(core):
    return core.call("listunspent", 0)


def info(core, a):
    c = coins(core)
    bal = core.call("getbalances")["mine"]
    print("wallet %s: %d coins, largest %s" % (core.wallet, len(c), max([x["amount"] for x in c], default=0)))
    print("  balances (BTC): " + ", ".join("%s %s" % (name, amount) for name, amount in sorted(bal.items())))
    unconf = [x for x in c if x["confirmations"] == 0]
    if unconf:
        print("  %d coins are not confirmed yet" % len(unconf))
    kinds = load_kinds(a)
    print("kinds noted so far: %d (%s)" % (len(kinds), a.kinds))


def load_kinds(a):
    p = pathlib.Path(a.kinds)
    return json.loads(p.read_text()) if p.exists() else {}


def note_kind(a, txid, kind):
    if a.dry_run:
        return
    k = load_kinds(a)
    k[txid] = kind
    pathlib.Path(a.kinds).write_text(json.dumps(k, indent=1))


def btc(amount, unit):
    """An amount as bitcoin-cli wants it (BTC, eight decimals): given in BTC, or in satoshis with --unit sats."""
    return "%.8f" % (amount / 1e8) if unit == "sats" else amount


def pay_many(core, a, amounts, to):
    done = 0
    for i in range(a.count):
        amt = amounts[(a.start + i) % len(amounts)]
        try:
            txid = core.call("sendtoaddress", address(core, to, a.start + i), btc(amt, a.unit), mutate=True)
        except RuntimeError as e:
            print("stopped after %d of %d: %s" % (done, a.count, e))
            print("fund the wallet, wait for the coins to confirm, and run this again with --start %d" % (a.start + done))
            return
        done += 1
        print("%3d  %s  %s %s -> %s" % (done, txid, amt, "sats" if a.unit == "sats" else "BTC", to))


def cmd_big(core, a):
    done = 0
    for i in range(a.count):
        c = coins(core)
        if len(c) < 2:
            print("stopped after %d: the wallet needs several coins to pay more than any one of them (it has %d)" % (done, len(c)))
            return
        amount = round(max(x["amount"] for x in c) * 1.1, 8)          # in BTC, as Core reports coins, whatever the unit
        try:
            txid = core.call("sendtoaddress", address(core, a.to, a.start + i), amount, mutate=True)
        except RuntimeError as e:
            print("stopped after %d of %d: %s" % (done, a.count, e))
            return
        done += 1
        print("%3d  %s  %s BTC (more than the largest coin) -> %s" % (done, txid, amount, a.to))


def cmd_batch(core, a):
    for n in range(a.count):
        pays = {}
        for k in range(a.recipients):
            pays[address(core, a.to, a.start + n * a.recipients + k)] = round((600 + (k + 1) * 70 + n * 10) / 1e8, 8) if a.unit == "sats" else round(0.001 + (k + 1) * 0.0007 + n * 0.0001, 8)
        try:
            txid = core.call("sendmany", "", json.dumps(pays), mutate=True)
        except RuntimeError as e:
            print("stopped after %d of %d: %s" % (n, a.count, e))
            return
        note_kind(a, txid, "batch")
        print("batch %s  %d recipients -> %s" % (txid, a.recipients, a.to))


def cmd_sweep(core, a):
    n = len([x for x in coins(core) if x["spendable"]])
    if n == 0:
        print("the wallet holds no coins")
        return
    try:
        res = core.call("sendall", json.dumps([address(core, a.to, a.start)]), mutate=True)
    except RuntimeError as e:
        print("could not send everything: %s" % e)
        return
    txid = res["txid"] if isinstance(res, dict) else res
    if n >= 5:
        note_kind(a, txid, "consolidation")
    print("send everything %s  %d coins -> %s%s" % (txid, n, a.to, "  (noted as a consolidation)" if n >= 5 else "  (fewer than 5 coins: not noted as a consolidation)"))


def cmd_refill(core, a):
    """Send everything the other wallets of this node hold back to the wallet under test, one coin each, so one faucet claim can be used many times.
    These sends are the other wallets' transactions, not the wallet under test's, so they are not scored and nothing is noted."""
    for src in a.sources:
        dest = core.call("getnewaddress", "", a.type, wallet=core.wallet)
        try:
            res = core.call("sendall", json.dumps([dest]), wallet=src, mutate=True)
        except RuntimeError as e:
            print("refill from %s: %s" % (src, e))
            continue
        print("refill from %s: %s -> %s (%s)" % (src, res["txid"] if isinstance(res, dict) else res, core.wallet, a.type))


def cmd_config(core, a):
    ds = core.call("listdescriptors")["descriptors"]
    if any(__import__("re").search(r"[\]\(,][xtyzuv]prv", d["desc"]) for d in ds):
        sys.exit("a private key is in that output: nothing was written")

    def pick(kind, internal):
        found = [d["desc"] for d in ds if d.get("active") and bool(d.get("internal")) == internal and d["desc"].startswith(PREFIX[kind])]
        if len(found) != 1:
            sys.exit("expected one active %s %s descriptor, found %d" % (kind, "change" if internal else "receive", len(found)))
        return found[0]
    cfg = {"name": a.name, "network": a.network,
           "wallets": {"core": {"software": a.software, "receive": pick(a.receive, False), "change": pick(a.change, True)}},
           "kinds": load_kinds(a)}
    pathlib.Path(a.out).write_text(json.dumps(cfg, indent=2))
    print("wrote %s: public descriptors only, %d batch/consolidation ids" % (a.out, len(cfg["kinds"])))
    print("next:  python tools/bench/make_wallet_case.py --config %s --out test/benchmark/cases/wallets-v1/%s" % (a.out, a.name))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--cli", default="docker exec -u bitcoin hb-core bitcoin-cli -signet", help="how to run bitcoin-cli (default: %(default)s)")
    ap.add_argument("--wallet", default="mixed")
    ap.add_argument("--kinds", default="kinds.json", help="where the ids of batches and consolidations are noted")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--unit", choices=["btc", "sats"], default="btc", help="the size of the amounts: the plan in bitcoin (default), or scaled down to satoshis for a wallet with a few thousand of them")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("info")
    for name, helptext in (("odd", "odd amounts"), ("round", "round amounts"), ("big", "more than the largest coin"), ("batch", "one payment to several addresses"), ("sweep", "send everything")):
        p = sub.add_parser(name, help=helptext)
        if name in ("odd", "round", "big", "batch"):
            p.add_argument("count", type=int)
        p.add_argument("--to", default="buddy" if name == "odd" else "payee")
        p.add_argument("--start", type=int, default=0, help="where in the cycle of amounts and address types to continue after a stop")
        if name == "batch":
            p.add_argument("--recipients", type=int, default=7)
    p = sub.add_parser("refill", help="send what the other wallets hold back to the wallet under test")
    p.add_argument("sources", nargs="+", help="the wallets to empty, e.g. buddy payee")
    p.add_argument("--type", default="p2sh-segwit", choices=TYPES, help="the address type of the wallet under test's coins (default: %(default)s)")
    p = sub.add_parser("config")
    p.add_argument("--name", required=True)
    p.add_argument("--network", required=True, choices=["testnet4", "signet"])
    p.add_argument("--receive", required=True, choices=list(PREFIX))
    p.add_argument("--change", required=True, choices=list(PREFIX))
    p.add_argument("--software", required=True)
    p.add_argument("--out", default="wallets-core.json")
    a = ap.parse_args(argv)
    core = Core(a.cli, a.wallet, a.dry_run)
    {"info": lambda: info(core, a), "odd": lambda: pay_many(core, a, ODD_SATS if a.unit == "sats" else ODD, a.to), "round": lambda: pay_many(core, a, ROUND_SATS if a.unit == "sats" else ROUND, a.to),
     "big": lambda: cmd_big(core, a), "batch": lambda: cmd_batch(core, a), "sweep": lambda: cmd_sweep(core, a), "refill": lambda: cmd_refill(core, a), "config": lambda: cmd_config(core, a)}[a.cmd]()


if __name__ == "__main__":
    main()
