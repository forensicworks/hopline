# Benchmarking with real wallet software (tier B)

The synthetic cases in [benchmark.md](benchmark.md) are all Bitcoin Core, with different settings. Real wallets choose coins, change types, change positions and amounts in their own ways, and that is what this tier measures. The truth is free: a wallet's descriptor says which of its addresses are on the **change chain** (the `/1/` branch), so the output of a transaction that pays that chain is its change, and the wallet cannot be wrong about it.

The tool is `tools/bench/make_wallet_case.py`. What is built and tested: reading the public descriptors, deriving the addresses with Bitcoin Core, reading the transactions from an Esplora API, working out the truth, and writing a case folder the harness reads. **What does not exist yet is the data**: it needs a person with real wallets and a few faucet coins. This page is what that person does.

## What you need

* A test network. **Testnet4** is the easier one with Sparrow: from version 1.9.1 it is built in (*Tools > Restart In Testnet4*, with a public server run by mempool). **Signet** is a more stable chain, but a wallet needs an Electrum server for it. Both have an Esplora API on mempool.space, which is what the tool reads (`"network": "testnet4"` or `"signet"` in the config). Nothing here touches mainnet.
* Coins from a **faucet**. Faucets come and go and most are rate-limited (a captcha, or an account): search for a current one and check its date; none was verified when this was written. Get coins once into one wallet and pass them on to the others. Testnet4 can be reset to a new genesis block: make the case soon after the transactions, because the case folder keeps the data and a reset takes the chain away.
* The wallets to measure, each with a **fresh wallet** (a new seed made for this, never one that holds or has held real bitcoin): Sparrow, Electrum, Bitcoin Core, a hardware wallet through Sparrow, Blockstream Green, BlueWallet, whatever people use. One wallet per software is enough; two in different address types is better.
* Docker (the tool derives addresses with Bitcoin Core in a container, so no address encoding is written twice) and Python 3.
* An hour or two.

## What to do with each wallet

1. Get coins from a faucet a few times, in different amounts, so that the wallet holds several coins.
2. Make **30 to 60 transactions**, letting the wallet choose its coins and its change. The point is what the wallet does by itself, so do not pick coins by hand and do not move change anywhere on purpose.
   * Pay your **other test wallets** (so the receiver is one of yours) and an address you do not own (the faucet's return address, or a fresh address of a wallet you throw away).
   * Mix **round and odd amounts** (0.001, 0.01 and things like 0.00123456).
   * Do a few **sends of everything** (no change), and a few payments that need **several coins**.
   * Do not pay the wallet's own receive addresses: a payment to oneself makes both outputs the wallet's and is left out of the scoring.
3. If you want a transaction scored as something other than a payment (a consolidation you meant as one), note its id for the `kinds` map below.
4. Wait for everything to confirm.

## Make the case

Write `wallets.json` with the **public** descriptor of each wallet (an `xpub` or `tpub`, never a private key; the tool refuses a private key). Wallets that show one descriptor with `<0;1>` in it (Sparrow, Bitcoin Core) take `descriptor`; wallets that show two take `receive` and `change`:

```json
{
  "name": "testnet4-1",
  "network": "testnet4",
  "wallets": {
    "sparrow":  { "software": "Sparrow 2.1",  "descriptor": "wpkh([a1b2c3d4/84h/1h/0h]tpub.../<0;1>/*)" },
    "electrum": { "software": "Electrum 4.5", "receive": "wpkh(tpub.../0/*)", "change": "wpkh(tpub.../1/*)" }
  },
  "kinds": { "<a txid>": "consolidation" }
}
```

If a wallet shows only a `vpub`, `zpub` or `ypub`, convert it to a `tpub` first (any BIP 32 converter will do; the key is public) and put it in the descriptor of its address type: `wpkh(...)` for native segwit, `sh(wpkh(...))` for nested segwit, `pkh(...)` for legacy, `tr(...)` for taproot.

```
python tools/bench/make_wallet_case.py --config wallets.json --out test/benchmark/cases/wallets-v1/<name>
node test/benchmark/run.js --cases test/benchmark/cases/wallets-v1
```

The tool walks each chain until 20 addresses in a row have no history, reads their transactions, and writes `txs.json.gz`, `truth.json` and `case.json` (with a hash of the descriptors, not the descriptors). It makes about 2 requests per address, paced for a public API.

## What is scored, and what is not

A transaction counts when **all its inputs are one of your wallets'**: its change is the one output on that wallet's change chain, or none (a send of everything). Left out, and named in `truth.json`: transactions paid in from outside (`incoming`), spending from two of your wallets at once (`mixed`), paying the wallet's own receive chain (`self-send`) and having two change-chain outputs (`unclear`).

The wallet's habits in the results (where it puts its change, whether its amounts are round) are **measured** from what it did, not taken from the wallet's settings.

## Limits to keep in mind

* 30 to 60 transactions from one wallet say what its habits are, not a precise rate: the interval on a proportion of 60 is about ±12 points. Pool the wallets, and treat one wallet's numbers as a description.
* The wallets are yours: what they show is how that software behaves with your coins and your choices.
* A signet or testnet transaction is not a mainnet one. The wallet software is the same; the people who use it are not.
* An output that nobody in the case spends is treated as unspent. That is true for your own wallets and false for a payment to an outside address that is later spent, which only matters to the wallet-fingerprint sign and to peel chains.
* The case holds public data only (addresses and transactions of test networks), but a reader can tell which wallets made them. Do not use a seed that holds anything.
