# Benchmark results

Written by `node test/benchmark/run.js --write-docs`; the method is in [benchmark.md](benchmark.md). These are measurements of a version of the analysis on synthetic data: read the limits there before reading the numbers.

|  |  |
| --- | --- |
| Date | 2026-10-26 |
| Commit | b4236f6 |
| `hopline-analysis.js` SHA-256 | `d14f004b301157c2` |
| Node | v24.19.0 |
| Cases | batch-consolidation, coinjoins, payjoin, payments, peel-chains, sweeps |

## The cases

| Case | Transactions | Wallets | Addresses | What the transactions were made to be | Made by |
| --- | --- | --- | --- | --- | --- |
| batch-consolidation | 480 | 13 | 2121 | batch 40, consolidation 40, payment 400 | tools/bench/make_regtest.py, seed 20261026 |
| coinjoins | 435 | 13 | 2508 | coinjoin 60, equal-payout 75, payment 300 | tools/bench/make_regtest.py, seed 20261026 |
| payjoin | 510 | 14 | 1640 | consolidation 60, payjoin 150, payment 300 | tools/bench/make_regtest.py, seed 20261026 |
| payments | 1200 | 20 | 2492 | payment 1200 | tools/bench/make_regtest.py, seed 20261026 |
| peel-chains | 686 | 24 | 1420 | payment 387, peel 299 | tools/bench/make_regtest.py, seed 20261026 |
| sweeps | 336 | 26 | 1016 | batch 25, consolidation 11, payment 300 | tools/bench/make_regtest.py, seed 20261026 |

## The change guess

Over 3068 transactions whose change is known (batch-consolidation, coinjoins, payjoin, payments, peel-chains, sweeps), and 408 that have none.

|  | Share of the transactions | Right when it guesses |
| --- | --- | --- |
| **Any guess** | 73.7% (72.1% to 75.2%), 2261 of 3068 | 95.6% (94.6% to 96.4%), 2161 of 2261 |
| **high** | 29.4% (27.8% to 31.1%), 903 of 3068 | 99.9% (99.4% to 100.0%), 902 of 903 |
| **medium** | 31.5% (29.9% to 33.2%), 966 of 3068 | 93.5% (91.7% to 94.9%), 903 of 966 |
| **low** | 12.8% (11.6% to 14.0%), 392 of 3068 | 90.8% (87.5% to 93.3%), 356 of 392 |

What a guess has to beat (a rule that always answers, so its coverage is 100%): a random output is right 48.3% of the time, the largest 56.4%, the smallest 43.5%, the first 45.3%, the last 53.6%.

On transactions that have no change a guess is always wrong: Hopline made one on 86 of 408 (high 1, medium 78, low 7).

### What each signal is worth

The same transactions with one signal switched off. A signal that matters lowers coverage or precision when it goes. A row that equals the first means these cases never gave that signal anything to do, which says nothing about whether it is useful on real data.

|  | Share guessed | Right when guessed | Right when high |
| --- | --- | --- | --- |
| all signals | 73.7% (72.1% to 75.2%), 2261 of 3068 | 95.6% (94.6% to 96.4%), 2161 of 2261 | 99.9% (99.4% to 100.0%), 902 of 903 |
| without reuse | 73.5% (71.9% to 75.1%), 2256 of 3068 | 95.6% (94.6% to 96.3%), 2156 of 2256 | 99.9% (99.3% to 100.0%), 864 of 865 |
| without type | 48.6% (46.9% to 50.4%), 1492 of 3068 | 99.9% (99.5% to 100.0%), 1490 of 1492 | 100.0% (97.6% to 100.0%), 159 of 159 |
| without known | 73.8% (72.2% to 75.3%), 2263 of 3068 | 95.4% (94.5% to 96.2%), 2159 of 2263 | 99.9% (99.4% to 100.0%), 893 of 894 |
| without fingerprint | 73.8% (72.2% to 75.4%), 2265 of 3068 | 95.4% (94.5% to 96.2%), 2161 of 2265 | 99.9% (99.3% to 100.0%), 866 of 867 |
| without round | 64.0% (62.2% to 65.6%), 1962 of 3068 | 92.2% (90.9% to 93.3%), 1809 of 1962 | 99.6% (97.8% to 99.9%), 251 of 252 |
| without smaller | 70.2% (68.6% to 71.8%), 2154 of 3068 | 95.3% (94.3% to 96.1%), 2052 of 2154 | 100.0% (99.5% to 100.0%), 823 of 823 |
| without the known list | 75.3% (73.4% to 77.1%), 1522 of 2021 | 94.7% (93.5% to 95.8%), 1442 of 1522 | 100.0% (99.5% to 100.0%), 700 of 700 |

### By how the sender's wallet behaves

**wallet software**

|  | Transactions | Share guessed | Right when guessed |
| --- | --- | --- | --- |
| core-like | 1420 | 74.9% (72.6% to 77.1%), 1064 of 1420 | 97.6% (96.4% to 98.3%), 1038 of 1064 |
| other-like | 1508 | 79.2% (77.1% to 81.2%), 1194 of 1508 | 93.8% (92.3% to 95.0%), 1120 of 1194 |
| service | 140 | 2.1% (0.7% to 6.1%), 3 of 140 | 100.0% (43.8% to 100.0%), 3 of 3 |

**change position**

|  | Transactions | Share guessed | Right when guessed |
| --- | --- | --- | --- |
| first | 898 | 79.6% (76.9% to 82.1%), 715 of 898 | 96.1% (94.4% to 97.3%), 687 of 715 |
| last | 1196 | 71.1% (68.4% to 73.6%), 850 of 1196 | 95.8% (94.2% to 96.9%), 814 of 850 |
| random | 974 | 71.5% (68.5% to 74.2%), 696 of 974 | 94.8% (92.9% to 96.2%), 660 of 696 |

**receive type**

|  | Transactions | Share guessed | Right when guessed |
| --- | --- | --- | --- |
| bech32 | 1789 | 65.5% (63.3% to 67.7%), 1172 of 1789 | 92.9% (91.3% to 94.3%), 1089 of 1172 |
| bech32m | 612 | 78.9% (75.5% to 82.0%), 483 of 612 | 98.8% (97.3% to 99.4%), 477 of 483 |
| legacy | 260 | 96.5% (93.6% to 98.2%), 251 of 260 | 98.4% (96.0% to 99.4%), 247 of 251 |
| p2sh-segwit | 407 | 87.2% (83.6% to 90.1%), 355 of 407 | 98.0% (96.0% to 99.0%), 348 of 355 |

**change type**

|  | Transactions | Share guessed | Right when guessed |
| --- | --- | --- | --- |
| bech32m | 166 | 67.5% (60.0% to 74.1%), 112 of 166 | 80.4% (72.0% to 86.7%), 90 of 112 |
| legacy | 251 | 63.3% (57.2% to 69.1%), 159 of 251 | 73.0% (65.6% to 79.3%), 116 of 159 |
| p2sh-segwit | 216 | 77.8% (71.8% to 82.8%), 168 of 216 | 81.5% (75.0% to 86.7%), 137 of 168 |
| same as receive | 2435 | 74.8% (73.1% to 76.5%), 1822 of 2435 | 99.8% (99.4% to 99.9%), 1818 of 1822 |

**amounts**

|  | Transactions | Share guessed | Right when guessed |
| --- | --- | --- | --- |
| mostly not round | 2107 | 68.3% (66.3% to 70.3%), 1440 of 2107 | 93.4% (92.0% to 94.6%), 1345 of 1440 |
| mostly round | 961 | 85.4% (83.1% to 87.5%), 821 of 961 | 99.4% (98.6% to 99.7%), 816 of 821 |

**address reuse**

|  | Transactions | Share guessed | Right when guessed |
| --- | --- | --- | --- |
| change reused an address | 74 | 100.0% (95.1% to 100.0%), 74 of 74 | 100.0% (95.1% to 100.0%), 74 of 74 |
| fresh change | 2994 | 73.0% (71.4% to 74.6%), 2187 of 2994 | 95.4% (94.5% to 96.2%), 2087 of 2187 |

**inputs**

|  | Transactions | Share guessed | Right when guessed |
| --- | --- | --- | --- |
| one input | 2133 | 74.4% (72.5% to 76.2%), 1586 of 2133 | 95.9% (94.8% to 96.8%), 1521 of 1586 |
| several inputs | 935 | 72.2% (69.2% to 75.0%), 675 of 935 | 94.8% (92.9% to 96.2%), 640 of 675 |

### The wrong "high" guesses

1 of 903 high guesses were wrong; the first 1:

| Case | Transaction | Guessed output | Change was | Why it guessed |
| --- | --- | --- | --- | --- |
| payjoin | `801efc46242d` | 0 | 1 | the only output of the same address type as the inputs (v0_p2wpkh); smaller than every input: a wallet would not have added the extra inputs just to pay it |

## The CoinJoin detector

A transaction is flagged when at least 3 input addresses and at least 3 outputs of exactly the same value to different addresses are present (and the equal outputs are at least half the outputs, or at least 5).

| Case | Found of those that are one | Right when flagged | Flagged of those that are not | Flagged wrongly, by what it was |
| --- | --- | --- | --- | --- |
| coinjoins | 100.0% (94.0% to 100.0%), 60 of 60 | 44.4% (36.3% to 52.9%), 60 of 135 | 20.0% (16.3% to 24.3%), 75 of 375 | equal-payout 75 |

## The consolidation flag

Flagged at 5 or more inputs going to 1 or 2 outputs. A sweep of deposit addresses counts as a consolidation here.

| Case | Found of those that are one | Right when flagged | Flagged of those that are not | Flagged wrongly, by what it was |
| --- | --- | --- | --- | --- |
| batch-consolidation | 100.0% (91.2% to 100.0%), 40 of 40 | 40.4% (31.3% to 50.3%), 40 of 99 | 13.4% (10.5% to 16.9%), 59 of 440 | payment 59 |
| coinjoins | none | 0.0% (0.0% to 10.7%), 0 of 32 | 7.4% (5.3% to 10.2%), 32 of 435 | payment 32 |
| payjoin | 100.0% (94.0% to 100.0%), 60 of 60 | 98.4% (91.3% to 99.7%), 60 of 61 | 0.2% (0.0% to 1.2%), 1 of 450 | payment 1 |
| payments | none | 0.0% (0.0% to 6.1%), 0 of 59 | 4.9% (3.8% to 6.3%), 59 of 1200 | payment 59 |
| peel-chains | none | 0.0% (0.0% to 18.4%), 0 of 17 | 2.5% (1.6% to 3.9%), 17 of 686 | payment 17 |
| sweeps | 100.0% (74.1% to 100.0%), 11 of 11 | 91.7% (64.6% to 98.5%), 11 of 12 | 0.3% (0.1% to 1.7%), 1 of 325 | payment 1 |

## The batch flag

Flagged at 6 or more outputs from 3 or fewer inputs.

| Case | Found of those that are one | Right when flagged | Flagged of those that are not | Flagged wrongly, by what it was |
| --- | --- | --- | --- | --- |
| batch-consolidation | 100.0% (91.2% to 100.0%), 40 of 40 | 100.0% (91.2% to 100.0%), 40 of 40 | 0.0% (0.0% to 0.9%), 0 of 440 | none |
| sweeps | 100.0% (86.7% to 100.0%), 25 of 25 | 100.0% (86.7% to 100.0%), 25 of 25 | 0.0% (0.0% to 1.2%), 0 of 311 | none |

## Clusters

Addresses spent together in one transaction are put in one cluster, unless the transaction looks like a CoinJoin. A pair is right when both addresses have the same owner.

| Case | Clusters | Pairs that share an owner | Of the pairs co-spending can find | Of all pairs of spent addresses | Clusters of several owners | Pairs right without the CoinJoin exclusion |
| --- | --- | --- | --- | --- | --- | --- |
| batch-consolidation | 228 | 100.0% (100.0% to 100.0%), 9770 of 9770 | 100.0% (100.0% to 100.0%), 9770 of 9770 | 7.4% (7.2% to 7.5%), 9770 of 132805 | 0 | 100.0% (100.0% to 100.0%), 9770 of 9770 |
| coinjoins | 128 | 100.0% (99.9% to 100.0%), 2600 of 2600 | 64.9% (63.4% to 66.4%), 2600 of 4005 | 1.2% (1.2% to 1.3%), 2600 of 215743 | 0 | 49.4% (48.4% to 50.4%), 4519 of 9144 |
| payjoin | 273 | 95.1% (94.4% to 95.7%), 3921 of 4122 | 100.0% (99.9% to 100.0%), 3870 of 3870 | 5.2% (5.1% to 5.4%), 3921 of 74864 | 150 | 95.1% (94.4% to 95.7%), 3921 of 4122 |
| payments | 375 | 100.0% (99.8% to 100.0%), 1823 of 1823 | 100.0% (99.8% to 100.0%), 1823 of 1823 | 1.7% (1.6% to 1.8%), 1823 of 106829 | 0 | 100.0% (99.8% to 100.0%), 1823 of 1823 |
| peel-chains | 82 | 100.0% (99.3% to 100.0%), 546 of 546 | 100.0% (99.3% to 100.0%), 546 of 546 | 2.5% (2.3% to 2.7%), 546 of 21740 | 0 | 100.0% (99.3% to 100.0%), 546 of 546 |
| sweeps | 55 | 100.0% (99.3% to 100.0%), 550 of 550 | 100.0% (99.3% to 100.0%), 550 of 550 | 5.6% (5.2% to 6.1%), 550 of 9761 | 0 | 100.0% (99.3% to 100.0%), 550 of 550 |

"Pairs that share an owner" is the precision of the rule; "of the pairs co-spending can find" is its recall against the best a co-spend rule could do on these transactions (it joins every transaction that had one sender and none that mixed owners), so a shortfall there is a CoinJoin flag that was wrong; "of all pairs of spent addresses" includes pairs no transaction ever linked, so it is low for a reason that is not the rule's fault.

## Peel chains

A chain is found when the detected run covers at least 80% of the real one; a detected chain is real when 80% of it lies in one real chain, and "not made as a chain" when less than half does. The rule is a shape (one coin in, a small payment and the rest out, several times running), and ordinary wallets that pay out of one coin make the same shape, so a chain that was not made as one is the rule firing on ordinary behaviour, which is what this column counts.

| Case | Real chains | Found | Detected chains that are real | Detected, not made as a chain | Of those, per 1,000 other transactions | Steps of real chains flagged |
| --- | --- | --- | --- | --- | --- | --- |
| batch-consolidation | 0 | none | 0.0% (0.0% to 65.8%), 0 of 2 | 2 | 4.2 | none |
| coinjoins | 0 | none | 0.0% (0.0% to 65.8%), 0 of 2 | 2 | 4.6 | none |
| payjoin | 0 | none | 0.0% (0.0% to 56.2%), 0 of 3 | 3 | 5.9 | none |
| payments | 0 | none | 0.0% (0.0% to 35.4%), 0 of 7 | 7 | 5.8 | none |
| peel-chains | 14 | 14.3% (4.0% to 39.9%), 2 of 14 | 92.9% (77.4% to 98.0%), 26 of 28 | 2 | 5.2 | 70.9% (65.5% to 75.8%), 212 of 299 |
| sweeps | 0 | none | 0.0% (0.0% to 43.4%), 0 of 5 | 5 | 14.9 | none |

### The steps of the real chains, by the smaller output over the larger

The scripted chains pay 1% to 60% of the coin at each step, evenly spread on a log scale, so no step is made to suit the rule. The rule calls a transaction a peel step when the smaller of its two outputs is at most half the larger, and a chain needs four such steps in a row; a step that pays more than a third of the coin is therefore never one, and breaks the chain. How many steps fall there is the generator's choice, so read the rows, not the total.

| Smaller over larger | Steps | Look like a peel step | Are in a detected chain |
| --- | --- | --- | --- |
| up to 0.1 | 145 | 100.0% (97.4% to 100.0%), 145 of 145 | 81.4% (74.3% to 86.9%), 118 of 145 |
| 0.1 to 0.25 | 67 | 100.0% (94.6% to 100.0%), 67 of 67 | 83.6% (72.9% to 90.6%), 56 of 67 |
| 0.25 to 0.5 | 40 | 100.0% (91.2% to 100.0%), 40 of 40 | 95.0% (83.5% to 98.6%), 38 of 40 |
| over 0.5 | 47 | 0.0% (0.0% to 7.6%), 0 of 47 | 0.0% (0.0% to 7.6%), 0 of 47 |
| not two outputs | 0 | none | none |

