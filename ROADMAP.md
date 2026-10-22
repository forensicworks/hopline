# Roadmap

Ideas and known gaps for Hopline, in no particular order inside each section. Nothing here has a date. Size is a rough guess: **S** = under a day, **M** = a few days, **L** = a project.

## Data sources and intelligence

- [ ] **A key for a data source.** An optional key sent with every request to a source you choose (for example your own Esplora behind a login), saved per source in the browser and never put in a URL, an export or a report; a clear message when the key is rejected (401 or 403). The code is `buildClient` in `public/js/hopline-api.js`. **S**
- [ ] **One interface for sources of wallet names.** Label packs, the local Arkham proxy and any future source would follow one contract (a list of addresses in, entries with label, category, source and time out), with the result kept per source on the wallet and the sources named in the report. The rules stay as they are: a name is a claim, nothing is applied automatically, and a lookup that sends an address to a third party asks first. Today Arkham is a special case in `public/js/hopline-external.js`. **M**
- [ ] **Check the Arkham look-ups against a real API key.** The reply is parsed from the field names Arkham documents; the raw reply is always kept on the wallet, so a mismatch is visible. If a real reply looks different, the parsing needs a small fix. **S**
- [ ] **Show every name a wallet has.** A wallet that is on two lists shows only the first name on the graph and on the wallet page (the workspace inspector lists the others as "also listed as"). For a sanctions hit that is too quiet: show every claim on the wallet page, and mark a sanctions pack on the graph. **S**
- [ ] **Review the built-in wallet list** (`public/data/known-addresses.js`). It began as the list in the original Orion project, was last updated upstream in November 2024 and has not been reviewed since. A name is a claim, not proof. **S**
- [ ] **Keeping the OFAC list current.** The list is read from a file you download. A button that fetches it could not work from a page, because OFAC's download address does not allow other sites to read it; a small local helper could. **S**

## Wallet overview (`public/wallet.html`)

- [ ] **"Balance not loaded yet"** in a wallet's details: say it more clearly ("press Load balance to read it"), or read the balance automatically when a wallet is selected (one request per wallet you click on, which matters on a rate-limited public API). **S**
- [ ] **Fiat values** in the ledger, with the same currency choice as the workspace. **S**
- [ ] **Your own labels and tags** from the saved workspace session. Today only the built-in list and the label lists saved by the workspace are used. **S**
- [ ] **A way to find things in a long history:** a date range, an amount range, a text search over addresses and labels. **M**
- [ ] **Load the whole history** (with a cap and a progress line) and download all of it, not only what is loaded. **S**
- [ ] **A balance-over-time chart** above the ledger. **M**
- [ ] **Trace from here:** tick transactions in the ledger and open them as a trace in the workspace. **M**
- [ ] **The biggest counterparties** in *Associations*, labelled or not, by volume. **S**
- [ ] **Wallet clusters.** A wallet explorer shows the whole wallet (all the addresses owned together), not one address. The workspace already finds clusters with the common-input rule; showing one on this page needs the cluster's transactions loaded. **L**

## Workspace

- [ ] **Redo for Undo load.** Undo and Redo cover the trace, hide and Re-layout steps; the top bar's *Undo load* (opening, expanding, importing, removing) has no Redo because it would have to keep a copy of the whole graph for each step. **S to M**
- [ ] **Wallet Transactions list: the same controls as the arrow list.** It has newest and largest first only; the arrow list also has oldest, smallest and "known or labelled first", the *skip known services / only known* choice and *unspent only*. **S**
- [ ] **A "3+" arrow loads more history.** Clicking an arrow that says "3+" shows the 3 known and stops; loading more of the wallet's history is the separate *Load history* button. The list could offer "load more history" itself. **S**
- [ ] **A range gesture just for expanding.** The arrows follow the ends of the time bar. A way to drag a range on the histogram that applies only to expanding (and does not hide anything else) is not built. **M**
- [ ] **Show on graph outside the Trace layout.** *Show on graph*, *As one vertex* and *+ show* exist only in the Trace layout; elsewhere the ticked rows can be selected and copied. **M**
- [ ] **Group vertex rough edges.** It exists only in the Trace layout; when auto-expand reveals a vertex that was folded into a group, Undo does not put it back in the group; a group cannot be labelled or tagged and is not in the colour legend; a JSON export with *Visible part only* leaves a group's members out, so the group is dropped when that file is imported. **S** each
- [ ] **More ways to group rows.** Rows are grouped by a shared wallet on the other side and by small amounts. By month (or any time bucket) is not built. **S**
- [ ] **A favicon, and the logo in the page headers.** **S**

## Bigger projects

- [ ] **A ready-made way to run your own Esplora** (Bitcoin Core with an Esplora or electrs index, packaged with Docker), so a team can drop the public API limits. The README says what it needs (roughly 440 GB of index, about 1 TB free while indexing). **L**
- [ ] **A machine-readable interface: what is left.** The evidence summary, the prompts, the check of an answer and a command-line tool exist (`docs/interface.md`), and so does *Ask the local model* in the workspace, tested against a stand-in server only. Still to do: try it against real local models (Ollama, LM Studio, llama.cpp) and tune the prompts and the size of the evidence for small context windows; a small local server so a script does not need Node; and letting an assistant act on a workspace (load, expand, follow the money in plain language), which needs an approval step for every request before it is offered. Any model feature stays optional and off by default, and nothing about a wallet is sent to a model that is not on this computer. **M**
- [ ] **Other blockchains.** Bitcoin only for now; widening it waits until people have used Hopline and say what they need. The model, the API client and the analysis are Bitcoin-only (inputs and outputs, UTXO rules such as common-input clustering). The cheapest next step would be another UTXO chain with an Esplora-style API (Litecoin); Ethereum and Tron need a different model. **L**
