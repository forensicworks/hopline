# Benchmark: documented cases

Written by `node test/benchmark/trace.js --write-docs`; the method is in [benchmark.md](benchmark.md) (tier C). A case starts where a public document says the money was and asks whether Hopline's auto-expand, run with each of its rules, reaches where the document says it ended up. **A case is a case study, not a rate**: one case says what each rule did there and nothing about how often.

|  |  |
| --- | --- |
| Date | 2026-10-27 |
| Commit | 164c5ac |
| `hopline-analysis.js` SHA-256 | `634132ae3ec68366` |
| Cases | colonial-darkside |

## The Colonial Pipeline ransom to DarkSide, May 2021, as far as the seizure

Where the 75 BTC ransom paid on 8 May 2021 went, forward from the payment to the address the US government seized 63.7 BTC from on 7 June 2021.

**What the documents say, and what was read:**

* An address of DarkSide received two payments on 2021-05-08, 75 BTC in all: bc1q7eqww9dmm9p48hx5yz5gcvmncu65w43wfytpsf. Source: Ransomwhere dataset version 1.1.0 (Zenodo, doi:10.5281/zenodo.13999026, CC BY 4.0), read in public/packs/ransomwhere.js. Read: yes, the entry in the shipped pack: label 'Ransomware: DarkSide', note '2 payments, 2021-05-08, 75 BTC in all'.
* The affiliate got 85% of the ransom (63.75 BTC), the US seized 63.7 BTC of it, and the address it was seized from is bc1qq2euq8pw950klpjcawuy4uj39ym43hs6cfsegq, 'the same address mentioned in the seizure affidavit'. That address was emptied on 2021-06-07. Source: Elliptic, 'US Authorities Seize DarkSide Ransom', 2021-06-07, https://www.elliptic.co/blog/us-authorities-seize-darkside. Read: yes, the page; its statement that the address is the affidavit's is Elliptic's.
* The ransom was about 75 BTC, paid on 8 May 2021; the FBI seized 63.7 BTC from one address whose private key it held. Source: US Department of Justice press release, 2021-06-07, https://www.justice.gov/archives/opa/pr/department-justice-seizes-23-million-cryptocurrency-paid-ransomware-extortionists-darkside. Read: no: the page is behind a bot check and I did not try to get past it; the claims are as quoted in search results and in the Elliptic page. The seizure affidavit itself was not read..

**Start:** `fc78327d4e46dac01dc313067b1ac7f274cdb3a07ea9f28f6f71473145f1b264`. The transaction that paid 74.99998307 BTC into bc1q7eqww9dmm9p48hx5yz5gcvmncu65w43wfytpsf, at 17:47 UTC on 2021-05-08 (the other payment into it was 0.00001693 BTC, in the transaction before this one). One of the two payments that make up the 75 BTC.

**End:** `bc1qq2euq8pw950klpjcawuy4uj39ym43hs6cfsegq`. The address Elliptic names as the one in the seizure affidavit.

**The route** (4 transactions, verified on the chain): `fc78327d4e46` then `0677781a5079` then `9436dbf0435b` then `daf38c7b38eb`. Found on the chain by walking back from the endpoint, then checked going forward: the 75 BTC is split 63.75 / 11.25 (the 85/15 of Elliptic) at 18:21 UTC on 8 May, 63.7 BTC of the larger part moves on 9 May, and on 28 May that coin is one of 24 inputs of a transaction that pays the endpoint 69.6 BTC. The documents do not list these transactions; the route is the benchmark's, and the verification is that each spends the one before and the last pays the endpoint (test/benchmark.test.js).

The walk goes forward from the start, 10 hops at most, 80 transactions and 400 requests at most, and stops at a CoinJoin-like transaction, as the workspace does with its default settings.

| Rule | Reached the end | Hops to it | Requests to get there | Wrong branches loaded on the way | Loaded after the end | The whole run: requests | The whole run: transactions | Where the branches ended |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| every output (largest first, up to 6) | yes | 3 | 10 | 2 | 74 | 160 | 80 (4 of the 4 on the route) | 1 × transaction looked like a CoinJoin; 11 × output unspent; the limit of transactions |
| the largest output only | yes | 3 | 7 | 0 | 7 | 21 | 11 (4 of the 4 on the route) | the limit of hops |
| the likely change output | no | n/a | n/a | 0 | 0 | 2 | 1 (1 of the 4 on the route) | 1 × output unspent |
| a peel chain | no | n/a | n/a | 0 | 0 | 4 | 2 (2 of the 4 on the route) | 1 × transaction was not a peel step |

Reading the rows:

* **every output (largest first, up to 6).** Reaches the end quickly, but does not know it has arrived and goes on to the limit of transactions: the cost of following everything is in the last columns.
* **the largest output only.** The cheapest way here. It works because every split on the route sent the larger part on; on a route that went through a smaller output it would miss.
* **the likely change output.** Follows what the sender kept, not the payment, so it leaves the ransom behind: in the first transaction it names the 0.0000675 BTC output (very likely the payer's leftover, so the guess may well be right) and the walk ends at that unspent coin. This rule is for following a wallet's own money; the case is about following a payment.
* **a peel chain.** Stops at the second transaction, which has two inputs (the 75 BTC and a 0.0000169 BTC payment into the same address), so it is not a peel step by the rule's own definition.

A wrong branch is a transaction the walk loaded that is not on the route, on the way to the end (a level at or before the one that reached it; when the end is not reached, everything it loaded off the route). The walk does not know when it has arrived, so what it loads after the end is counted apart. "Requests to get there" is a second walk with the hops set to the level the end was reached at.

