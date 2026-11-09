# Benchmark results: the synthetic cases on a fresh seed

Written by `node test/benchmark/run.js --cases test/benchmark/cases/regtest-v2 --date 2026-11-09` (the output, saved as this page); the method is in [benchmark.md](benchmark.md), and what it showed beside the first run is in [A fresh seed](benchmark.md#a-fresh-seed-2026-11-09). These are measurements of a version of the analysis on synthetic data: read the limits there before reading the numbers.

|  |  |
| --- | --- |
| Date | 2026-11-09 |
| Commit | 89d62ed |
| `hopline-analysis.js` SHA-256 | `0edb6ed4a15912b8` |
| Node | v24.19.0 |
| Cases | batch-consolidation, coinjoins, payjoin, payments, peel-chains, sweeps |

## The cases

| Case | Transactions | Wallets | Addresses | What the transactions were made to be | Made by |
| --- | --- | --- | --- | --- | --- |
| batch-consolidation | 480 | 13 | 2063 | batch 40, consolidation 40, payment 400 | tools/bench/make_regtest.py, seed 20261109 |
| coinjoins | 453 | 13 | 2612 | coinjoin 60, equal-payout 93, payment 300 | tools/bench/make_regtest.py, seed 20261109 |
| payjoin | 510 | 14 | 1646 | consolidation 60, payjoin 150, payment 300 | tools/bench/make_regtest.py, seed 20261109 |
| payments | 1200 | 20 | 2459 | payment 1200 | tools/bench/make_regtest.py, seed 20261109 |
| peel-chains | 553 | 24 | 1172 | payment 367, peel 186 | tools/bench/make_regtest.py, seed 20261109 |
| sweeps | 335 | 26 | 1024 | batch 25, consolidation 10, payment 300 | tools/bench/make_regtest.py, seed 20261109 |

## The change guess

Over 3039 transactions whose change is known (batch-consolidation, coinjoins, payjoin, payments, peel-chains, sweeps), and 322 that have none.

|  | Share of the transactions | Right when it guesses |
| --- | --- | --- |
| **Any guess** | 73.0% (71.3% to 74.5%), 2217 of 3039 | 96.7% (95.9% to 97.4%), 2144 of 2217 |
| **high** | 31.0% (29.4% to 32.7%), 942 of 3039 | 99.9% (99.4% to 100.0%), 941 of 942 |
| **medium** | 28.0% (26.5% to 29.7%), 852 of 3039 | 94.1% (92.3% to 95.5%), 802 of 852 |
| **low** | 13.9% (12.7% to 15.2%), 423 of 3039 | 94.8% (92.3% to 96.5%), 401 of 423 |

What a guess has to beat (a rule that always answers, so its coverage is 100%): a random output is right 48.1% of the time, the largest 50.9%, the smallest 49.0%, the first 39.8%, the last 59.1%.

On transactions that have no change a guess is always wrong: Hopline made one on 61 of 322 (high 0, medium 57, low 4).

### Guesses by how many signs they rest on

A guess on one sign is worded as a lead. This says how good a lead, by tier. The signs are reuse, type, known, fingerprint, round and smaller (see the table of what each is worth, further down).

| Tier | Signs the guess rests on | Guesses | Right when guessed |
| --- | --- | --- | --- |
| high | 1 | 18 | 100.0% (82.4% to 100.0%), 18 of 18 |
| high | 2 | 523 | 99.8% (98.9% to 100.0%), 522 of 523 |
| high | 3 or more | 401 | 100.0% (99.1% to 100.0%), 401 of 401 |
| medium | 1 | 462 | 89.2% (86.0% to 91.7%), 412 of 462 |
| medium | 2 | 390 | 100.0% (99.0% to 100.0%), 390 of 390 |
| low | 1 | 420 | 94.8% (92.2% to 96.5%), 398 of 420 |
| low | 2 | 1 | 100.0% (20.7% to 100.0%), 1 of 1 |
| low | 3 or more | 2 | 100.0% (34.2% to 100.0%), 2 of 2 |

The same, for the guesses that rest on one sign, by which sign:

| The one sign | Guesses | Right when guessed |
| --- | --- | --- |
| type | 479 | 85.6% (82.2% to 88.5%), 410 of 479 |
| round | 309 | 100.0% (98.8% to 100.0%), 309 of 309 |
| smaller | 83 | 96.4% (89.9% to 98.8%), 80 of 83 |
| reuse | 18 | 100.0% (82.4% to 100.0%), 18 of 18 |
| fingerprint | 6 | 100.0% (61.0% to 100.0%), 6 of 6 |
| known | 5 | 100.0% (56.6% to 100.0%), 5 of 5 |

**What if** a medium guess that rests on one sign were called low (a what-if; the rule is not changed):

| Tier | Now: guesses | Now: right when guessed | If capped: guesses | If capped: right when guessed |
| --- | --- | --- | --- | --- |
| high | 942 | 99.9% (99.4% to 100.0%), 941 of 942 | 942 | 99.9% (99.4% to 100.0%), 941 of 942 |
| medium | 852 | 94.1% (92.3% to 95.5%), 802 of 852 | 390 | 100.0% (99.0% to 100.0%), 390 of 390 |
| low | 423 | 94.8% (92.3% to 96.5%), 401 of 423 | 885 | 91.9% (89.9% to 93.5%), 813 of 885 |

### What each signal is worth

The same transactions with one signal switched off. A signal that matters lowers coverage or precision when it goes. A row that equals the first means these cases never gave that signal anything to do, which says nothing about whether it is useful on real data.

|  | Share guessed | Right when guessed | Right when high |
| --- | --- | --- | --- |
| all signals | 73.0% (71.3% to 74.5%), 2217 of 3039 | 96.7% (95.9% to 97.4%), 2144 of 2217 | 99.9% (99.4% to 100.0%), 941 of 942 |
| without reuse | 72.3% (70.6% to 73.8%), 2196 of 3039 | 96.7% (95.8% to 97.3%), 2123 of 2196 | 99.9% (99.4% to 100.0%), 873 of 874 |
| without type | 53.3% (51.6% to 55.1%), 1621 of 3039 | 99.6% (99.1% to 99.8%), 1614 of 1621 | 100.0% (97.9% to 100.0%), 182 of 182 |
| without known | 72.9% (71.2% to 74.4%), 2214 of 3039 | 96.7% (95.9% to 97.4%), 2141 of 2214 | 99.9% (99.4% to 100.0%), 930 of 931 |
| without fingerprint | 73.0% (71.4% to 74.5%), 2218 of 3039 | 96.7% (95.8% to 97.3%), 2144 of 2218 | 99.9% (99.4% to 100.0%), 899 of 900 |
| without round | 59.8% (58.1% to 61.6%), 1818 of 3039 | 94.1% (92.9% to 95.1%), 1710 of 1818 | 99.7% (98.2% to 99.9%), 308 of 309 |
| without smaller | 69.2% (67.5% to 70.8%), 2103 of 3039 | 96.7% (95.8% to 97.4%), 2033 of 2103 | 100.0% (99.6% to 100.0%), 856 of 856 |
| without the known list | 76.0% (74.1% to 77.8%), 1586 of 2087 | 96.3% (95.3% to 97.2%), 1528 of 1586 | 99.9% (99.2% to 100.0%), 737 of 738 |

### By how the sender's wallet behaves

**wallet software**

|  | Transactions | Share guessed | Right when guessed |
| --- | --- | --- | --- |
| core-like | 1702 | 76.2% (74.1% to 78.2%), 1297 of 1702 | 97.4% (96.4% to 98.1%), 1263 of 1297 |
| other-like | 1179 | 77.8% (75.3% to 80.1%), 917 of 1179 | 95.7% (94.2% to 96.9%), 878 of 917 |
| service | 158 | 1.9% (0.6% to 5.4%), 3 of 158 | 100.0% (43.8% to 100.0%), 3 of 3 |

**change position**

|  | Transactions | Share guessed | Right when guessed |
| --- | --- | --- | --- |
| first | 562 | 82.9% (79.6% to 85.8%), 466 of 562 | 98.1% (96.4% to 99.0%), 457 of 466 |
| last | 1253 | 67.7% (65.0% to 70.2%), 848 of 1253 | 93.4% (91.5% to 94.9%), 792 of 848 |
| random | 1224 | 73.8% (71.2% to 76.2%), 903 of 1224 | 99.1% (98.3% to 99.6%), 895 of 903 |

**receive type**

|  | Transactions | Share guessed | Right when guessed |
| --- | --- | --- | --- |
| bech32 | 1857 | 63.2% (61.0% to 65.4%), 1174 of 1857 | 94.8% (93.4% to 95.9%), 1113 of 1174 |
| bech32m | 384 | 88.0% (84.4% to 90.9%), 338 of 384 | 96.7% (94.3% to 98.2%), 327 of 338 |
| legacy | 257 | 92.2% (88.3% to 94.9%), 237 of 257 | 100.0% (98.4% to 100.0%), 237 of 237 |
| p2sh-segwit | 541 | 86.5% (83.4% to 89.1%), 468 of 541 | 99.8% (98.8% to 100.0%), 467 of 468 |

**change type**

|  | Transactions | Share guessed | Right when guessed |
| --- | --- | --- | --- |
| bech32 | 36 | 27.8% (15.8% to 44.0%), 10 of 36 | 70.0% (39.7% to 89.2%), 7 of 10 |
| bech32m | 71 | 70.4% (59.0% to 79.8%), 50 of 71 | 78.0% (64.8% to 87.2%), 39 of 50 |
| legacy | 178 | 74.7% (67.9% to 80.5%), 133 of 178 | 67.7% (59.3% to 75.0%), 90 of 133 |
| p2sh-segwit | 43 | 76.7% (62.3% to 86.8%), 33 of 43 | 81.8% (65.6% to 91.4%), 27 of 33 |
| same as receive | 2711 | 73.4% (71.7% to 75.1%), 1991 of 2711 | 99.5% (99.1% to 99.7%), 1981 of 1991 |

**amounts**

|  | Transactions | Share guessed | Right when guessed |
| --- | --- | --- | --- |
| mostly not round | 1843 | 64.5% (62.3% to 66.7%), 1189 of 1843 | 94.5% (93.1% to 95.7%), 1124 of 1189 |
| mostly round | 1196 | 86.0% (83.9% to 87.8%), 1028 of 1196 | 99.2% (98.5% to 99.6%), 1020 of 1028 |

**address reuse**

|  | Transactions | Share guessed | Right when guessed |
| --- | --- | --- | --- |
| change reused an address | 105 | 100.0% (96.5% to 100.0%), 105 of 105 | 100.0% (96.5% to 100.0%), 105 of 105 |
| fresh change | 2934 | 72.0% (70.3% to 73.6%), 2112 of 2934 | 96.5% (95.7% to 97.2%), 2039 of 2112 |

**inputs**

|  | Transactions | Share guessed | Right when guessed |
| --- | --- | --- | --- |
| one input | 1934 | 72.9% (70.8% to 74.8%), 1409 of 1934 | 96.3% (95.2% to 97.2%), 1357 of 1409 |
| several inputs | 1105 | 73.1% (70.4% to 75.7%), 808 of 1105 | 97.4% (96.1% to 98.3%), 787 of 808 |

### The wrong "high" guesses

1 of 942 high guesses were wrong; the first 1:

| Case | Transaction | Guessed output | Change was | Why it guessed |
| --- | --- | --- | --- | --- |
| coinjoins | `5b0d18eda94d` | 0 | 1 | the only output of the same address type as the inputs (v0_p2wpkh); smaller than every input: a wallet would not have added the extra inputs just to pay it |

## The CoinJoin detector

A transaction is flagged when at least 3 input addresses and at least 3 outputs of exactly the same value to different addresses are present (and the equal outputs are at least half the outputs, or at least 5).

| Case | Found of those that are one | Right when flagged | Flagged of those that are not | Flagged wrongly, by what it was |
| --- | --- | --- | --- | --- |
| coinjoins | 100.0% (94.0% to 100.0%), 60 of 60 | 39.2% (31.8% to 47.1%), 60 of 153 | 23.7% (19.7% to 28.1%), 93 of 393 | equal-payout 93 |

## The consolidation flag

Flagged at 5 or more inputs going to 1 or 2 outputs. A sweep of deposit addresses counts as a consolidation here.

| Case | Found of those that are one | Right when flagged | Flagged of those that are not | Flagged wrongly, by what it was |
| --- | --- | --- | --- | --- |
| batch-consolidation | 100.0% (91.2% to 100.0%), 40 of 40 | 35.1% (26.9% to 44.2%), 40 of 114 | 16.8% (13.6% to 20.6%), 74 of 440 | payment 74 |
| coinjoins | none | 0.0% (0.0% to 6.9%), 0 of 52 | 11.5% (8.9% to 14.7%), 52 of 453 | payment 52 |
| payjoin | 100.0% (94.0% to 100.0%), 60 of 60 | 81.1% (70.7% to 88.4%), 60 of 74 | 3.1% (1.9% to 5.2%), 14 of 450 | payment 11, payjoin 3 |
| payments | none | 0.0% (0.0% to 6.5%), 0 of 55 | 4.6% (3.5% to 5.9%), 55 of 1200 | payment 55 |
| peel-chains | none | 0.0% (0.0% to 27.8%), 0 of 10 | 1.8% (1.0% to 3.3%), 10 of 553 | payment 10 |
| sweeps | 100.0% (72.2% to 100.0%), 10 of 10 | 76.9% (49.7% to 91.8%), 10 of 13 | 0.9% (0.3% to 2.7%), 3 of 325 | payment 3 |

## The batch flag

Flagged at 6 or more outputs from 3 or fewer inputs.

| Case | Found of those that are one | Right when flagged | Flagged of those that are not | Flagged wrongly, by what it was |
| --- | --- | --- | --- | --- |
| batch-consolidation | 100.0% (91.2% to 100.0%), 40 of 40 | 100.0% (91.2% to 100.0%), 40 of 40 | 0.0% (0.0% to 0.9%), 0 of 440 | none |
| sweeps | 100.0% (86.7% to 100.0%), 25 of 25 | 100.0% (86.7% to 100.0%), 25 of 25 | 0.0% (0.0% to 1.2%), 0 of 310 | none |

## Clusters

Addresses spent together in one transaction are put in one cluster, unless the transaction looks like a CoinJoin. A pair is right when both addresses have the same owner.

| Case | Clusters | Pairs that share an owner | Of the pairs co-spending can find | Of all pairs of spent addresses | Clusters of several owners | Pairs right without the CoinJoin exclusion |
| --- | --- | --- | --- | --- | --- | --- |
| batch-consolidation | 264 | 100.0% (100.0% to 100.0%), 7778 of 7778 | 100.0% (100.0% to 100.0%), 7778 of 7778 | 6.0% (5.9% to 6.2%), 7778 of 128964 | 0 | 100.0% (100.0% to 100.0%), 7778 of 7778 |
| coinjoins | 160 | 100.0% (99.8% to 100.0%), 2515 of 2515 | 64.4% (62.9% to 65.9%), 2515 of 3905 | 1.0% (1.0% to 1.0%), 2515 of 251837 | 0 | 52.0% (50.9% to 53.1%), 4382 of 8428 |
| payjoin | 303 | 94.5% (93.7% to 95.1%), 3759 of 3979 | 100.0% (99.9% to 100.0%), 3682 of 3682 | 4.6% (4.4% to 4.7%), 3759 of 82375 | 150 | 94.5% (93.7% to 95.1%), 3759 of 3979 |
| payments | 392 | 100.0% (99.8% to 100.0%), 1865 of 1865 | 100.0% (99.8% to 100.0%), 1865 of 1865 | 1.7% (1.7% to 1.8%), 1865 of 107444 | 0 | 100.0% (99.8% to 100.0%), 1865 of 1865 |
| peel-chains | 96 | 100.0% (99.1% to 100.0%), 423 of 423 | 100.0% (99.1% to 100.0%), 423 of 423 | 2.3% (2.1% to 2.5%), 423 of 18380 | 0 | 100.0% (99.1% to 100.0%), 423 of 423 |
| sweeps | 53 | 100.0% (99.4% to 100.0%), 630 of 630 | 100.0% (99.4% to 100.0%), 630 of 630 | 6.1% (5.7% to 6.6%), 630 of 10251 | 0 | 100.0% (99.4% to 100.0%), 630 of 630 |

"Pairs that share an owner" is the precision of the rule; "of the pairs co-spending can find" is its recall against the best a co-spend rule could do on these transactions (it joins every transaction that had one sender and none that mixed owners), so a shortfall there is a CoinJoin flag that was wrong; "of all pairs of spent addresses" includes pairs no transaction ever linked, so it is low for a reason that is not the rule's fault.

## Peel chains

A chain is found when the detected run covers at least 80% of the real one; a detected chain is real when 80% of it lies in one real chain, and "not made as a chain" when less than half does. The rule is a shape (one coin in, a small payment and the rest out, several times running), and ordinary wallets that pay out of one coin make the same shape, so a chain that was not made as one is the rule firing on ordinary behaviour, which is what this column counts.

| Case | Real chains | Found | Detected chains that are real | Detected, not made as a chain | Of those, per 1,000 other transactions | Steps of real chains flagged |
| --- | --- | --- | --- | --- | --- | --- |
| batch-consolidation | 0 | none | 0.0% (0.0% to 79.3%), 0 of 1 | 1 | 2.1 | none |
| payjoin | 0 | none | 0.0% (0.0% to 65.8%), 0 of 2 | 2 | 3.9 | none |
| payments | 0 | none | 0.0% (0.0% to 39.0%), 0 of 6 | 6 | 5.0 | none |
| peel-chains | 14 | 28.6% (11.7% to 54.6%), 4 of 14 | 100.0% (81.6% to 100.0%), 17 of 17 | 0 | 0.0 | 64.0% (56.9% to 70.5%), 119 of 186 |
| sweeps | 0 | none | 0.0% (0.0% to 65.8%), 0 of 2 | 2 | 6.0 | none |

### The steps of the real chains, by the smaller output over the larger

The scripted chains pay 1% to 60% of the coin at each step, evenly spread on a log scale, so no step is made to suit the rule. The rule calls a transaction a peel step when the smaller of its two outputs is at most half the larger and not dust-sized (under 1,000 satoshis), and a chain needs four such steps in a row; a step that pays more than a third of the coin is therefore never one, and breaks the chain. How many steps fall there is the generator's choice, so read the rows, not the total.

| Smaller over larger | Steps | Look like a peel step | Are in a detected chain |
| --- | --- | --- | --- |
| up to 0.1 | 99 | 100.0% (96.3% to 100.0%), 99 of 99 | 81.8% (73.1% to 88.2%), 81 of 99 |
| 0.1 to 0.25 | 28 | 100.0% (87.9% to 100.0%), 28 of 28 | 75.0% (56.6% to 87.3%), 21 of 28 |
| 0.25 to 0.5 | 23 | 100.0% (85.7% to 100.0%), 23 of 23 | 73.9% (53.5% to 87.5%), 17 of 23 |
| over 0.5 | 36 | 0.0% (0.0% to 9.6%), 0 of 36 | 0.0% (0.0% to 9.6%), 0 of 36 |
| not two outputs | 0 | none | none |

