# Benchmark results: real wallet software (tier B)

Written by `node test/benchmark/run.js --cases test/benchmark/cases/wallets-v1 --write-docs`; the method is in [benchmark.md](benchmark.md) and how the transactions were made is in [benchmark-wallets.md](benchmark-wallets.md). These are measurements of a version of the analysis on transactions made by real wallet software on a test network. Nothing here is guessed: an output that pays an address of the sender's change chain is its change. The synthetic results are in [benchmark-results.md](benchmark-results.md).

|  |  |
| --- | --- |
| Date | 2026-11-09 |
| Commit | 96afa28 |
| `hopline-analysis.js` SHA-256 | `0edb6ed4a15912b8` |
| Node | v24.19.0 |
| Cases | signet-core-1, testnet4-1 |

## What these numbers cannot say

- **A few wallets.** Each wallet is one program with one set of settings, used by one person; the cases table names them. The intervals are 95% intervals and are wide where the counts are small.
- **The mix was planned.** The transactions were made to a plan ([benchmark-wallets.md](benchmark-wallets.md)): so many odd and round amounts, so many to the other wallet and to a wallet outside, so many batches and sweeps. A share of the transactions here is therefore not a rate on the chain; compare the tiers, the signs and the wallets with each other, and read the rates of real traffic in [benchmark-base-rates.md](benchmark-base-rates.md).
- **A test network.** The coins come from a faucet. There are no exchanges, no mixers and no lists of names, so the CoinJoin detector and the known-wallet sign have nothing to do here.
- **What a transaction was made to be** (batch, consolidation) is what the person who made it recorded. Every other transaction counts as a payment, so a payment that has the shape of a consolidation or a batch shows up as a wrong flag.
- **Left out of the scoring:** transactions paid in from outside, transactions that spend from two wallets at once, payments to the wallet itself and transactions with two change outputs. They are in the table of the cases under their kind.

## The cases

| Case | Transactions | Wallets | Addresses | What the transactions were made to be | Made by |
| --- | --- | --- | --- | --- | --- |
| signet-core-1 | 90 | 1 | 78 | batch 2, consolidation 1, incoming 22, payment 65 | tools/bench/make_wallet_case.py |
| testnet4-1 | 286 | 2 | 339 | batch 4, consolidation 15, incoming 170, payment 96, self-send 1 | tools/bench/make_wallet_case.py |

**signet-core-1.** Bitcoin Core 31.1 on signet: one wallet that receives on p2sh-segwit and changes to bech32 (-addresstype=p2sh-segwit -changetype=bech32), paying two other wallets of the same node (legacy, p2sh-segwit, bech32 and bech32m recipients in turn) at a tiny scale: about 34,000 satoshis from the faucet at 1 sat/vB, odd amounts of 600 to 2,100 satoshis and some of 10,000, with what the other two wallets held sent back between rounds (tools/bench/drive_core.py and run_plan.py, docs/benchmark-wallets.md scaled down). Two batches (7 recipients) and one send-everything of 5 coins are marked as such by the person who made them; every other transaction counts as a payment, and the 22 incoming transactions are the faucet and the refills. The change of each transaction is the output on its change chain.

**testnet4-1.** Sparrow 2.5.5 and Electrum 4.8.3, one native segwit wallet each, paying each other and a third wallet that only received, following docs/benchmark-wallets.md. A batch (6 or more recipients) or a send-everything of 5 or more coins is marked as such by the person who made it (4 batches, 15 consolidations); every other transaction counts as a payment, including two with 5 or more inputs, one output and no change, where the amount was the payment and the wallet kept its other coins (Sparrow 7080ced38210, 16,837 sat; Electrum 861a83023bea, 10,000 sat). The change of each transaction is the output on its change chain.

## The change guess

Over 125 transactions whose change is known (signet-core-1, testnet4-1), and 58 that have none.

|  | Share of the transactions | Right when it guesses |
| --- | --- | --- |
| **Any guess** | 71.2% (62.7% to 78.4%), 89 of 125 | 94.4% (87.5% to 97.6%), 84 of 89 |
| **high** | 10.4% (6.2% to 17.0%), 13 of 125 | 100.0% (77.2% to 100.0%), 13 of 13 |
| **medium** | 51.2% (42.5% to 59.8%), 64 of 125 | 95.3% (87.1% to 98.4%), 61 of 64 |
| **low** | 9.6% (5.6% to 16.0%), 12 of 125 | 83.3% (55.2% to 95.3%), 10 of 12 |

What a guess has to beat (a rule that always answers, so its coverage is 100%): a random output is right 48.8% of the time, the largest 75.2%, the smallest 24.8%, the first 50.4%, the last 47.2%.

On transactions that have no change a guess is always wrong: Hopline made one on 0 of 58 (high 0, medium 0, low 0).

### Guesses by how many signs they rest on

A guess on one sign is worded as a lead. This says how good a lead, by tier. The signs are reuse, type, known, fingerprint, round and smaller (see the table of what each is worth, further down).

| Tier | Signs the guess rests on | Guesses | Right when guessed |
| --- | --- | --- | --- |
| high | 2 | 12 | 100.0% (75.7% to 100.0%), 12 of 12 |
| high | 3 or more | 1 | 100.0% (20.7% to 100.0%), 1 of 1 |
| medium | 1 | 62 | 95.2% (86.7% to 98.3%), 59 of 62 |
| medium | 2 | 2 | 100.0% (34.2% to 100.0%), 2 of 2 |
| low | 1 | 12 | 83.3% (55.2% to 95.3%), 10 of 12 |

The same, for the guesses that rest on one sign, by which sign:

| The one sign | Guesses | Right when guessed |
| --- | --- | --- |
| type | 62 | 95.2% (86.7% to 98.3%), 59 of 62 |
| round | 8 | 100.0% (67.6% to 100.0%), 8 of 8 |
| smaller | 4 | 50.0% (15.0% to 85.0%), 2 of 4 |

**What if** a medium guess that rests on one sign were called low (a what-if; the rule is not changed):

| Tier | Now: guesses | Now: right when guessed | If capped: guesses | If capped: right when guessed |
| --- | --- | --- | --- | --- |
| high | 13 | 100.0% (77.2% to 100.0%), 13 of 13 | 13 | 100.0% (77.2% to 100.0%), 13 of 13 |
| medium | 64 | 95.3% (87.1% to 98.4%), 61 of 64 | 2 | 100.0% (34.2% to 100.0%), 2 of 2 |
| low | 12 | 83.3% (55.2% to 95.3%), 10 of 12 | 74 | 93.2% (85.1% to 97.1%), 69 of 74 |

### What each signal is worth

The same transactions with one signal switched off. A signal that matters lowers coverage or precision when it goes. A row that equals the first means these cases never gave that signal anything to do, which says nothing about whether it is useful on real data.

|  | Share guessed | Right when guessed | Right when high |
| --- | --- | --- | --- |
| all signals | 71.2% (62.7% to 78.4%), 89 of 125 | 94.4% (87.5% to 97.6%), 84 of 89 | 100.0% (77.2% to 100.0%), 13 of 13 |
| without reuse | 71.2% (62.7% to 78.4%), 89 of 125 | 94.4% (87.5% to 97.6%), 84 of 89 | 100.0% (77.2% to 100.0%), 13 of 13 |
| without type | 21.6% (15.3% to 29.6%), 27 of 125 | 92.6% (76.6% to 97.9%), 25 of 27 | none |
| without known | 71.2% (62.7% to 78.4%), 89 of 125 | 94.4% (87.5% to 97.6%), 84 of 89 | 100.0% (77.2% to 100.0%), 13 of 13 |
| without fingerprint | 71.2% (62.7% to 78.4%), 89 of 125 | 94.4% (87.5% to 97.6%), 84 of 89 | 100.0% (77.2% to 100.0%), 13 of 13 |
| without round | 64.0% (55.3% to 71.9%), 80 of 125 | 93.8% (86.2% to 97.3%), 75 of 80 | 100.0% (61.0% to 100.0%), 6 of 6 |
| without smaller | 68.0% (59.4% to 75.5%), 85 of 125 | 96.5% (90.1% to 98.8%), 82 of 85 | 100.0% (67.6% to 100.0%), 8 of 8 |

### By how the sender's wallet behaves

**wallet software**

|  | Transactions | Share guessed | Right when guessed |
| --- | --- | --- | --- |
| Bitcoin Core 31.1, addresstype=p2sh-segwit, changetype=bech32, consolidatefeerate=1 sat/vB | 58 | 72.4% (59.8% to 82.2%), 42 of 58 | 90.5% (77.9% to 96.2%), 38 of 42 |
| Electrum 4.8.3 | 35 | 71.4% (54.9% to 83.7%), 25 of 35 | 100.0% (86.7% to 100.0%), 25 of 25 |
| Sparrow 2.5.5 | 32 | 68.8% (51.4% to 82.0%), 22 of 32 | 95.5% (78.2% to 99.2%), 21 of 22 |

**change position**

|  | Transactions | Share guessed | Right when guessed |
| --- | --- | --- | --- |
| random | 125 | 71.2% (62.7% to 78.4%), 89 of 125 | 94.4% (87.5% to 97.6%), 84 of 89 |

**receive type**

|  | Transactions | Share guessed | Right when guessed |
| --- | --- | --- | --- |
| bech32 | 67 | 70.1% (58.3% to 79.8%), 47 of 67 | 97.9% (88.9% to 99.6%), 46 of 47 |
| p2sh-segwit | 58 | 72.4% (59.8% to 82.2%), 42 of 58 | 90.5% (77.9% to 96.2%), 38 of 42 |

**change type**

|  | Transactions | Share guessed | Right when guessed |
| --- | --- | --- | --- |
| bech32 | 58 | 72.4% (59.8% to 82.2%), 42 of 58 | 90.5% (77.9% to 96.2%), 38 of 42 |
| same as receive | 67 | 70.1% (58.3% to 79.8%), 47 of 67 | 97.9% (88.9% to 99.6%), 46 of 47 |

**amounts**

|  | Transactions | Share guessed | Right when guessed |
| --- | --- | --- | --- |
| mostly not round | 125 | 71.2% (62.7% to 78.4%), 89 of 125 | 94.4% (87.5% to 97.6%), 84 of 89 |

**address reuse**

|  | Transactions | Share guessed | Right when guessed |
| --- | --- | --- | --- |
| fresh change | 125 | 71.2% (62.7% to 78.4%), 89 of 125 | 94.4% (87.5% to 97.6%), 84 of 89 |

**inputs**

|  | Transactions | Share guessed | Right when guessed |
| --- | --- | --- | --- |
| one input | 108 | 69.4% (60.2% to 77.3%), 75 of 108 | 96.0% (88.9% to 98.6%), 72 of 75 |
| several inputs | 17 | 82.4% (59.0% to 93.8%), 14 of 17 | 85.7% (60.1% to 96.0%), 12 of 14 |

### The wrong "high" guesses

0 of 13 high guesses were wrong.

## The consolidation flag

Flagged at 5 or more inputs going to 1 or 2 outputs. A sweep of deposit addresses counts as a consolidation here.

| Case | Found of those that are one | Right when flagged | Flagged of those that are not | Flagged wrongly, by what it was |
| --- | --- | --- | --- | --- |
| signet-core-1 | 100.0% (20.7% to 100.0%), 1 of 1 | 11.1% (2.0% to 43.5%), 1 of 9 | 9.0% (4.6% to 16.7%), 8 of 89 | incoming 8 |
| testnet4-1 | 100.0% (79.6% to 100.0%), 15 of 15 | 78.9% (56.7% to 91.5%), 15 of 19 | 1.5% (0.6% to 3.7%), 4 of 271 | payment 4 |

## The batch flag

Flagged at 6 or more outputs from 3 or fewer inputs.

| Case | Found of those that are one | Right when flagged | Flagged of those that are not | Flagged wrongly, by what it was |
| --- | --- | --- | --- | --- |
| signet-core-1 | 100.0% (34.2% to 100.0%), 2 of 2 | 100.0% (34.2% to 100.0%), 2 of 2 | 0.0% (0.0% to 4.2%), 0 of 88 | none |
| testnet4-1 | 25.0% (4.6% to 69.9%), 1 of 4 | 100.0% (20.7% to 100.0%), 1 of 1 | 0.0% (0.0% to 1.3%), 0 of 282 | none |

## Clusters

Addresses spent together in one transaction are put in one cluster, unless the transaction looks like a CoinJoin. A pair is right when both addresses have the same owner.

| Case | Clusters | Pairs that share an owner | Of the pairs co-spending can find | Of all pairs of spent addresses | Clusters of several owners | Pairs right without the CoinJoin exclusion |
| --- | --- | --- | --- | --- | --- | --- |
| signet-core-1 | 20 | 100.0% (81.6% to 100.0%), 17 of 17 | 100.0% (98.4% to 100.0%), 239 of 239 | 0.6% (0.4% to 0.9%), 17 of 3003 | 0 | 100.0% (81.6% to 100.0%), 17 of 17 |
| testnet4-1 | 47 | 100.0% (99.7% to 100.0%), 1139 of 1139 | 100.0% (99.7% to 100.0%), 1139 of 1139 | 4.2% (4.0% to 4.4%), 1139 of 27181 | 0 | 100.0% (99.7% to 100.0%), 1139 of 1139 |

"Pairs that share an owner" is the precision of the rule; "of the pairs co-spending can find" is its recall against the best a co-spend rule could do on these transactions (it joins every transaction that had one sender and none that mixed owners), so a shortfall there is a CoinJoin flag that was wrong; "of all pairs of spent addresses" includes pairs no transaction ever linked, so it is low for a reason that is not the rule's fault.

## Peel chains

A chain is found when the detected run covers at least 80% of the real one; a detected chain is real when 80% of it lies in one real chain, and "not made as a chain" when less than half does. The rule is a shape (one coin in, a small payment and the rest out, several times running), and ordinary wallets that pay out of one coin make the same shape, so a chain that was not made as one is the rule firing on ordinary behaviour, which is what this column counts.

| Case | Real chains | Found | Detected chains that are real | Detected, not made as a chain | Of those, per 1,000 other transactions | Steps of real chains flagged |
| --- | --- | --- | --- | --- | --- | --- |
| testnet4-1 | 0 | none | 0.0% (0.0% to 79.3%), 0 of 1 | 1 | 3.5 | none |

### The steps of the real chains, by the smaller output over the larger

The scripted chains pay 1% to 60% of the coin at each step, evenly spread on a log scale, so no step is made to suit the rule. The rule calls a transaction a peel step when the smaller of its two outputs is at most half the larger and not dust-sized (under 1,000 satoshis), and a chain needs four such steps in a row; a step that pays more than a third of the coin is therefore never one, and breaks the chain. How many steps fall there is the generator's choice, so read the rows, not the total.

| Smaller over larger | Steps | Look like a peel step | Are in a detected chain |
| --- | --- | --- | --- |
| up to 0.1 | 0 | none | none |
| 0.1 to 0.25 | 0 | none | none |
| 0.25 to 0.5 | 0 | none | none |
| over 0.5 | 0 | none | none |
| not two outputs | 0 | none | none |

