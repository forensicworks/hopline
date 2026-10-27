# Benchmarking Hopline's heuristics

Hopline guesses: which output of a transaction is the change, which addresses share an owner, which transactions are CoinJoins, which chains are peel chains. Every guess carries its reasons, and none is proof. This benchmark measures **how often each guess is right, and whether the label Hopline puts on a guess (high, medium, low) means anything**, with a harness anyone can rerun and numbers that always name the commit they were measured on.

What it does not measure: the accuracy of the lists of names ([sources.md](../sources.md)). A name there is somebody's claim, and the benchmark only counts how many addresses a list names in a case.

The results are written by the runners: [benchmark-results.md](benchmark-results.md) (the synthetic cases, tier A), [benchmark-base-rates.md](benchmark-base-rates.md) (a sample of the real chain, tier D) and [benchmark-cases.md](benchmark-cases.md) (documented cases, tier C). This file is the method.

## Status

| Phase | Work | State |
|---|---|---|
| 0 | The harness, the metrics, the committed floors the tests keep | done |
| 1 | A generator of regtest data with known ownership and known change, six scenarios, the first full results | done |
| D | How often each flag fires on a sample of the real chain, with the flagged ones read by hand | done: 4,674 transactions from 8 blocks, 2013 to 2026 |
| 2 | Real wallet software on signet or testnet4, truth from the wallets' own change chain | **tool built and tested; no data yet**: it needs a person with real wallets and faucet coins, see [benchmark-wallets.md](benchmark-wallets.md) |
| 3 | Documented public cases (court and FBI documents) as case studies | one case done (Colonial Pipeline and DarkSide); the court documents themselves could not be read, see below |
| 4 | Recalibrating on what the results show, one change at a time, each judged on a sample it was not made on, and a page for readers | two changes made and each tested on a holdout (below), and the one-sign change guess measured; the confidence tiers are not changed; the wiki has a first Accuracy page |

## What is measured

| Heuristic (in `public/js/hopline-analysis.js`) | Metrics |
|---|---|
| **Change guess.** Signals: the wallet paid itself back (100), the only output of the inputs' address type (40), the other output pays a known or tagged wallet (35), the other output is a round amount (30), smaller than every input (20), the spender looks like the same wallet software (15 or 30). The tier comes from the lead over the next output: high at 60 or more, medium at 35, low at 20, otherwise no guess. | Precision and coverage overall and per tier, with 95% intervals, so "does high beat medium" is a number. Precision with each signal switched off. The baselines a guess has to beat: a random output, the largest, the first, the last. Wrong guesses on transactions that have no change. |
| **Clusters** (common-input rule, CoinJoin-like transactions left out) | Pairwise precision (pairs put together that really share an owner), pairwise recall, clusters that join more than one owner. With the CoinJoin exclusion on and off. |
| **CoinJoin-like detector** | Recall on real CoinJoins and false positives on ordinary transactions, split by kind: exchange payouts of equal amounts, consolidations, batches, collaborative payments. |
| **Consolidation and batch flags** | Agreement with what the transaction was made to be. These flags describe a shape, so the definition is part of the result. |
| **Peel chains** | Truth chains found, detected chains that are real, and chains found that are not, per 1,000 other transactions. |

## Ground truth, in tiers

- **A. Synthetic, on regtest** (built). Bitcoin Core in Docker, wallets with known ownership, every transaction made by a script that knows which output is the change and which wallet owns which address. It checks that the rules do what they say and how sensitive they are, and it can make thousands of labelled decisions. **It only measures my own assumptions about how wallets behave**: the wallets are Bitcoin Core with varied settings, and the scenarios are the ones I thought of.
- **B. Real wallet software on testnet4 or signet** (tool built, no data yet). Sparrow, Electrum, Core, BlueWallet and a hardware wallet, with free coins. For a wallet whose descriptor is known the derivation path gives the truth exactly (the `/1/` chain is change), so no guessing is needed and no money is spent. `tools/bench/make_wallet_case.py` turns the public descriptors into a case in the format the harness reads; what a person does with the wallets is in [benchmark-wallets.md](benchmark-wallets.md).
- **C. Documented public cases** (one case). A public document says where money was and where it ended up. Whether a trace reaches the documented endpoint with each rule, how many wrong branches it takes, how many requests it needs. Reported as case studies, not as statistics. The walk is the workspace's own (`HoplineApi.Explorer.walk` and `HoplineAnalysis.successors`), with the network replaced by a recording of what the API said, so the result does not depend on the day; `node test/benchmark/trace.js --record` asks the API again.
- **D. Base rates on real traffic** (done). Random pages of 25 consecutive transactions from 8 blocks spread over 2013 to 2026, fetched by `tools/bench/fetch_mainnet_sample.py`. Nobody knows who owns what, so there is no right or wrong: only how often each flag fires, what the change guess rests on, and what the flagged transactions look like. The sample is clustered (neighbours in a block are often related) and a spend is only known when the spender is in the sample.

## The synthetic scenarios (tier A)

Each scenario is a folder in `test/benchmark/cases/regtest-v1/` with `case.json`, `txs.json.gz` (the transactions as the Esplora API returns them) and `truth.json`.

| Scenario | What it contains | What it tests |
|---|---|---|
| `payments` | 20 wallets of different habits (address type, change type, where the change goes, round or random amounts, RBF and locktime, address reuse) paying each other | The change guess and what moves it |
| `peel-chains` | Scripted peel chains of 5 to 30 steps with ordinary payments around them | Chain detection and chains that are not there |
| `batch-consolidation` | Exchange-style batch payouts, consolidations of 5 to 30 coins, ordinary payments near the thresholds | The shape flags |
| `coinjoins` | Equal-output CoinJoins of 3 to 9 participants, exchange payouts of equal amounts from several addresses (the false-positive case), ordinary payments | The CoinJoin detector and what a CoinJoin does to clusters |
| `payjoin` | Two-party payments where both sides add inputs, with ordinary payments and consolidations | Clusters that join two owners |
| `sweeps` | Customers paying deposit addresses, the exchange sweeping them into a hot wallet, batch withdrawals | Cluster recall: addresses that really are one owner |

## Running it

```
node test/benchmark/run.js                   # the committed cases, to the screen
node test/benchmark/run.js --write-docs      # also rewrite docs/benchmark-results.md
python tools/bench/make_regtest.py --out test/benchmark/cases/regtest-v1    # make the cases again (needs Docker, about half an hour)

node test/benchmark/base-rates.js [--write-docs]                           # rates on the sample of real transactions
python tools/bench/fetch_mainnet_sample.py --out test/benchmark/cases/mainnet-sample    # a new sample (public API, about 200 requests)
node test/benchmark/trace.js [--write-docs]                                # the documented cases, replayed from their recordings
node test/benchmark/trace.js --record                                      # ask the public API again and keep the answers

python tools/bench/make_wallet_case.py --config wallets.json --out test/benchmark/cases/wallets-v1/<name>    # real wallets: see benchmark-wallets.md
```

`node --test` runs the same cases and fails if a measure falls below the floors (or above the ceilings) in `test/benchmark/floors.json`, so a change to the rules cannot quietly make a guess worse. A floor is only moved with the result that justifies it. The ceilings on `mainnet-sample` are on how often a flag fires on real traffic; for the documented cases, `expect` in each `case.json` pins what each rule did, and the route of a case is checked to be a real chain of spends.

## What the first run showed (2026-10-26)

Six cases, 3,647 transactions, on `hopline-analysis.js` as it was that day (the SHA-256 is in [benchmark-results.md](benchmark-results.md), which has every number below with its interval). These are statements about the synthetic wallets, not about the chain.

- **The labels are ordered.** A high change guess was right 902 times in 903, medium 93.5% of the time, low 90.8%. The best rule that always answers (the largest output) is right 56%.
- **The "same address type" signal buys coverage and costs precision.** With it off, Hopline guesses on 49% of the transactions instead of 74%, and is right 99.9% of the time instead of 95.6%. The round-amount signal helps both. The known-wallet and fingerprint signals changed almost nothing, because these cases hardly ever give them anything to do.
- **The change guess breaks when the wallet's change type is not its receive type**: right 73% to 82% of the time then, against 99.8% when they are the same. The one wrong high guess was in a PayJoin.
- **The shape flags fire on ordinary behaviour.** A payment out of five or more coins is flagged as a consolidation (59 of 1,200 payments); an exchange payout of equal amounts is flagged as a CoinJoin (75 of 375 transactions that are not one); ordinary payments out of one coin make a chain that looks like a peel chain, 4 to 15 per 1,000 transactions. How often depends on how fragmented the generator's wallets are, which is its choice.
- **The CoinJoin exclusion is worth having.** Without it, 49% of the pairs put together in the `coinjoins` case share an owner; with it, 100%. What it costs: an exchange payout wrongly flagged loses its cluster (65% of the pairs co-spending could find are found).
- **A PayJoin joins two owners and the rule cannot tell**: 95% of the pairs in the `payjoin` case share an owner.
- **Peel chains are found step by step more than as whole chains.** A step is a peel step when the smaller output is at most half the larger, so a step that pays more than a third of the coin ends the run; 2 of the 14 whole chains were found at 80% coverage, and 71% of the steps were in a detected chain.

How these were reached, so the numbers can be weighed: the generator and the evaluator were developed on a small run (the same seed, 5% of the size). After it two things were changed, both because they were wrong, not because of a result: the cluster recall counted pairs joined through a PayJoin against an oracle that leaves PayJoins out (it could exceed 100%), and the scripted peel chains drew their payments from a short list that put about a quarter of the steps past the rule's cut-off, so the chains were broken by construction. No rule in `public/js` was changed in response; the only change there is the option that switches one change signal off, which does nothing when unset. The full-size run used the same seed (20261026), so it is a report, not a test on fresh data; phase 4 starts with a new seed.

## What real traffic showed (2026-10-26)

4,674 transactions from 8 blocks between 2013 and 2026 ([benchmark-base-rates.md](benchmark-base-rates.md)). Nobody knows who owns what in them, so none of this says whether a guess is right.

- **Both CoinJoin flags on real traffic were wrong.** The detector fired on 2 of 4,671 transactions (0.4 per 1,000). Both are from one block in 2023 and look alike: 20 inputs from 4 addresses paying 31 outputs to 5 addresses, with equal outputs of 381, 546 and 600 satoshis, and three of the addresses on both sides, so one wallet. That is a batch of dust-sized outputs (the look of inscription tooling, though the benchmark does not know), not a mix. Every equal amount in both went to **one** address, which is what the first change in phase 4 (below) is about.
- **The sample cannot say how many real CoinJoins the detector finds.** It holds no transaction of the Whirlpool shape, and three that have 3 or more equal outputs of 10,000 satoshis or more were not flagged (a payout, or a CoinJoin; the benchmark does not know). Recall on real CoinJoins needs a list of known ones.
- **The peel-chain shape is common.** 41% of the real transactions are one coin in and two outputs with the small at most half the large (the same share as in the synthetic cases, by coincidence of their mix). 3.6% sit in a detected chain (2.8% after the dust rule of the second change, below) even though only neighbours inside the sample can form one, so with a whole investigation loaded the PEEL badge will fire on ordinary traffic more often than that.
- **The shape flags are not rare either:** CONSOL on 3.5% of the transactions and BATCH on 3.2%, the same order as the synthetic mix (7.7% and 1.8%).
- **The change guess is made about as often as on the synthetic cases (71% against 70%) but for other reasons.** Address reuse is a reason in 46% of the real guesses and 3% of the synthetic ones; the "same wallet software" sign is nearly absent (0.2% against 29%) because it needs the spending transaction, which a sample does not have. 66% of the real guesses rest on one sign only, against 46%. By year, a guess was made on 56% to 57% of the transactions that can have change up to 2017 and on 71% to 80% from 2019. What the signs would be worth on real wallets is what phase 2 is for.

## A documented case: Colonial Pipeline and DarkSide (2026-10-26)

Where the 75 BTC ransom of 8 May 2021 went, as far as the seizure ([benchmark-cases.md](benchmark-cases.md) has the sources, the route and the table). What the documents say and what was read of them:

- Ransomwhere (read in the shipped pack): an address of DarkSide received two payments on 8 May 2021, 75 BTC in all.
- Elliptic (read): the affiliate's 85% (63.75 BTC) was traced to one address, 63.7 BTC of it was seized, and that address is "the same address mentioned in the seizure affidavit".
- The US Department of Justice press release and the affidavit were **not read**. The DOJ site answers with a bot check, which I did not try to get past, and the affidavit is not on a host that serves it openly.

On the chain, the route is four transactions: the payment into the DarkSide address, the 63.75 / 11.25 split, 63.7 BTC moving on, and a 24-input consolidation that pays the seized address on 28 May. Following **the largest output** reaches the end in 3 hops and 7 requests with no wrong branch. Following **every output** reaches it in 3 hops and 10 requests with 2 wrong branches, then keeps loading to its limit (80 transactions, 160 requests) because it cannot know it has arrived. **The peel-chain rule** stops at the second transaction, which has two inputs. **The likely-change rule** follows what the sender kept, which is not the payment, and ends at an unspent coin: it is a rule for following a wallet's own money.

This is one case. The route was found by walking back from the endpoint, so reaching it is partly by construction; what the case shows is what each rule does along a route that is known, not how often tracing works. More cases are added by writing a `case.json` from documents someone has read and running `node test/benchmark/trace.js --record`.

## Phase 4, first change: count recipients, not outputs (2026-10-26)

**What the real sample showed.** The two COINJOIN? flags on the first real sample paid every equal amount to **one address** (ten outputs of 600 satoshis to one address, six of 546 to another, five of 35,769 to a third): one wallet paying itself in many pieces. A CoinJoin pays each participant a different address.

**The change.** The equal outputs of a CoinJoin are counted by the number of **different addresses** they pay, not by the number of outputs (`mostEqual` in `hopline-analysis.js`). A minimum amount for the equal outputs, which was the first idea, would not have been enough: five outputs of 35,769 satoshis to one address would still have counted. Nothing else about the rule changed (3 input addresses, 3 equal outputs, and at least 5 of them or half of all the outputs).

**What it did to the data it was made on.** On the synthetic cases nothing changed: every CoinJoin and every exchange payout of equal amounts pays different addresses, so the CoinJoin detector, the clusters and every other number in [benchmark-results.md](benchmark-results.md) are the same to the digit. On the first real sample the two flags went (2 of 4,671 to 0 of 4,671).

**Judged on a sample it was not made on.** A new sample of the real chain, seed 20261101: 10,723 transactions from 8 blocks (2013 to 2026) that were not in the first. It was fetched before the change was made and not looked at until the change was finished. `node test/benchmark/compare.js --rev <earlier commit> --sample <folder>` lists what an earlier version flagged that today's does not.

| | Flagged as COINJOIN? |
|---|---|
| The rule before the change | 12 of 10,723 |
| The rule after it | 10 of 10,723 |
| Dropped by the change | 2 |
| Added by the change | 0 |

* **The two dropped** both pay their equal outputs to one address: a 2019 transaction with 36 inputs and 7 outputs of 4,900,000 satoshis to a single address, and a 2025 batch of 5 dust outputs of 600 satoshis to a single address (15 inputs from 5 addresses). Neither pays several recipients.
* **The ten kept** all look like what the rule is for, by their shape: three have the Whirlpool shape (5 inputs, 5 outputs of 0.05 BTC to five addresses), four are identical 8-input, 8-output transactions of 0.01 BTC to eight addresses, and three are larger mixes with 5 to 21 equal outputs among 20 to 296. So all three Whirlpool-shaped transactions in the sample were found; that is the first evidence on real transactions that the detector finds a shape it should, from three transactions.
* **Not flagged, with 3 or more equal outputs of 10,000 satoshis or more to different addresses** (3 transactions, from 2015 and 2017): 3 or 4 equal outputs among 10 to 21, with 24, 3 and 3 inputs. They look like ordinary batch payouts, and the rule does not flag them by design (fewer than 5 equal and fewer than half of the outputs).
* What this does **not** show: how many real CoinJoins the detector misses (the sample is not labelled; a list of known CoinJoins is needed), and whether the ten kept are CoinJoins (their shape says so, nothing else does).

**The PEEL badge.** Looked at here, and changed in the second change below (dust-sized peels). What is known about the minimum chain length, which is not changed: with 4, 3.6% of the real transactions in the first sample sat in a detected chain, and 2.0% in one of 10 or more; on the synthetic cases a longer minimum finds fewer real chains (steps of real chains in a detected chain: 75% at 3, 71% at 4, 63% at 5, 58% at 6, 52% at 8) and fewer chains that were not made as one (15.5, 6.3, 2.1, 1.2 and 0.3 per 1,000 other transactions). The minimum length is a choice between those two columns that the benchmark can show but not make.

## Phase 4, second change: a peel step is not a dust-sized output (2026-10-27)

**What the real samples showed.** Detected peel chains were sorted by shape (`docs/benchmark-base-rates.md`). On the first sample, 5 of the 19 chains (20% of the steps in chains) peel only dust, next to an OP_RETURN output; on the first holdout, 11 of the 61 (25% of the steps). The peeled amounts are exactly the dust limits of address types: 546 satoshis (the legacy limit, with OP_RETURN, in 2019) and 330 satoshis (the taproot limit, in 2025). That is the look of token and inscription transfers, where the small output is a marker, not a payment.

**The change.** The smaller output of a peel step must be at least 1,000 satoshis (`peel.minSmall` in `hopline-analysis.js`; `peel: { minSmall: 0 }` brings the old rule back). Nothing else about the rule changed: one input, two outputs, the small one at most half the large one, four in a row. The minimum chain length of 4 is **unchanged**: a longer one trades real chains found against chains that were not made as one, and the benchmark shows both but cannot choose.

**What it did to the data it was made on.** On the synthetic cases nothing changed (the scripted chains peel at least 20,000 satoshis). On the first sample, 166 transactions in chains became 132: exactly the 34 steps of the five dust chains.

**Judged on a sample it was not made on.** A second new sample, seed 20261108: 9,247 transactions from 8 blocks (2013 to 2026) that are in neither earlier sample. It was fetched before the change was made and not read until the change was finished.

| | Transactions in a detected peel chain |
|---|---|
| The rule before the change | 502 of 9,247 (5.4%), in 58 chains |
| The rule after it | 315 of 9,247 (3.4%), in 48 chains |
| Dropped by the change | 187 |
| Added by the change | 0 |

* **181 of the 187 dropped steps peel dust**: 163 peel exactly 330 satoshis (all from 2025) and 18 exactly 546, with an OP_RETURN output (2019).
* **6 are collateral**: steps that peel 2,400 satoshis and lost their chain when a dust step in the middle of it was no longer one (3% of what dropped).
* **What remains** are chains that peel the same amount again and again (11 chains) and chains inside one block (37): the shapes that look like a service paying out in turn, which the benchmark cannot call right or wrong.
* What this does **not** show: that what remains is genuine peeling. There is no truth for peel chains on real traffic; the claim is only that a peeled output at the dust limit is not a payment.

## Change guesses by the number of signs (2026-10-27)

The roadmap asks whether a change guess that rests on one sign should count as low. On the synthetic cases (the only labelled data so far; [benchmark-results.md](benchmark-results.md) has the tables):

* A **medium** guess on one sign is right **89.5%** of the time (518 of 579); on two signs **99.5%** (385 of 387).
* The weak sign is **"same address type" alone**: right **84.3%** (515 of 611), below the low tier as a whole (90.8%). "Round amount" alone (251 of 251) and "smaller than every input" alone (91 of 92) are right nearly every time, and are already low.
* If one-sign medium guesses were called low, the tiers would read: high 99.9% (903 guesses), medium 99.5% (387), low 90.0% (971). Medium would mean two agreeing signs.
* On real traffic, 66% of the change guesses rest on one sign, so on real data most "medium" guesses would be called low.

This is a measurement; the rule is **not changed**. The synthetic wallets give "same address type" a good record because most of them change to the type they receive on, and real wallets may not; the real-wallet data ([benchmark-wallets.md](benchmark-wallets.md)) is the test, and is waiting for wallets and faucet coins.

## Rules the numbers follow

- **Precision first.** A wrong guess sends an investigator down the wrong chain, so precision matters more than coverage, and both are reported.
- **Intervals.** Every proportion has a Wilson 95% interval. About 1,000 labelled decisions in a tier gives a width of about 3 points.
- **No tuning on what is reported.** Rules are developed on one set of scenarios and reported on a different one; the generator takes a seed, and a seed used for tuning is not used for reporting. Seeds so far: 20261026 (the synthetic cases, made while the harness was developed), 20261027 (the first sample of the real chain, which the change below was made on) 20261101 (the first holdout, reported once, for the CoinJoin change) and 20261108 (the second holdout, reported once, for the peel change).
- **Failures are listed.** The results include the wrong "high" guesses, with their reasons.
- **No client data, ever.** Cases are synthetic, made from our own wallets, or public documents.

## Known limits

- Synthetic wallets are a monoculture of Bitcoin Core with varied settings. Real software leaves other habits.
- Testnet may differ from mainnet in who uses it and why.
- One person's wallets are not everyone's.
- Wallet software changes, so a result is true of a version and a date.
- The shape flags (consolidation, batch) are definitions, so agreement with "what the transaction was made to be" is a statement about the thresholds, not about the world.
