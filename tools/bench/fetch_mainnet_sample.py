#!/usr/bin/env python3
"""A sample of real Bitcoin transactions, for measuring how often Hopline's flags fire on ordinary traffic (tier D of docs/benchmark.md).

Takes a few blocks spread over the years (a seed chooses them), and from each a number of random pages of 25 consecutive transactions, from
an Esplora API (public chain data, read only). Writes a case folder: case.json (what was chosen, so it can be repeated), txs.json.gz
(the transactions as the API returned them) and nothing about who owns what, because nobody knows. The results are rates, not accuracy.

    python tools/bench/fetch_mainnet_sample.py --out test/benchmark/cases/mainnet-sample [--seed N] [--blocks 8] [--pages 30]
    python tools/bench/fetch_mainnet_sample.py --out <folder> --heights 231000,350000   # the same blocks again (the pages follow from the seed)

Pages of 25 neighbouring transactions are what the API gives, and neighbours in a block are often related, so the sample is clustered and
its intervals are a little too narrow. Nothing here is a client's: it is the public chain.
"""
import argparse
import gzip
import json
import pathlib
import random
import sys
import time
import urllib.error
import urllib.request

BASE = "https://mempool.space/api"
# Where the years roughly are on the chain; the sampler also takes one block from the last months, and reports each block's real date.
ERAS = [(220000, 270000), (336000, 390000), (447000, 500000), (557000, 610000), (664000, 716000), (767000, 820000), (878000, 930000)]
PAGE = 25
DELAY = 0.7           # seconds between requests: a public API is somebody else's


class Api:
    def __init__(self, base):
        self.base, self.requests = base.rstrip("/"), 0

    def get(self, path, text=False):
        for attempt in range(6):
            time.sleep(DELAY)
            self.requests += 1
            req = urllib.request.Request(self.base + path, headers={"User-Agent": "hopline-benchmark/1.0 (public chain data, read only)"})
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    raw = r.read().decode("utf-8")
                return raw.strip() if text else json.loads(raw)
            except urllib.error.HTTPError as e:
                if e.code in (429, 502, 503, 504) and attempt < 5:
                    time.sleep(5 * (attempt + 1)); continue
                raise
            except (urllib.error.URLError, TimeoutError):
                if attempt < 5:
                    time.sleep(5 * (attempt + 1)); continue
                raise


ASM = ("scriptsig_asm", "scriptpubkey_asm", "inner_redeemscript_asm", "inner_witnessscript_asm")


SIGNATURES = ("witness", "scriptsig")


def slim(t):
    """The transaction without what nothing in Hopline reads and is most of the size: the assembly text of the scripts, and the signatures
    (witness and scriptsig) of every input that is not a coinbase (a coinbase keeps its script: it names the miner)."""
    for v in t["vin"]:
        for k in ASM:
            v.pop(k, None)
            (v.get("prevout") or {}).pop(k, None)
        if not v.get("is_coinbase"):
            for k in SIGNATURES:
                v.pop(k, None)
    for o in t["vout"]:
        for k in ASM:
            o.pop(k, None)
    return t


def choose_heights(rng, tip, count):
    spread = [rng.randint(lo, hi) for lo, hi in ERAS]
    spread.append(rng.randint(max(tip - 40000, ERAS[-1][1]), tip - 100))
    if count < len(spread):
        spread = sorted(rng.sample(spread, count))
    return sorted(spread)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", required=True, help="the case folder to write")
    ap.add_argument("--seed", type=int, default=20261027)
    ap.add_argument("--blocks", type=int, default=8)
    ap.add_argument("--pages", type=int, default=30, help="random pages of 25 transactions from each block")
    ap.add_argument("--heights", help="comma-separated block heights instead of choosing them")
    ap.add_argument("--base", default=BASE, help="an Esplora API (mempool.space or blockstream.info)")
    a = ap.parse_args(argv)
    api, rng = Api(a.base), random.Random(a.seed)
    tip = int(api.get("/blocks/tip/height", text=True))
    heights = [int(h) for h in a.heights.split(",")] if a.heights else choose_heights(rng, tip, a.blocks)
    print("tip %d, blocks %s" % (tip, heights))
    txs, blocks = [], []
    for h in heights:
        block_hash = api.get("/block-height/%d" % h, text=True)
        info = api.get("/block/" + block_hash)
        pages_total = (info["tx_count"] + PAGE - 1) // PAGE
        brng = random.Random("%d:%d" % (a.seed, h))               # the pages of a block follow from the seed and its height, whatever else was asked
        starts = sorted(brng.sample(range(pages_total), min(a.pages, pages_total)))
        got = []
        for p in starts:
            got.extend(slim(t) for t in api.get("/block/%s/txs/%d" % (block_hash, p * PAGE)))
        txs.extend(got)
        blocks.append({"height": h, "hash": block_hash, "time": info["timestamp"], "tx_count": info["tx_count"], "pages": starts, "transactions": len(got)})
        print("  %d  %s  %d transactions in the block, %d taken" % (h, time.strftime("%Y-%m-%d", time.gmtime(info["timestamp"])), info["tx_count"], len(got)))
    seen, unique = set(), []
    for t in txs:
        if t["txid"] not in seen:
            seen.add(t["txid"]); unique.append(t)
    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "txs.json.gz").write_bytes(gzip.compress(json.dumps(unique, separators=(",", ":"), sort_keys=True).encode("utf-8"), 9, mtime=0))
    meta = {"generator": "tools/bench/fetch_mainnet_sample.py", "tier": "D", "name": out.name, "seed": a.seed, "api": a.base, "tip_when_chosen": tip, "blocks": blocks,
            "fields_removed": list(ASM) + list(SIGNATURES), "transactions": len(unique), "summary": "real mainnet transactions in random pages of 25 from blocks over the years; no ownership is known"}
    (out / "case.json").write_text(json.dumps(meta, indent=1, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
    print("wrote %d transactions, %d requests" % (len(unique), api.requests))
    return 0


if __name__ == "__main__":
    sys.exit(main())
