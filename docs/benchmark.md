# Benchmarking Hopline's heuristics

Hopline guesses: which output of a transaction is the change, which addresses share an owner, which transactions are CoinJoins, which chains are peel chains. Every guess carries its reasons, and none is proof. This benchmark measures **how often each guess is right, and whether the label Hopline puts on a guess (high, medium, low) means anything**, with a harness anyone can rerun and numbers that always name the commit they were measured on.

What it does not measure: the accuracy of the lists of names ([sources.md](../sources.md)). A name there is somebody's claim, and the benchmark only counts how many addresses a list names in a case.

The results are in [benchmark-results.md](benchmark-results.md), written by the runner. This file is the method.

## Status

| Phase | Work | State |
|---|---|---|
| 0 | The harness, the metrics, the committed floors the tests keep | done |
| 1 | A generator of regtest data with known ownership and known change, six scenarios, the first full results | done |
| 2 | The same on testnet4 or signet with real wallet software, truth from the wallets' own derivation paths | not started |
| 3 | Documented public cases (court and FBI documents) as case studies | not started |
| 4 | Recalibrating the confidence tiers on what the results show, and a wiki page for readers | not started |

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
- **B. Real wallet software on testnet4 or signet** (planned). Sparrow, Electrum, Core, BlueWallet and a hardware wallet, with free coins. For a wallet whose descriptor is known the derivation path gives the truth exactly (the `/1/` chain is change), so no guessing is needed and no money is spent.
- **C. Documented public cases** (planned). Court and FBI documents that name transactions. Whether a trace reaches the documented endpoint, how many wrong branches it takes, how many requests it needs. Reported as case studies, not as statistics.
- **D. Base rates** (planned). A few random blocks, to show how often each flag fires on ordinary traffic, with the flagged ones read by hand.

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
```

`node --test` runs the same cases and fails if a measure falls below the floors in `test/benchmark/floors.json`, so a change to the rules cannot quietly make a guess worse. A floor is only moved with the result that justifies it.

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

## Rules the numbers follow

- **Precision first.** A wrong guess sends an investigator down the wrong chain, so precision matters more than coverage, and both are reported.
- **Intervals.** Every proportion has a Wilson 95% interval. About 1,000 labelled decisions in a tier gives a width of about 3 points.
- **No tuning on what is reported.** Rules are developed on one set of scenarios and reported on a different one; the generator takes a seed, and a seed used for tuning is not used for reporting.
- **Failures are listed.** The results include the wrong "high" guesses, with their reasons.
- **No client data, ever.** Cases are synthetic, made from our own wallets, or public documents.

## Known limits

- Synthetic wallets are a monoculture of Bitcoin Core with varied settings. Real software leaves other habits.
- Testnet may differ from mainnet in who uses it and why.
- One person's wallets are not everyone's.
- Wallet software changes, so a result is true of a version and a date.
- The shape flags (consolidation, batch) are definitions, so agreement with "what the transaction was made to be" is a statement about the thresholds, not about the world.
