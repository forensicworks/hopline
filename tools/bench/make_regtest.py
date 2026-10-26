#!/usr/bin/env python3
"""Make the synthetic benchmark cases: Bitcoin Core on regtest, wallets whose ownership and change are known, six scenarios.

    python tools/bench/make_regtest.py --out test/benchmark/cases/regtest-v1                 (all six, about ten minutes)
    python tools/bench/make_regtest.py --out /tmp/cases --scenarios payments --scale 0.1     (a small one to try it)

It starts the official Bitcoin Core image in Docker (nothing else is installed, nothing leaves the machine: the node listens on
127.0.0.1 and is stopped when the script ends), makes wallets with different habits, makes the transactions of each scenario, and writes
for each one a folder with
    case.json    what it is and what made it
    txs.json.gz  every transaction of the scenario as the Esplora API returns it
    truth.json   what is known about them (see test/benchmark/lib/cases.js)
The method is in docs/benchmark.md. The seed fixes what this script chooses; Bitcoin Core's own choices (which coins it spends, the keys)
are random, so running it again gives a similar set and not the same one: the committed files are the data the results are measured on.
"""
import argparse
import base64
import gzip
import json
import math
import os
import random
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

IMAGE = "bitcoin/bitcoin:latest"
SCRIPT_TYPES = {"pubkeyhash": "p2pkh", "scripthash": "p2sh", "witness_v0_keyhash": "v0_p2wpkh", "witness_v0_scripthash": "v0_p2wsh", "witness_v1_taproot": "v1_p2tr",
                "nulldata": "op_return", "pubkey": "p2pk", "multisig": "multisig", "nonstandard": "unknown"}
ROUND_BTC = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5]
ADDRESS_TYPES = ["legacy", "p2sh-segwit", "bech32", "bech32m"]
DUST = 1000


def sat(btc):
    return int(round(btc * 1e8))


def btc(sats):
    return round(sats / 1e8, 8)


# ---- the node -------------------------------------------------------------------------------------------------------------------
class Node:
    """Bitcoin Core regtest in a container, reached over RPC on 127.0.0.1."""

    def __init__(self, image):
        s = socket.socket(); s.bind(("127.0.0.1", 0)); self.port = s.getsockname()[1]; s.close()
        self.name = "hopline-bench-%d" % os.getpid()
        self.auth = "Basic " + base64.b64encode(b"bench:bench").decode()
        subprocess.run(["docker", "run", "-d", "--rm", "--name", self.name, "-p", "127.0.0.1:%d:18443" % self.port, image, "bitcoind", "-regtest", "-server=1", "-rpcuser=bench",
                        "-rpcpassword=bench", "-rpcbind=0.0.0.0", "-rpcallowip=0.0.0.0/0", "-rpcport=18443", "-txindex=1", "-fallbackfee=0.0002", "-printtoconsole=0"],
                       check=True, capture_output=True)
        for _ in range(60):
            try:
                self.call("getblockchaininfo")
                break
            except (urllib.error.URLError, ConnectionError, RuntimeError, OSError):
                time.sleep(1)
        else:
            raise RuntimeError("the node did not start")
        self.version = self.call("getnetworkinfo")["subversion"]

    def call(self, method, params=None, wallet=None):
        url = "http://127.0.0.1:%d/%s" % (self.port, ("wallet/" + wallet) if wallet else "")
        req = urllib.request.Request(url, data=json.dumps({"jsonrpc": "1.0", "id": "b", "method": method, "params": params if params is not None else []}).encode(),
                                     headers={"Authorization": self.auth, "Content-Type": "text/plain"})
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                d = json.loads(r.read())
        except urllib.error.HTTPError as e:
            d = json.loads(e.read())
        if d.get("error"):
            raise RuntimeError("%s %s: %s" % (method, json.dumps(params)[:200], d["error"]))
        return d["result"]

    def stop(self):
        subprocess.run(["docker", "rm", "-f", self.name], capture_output=True)


# ---- wallets ---------------------------------------------------------------------------------------------------------------------
class Wallet:
    """A wallet with a habit: the address type it receives on, where and in what type it puts its change, how it signals, how it likes its amounts."""

    def __init__(self, env, name, software, **b):
        self.env, self.name, self.software = env, name, software
        self.b = dict(address_type="bech32", change_type="bech32", change_position="random", locktime="height", replaceable=True, round_payments=0.5, reuse=0.0, fee_rate=10.0, service=False)
        self.b.update(b)
        env.node.call("createwallet", {"wallet_name": name, "descriptors": True})

    def call(self, method, params=None):
        return self.env.node.call(method, params, self.name)

    def new_address(self, kind=None):
        a = self.call("getnewaddress", ["", kind or self.b["address_type"]])
        self.env.owners[a] = self.name
        return a

    def balance(self):
        return sat(self.call("getbalance"))

    def utxos(self, minconf=1):
        return sorted(self.call("listunspent", [minconf]), key=lambda u: (u["txid"], u["vout"]))

    def meta(self):
        return {"software": self.software, "behaviour": {k: v for k, v in self.b.items() if k != "service"}, "service": bool(self.b["service"])}

    def amount(self, rng, ceiling):
        """What this wallet pays: round with the probability of its habit, else a random number of satoshis."""
        if rng.random() < self.b["round_payments"]:
            choices = [x for x in ROUND_BTC if sat(x) <= ceiling]
            if choices:
                return sat(rng.choice(choices))
        return rng.randint(30000, max(30001, min(ceiling, 6000000)))

    def options(self, rng, n_outputs, extra=None):
        o = {"fee_rate": round(max(2.0, rng.gauss(self.b["fee_rate"], self.b["fee_rate"] / 3)), 1), "replaceable": self.b["replaceable"], "change_type": self.b["change_type"]}
        pos = self.b["change_position"]
        o["change_position"] = 0 if pos == "first" else n_outputs if pos == "last" else rng.randint(0, n_outputs)
        if self.b["locktime"] == "zero":
            o["locktime"] = 0
        o.update(extra or {})
        return o


class Env:
    def __init__(self, node, seed):
        self.node, self.rng = node, random.Random(seed)
        self.owners, self.events, self.wallets, self.chains, self.known = {}, {}, {}, [], set()
        self.clock = int(time.time())                           # block times run on from now, ten minutes a block: a wallet ignores blocks older than itself
        self.blocks_since = 0
        self.height_of = {}
        self.node.call("createwallet", {"wallet_name": "miner", "descriptors": True})
        self.miner_addr = self.node.call("getnewaddress", ["", "bech32"], "miner")
        self.mine(260)                                           # regtest halves the reward every 150 blocks: this leaves the miner plenty of mature coins

    def mine(self, n=1):
        for _ in range(n):
            self.clock += 600
            self.node.call("setmocktime", [self.clock])
            self.node.call("generatetoaddress", [1, self.miner_addr])

    def wallet(self, name, software, **b):
        w = Wallet(self, name, software, **b)
        self.wallets[name] = w
        return w

    def fund(self, w, count, low=0.01, high=0.3):
        """Send the wallet `count` coins of random sizes from the miner, to count different addresses of its own."""
        outs, remaining = {}, count
        while remaining > 0:
            batch = min(remaining, 20); outs = {}
            for _ in range(batch):
                outs[w.new_address()] = round(self.rng.uniform(low, high), 8)
            self.node.call("send", {"outputs": [{a: v} for a, v in outs.items()], "options": {"fee_rate": 5}}, "miner")
            remaining -= batch
        self.mine()

    def top_up(self, w, floor_btc=0.5, count=6):
        if w.balance() < sat(floor_btc):
            self.fund(w, count, 0.02, 0.5)

    def record(self, txid, kind, wallet=None, change_vout="unset", tags=None, **more):
        e = {"kind": kind}
        if wallet:
            e["wallet"] = wallet
        if change_vout != "unset":
            e["change_vout"] = change_vout
        if tags:
            e["tags"] = tags
        e.update(more)
        self.events[txid] = e
        self.blocks_since += 1
        if self.blocks_since >= 6:
            self.mine(); self.blocks_since = 0

    def outputs_of(self, txid):
        tx = self.node.call("getrawtransaction", [txid, 1])
        return [o["scriptPubKey"].get("address") for o in tx["vout"]], tx

    def split_change(self, txid, pay_addrs):
        """(vouts that pay, the change vout or None) of a transaction that paid `pay_addrs`."""
        outs, tx = self.outputs_of(txid)
        pay = [i for i, a in enumerate(outs) if a in pay_addrs]
        rest = [i for i in range(len(outs)) if i not in pay]
        if len(rest) > 1:
            raise RuntimeError("more than one output that is not a payment in " + txid)
        return pay, (rest[0] if rest else None), outs, tx

    def pay(self, sender, dests, kind="payment", extra=None, tags=None, with_change=True):
        """Pay {address: sats} from `sender` and record what it was made to be. Returns the txid."""
        n = len(dests)
        res = self.node.call("send", {"outputs": [{a: btc(v)} for a, v in dests.items()], "options": sender.options(self.rng, n, extra)}, sender.name)
        pay, change, outs, tx = self.split_change(res["txid"], set(dests))
        if change is not None:
            self.owners[outs[change]] = sender.name
        self.record(res["txid"], kind, sender.name, change, tags)
        return res["txid"]

    def pay_reusing(self, sender, dest, amount):
        """Pay from one coin and send the change back to the address that coin was on: the address-reuse habit."""
        u = self.rng.choice([x for x in sender.utxos() if sat(x["amount"]) > amount + 20000] or [None])
        if u is None:
            return None
        opts = sender.options(self.rng, 1, {"inputs": [{"txid": u["txid"], "vout": u["vout"]}], "add_inputs": False, "change_address": u["address"]})
        opts.pop("change_type", None)
        res = self.node.call("send", {"outputs": [{dest: btc(amount)}], "options": opts}, sender.name)
        pay, change, outs, tx = self.split_change(res["txid"], {dest})
        self.owners.setdefault(u["address"], sender.name)
        self.record(res["txid"], "payment", sender.name, change, ["reuse"])
        return res["txid"]


    def pay_exact(self, sender, dest_a, dest_b):
        """Pay two people the whole of one coin, the fee coming out of the second: a transaction with no change at all."""
        coins = [x for x in sender.utxos() if sat(x["amount"]) > 120000]
        if not coins:
            return None
        u = self.rng.choice(coins)
        total = sat(u["amount"]); a = int(total * self.rng.uniform(0.2, 0.8)); b = total - a
        opts = sender.options(self.rng, 2, {"inputs": [{"txid": u["txid"], "vout": u["vout"]}], "add_inputs": False, "subtract_fee_from_outputs": [1]})
        opts.pop("change_position", None); opts.pop("change_type", None)
        res = self.node.call("send", {"outputs": [{dest_a: btc(a)}, {dest_b: btc(b)}], "options": opts}, sender.name)
        pay, change, outs, tx = self.split_change(res["txid"], {dest_a, dest_b})
        if change is not None:
            raise RuntimeError("a payment that was meant to have no change has some")
        self.owners.setdefault(u["address"], sender.name)
        self.record(res["txid"], "payment", sender.name, None, ["exact"])
        return res["txid"]


# ---- scenario helpers ---------------------------------------------------------------------------------------------------------
def habit(rng, i):
    """The habits of wallet number i: a different mix for each, chosen by the seed."""
    t = rng.choices(ADDRESS_TYPES, weights=[3, 3, 10, 4])[0]
    same = rng.random() < 0.75
    return dict(address_type=t, change_type=t if same else rng.choice(ADDRESS_TYPES), change_position=rng.choices(["random", "last", "first"], weights=[4, 4, 2])[0],
                locktime=rng.choices(["height", "zero"], weights=[7, 3])[0], replaceable=rng.random() < 0.7, round_payments=rng.choice([0.9, 0.5, 0.1]),
                fee_rate=rng.choice([3.0, 8.0, 15.0, 30.0]))


def software_label(b):
    return "core-like" if b["locktime"] == "height" and b["replaceable"] else "other-like"


def people(env, prefix, n, **fixed):
    out = []
    for i in range(n):
        b = habit(env.rng, i); b.update(fixed)
        out.append(env.wallet("%s%02d" % (prefix, i + 1), software_label(b), **b))
    return out


def random_payment(env, wallets, services=(), p_reuse=True):
    """One payment between two of the wallets (or to a service): the sender, the receiver and the amount are chosen here."""
    rng = env.rng
    sender = rng.choice(wallets)
    env.top_up(sender, 0.25)
    pool = (list(services) + wallets) if services and rng.random() < 0.35 else wallets
    receiver = rng.choice([w for w in pool if w is not sender])
    ceiling = max(40000, int(sender.balance() * 0.6))
    amount = sender.amount(rng, ceiling)
    dest = receiver.new_address()
    if rng.random() < 0.07:                                            # now and then the whole of a coin goes to two people and nothing comes back
        other = rng.choice([w for w in wallets if w is not sender and w is not receiver] or [receiver])
        if env.pay_exact(sender, dest, other.new_address()):
            return
    if p_reuse and sender.b["reuse"] and rng.random() < sender.b["reuse"]:
        if env.pay_reusing(sender, dest, amount):
            return
    try:
        env.pay(sender, {dest: amount})
    except RuntimeError as e:
        if "Insufficient funds" in str(e) or "insufficient" in str(e).lower():
            env.fund(sender, 6, 0.02, 0.5)
        else:
            raise


def n_of(scale, base, floor=1):
    return max(floor, int(round(base * scale)))


# ---- the scenarios -------------------------------------------------------------------------------------------------------------
def scenario_payments(env, scale):
    wallets = people(env, "w", 18)
    for i, w in enumerate(wallets):
        if i % 6 == 0:
            w.b["reuse"] = 0.5
    services = [env.wallet("exchange", "service", address_type="bech32", change_type="bech32", change_position="last", service=True, round_payments=0.3),
                env.wallet("shop", "service", address_type="p2sh-segwit", change_type="p2sh-segwit", change_position="random", service=True, round_payments=0.8)]
    for w in wallets + services:
        env.fund(w, 10, 0.02, 0.4)
    for _ in range(n_of(scale, 1200)):
        random_payment(env, wallets, services)
    # the addresses of the two services that a list of names would have: about half of those that appear
    seen = [a for a, o in env.owners.items() if o in ("exchange", "shop")]
    env.known = {a for a in seen if env.rng.random() < 0.5}


def scenario_peel_chains(env, scale):
    ws = people(env, "r", 10)
    for w in ws:
        env.fund(w, 8, 0.05, 0.4)
    peelers = []
    for i in range(n_of(scale, 14)):
        b = habit(env.rng, i); b.update(change_position=env.rng.choice(["random", "last", "first"]))
        p = env.wallet("peeler%02d" % (i + 1), software_label(b), **b)
        peelers.append(p)
    for p in peelers:
        env.node.call("send", {"outputs": [{p.new_address(): round(env.rng.uniform(4, 15), 8)}], "options": {"fee_rate": 5}}, "miner")
        env.mine()
    chains = []
    # the chains are made one after the other with ordinary traffic in between
    for p in peelers:
        coin = max(p.utxos(), key=lambda u: u["amount"])
        txids, length = [], env.rng.randint(5, 30)
        for step in range(length):
            value = sat(coin["amount"])
            ratio = math.exp(env.rng.uniform(math.log(0.01), math.log(0.6)))          # a payment of 1% to 60% of the coin, evenly spread on a log scale: no step is made to suit the detector's cut-off
            amount = max(20000, int(value * ratio))
            if value - amount < 200000:
                break
            dest = env.rng.choice(ws).new_address()
            opts = p.options(env.rng, 1, {"inputs": [{"txid": coin["txid"], "vout": coin["vout"]}], "add_inputs": False})
            res = env.node.call("send", {"outputs": [{dest: btc(amount)}], "options": opts}, p.name)
            pay, change, outs, tx = env.split_change(res["txid"], {dest})
            if change is None:
                break
            env.owners[outs[change]] = p.name
            env.owners.setdefault(coin["address"], p.name)
            env.record(res["txid"], "peel", p.name, change)
            txids.append(res["txid"])
            env.mine()
            coin = {"txid": res["txid"], "vout": change, "amount": tx["vout"][change]["value"], "address": outs[change]}
        if len(txids) >= 2:
            chains.append(txids)
        for _ in range(env.rng.randint(8, 30)):
            random_payment(env, ws, p_reuse=False)
    env.chains = chains
    for _ in range(n_of(scale, 120)):
        random_payment(env, ws, p_reuse=False)


def scenario_batch_consolidation(env, scale):
    rng = env.rng
    customers = people(env, "c", 12)
    ex = env.wallet("exchange", "service", address_type="bech32", change_type="bech32", change_position="random", service=True)
    env.fund(ex, 40, 0.05, 0.6)
    for c in customers:
        env.fund(c, 6, 0.02, 0.2)
    for _ in range(n_of(scale, 40)):                                   # batch payouts
        k = rng.randint(6, 25)
        dests = {}
        for _i in range(k):
            dests[rng.choice(customers).new_address()] = rng.randint(20000, 400000)
        env.top_up(ex, 8, 10)
        env.pay(ex, dests, kind="batch", extra={"change_position": rng.randint(0, k)})
    for _ in range(n_of(scale, 40)):                                   # consolidations
        c = rng.choice(customers)
        count = rng.randint(5, 30)
        env.fund(c, count, 0.002, 0.02)
        coins = sorted(c.utxos(), key=lambda u: u["amount"])[:count]
        dest = c.new_address()
        opts = c.options(rng, 1, {"inputs": [{"txid": u["txid"], "vout": u["vout"]} for u in coins], "add_inputs": False, "subtract_fee_from_outputs": [0]})
        total = sum(sat(u["amount"]) for u in coins)
        res = env.node.call("send", {"outputs": [{dest: btc(total)}], "options": opts}, c.name)
        for u in coins:
            env.owners.setdefault(u["address"], c.name)
        env.record(res["txid"], "consolidation", c.name)
    for _ in range(n_of(scale, 300)):                                  # ordinary payments, some from wallets that hold many small coins
        random_payment(env, customers, [ex])
    for c in customers:
        if rng.random() < 0.7:
            env.fund(c, rng.randint(6, 12), 0.003, 0.02)
    for _ in range(n_of(scale, 100)):
        random_payment(env, customers, [ex])
    env.known = {a for a, o in env.owners.items() if o == "exchange" and rng.random() < 0.5}


def psbt_round(env, parts, outputs):
    """One transaction built by several wallets together. parts = [(wallet, [coins])], outputs = [(address, sats)]. Returns the txid."""
    inputs = [{"txid": u["txid"], "vout": u["vout"]} for _, coins in parts for u in coins]
    psbt = env.node.call("createpsbt", [inputs, [{a: btc(v)} for a, v in outputs], 0, True])
    # a taproot signature commits to every input's amount and script, so everyone adds what they know before anyone signs
    for w, _ in parts:
        psbt = w.call("walletprocesspsbt", [psbt, False, "ALL", True])["psbt"]
    for w, _ in parts:
        psbt = w.call("walletprocesspsbt", [psbt, True, "ALL", True])["psbt"]
    fin = env.node.call("finalizepsbt", [psbt])
    if not fin["complete"]:
        raise RuntimeError("the shared transaction could not be completed: " + json.dumps(env.node.call("analyzepsbt", [psbt]))[:600])
    return env.node.call("sendrawtransaction", [fin["hex"]])


def pick_coins(w, need, rng, min_count=1):
    coins = [u for u in w.utxos()]
    rng.shuffle(coins)
    chosen, total = [], 0
    for u in sorted(coins, key=lambda x: rng.random()):
        chosen.append(u); total += sat(u["amount"])
        if total >= need and len(chosen) >= min_count:
            return chosen, total
    return None, 0


def scenario_coinjoins(env, scale):
    rng = env.rng
    ws = people(env, "p", 12)
    ex = env.wallet("exchange", "service", address_type="bech32", change_type="bech32", change_position="last", service=True)
    for w in ws:
        env.fund(w, 10, 0.02, 0.6)
    env.fund(ex, 40, 0.004, 0.02)
    for _ in range(n_of(scale, 60)):                                   # CoinJoins of equal outputs
        k = rng.randint(3, 9)
        parts_w = rng.sample(ws, k)
        denom = sat(rng.choice([0.01, 0.05, 0.1]))
        fee_each = 4000
        parts, outputs, ok = [], [], True
        for w in parts_w:
            coins, total = pick_coins(w, denom + fee_each + 3000, rng, rng.choice([1, 1, 2, 3]))
            if not coins:
                env.top_up(w, 2.0, 8)
                coins, total = pick_coins(w, denom + fee_each + 3000, rng)
            if not coins:
                ok = False
                break
            parts.append((w, coins))
            outputs.append((w.new_address("bech32"), denom))
            change = total - denom - fee_each
            if change > DUST:
                outputs.append((w.new_address("bech32"), change))
        if not ok:
            continue
        rng.shuffle(outputs)
        for w, coins in parts:
            for u in coins:
                env.owners.setdefault(u["address"], w.name)
        txid = psbt_round(env, parts, outputs)
        env.record(txid, "coinjoin", participants=[w.name for w, _ in parts], denomination=denom)
        env.mine(); env.blocks_since = 0
    for _ in range(n_of(scale, 200)):                                  # an exchange pays equal amounts from several of its own addresses: the look-alike
        k = rng.randint(3, 12)
        each = sat(rng.choice([0.005, 0.01, 0.02]))
        coins = sorted(ex.utxos(), key=lambda u: rng.random())[:rng.randint(3, 8)]
        total = sum(sat(u["amount"]) for u in coins)
        if total < each * k + 30000:
            env.fund(ex, 30, 0.004, 0.02)
            continue
        dests = {rng.choice(ws).new_address(): each for _i in range(k)}
        if len(dests) < k:
            continue
        res = env.node.call("send", {"outputs": [{a: btc(v)} for a, v in dests.items()], "options": ex.options(rng, k, {"inputs": [{"txid": u["txid"], "vout": u["vout"]} for u in coins], "add_inputs": False})}, ex.name)
        pay, change, outs, tx = env.split_change(res["txid"], set(dests))
        if change is not None:
            env.owners[outs[change]] = ex.name
        for u in coins:
            env.owners.setdefault(u["address"], ex.name)
        env.record(res["txid"], "equal-payout", ex.name, change)
    for _ in range(n_of(scale, 300)):
        random_payment(env, ws, [ex])
    env.known = {a for a, o in env.owners.items() if o == "exchange" and rng.random() < 0.5}


def scenario_payjoin(env, scale):
    rng = env.rng
    ws = people(env, "j", 14)
    for w in ws:
        env.fund(w, 12, 0.02, 0.5)
    for _ in range(n_of(scale, 150)):
        s, r = rng.sample(ws, 2)
        amount = s.amount(rng, int(s.balance() * 0.4))
        fee = rng.randint(2500, 6000)
        coins_s, total_s = pick_coins(s, amount + fee + 5000, rng)
        coins_r, total_r = pick_coins(r, 1000, rng, rng.choice([1, 1, 2]))
        if not coins_s or not coins_r:
            env.top_up(s, 3.0, 8); env.top_up(r, 3.0, 8)
            continue
        change = total_s - amount - fee
        if change < DUST:
            continue
        r_addr, s_addr = r.new_address(), s.new_address(s.b["change_type"])
        outputs = [(r_addr, amount + total_r), (s_addr, change)]
        change_at = 1
        if rng.random() < 0.5:
            outputs.reverse(); change_at = 0
        for u in coins_s:
            env.owners.setdefault(u["address"], s.name)
        for u in coins_r:
            env.owners.setdefault(u["address"], r.name)
        txid = psbt_round(env, [(s, coins_s), (r, coins_r)], outputs)
        env.record(txid, "payjoin", s.name, change_at, receiver=r.name)
    for _ in range(n_of(scale, 300)):
        random_payment(env, ws)
    for _ in range(n_of(scale, 60)):
        c = rng.choice(ws)
        env.fund(c, rng.randint(5, 16), 0.003, 0.02)
        coins = sorted(c.utxos(), key=lambda u: u["amount"])[:rng.randint(5, 16)]
        total = sum(sat(u["amount"]) for u in coins)
        dest = c.new_address()
        res = env.node.call("send", {"outputs": [{dest: btc(total)}], "options": c.options(rng, 1, {"inputs": [{"txid": u["txid"], "vout": u["vout"]} for u in coins], "add_inputs": False, "subtract_fee_from_outputs": [0]})}, c.name)
        for u in coins:
            env.owners.setdefault(u["address"], c.name)
        env.record(res["txid"], "consolidation", c.name)


def scenario_sweeps(env, scale):
    rng = env.rng
    custs = people(env, "u", 25)
    ex = env.wallet("exchange", "service", address_type="bech32", change_type="bech32", change_position="last", service=True, round_payments=0.2)
    hot = [ex.new_address() for _ in range(3)]
    for c in custs:
        env.fund(c, 8, 0.05, 0.5)
    deposits = []
    for c in custs:                                                    # each customer pays four deposit addresses of the exchange
        for _ in range(n_of(scale, 4)):
            env.top_up(c, 0.4)
            a = ex.new_address()
            deposits.append(a)
            env.pay(c, {a: c.amount(rng, int(c.balance() * 0.3))})
    for _ in range(n_of(scale, 200)):
        random_payment(env, custs)
    env.mine()
    deposit_set = set(deposits)                                        # sweep the deposit coins into the hot wallet, a batch of them at a time
    coins = [u for u in ex.utxos() if u["address"] in deposit_set]
    rng.shuffle(coins)
    while len(coins) >= 5:
        take = coins[:rng.randint(5, 20)]; coins = coins[len(take):]
        total = sum(sat(u["amount"]) for u in take)
        res = env.node.call("send", {"outputs": [{rng.choice(hot): btc(total)}], "options": ex.options(rng, 1, {"inputs": [{"txid": u["txid"], "vout": u["vout"]} for u in take], "add_inputs": False, "subtract_fee_from_outputs": [0]})}, ex.name)
        for u in take:
            env.owners.setdefault(u["address"], ex.name)
        env.record(res["txid"], "consolidation", ex.name, tags=["sweep"])
    env.mine()
    for _ in range(n_of(scale, 25)):                                   # batch withdrawals
        k = rng.randint(6, 15)
        dests = {rng.choice(custs).new_address(): rng.randint(30000, 500000) for _i in range(k)}
        env.top_up(ex, 6, 8)
        if sat(ex.call("getbalance")) < sum(dests.values()) + 100000:
            continue
        env.pay(ex, dests, kind="batch")
    env.known = set(hot)


SCENARIOS = {"payments": scenario_payments, "peel-chains": scenario_peel_chains, "batch-consolidation": scenario_batch_consolidation, "coinjoins": scenario_coinjoins,
             "payjoin": scenario_payjoin, "sweeps": scenario_sweeps}
SUMMARY = {"payments": "20 wallets with different habits paying each other and two services",
           "peel-chains": "14 scripted peel chains of 5 to 30 steps among ordinary payments", "batch-consolidation": "exchange batch payouts, consolidations of 5 to 30 coins, ordinary payments",
           "coinjoins": "equal-output CoinJoins of 3 to 9 wallets, exchange payouts of equal amounts, ordinary payments", "payjoin": "two-party payments where both sides add inputs, with payments and consolidations",
           "sweeps": "customers paying deposit addresses, the exchange sweeping them into a hot wallet, batch withdrawals"}


# ---- writing a case ----------------------------------------------------------------------------------------------------------
def esplora(node, txid, heights):
    t = node.call("getrawtransaction", [txid, 2])
    bh = t["blockhash"]
    if bh not in heights:
        h = node.call("getblockheader", [bh]); heights[bh] = (h["height"], h["time"])
    height, btime = heights[bh]
    vin = []
    for v in t["vin"]:
        p = v["prevout"]["scriptPubKey"]
        vin.append({"txid": v["txid"], "vout": v["vout"], "is_coinbase": False, "sequence": v["sequence"],
                    "prevout": {"scriptpubkey": p["hex"], "scriptpubkey_asm": p["asm"], "scriptpubkey_type": SCRIPT_TYPES[p["type"]], "scriptpubkey_address": p["address"], "value": sat(v["prevout"]["value"])},
                    "scriptsig": v.get("scriptSig", {}).get("hex", ""), "witness": v.get("txinwitness", [])})
    vout = []
    for o in t["vout"]:
        p = o["scriptPubKey"]
        e = {"scriptpubkey": p["hex"], "scriptpubkey_asm": p["asm"], "scriptpubkey_type": SCRIPT_TYPES[p["type"]], "value": sat(o["value"])}
        if "address" in p:
            e["scriptpubkey_address"] = p["address"]
        vout.append(e)
    return {"txid": t["txid"], "version": t["version"], "locktime": t["locktime"], "size": t["size"], "weight": t["weight"], "fee": sat(t["fee"]), "vin": vin, "vout": vout,
            "status": {"confirmed": True, "block_height": height, "block_hash": bh, "block_time": btime}}


def write_case(env, name, outdir, seed, scale, image_digest):
    env.mine(2)
    txids = list(env.events)
    heights = {}
    txs = [esplora(env.node, t, heights) for t in txids]
    txs.sort(key=lambda t: (t["status"]["block_height"], t["txid"]))
    owners = {}
    for t in txs:                                                      # the inputs of a transaction one wallet made are that wallet's; every address that appears must have an owner, or the case is not usable
        ev = env.events[t["txid"]]
        if ev.get("wallet") and ev["kind"] not in ("coinjoin", "payjoin"):
            for v in t["vin"]:
                env.owners.setdefault(v["prevout"]["scriptpubkey_address"], ev["wallet"])
        for a in [v["prevout"]["scriptpubkey_address"] for v in t["vin"]] + [o["scriptpubkey_address"] for o in t["vout"] if "scriptpubkey_address" in o]:
            owner = env.owners.get(a)
            if owner is None:
                owner = next((w for w in env.wallets if env.node.call("getaddressinfo", [a], w)["ismine"]), None)
            if owner is None:
                raise RuntimeError("an address with no owner: " + a)
            owners[a] = owner
    truth = {"schema": 1, "wallets": {w: env.wallets[w].meta() for w in sorted(env.wallets)}, "owners": dict(sorted(owners.items())), "txs": env.events, "chains": env.chains,
             "known": sorted(a for a in env.known if a in owners)}
    d = os.path.join(outdir, name)
    os.makedirs(d, exist_ok=True)
    meta = {"name": name, "tier": "A", "summary": SUMMARY[name], "generator": "tools/bench/make_regtest.py", "seed": seed, "scale": scale, "node": env.node.version, "image": image_digest,
            "transactions": len(txs), "wallets": len(env.wallets)}
    with open(os.path.join(d, "case.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(meta, f, indent=1, sort_keys=True); f.write("\n")
    with open(os.path.join(d, "txs.json.gz"), "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0, compresslevel=9) as z:
        z.write(json.dumps(txs, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    with open(os.path.join(d, "truth.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(truth, f, separators=(",", ":"), sort_keys=True); f.write("\n")
    return meta


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split(chr(10) * 2)[0])
    ap.add_argument("--out", required=True, help="the folder to write the cases into")
    ap.add_argument("--scenarios", default=",".join(SCENARIOS), help="which to make, comma separated (default: all)")
    ap.add_argument("--seed", type=int, default=20261026, help="the seed for what this script chooses")
    ap.add_argument("--scale", type=float, default=1.0, help="a share of the usual number of transactions (0.1 for a quick try)")
    ap.add_argument("--image", default=IMAGE, help="the Bitcoin Core image (default: %(default)s)")
    a = ap.parse_args(argv)
    wanted = [s.strip() for s in a.scenarios.split(",") if s.strip()]
    for s in wanted:
        if s not in SCENARIOS:
            ap.error("no such scenario: %s (the scenarios are %s)" % (s, ", ".join(SCENARIOS)))
    digest = subprocess.run(["docker", "image", "inspect", a.image, "--format", "{{index .RepoDigests 0}}"], capture_output=True, text=True).stdout.strip() or a.image
    for name in wanted:
        started = time.time()
        node = Node(a.image)
        try:
            env = Env(node, "%s/%s" % (a.seed, name))
            SCENARIOS[name](env, a.scale)
            meta = write_case(env, name, a.out, a.seed, a.scale, digest)
        finally:
            node.stop()
        print("%-20s %5d transactions, %2d wallets, %4.0f s" % (name, meta["transactions"], meta["wallets"], time.time() - started), flush=True)


if __name__ == "__main__":
    main()
