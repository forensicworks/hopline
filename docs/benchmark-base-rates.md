# Benchmark: rates on real traffic

Written by `node test/benchmark/base-rates.js --write-docs`; the method is in [benchmark.md](benchmark.md) (tier D). Nobody knows who owns what in a sample of the chain, so these are **rates and shapes, not accuracy**: a flag that fires is not wrong for it, and one that does not fire is not right.

|  |  |
| --- | --- |
| Date | 2026-10-26 |
| Commit | b4236f6 |
| `hopline-analysis.js` SHA-256 | `d14f004b301157c2` |
| Sample | mn_full2: 4671 transactions (the coinbase of a block left out), 8 blocks |
| Chosen by | tools/bench/fetch_mainnet_sample.py, seed 20261027 |

## The sample

Random pages of 25 consecutive transactions from blocks spread over the years. Neighbours in a block are often related, so the sample is clustered and the intervals below are a little too narrow. A rate pools the transactions as sampled, not as the blocks were full, so it is the rate over this sample, and the early blocks (small) weigh more than their share of the chain.

| Block | Date | Transactions in the block | Taken |
| --- | --- | --- | --- |
| 230027 | 2013-04-06 | 55 | 55 |
| 339270 | 2015-01-16 | 128 | 128 |
| 499965 | 2017-12-18 | 2102 | 750 |
| 565480 | 2019-03-03 | 3106 | 750 |
| 676495 | 2021-03-27 | 1976 | 750 |
| 806222 | 2023-09-04 | 2091 | 741 |
| 890293 | 2025-03-31 | 3380 | 750 |
| 960005 | 2026-07-28 | 4218 | 750 |

## What the transactions look like

Share of the sample by the number of inputs (down) and outputs (across). The synthetic cases, which were made to exercise the flags, are shown beside it.

|  | 1 out | 2 out | 3 to 5 out | 6 or more out |
| --- | --- | --- | --- | --- |
| 1 in | 13.5% (synthetic 0.3%) | 52.5% (synthetic 63.1%) | 6.0% (synthetic 0.0%) | 2.6% (synthetic 1.6%) |
| 2 to 4 in | 4.0% (synthetic 2.1%) | 14.6% (synthetic 21.4%) | 1.3% (synthetic 0.0%) | 0.9% (synthetic 0.4%) |
| 5 to 9 in | 0.6% (synthetic 3.1%) | 1.0% (synthetic 1.7%) | 0.3% (synthetic 0.5%) | 0.3% (synthetic 1.7%) |
| 10 or more in | 1.2% (synthetic 2.6%) | 0.6% (synthetic 0.3%) | 0.3% (synthetic 0.0%) | 0.3% (synthetic 1.2%) |

## How often each flag fires

| Flag | Real traffic | Per 1,000 transactions | The synthetic cases |
| --- | --- | --- | --- |
| COINJOIN? | 0.0% (0.0% to 0.1%), 0 of 4671 | 0.0 | 3.7% (3.1% to 4.4%), 135 of 3647 |
| CONSOL | 3.5% (3.0% to 4.1%), 163 of 4671 | 34.9 | 7.7% (6.9% to 8.6%), 280 of 3647 |
| BATCH | 3.2% (2.7% to 3.7%), 148 of 4671 | 31.7 | 1.8% (1.4% to 2.3%), 65 of 3647 |
| A single peel step (one input, two outputs, the small one at most half the large one) | 40.8% (39.4% to 42.2%), 1905 of 4671 | 407.8 | 40.9% (39.3% to 42.5%), 1492 of 3647 |
| In a detected peel chain (needs the next transaction in the sample, so this is a floor) | 3.6% (3.1% to 4.1%), 166 of 4671 | 35.5 | 8.6% (7.8% to 9.6%), 315 of 3647 |

The synthetic column is the six synthetic cases together (3647 transactions); their mix was chosen to exercise the flags, so it says how far from ordinary traffic they are and nothing else.

### By year

| Year | Transactions | COINJOIN? | CONSOL | BATCH | Change guessed, of those with two or more outputs |
| --- | --- | --- | --- | --- | --- |
| 2013 | 54 | 0.0% (0.0% to 6.6%), 0 of 54 | 7.4% (2.9% to 17.6%), 4 of 54 | 1.9% (0.3% to 9.8%), 1 of 54 | 57.4% (43.3% to 70.5%), 27 of 47 |
| 2015 | 127 | 0.0% (0.0% to 2.9%), 0 of 127 | 2.4% (0.8% to 6.7%), 3 of 127 | 0.0% (0.0% to 2.9%), 0 of 127 | 57.3% (47.9% to 66.1%), 63 of 110 |
| 2017 | 749 | 0.0% (0.0% to 0.5%), 0 of 749 | 4.3% (3.0% to 6.0%), 32 of 749 | 2.3% (1.4% to 3.6%), 17 of 749 | 56.1% (52.3% to 59.8%), 375 of 669 |
| 2019 | 750 | 0.0% (0.0% to 0.5%), 0 of 750 | 1.6% (0.9% to 2.8%), 12 of 750 | 1.3% (0.7% to 2.4%), 10 of 750 | 79.9% (76.1% to 83.3%), 378 of 473 |
| 2021 | 750 | 0.0% (0.0% to 0.5%), 0 of 750 | 3.3% (2.3% to 4.9%), 25 of 750 | 5.3% (3.9% to 7.2%), 40 of 750 | 76.3% (72.7% to 79.6%), 439 of 575 |
| 2023 | 741 | 0.0% (0.0% to 0.5%), 0 of 741 | 7.7% (6.0% to 9.8%), 57 of 741 | 3.4% (2.3% to 4.9%), 25 of 741 | 72.9% (68.9% to 76.7%), 364 of 499 |
| 2025 | 750 | 0.0% (0.0% to 0.5%), 0 of 750 | 2.4% (1.5% to 3.8%), 18 of 750 | 2.9% (1.9% to 4.4%), 22 of 750 | 77.2% (73.4% to 80.6%), 403 of 522 |
| 2026 | 750 | 0.0% (0.0% to 0.5%), 0 of 750 | 1.6% (0.9% to 2.8%), 12 of 750 | 4.4% (3.1% to 6.1%), 33 of 750 | 71.0% (67.2% to 74.6%), 402 of 566 |

## The change guess on real transactions

On transactions with two or more payment outputs (the ones that can have a change output). Whether a guess is right cannot be known here; only how often one is made, and on what.

|  | Real traffic | The synthetic cases |
| --- | --- | --- |
| Transactions with two or more outputs | 3461 | 3355 |
| A guess was made | 70.8% (69.3% to 72.3%), 2451 of 3461 | 70.3% (68.7% to 71.8%), 2358 of 3355 |
| High | 38.7% (37.1% to 40.4%), 1340 of 3461 | 26.6% (25.2% to 28.2%), 894 of 3355 |
| Medium | 21.5% (20.1% to 22.9%), 743 of 3461 | 31.3% (29.7% to 32.9%), 1049 of 3355 |
| Low | 10.6% (9.6% to 11.7%), 368 of 3461 | 12.4% (11.3% to 13.5%), 415 of 3355 |
| Of the guesses, resting on one sign only | 66.1% (64.2% to 67.9%), 1619 of 2451 | 45.5% (43.5% to 47.5%), 1073 of 2358 |

**Which signs the guesses rest on** (a guess can have several):

| Sign | Real traffic | The synthetic cases |
| --- | --- | --- |
| reuse | 45.5% (43.5% to 47.5%), 1115 of 2451 | 3.1% (2.5% to 3.9%), 74 of 2358 |
| type | 56.2% (54.2% to 58.2%), 1378 of 2451 | 75.3% (73.5% to 77.0%), 1776 of 2358 |
| known | 0.0% (0.0% to 0.2%), 0 of 2451 | 0.0% (0.0% to 0.2%), 0 of 2358 |
| fingerprint | 0.2% (0.1% to 0.5%), 6 of 2451 | 28.8% (27.0% to 30.7%), 679 of 2358 |
| round | 22.4% (20.8% to 24.1%), 548 of 2451 | 51.6% (49.6% to 53.6%), 1216 of 2358 |
| smaller | 14.8% (13.5% to 16.3%), 363 of 2451 | 15.4% (14.0% to 16.9%), 363 of 2358 |

## What the COINJOIN? flags look like

None was flagged.



**What the detector did not flag.** In the sample, 0 transactions have the Whirlpool shape (0 flagged). So few CoinJoins are in a sample like this that it cannot say how many real ones the detector finds: that is measured on the synthetic cases, and on real CoinJoins only with a list of known ones.

Transactions with at least 3 equal outputs of 10000 satoshis or more and at least 3 inputs that were not flagged (3), to look at by hand. Some may be CoinJoins and some payouts of one amount; the benchmark does not know which.

| Transaction | Year | Inputs | Outputs | Equal outputs | Amount (satoshis) |
| --- | --- | --- | --- | --- | --- |
| `a71b8cc529f047a883ee6e6e11876c036a9cb3008d697e47ca04e2532694bd3c` | 2017 | 51 | 54 | 3 | 950000 |
| `1a11fbab5b5e341984988e66069b24b7d1c037c8814f72f38100588a5a88c1b9` | 2023 | 25 | 9 | 3 | 1935059 |
| `5dc76dae10cb4ce691d0b4dfa64cf780743125127ac77fe4b0d82761646eaba7` | 2023 | 8 | 9 | 4 | 19352092 |

