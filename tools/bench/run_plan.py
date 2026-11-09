#!/usr/bin/env python3
"""Run rounds of the sats-scaled plan unattended on signet (or regtest, to rehearse): wait for confirmations, refill, make payments, report.

    python run_plan.py [--rounds 8] [--min-funds 4000] [--cli "docker exec -u bitcoin hb-core bitcoin-cli -signet"] [--mine "<command that mines one block>"]

Each round: wait until everything is confirmed, send what the other wallets hold back to the wallet under test (refill), wait again, then make as many
payments as the funds allow with drive_core.py (a round amount every third round, a batch in rounds 1 and 3, then odd amounts to buddy and to payee), and say how many
of them have a change output. It stops when the wallet under test holds less than --min-funds satoshis, or when fewer than 60% of a round's
transactions have change (then the settings, not the plan, need a look). The ids of everything it makes go to plan-txids.log.
"""
import argparse
import json
import re
import shlex
import subprocess
import sys
import time

HERE = __import__("pathlib").Path(__file__).resolve().parent


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


class Node:
    def __init__(self, cli, mine):
        self.cli, self.mine = shlex.split(cli), mine

    def call(self, *args, wallet=None):
        cmd = self.cli + (["-rpcwallet=" + wallet] if wallet else []) + [str(a) for a in args]
        out = run(cmd)
        if out.returncode != 0:
            raise RuntimeError((out.stderr or out.stdout).strip())
        t = out.stdout.strip()
        return json.loads(t) if t[:1] in "{[" else t

    def sats(self, wallet, minconf):
        return round(sum(x["amount"] for x in self.call("listunspent", minconf, wallet=wallet)) * 1e8)

    def pending(self, wallet):
        m = self.call("getbalances", wallet=wallet)["mine"]
        return round(m["untrusted_pending"] * 1e8) + (self.sats(wallet, 0) - self.sats(wallet, 1))

    def wait_confirmed(self, wallets, what):
        t0 = time.time()
        while any(self.pending(w) for w in wallets):
            if self.mine:
                run(shlex.split(self.mine))
                time.sleep(1)
            else:
                time.sleep(30)
            if time.time() - t0 > 3 * 3600:
                sys.exit("waited three hours for " + what)
        print("  confirmed: %s (%.0f min)" % (what, (time.time() - t0) / 60), flush=True)


def has_change(node, txid):
    raw = node.call("getrawtransaction", txid, "true", wallet="mixed")
    if len(raw["vout"]) < 2:
        return False
    for o in raw["vout"]:
        addr = o["scriptPubKey"].get("address")
        if addr and node.call("getaddressinfo", addr, wallet="mixed").get("ischange"):
            return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cli", default="docker exec -u bitcoin hb-core bitcoin-cli -signet")
    ap.add_argument("--rounds", type=int, default=8)
    ap.add_argument("--min-funds", type=int, default=4000)
    ap.add_argument("--mine", default="", help="a command that mines one block (regtest rehearsal); empty: wait for the network")
    a = ap.parse_args()
    node = Node(a.cli, a.mine)
    drive = lambda *args: run([sys.executable, str(HERE / "drive_core.py"), "--cli", a.cli, "--unit", "sats", *map(str, args)]).stdout
    log = open(HERE / "plan-txids.log", "a")
    for r in range(a.rounds):
        print("round %d" % (r + 1), flush=True)
        node.wait_confirmed(["mixed", "buddy", "payee"], "everything so far")
        if node.sats("buddy", 1) + node.sats("payee", 1) > 700:
            print("  " + drive("refill", "buddy", "payee").strip().replace("\n", "\n  "), flush=True)
            node.wait_confirmed(["mixed", "buddy", "payee"], "the refill")
        funds = node.sats("mixed", 1)
        print("  the wallet holds %d sats" % funds, flush=True)
        if funds < a.min_funds:
            print("  below %d: stopping" % a.min_funds)
            break
        budget = int(funds * 0.65)                                   # what a round may pay out: it only comes back at the next refill, and fees are not coming back
        ops = []
        if r % 3 == 0 and budget >= 14000:
            ops.append(("round", 1, "buddy", r // 3)); budget -= 10300
        if r in (0, 2) and budget >= 7500:
            ops.append(("batch", 1, "payee", 7 * r)); budget -= 6300
        n = min(22 - len(ops), max(2, budget // 1250))               # about 1,250 satoshis for an odd payment; at most 22 transactions, the mempool allows 25 unconfirmed in a chain
        ops += [("odd", n // 2, "buddy", 8 * r), ("odd", n - n // 2, "payee", 8 * r + 3)]
        txids = []
        for kind, n, to, start in ops:
            extra = ["--recipients", "7"] if kind == "batch" else []
            out = drive(kind, n, "--to", to, "--start", start, *extra)
            got = re.findall(r"\b[0-9a-f]{64}\b", out)
            txids += got
            if "stopped" in out or "could not" in out.lower():
                print("  %s %d -> %s: %s" % (kind, n, to, " | ".join(l for l in out.splitlines() if "stopped" in l or "could not" in l.lower())), flush=True)
                break
        for t in txids:
            log.write(t + "\n")
        log.flush()
        withc = sum(1 for t in txids if has_change(node, t))
        print("  made %d transactions, %d with a change output (%.0f%%)" % (len(txids), withc, 100.0 * withc / max(1, len(txids))), flush=True)
        if txids and withc < 0.6 * len(txids):
            print("  fewer than 60% have change: stopping to look at the settings")
            break
    print("done: the wallet holds %d sats (confirmed %d)" % (node.sats("mixed", 0), node.sats("mixed", 1)))


if __name__ == "__main__":
    main()
