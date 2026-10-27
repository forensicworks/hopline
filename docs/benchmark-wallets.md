# Benchmarking with real wallet software (tier B)

The synthetic cases in [benchmark.md](benchmark.md) are all Bitcoin Core, with different settings. Real wallets choose coins, change types, change positions and amounts in their own ways, and that is what this tier measures. The truth is free: a wallet's descriptor says which of its addresses are on the **change chain** (the `/1/` branch), so the output of a transaction that pays that chain is its change, and the wallet cannot be wrong about it.

The tool is `tools/bench/make_wallet_case.py`. What is built and tested: reading the public descriptors, deriving the addresses with Bitcoin Core, reading the transactions from an Esplora API, working out the truth, and writing a case folder the harness reads. **What does not exist yet is the data**: it needs a person with real wallets and a few faucet coins. This page is what that person does, step by step.

## What you need

* A test network. **Testnet4** is the easier one with Sparrow: from version 1.9.1 it is built in (*Tools > Restart In Testnet4*, with a public server run by mempool). **Signet** is a more stable chain, but a wallet needs an Electrum server for it. Both have an Esplora API on mempool.space, which is what the tool reads (`"network": "testnet4"` or `"signet"` in the config). Nothing here touches mainnet.
* **At least two different wallet programs**, each with a **fresh wallet** (a new seed made for this, never one that holds or has held real bitcoin). The point is different software, because the synthetic wallets are all Bitcoin Core: Sparrow, Electrum, Bitcoin Core, Blockstream Green, a hardware wallet through Sparrow (that is Sparrow's behaviour, not the device's). Check that the program supports the test network you chose (testnet4 is recent; look in its network settings or `--help`). A second wallet in another address type from the same program is a useful extra, not a substitute.
* **One throwaway wallet** (any program, call it D) whose addresses you will pay and never share with me. Payments to D are payments to "somebody else".
* Coins from a **faucet**. Faucets come and go and most are rate-limited (a captcha, or an account): search for a current one for your network and check its date; none was verified when this was written. Each claim is usually small, so plan on several. Testnet4 can be reset to a new genesis block: make the case soon after the transactions, because the case folder keeps the data and a reset takes the chain away.
* Docker (the tool derives addresses with Bitcoin Core in a container, so no address encoding is written twice) and Python 3, on the machine that runs the tool.
* About two hours of work, plus waiting for the faucet and for confirmations.

## The plan: about 40 transactions per wallet

Every transaction should be made **by the wallet's own coin selection and change**: do not pick coins by hand, do not choose where the change goes, do not bump fees. That is what is being measured. Call your wallets A and B (and C), the throwaway D.

**1. Fund.** Ask the faucet for coins **at least six times**, each time to a **new receive address** of A (the Receive tab gives a new one each time), so that A holds several separate coins. Then pay B (and C) from A a few times with ordinary payments, so that each wallet holds at least six coins. Those payments from A count as A's transactions.

**2. Make the transactions**, per wallet, in this order (the last ones empty the wallet, so they go last):

| How many | What | Why it is in the plan |
|---|---|---|
| 10 | Pay another of your test wallets, an **odd** amount (0.00123, 0.00457, 0.00891, ...) | ordinary payments, the common case |
| 8 | Pay another test wallet or D, a **round** amount (0.001, 0.002, 0.005, 0.01, 0.02) | the round-amount sign |
| 8 | Pay D an odd amount | payments to somebody else |
| 4 | Pay an amount **larger than any single coin** the wallet holds | forces several inputs |
| 2 | **One transaction with six or more recipients** (the wallet's *add recipient* feature; use new addresses of D) | the batch shape |
| 2 | **Send everything** (the *max* button) to D, with **five or more coins** in the wallet | the consolidation shape, and no change |
| 4 | **Send everything** from a wallet holding **one or two coins** to D | no change at all |

Keep a note of the ids of the batch and consolidation transactions: they go in `kinds` below, so they are scored as what you meant them to be. Between rounds, send fresh coins into the wallets again (from the faucet, or from another of your wallets).

**3. Do not** pay a wallet's own receive addresses (a payment to oneself makes both outputs the wallet's and is left out of the scoring), and do not spend from two of your wallets in one transaction.

**4. Wait** until everything is confirmed.

## Find the public descriptor of each wallet

The tool needs **public** keys only (an `xpub` or `tpub`, never a seed or a private key; it refuses anything that looks like one).

* **Sparrow:** open the wallet and look at the *Settings* tab: it shows the script type and the descriptor.
* **Bitcoin Core:** `bitcoin-cli -testnet4 listdescriptors` (it shows public keys unless you ask for private ones). It lists two descriptors for each address type: the one marked `"internal": true` is the change chain.
* **Electrum:** *Wallet > Information* shows the master public key. On a test network a native segwit wallet shows a `vpub...`: that is not a descriptor key, it has to be converted to a `tpub...` (any BIP 32 key converter does it; the key is public). If you prefer, send me the `vpub` and the script type and I will convert it.
* **A hardware wallet through Sparrow:** the same as Sparrow.

A descriptor wraps the key in the wallet's address type: `wpkh(...)` for native segwit, `sh(wpkh(...))` for nested segwit, `pkh(...)` for legacy, `tr(...)` for taproot, followed by `/0/*` for receiving addresses and `/1/*` for change.

## Make the case

Write `wallets.json`. A wallet that shows **one** descriptor with `<0;1>` in it takes `descriptor`; a wallet that shows **two** (one ending `/0/*`, the other `/1/*`) takes `receive` and `change`:

```json
{
  "name": "testnet4-1",
  "network": "testnet4",
  "wallets": {
    "sparrow":  { "software": "Sparrow 2.1",  "descriptor": "wpkh([a1b2c3d4/84h/1h/0h]tpub.../<0;1>/*)" },
    "electrum": { "software": "Electrum 4.5", "receive": "wpkh(tpub.../0/*)", "change": "wpkh(tpub.../1/*)" }
  },
  "kinds": { "<the id of a batch>": "batch", "<the id of a consolidation>": "consolidation" }
}
```

```
python tools/bench/make_wallet_case.py --config wallets.json --out test/benchmark/cases/wallets-v1/<name>
node test/benchmark/run.js --cases test/benchmark/cases/wallets-v1
```

The tool walks each chain until 20 addresses in a row have no history, reads their transactions, and writes `txs.json.gz`, `truth.json` and `case.json` (with a hash of the descriptors, not the descriptors). It makes about 2 requests per address, paced for a public API.

## What to send, if somebody else runs the tool

For each wallet: the program and its version, the network, the script type, the **public** descriptor (or the `vpub`/`zpub` and the script type), and the ids of the batch and consolidation transactions. Nothing else, and never a seed or a private key.

## What is scored, and what is not

A transaction counts when **all its inputs are one of your wallets'**: its change is the one output on that wallet's change chain, or none (a send of everything). Left out, and named in `truth.json`: transactions paid in from outside (`incoming`), spending from two of your wallets at once (`mixed`), paying the wallet's own receive chain (`self-send`) and having two change-chain outputs (`unclear`).

The wallet's habits in the results (where it puts its change, whether its amounts are round) are **measured** from what it did, not taken from the wallet's settings.

## Limits to keep in mind

* 30 to 60 transactions from one wallet say what its habits are, not a precise rate: the interval on a proportion of 60 is about ±12 points. Pool the wallets, and treat one wallet's numbers as a description.
* The wallets are yours: what they show is how that software behaves with your coins and your choices.
* A signet or testnet transaction is not a mainnet one. The wallet software is the same; the people who use it are not.
* An output that nobody in the case spends is treated as unspent. That is true for your own wallets and false for a payment to an outside address that is later spent, which only matters to the wallet-fingerprint sign and to peel chains.
* The case holds public data only (addresses and transactions of test networks), but a reader can tell which wallets made them. Do not use a seed that holds anything.
