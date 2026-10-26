# Sources

Where the data in Hopline comes from, under what licence, how it is kept up to date, and what was looked at and left out.

A name for a wallet is a **claim**, not a finding: every list below says who made the claim, shows it as "known (list name)" with the date of its data and a link to its source where it has one, and keeps it apart from your own labels. Nothing from a list is applied to your work without you seeing it.

The wallet counts and dates below are as of 26 October 2026. The live ones are in *Label packs > Built in* in the workspace and in [public/packs/index.js](public/packs/index.js). The credits and licence notices that the licences ask for are also in [NOTICE](NOTICE).

## Lists that ship with Hopline

They are files in [public/packs/](public/packs/), read from the same site as the page (nothing is sent anywhere) and only when the list is switched on. Each list is made by its own converter in [tools/](tools/) and written by [tools/build_packs.py](tools/build_packs.py), one wallet per line, so a refresh shows as a clean diff. Every address is checked by checksum before it gets in, and again when the page reads it. A workflow ([refresh-packs.yml](.github/workflows/refresh-packs.yml)) downloads every source again every Monday, runs the tests and opens a pull request that lists the wallets added, removed and renamed; nothing is published until that pull request is merged.

| List | Wallets | Data as of | Licence | On by default |
|---|---|---|---|---|
| [OFAC sanctions list](#ofac-sanctions-list) | 532 | 2026-10-21 | Public domain (U.S. government work) | yes |
| [UK Sanctions List](#uk-sanctions-list) | 4 | 2026-10-16 | Open Government Licence v3.0 | yes |
| [Ransomwhere](#ransomwhere) | 11,178 | 2024-10-27 | CC BY 4.0 | no |
| [Mining pools](#mining-pools) | 212 | 2026-09-24 | MIT | no |
| [GraphSense tag packs (selected)](#graphsense-tag-packs-selected) | 188 | 2023-08-28 | MIT | no |
| [Built-in wallet list](#built-in-wallet-list) | 908 | not dated | public domain | always |

The two sanctions lists are on by default because a missing sanctions banner reads as "clean". The others are off until you switch them on: a named wallet stops Auto-expand and feeds the likely-change guess, and a list that is old or small should be a choice. Your choices are kept in your browser.

### OFAC sanctions list

- **What:** the Bitcoin addresses ("Digital Currency Address - XBT") on the U.S. Treasury's Specially Designated Nationals list, 532 addresses from 65 entries, each named *OFAC SDN: <entry>*, with a link to OFAC's page for the entry. A sanctions list: a wallet on it gets a red ring, a banner and a line in the report.
- **From:** the SDN list XML published at <https://sanctionslist.ofac.treas.gov/Home/SdnList> (`SDN_XML.ZIP`). The CSV version is not used: it cuts long entries and loses about half of the Bitcoin addresses.
- **Licence:** a U.S. government work, public domain.
- **Made by:** [tools/make_label_pack_ofac.py](tools/make_label_pack_ofac.py). The workspace can also read the file itself ([public/js/hopline-ofac.js](public/js/hopline-ofac.js)), for a newer list than the shipped one; a pack you import under the same name replaces the built-in one.

### UK Sanctions List

- **What:** the Bitcoin addresses named in the entries of the UK Sanctions List, published by the Foreign, Commonwealth & Development Office. Four today (Garantex Europe OU, Ayash, Rapira Group), two of them also on OFAC. A sanctions list, like OFAC.
- **From:** `UK-Sanctions-List.xml` linked from <https://www.gov.uk/government/publications/the-uk-sanctions-list>.
- **Licence:** Open Government Licence v3.0 (Crown copyright). Contains public sector information licensed under the Open Government Licence v3.0.
- **How it is read:** the list has no field for a crypto wallet; the UK writes one into the free text of an entry ("Other information" or "UK statement of reasons"). The converter reads only those two fields, keeps what is shaped like a Bitcoin address and passes its checksum, and skips an address the text gives as another coin (BCH, ETH and so on). One marked USDT is kept, because USDT on the Omni layer is paid to an ordinary Bitcoin address, and the note says what the entry called it. Most crypto addresses on the list are Ethereum or Tron ones, which Hopline does not read.
- **Made by:** [tools/make_label_pack_uksanctions.py](tools/make_label_pack_uksanctions.py).
- **Not used:** the older OFSI consolidated list, which closed on 28 January 2026.

### Ransomwhere

- **What:** Bitcoin addresses that ransomware actors asked victims to pay, 11,178 from 136 families, each named *Ransomware: <family>* with a note on the payments the dataset recorded for it (how many, when, how much). Every report in it was checked by hand against the ransom demand. It says an address was reported as a ransom address, not who is behind it.
- **From:** the dataset on Zenodo, version 1.1.0 of 27 October 2024, by Jack Cable and contributors (<https://zenodo.org/records/13999026>, DOI 10.5281/zenodo.13999026), file `ransomwhere.json`, from <https://ransomwhe.re>.
- **Licence:** CC BY 4.0. Changes made: converted to the label pack format, the recorded payments summarised in a note, addresses sorted.
- **Pinned:** the tool takes only that release and checks the file's MD5 against the one Zenodo publishes, because the pack states that release's licence. The weekly run says when Zenodo has a newer release; adopting it is a decision for a person, after reading its record and licence. The live API at ransomwhe.re has a few more addresses than the release; its own licence was not checked.
- **Age:** the newest data is from October 2024, so the panel shows how old the list is.
- **Made by:** [tools/make_label_pack_ransomwhere.py](tools/make_label_pack_ransomwhere.py). Not included: the payment transaction ids (they would add about 1.4 MB).

### Mining pools

- **What:** the addresses that block rewards of known mining pools are paid to, 212 addresses of 104 pools, each named *Mining pool: <name>* with the pool's own web address as the link. The coinbase text tags in the same list are not used: they are patterns for blocks, not addresses. A reward address is not always the wallet a pool pays its miners from.
- **From:** `pools-v2.json` in <https://github.com/mempool/mining-pools>, the list mempool.space uses to name the miners of blocks, at the newest commit (the commit and its date are in the pack). Testnet addresses in it are left out.
- **Licence:** MIT, Copyright (c) 2019 btc.com and contributors. The licence asks for its text to travel with copies, so the pack file starts with it. The tool stops if the repository's licence text is no longer the one it knows.
- **Made by:** [tools/make_label_pack_miningpools.py](tools/make_label_pack_miningpools.py).

### GraphSense tag packs (selected)

- **What:** 188 Bitcoin addresses from ten of the GraphSense public TagPacks, each linked to the document it comes from: a U.S. Department of Justice forfeiture complaint (155 addresses of an al-Qaeda campaign), an FBI press release on funds stolen by North Korea (6), and the addresses that Binance, Huobi, KuCoin, Bybit, Deribit and Bitfinex publish for their own reserve wallets, the Internet Archive's donation address and Proton's.
- **From:** <https://github.com/graphsense/graphsense-tagpacks>, at the newest commit. A TagPack is a YAML file of tags, each with a link to its public source.
- **Licence:** MIT, Copyright (c) 2022 Iknaio Cryptoasset Analytics GmbH and (c) 2018-2022 AIT Austrian Institute of Technology; the pack file starts with the licence text, and the tool stops if the text changes.
- **Why only ten packs:** the repository holds about 500,000 Bitcoin tags, most of them bulk lists copied from other projects, scraped sites and social media, whose own terms the repository's MIT licence cannot grant, and none of its packs states a licence of its own. So a pack is taken only when its tags come from a government or court document, or from the page of the exchange or service that owns the address, and within a pack only the tags whose source link is on such a page. The list is in `PACKS` in the converter; a pack is added after its tags' sources have been read.
- **Not taken, and why:** packs made from the OFAC list or from Ransomwhere (Hopline has those directly and current); the miners pack (37,000 addresses from a research dataset, with its own terms; the mining pools list above covers the pools); Samourai and the sextortion lists (tens of thousands of addresses copied from other projects and a blog); the BitMEX list (336,000 addresses, too large for a page); WalletExplorer, EtherScamDB, bitcointalk and gist crawls, lock-bit tattoos, rich lists (scraped or crowd sources); a pack that names individuals and organisations from an advocacy article; packs whose source is a news article or a social media post; INTERPOL's (its terms were not read).
- **Made by:** [tools/make_label_pack_graphsense.py](tools/make_label_pack_graphsense.py), which reads the TagPack format strictly and refuses what it does not know instead of guessing.

### Built-in wallet list

- **What:** 908 exchange and service wallets, one name each ([public/data/known-addresses.js](public/data/known-addresses.js)).
- **From:** the starting list of the original Orion project by Kyle Honeycutt, released into the public domain under the Unlicense. It was last updated upstream in November 2024 and has not been reviewed since; it is on the [roadmap](ROADMAP.md).

## Live data, asked for as you work

- **Transactions and addresses:** a public block explorer API of your choice, mempool.space by default with Blockstream.info as its backup, mempool.space over Tor, or your own Esplora server. Each one sees your IP address and which addresses and transactions you look up. mempool.space publishes no rate limit.
- **Prices:** the mempool.space price history, or prices from your own server. Only the currency and the times are sent, never an address.
- Details and limits: [Data sources and limits](https://github.com/forensicworks/hopline/wiki/Data-sources-and-limits).

## Lookups with your own key or account, on request

- **Arkham Intelligence, with a key:** a wallet is looked up through `tools/arkham_proxy.py`, a small program on your own computer that keeps your API key in an environment variable, so the key never enters the page. One wallet at a time, after you confirm, never for the whole graph; the reply is shown with its raw text and nothing is applied automatically. Off while the data source is Tor.
- **Arkham Intelligence, without a key:** *Check in Arkham* in the right-click menu, the details and the wallet overview opens Arkham's own page for the wallet or transaction in a new tab, with no referrer, so your own Arkham account is used if you are signed in there. Nothing is sent until you click; Arkham is then told what you are looking at. Not offered over Tor.
- Other providers need an adapter in the proxy and have not been built.

## Looked at and not used

| Source | Why not |
|---|---|
| OpenSanctions (crypto wallets of several governments) | Its data is under a non-commercial licence (CC BY-NC), which does not fit an Apache-2.0 project that anyone may reuse. The governments' own files are read instead. |
| Israel's seizure orders (NBCTF) | Published as documents, not as a file, and most of the addresses are Tether. A small pack can be made by hand from the documents. |
| Japan, the EU and the UN lists | Nothing found for Japan; for the EU and the UN only a vendor says they carry crypto addresses, and the files have not been read. |
| Chainabuse (TRM) | An API with a small free quota; no terms for reuse were found. A look-up candidate, not a list. |
| WalletExplorer and similar scraped sites | No bulk licence. |
| BitcoinHeist, BABD-13, Elliptic++ | Labels such as "ransomware" or "illicit" without owners; for testing the analysis, not for naming wallets. Elliptic++ has no licence that was found. |
| Schnoering and Vazirgiannis 2025 | Some of its labels were made with ChatGPT, and its licence was not confirmed. |
| Codatta sample | An OpenRAIL licence, which restricts use, and not only Bitcoin. |
| abuse.ch ThreatFox | Its indicator types are IP addresses, domains, URLs, emails and file hashes, not crypto addresses. |
| Bulk labels from commercial intelligence providers | Their terms do not allow redistribution. |

## Adding a source

1. Read its licence or terms and where its entries come from. A source whose terms are not settled does not go in.
2. Write `tools/make_label_pack_<name>.py`: read the file strictly, check every address by checksum ([tools/btc_address.py](tools/btc_address.py)), keep a link to the source on each entry, and state the licence, the credit and the date of the data in the pack.
3. Add a `build_<name>()` and one entry in `SOURCES` in [tools/build_packs.py](tools/build_packs.py); the weekly workflow then includes it without a change.
4. Add tests (see `test/tools/`), credit it in [NOTICE](NOTICE), and add it to this file.
